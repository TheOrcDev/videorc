import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

// Plan 174 S1.2 (A-5, I-18, V-X1): a shortcut is authored as an Electron
// accelerator and printed by ShortcutKeys / shortcutLabel, per platform. A
// hand-typed "⌘K", "⇧⌘J", "↵" or "Cmd+P" in the renderer shows a Mac glyph on
// Windows (or the raw "Cmd+P" on a Mac). This guard reads every string
// literal, template literal and JSX text in the renderer and fails on one.

const RENDERER_ROOT = join(__dirname, '..')

/**
 * The modules that own key glyphs. Comments never count: only text a
 * reader could see is checked.
 */
const ALLOWLIST = new Set([
  // Maps a lone Mac glyph to its Windows word.
  'src/lib/platform.ts',
  // The recorder's refusal names the Mac modifiers on a Mac only.
  'src/lib/shortcut-recorder.ts'
])

const KEY_GLYPH = /[⌘⇧⌥⌃␣⌫↵⏎↩⌦]/
const CMD_ACCELERATOR = /\b(Cmd|Command)\+/

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

describe('renderer shortcut guard (plan 174 S1.2)', () => {
  it('prints shortcuts through ShortcutKeys, never as hand-typed glyphs or Cmd+', () => {
    const offenders: string[] = []
    for (const path of rendererSources()) {
      const name = relative(RENDERER_ROOT, path).split(sep).join('/')
      if (ALLOWLIST.has(name)) continue
      for (const { line, text } of readableTexts(path, readFileSync(path, 'utf8'))) {
        if (KEY_GLYPH.test(text) || CMD_ACCELERATOR.test(text)) {
          offenders.push(`${name}:${line} ${JSON.stringify(text.trim().slice(0, 60))}`)
        }
      }
    }
    expect(offenders).toEqual([])
    // Parsing every renderer module takes seconds on a loaded machine.
  }, 60_000)

  it('keeps its allowlist to the modules that own key glyphs', () => {
    expect(ALLOWLIST.size).toBeLessThanOrEqual(4)
    for (const name of ALLOWLIST) {
      expect(() => readFileSync(join(RENDERER_ROOT, name)), name).not.toThrow()
    }
  })
})
