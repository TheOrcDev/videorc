import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

// Plan 174 S2.4 (J2-7): raw error text never reaches a toast. A toast says
// what failed and what to do (`userErrorMessage` / `toastUserError` in
// lib/user-error.ts); the raw text goes to the console and the support
// bundle. This guard reads every `toast(…)`, `toast.<kind>(…)` and
// `notifyOnce(…)` call in the renderer and fails when its arguments read an
// error's `.message`, stringify an error, or pass the error text through
// `ipcErrorMessage`.

const RENDERER_ROOT = join(__dirname, '..')

/** Names an error usually goes by in a `catch` or a rejection handler. */
const ERROR_NAME = /^(?:e|err|error|cause|reason|rejection|\w+Error)$/

const TOAST_CALLEE = /^(?:toast(?:\.(?:error|warning|success|info|message|loading))?|notifyOnce)$/

function rendererSources(): string[] {
  const files: string[] = []
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory)) {
      const path = join(directory, entry)
      if (statSync(path).isDirectory()) {
        if (entry !== 'node_modules') walk(path)
      } else if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry)) {
        files.push(path)
      }
    }
  }
  walk(RENDERER_ROOT)
  return files
}

function isErrorName(node: ts.Node): boolean {
  return ts.isIdentifier(node) && ERROR_NAME.test(node.text)
}

/** Each toast call in `source` whose arguments pass raw error text, as `path:line text`. */
function rawErrorToasts(path: string, source: string): string[] {
  const file = ts.createSourceFile(
    path,
    source,
    ts.ScriptTarget.Latest,
    true,
    path.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  )
  const found: string[] = []
  const leaks = (node: ts.Node): boolean => {
    // `error.message`
    if (
      ts.isPropertyAccessExpression(node) &&
      node.name.text === 'message' &&
      isErrorName(node.expression)
    ) {
      return true
    }
    if (ts.isCallExpression(node)) {
      const callee = node.expression.getText(file)
      // `String(error)` and `ipcErrorMessage(error)`
      if (
        (callee === 'String' || callee === 'ipcErrorMessage') &&
        node.arguments.some((argument) => isErrorName(argument))
      ) {
        return true
      }
    }
    // A nested function (an action's onClick) is its own code, not this toast's text.
    if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) return false
    return ts.forEachChild(node, (child) => (leaks(child) ? true : undefined)) ?? false
  }
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && TOAST_CALLEE.test(node.expression.getText(file))) {
      if (node.arguments.some((argument) => leaks(argument))) {
        const { line } = file.getLineAndCharacterOfPosition(node.getStart(file))
        found.push(`${path}:${line + 1} ${node.getText(file).replace(/\s+/g, ' ').slice(0, 120)}`)
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(file)
  return found
}

// Whole-renderer source scans are CPU-bound: under a parallel full run on a
// laptop they pass vitest's 5 s default (ogre 2026-10-12: 6.9 s; 1.5 s alone).
const SOURCE_SCAN_TIMEOUT = { timeout: 30_000 }

describe('renderer toast guards (plan 174 S2.4)', SOURCE_SCAN_TIMEOUT, () => {
  it('never hands a toast raw error text', () => {
    const offenders = rendererSources().flatMap((path) =>
      rawErrorToasts(relative(RENDERER_ROOT, path).split(sep).join('/'), readFileSync(path, 'utf8'))
    )
    expect(offenders).toEqual([])
  })

  it('catches error.message, String(error) and ipcErrorMessage, and leaves copy alone', () => {
    const source = [
      'toast.error(error instanceof Error ? error.message : "Import failed.")',
      'toast.error("Couldn\'t import the image", { description: String(error) })',
      "notifyOnce('k', 'error', ipcErrorMessage(chatError))",
      "toast(err.message, { id: 'x' })",
      'toast.warning(copy.title, { description: copy.description })',
      'toast.success(event.message)',
      "toast.info('Saved', { action: { label: 'Retry', onClick: () => log(error.message) } })",
      "toastUserError(error, { action: 'import', object: 'the image' })"
    ].join('\n')
    expect(rawErrorToasts('sample.ts', source).map((entry) => entry.split(' ')[0])).toEqual([
      'sample.ts:1',
      'sample.ts:2',
      'sample.ts:3',
      'sample.ts:4'
    ])
  })
})
