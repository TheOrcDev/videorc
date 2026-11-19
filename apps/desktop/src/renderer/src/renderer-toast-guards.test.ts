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

const TOAST_CALLEE =
  /^(?:toast(?:\.(?:error|warning|success|info|message|loading|problem))?|notifyOnce)$/

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

// Plan 250: what Videorc notices on its own is an entry behind the bell, and
// only `lib/notifications/pop-up.ts` turns an entry into a toast. A toast is
// the answer to something the streamer just did, or one urgent problem, and
// it is never pinned: a toast that times out leaves its entry behind.

/** Files whose only job is unprompted news: they publish, and never toast. */
const UNPROMPTED_ONLY = /^src\/lib\/notifications\/sources\//

/**
 * The toasts that may still stay until closed, each for a reason a list
 * cannot serve.
 */
const PINNED_TOASTS_THAT_STAY = new Set([
  // "Remove this message?": a question with a 20 s deadline (D11).
  'src/lib/chat-moderation-relay.ts',
  // "Couldn't start": the answer to Record or Go Live, with its way out.
  'src/lib/session-start-failure.ts',
  // The same "Couldn't start", when the backend's refusal arrives first.
  'src/lib/studio-health.ts',
  // "Finish connecting in your browser": a step the streamer is in the middle of.
  'src/lib/studio-connection-toasts.ts'
])

/** Each `duration: Infinity` (or `Number.POSITIVE_INFINITY`) in `source`, as `path:line`. */
function pinnedDurations(path: string, source: string): string[] {
  const file = ts.createSourceFile(
    path,
    source,
    ts.ScriptTarget.Latest,
    true,
    path.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  )
  const found: string[] = []
  const visit = (node: ts.Node): void => {
    if (
      ts.isPropertyAssignment(node) &&
      node.name.getText(file) === 'duration' &&
      /^(?:Infinity|Number\.POSITIVE_INFINITY)$/.test(node.initializer.getText(file))
    ) {
      const { line } = file.getLineAndCharacterOfPosition(node.getStart(file))
      found.push(`${path}:${line + 1}`)
    }
    ts.forEachChild(node, visit)
  }
  visit(file)
  return found
}

/** Each toast call in `source`, as `path:line`. */
function toastCalls(path: string, source: string): string[] {
  const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const found: string[] = []
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && TOAST_CALLEE.test(node.expression.getText(file))) {
      const { line } = file.getLineAndCharacterOfPosition(node.getStart(file))
      found.push(`${path}:${line + 1}`)
    }
    ts.forEachChild(node, visit)
  }
  visit(file)
  return found
}

describe('notifications never toast around the store (plan 250)', SOURCE_SCAN_TIMEOUT, () => {
  const sources = (): { path: string; source: string }[] =>
    rendererSources().map((path) => ({
      path: relative(RENDERER_ROOT, path).split(sep).join('/'),
      source: readFileSync(path, 'utf8')
    }))

  it('the modules that only carry unprompted news call no toast', () => {
    const offenders = sources()
      .filter(({ path }) => UNPROMPTED_ONLY.test(path))
      .flatMap(({ path, source }) => [
        ...toastCalls(path, source),
        ...(/from '@\/lib\/toast'/.test(source) ? [`${path}: imports the toast door`] : [])
      ])
    expect(offenders).toEqual([])
  })

  it('no toast is pinned outside the named list', () => {
    const offenders = sources()
      .filter(({ path }) => !PINNED_TOASTS_THAT_STAY.has(path))
      .flatMap(({ path, source }) => pinnedDurations(path, source))
    expect(offenders).toEqual([])
  })

  it('every file on the list still pins a toast: a list entry is never stale', () => {
    const pinned = new Set(
      sources()
        .filter(({ source, path }) => pinnedDurations(path, source).length > 0)
        .map(({ path }) => path)
    )
    for (const path of PINNED_TOASTS_THAT_STAY) {
      expect(pinned.has(path), path).toBe(true)
    }
  })

  it('catches a pinned toast however the number is written, and a planted toast', () => {
    const source = [
      "toast.warning('Your stream is frozen', { duration: Infinity })",
      "toast('Saved', { duration: Number.POSITIVE_INFINITY, id: 'x' })",
      "toast.success('Saved', { duration: 8_000 })",
      'const limit = Number.POSITIVE_INFINITY'
    ].join('\n')
    expect(pinnedDurations('sample.ts', source)).toEqual(['sample.ts:1', 'sample.ts:2'])
    expect(
      toastCalls('src/lib/notifications/sources/health.ts', "toast.warning('Planted')")
    ).toEqual(['src/lib/notifications/sources/health.ts:1'])
    expect(UNPROMPTED_ONLY.test('src/lib/notifications/sources/health.ts')).toBe(true)
    expect(UNPROMPTED_ONLY.test('src/lib/notifications/pop-up.ts')).toBe(false)
  })
})
