import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

// Plan 174 S0.3 (E-2, J2-1): what a streamer reads is never an identifier.
// A codemod once turned "Trash" into "DeleteIcon" inside a sentence, and
// the dialog said "You can restore them from the DeleteIcon." for months.
// This guard reads every string literal, template literal and JSX text in
// the renderer and fails on an icon component's name. Later slices extend
// this file with the other copy rules (plan 174 S2.1).

const RENDERER_ROOT = join(__dirname, '..')

/** The registry names its own glyphs as strings; nothing else may. */
const ICON_NAME_ALLOWLIST = new Set(['src/components/icons.tsx'])

const ICON_NAME = /\b[A-Z]\w+Icon\b/

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

/** Every text a reader could see: JSX text and string or template literals. */
function readableTexts(path: string, source: string): Array<{ line: number; text: string }> {
  const file = ts.createSourceFile(
    path,
    source,
    ts.ScriptTarget.Latest,
    true,
    path.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  )
  const found: Array<{ line: number; text: string }> = []
  const visit = (node: ts.Node): void => {
    if (
      ts.isJsxText(node) ||
      ts.isStringLiteral(node) ||
      ts.isNoSubstitutionTemplateLiteral(node) ||
      ts.isTemplateHead(node) ||
      ts.isTemplateMiddle(node) ||
      ts.isTemplateTail(node)
    ) {
      const { line } = file.getLineAndCharacterOfPosition(node.getStart(file))
      found.push({ line: line + 1, text: node.text })
    }
    ts.forEachChild(node, visit)
  }
  visit(file)
  return found
}

describe('renderer copy guards (plan 174)', () => {
  const files = rendererSources().map((path) => ({
    path: relative(RENDERER_ROOT, path).split(sep).join('/'),
    source: readFileSync(path, 'utf8')
  }))

  it('scans the renderer sources', () => {
    expect(files.length).toBeGreaterThan(100)
    expect(files.some(({ path }) => path === 'src/components/tabs/library-tab.tsx')).toBe(true)
  })

  it('never shows an icon name as copy', () => {
    const offenders = files
      .filter(({ path }) => !ICON_NAME_ALLOWLIST.has(path))
      .flatMap(({ path, source }) =>
        readableTexts(path, source)
          .filter(({ text }) => ICON_NAME.test(text))
          .map(({ line, text }) => `${path}:${line}: ${text.trim().slice(0, 120)}`)
      )
    expect(offenders).toEqual([])
  })
})
