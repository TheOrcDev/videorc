import { existsSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

// Performance finding PH-09 (11-20): what every launch loads, past the entry.
// A lazy chunk that is mounted or imported at every launch loads its whole
// static import graph with it, so one stray value import can pull a large
// module into every launch:
// - The talk-show room host is mounted at launch. One import of a 12-line URL
//   helper from the HTML-layer publisher brought `livekit-client` (about
//   600 KB) with no room open. LiveKit loads only when a room opens (the rule
//   in `use-talk-show-room.ts`, `lib/talk-show-context.ts`,
//   `lib/talk-show-room.ts`).
// - The remote surface and the agents' link load with every Studio socket.
//   Through the `studio-actions` barrel and `BUDDY_AGENT_ID` they brought the
//   agent executors and their 60 KB tool catalog with Agents off; a tool call
//   loads them itself when it runs (`handleAgentIntent`).
// This walks the imports the bundler keeps (value imports, side-effect
// imports and value re-exports; never `import type`, an import whose every
// name is a type, or a dynamic `import()`) and fails on a forbidden module.

const RENDERER_SRC = __dirname
const DESKTOP_SRC = resolve(RENDERER_SRC, '..', '..')
const EXTENSIONS = ['.ts', '.tsx', '/index.ts', '/index.tsx']

const LIVEKIT = /^(livekit-client|@livekit\/)/
/** Paths relative to `src/`. */
const AGENT_CATALOG =
  /^(renderer\/src\/lib\/studio-actions\/(index|agent|tools)\.ts|shared\/agent-tools\.ts)$/

const RULES: Array<{ module: string; forbidden: RegExp }> = [
  { module: 'components/studio/talk-show-room-host.tsx', forbidden: LIVEKIT },
  { module: 'lib/remote-surface.ts', forbidden: AGENT_CATALOG },
  { module: 'lib/agent-studio-link.ts', forbidden: AGENT_CATALOG }
]

function resolveLocal(fromFile: string, specifier: string): string | null {
  // `?url`, `?worker&url`, `?raw`: Vite hands back a URL or a string, and a
  // worker is its own bundle; none of it runs in this graph.
  if (specifier.includes('?')) return null
  let base: string
  if (specifier.startsWith('@/')) base = join(RENDERER_SRC, specifier.slice(2))
  else if (specifier.startsWith('.')) base = resolve(dirname(fromFile), specifier)
  else return null
  if (existsSync(base) && statSync(base).isFile()) return base
  for (const extension of EXTENSIONS) {
    if (existsSync(base + extension)) return base + extension
  }
  throw new Error(`${relative(DESKTOP_SRC, fromFile)}: cannot resolve '${specifier}'`)
}

/** The specifiers of `file` that survive TypeScript's type-import elision. */
function keptImports(file: string): string[] {
  const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest)
  const kept: string[] = []
  for (const statement of source.statements) {
    if (ts.isImportDeclaration(statement)) {
      const clause = statement.importClause
      if (clause?.isTypeOnly) continue
      const bindings = clause?.namedBindings
      const onlyTypeNames =
        clause !== undefined &&
        clause.name === undefined &&
        bindings !== undefined &&
        ts.isNamedImports(bindings) &&
        bindings.elements.length > 0 &&
        bindings.elements.every((element) => element.isTypeOnly)
      if (onlyTypeNames) continue
      kept.push((statement.moduleSpecifier as ts.StringLiteral).text)
    } else if (ts.isExportDeclaration(statement) && statement.moduleSpecifier) {
      if (statement.isTypeOnly) continue
      const clause = statement.exportClause
      if (
        clause &&
        ts.isNamedExports(clause) &&
        clause.elements.length > 0 &&
        clause.elements.every((element) => element.isTypeOnly)
      )
        continue
      kept.push((statement.moduleSpecifier as ts.StringLiteral).text)
    }
  }
  return kept
}

/**
 * Every forbidden module the static graph of `entry` reaches, as the import
 * path that reaches it. A package matches by its specifier, a source file by
 * its path under `src/`.
 */
function forbiddenReach(entry: string, forbidden: RegExp): string[] {
  const seen = new Set<string>()
  const found: string[] = []
  const walk = (file: string, trail: string[]): void => {
    if (seen.has(file)) return
    seen.add(file)
    const here = [...trail, relative(DESKTOP_SRC, file)]
    if (forbidden.test(relative(DESKTOP_SRC, file))) {
      found.push(here.join(' -> '))
      return
    }
    for (const specifier of keptImports(file)) {
      const next = resolveLocal(file, specifier)
      if (next === null) {
        if (forbidden.test(specifier)) found.push(`${here.join(' -> ')} -> ${specifier}`)
      } else if (/\.tsx?$/.test(next)) {
        walk(next, here)
      }
    }
  }
  walk(entry, [])
  return found
}

describe('launch import graph', () => {
  for (const { module, forbidden } of RULES) {
    it(`${module} does not load ${forbidden.source} statically`, () => {
      expect(forbiddenReach(join(RENDERER_SRC, module), forbidden)).toEqual([])
    })
  }

  it('the walker is not blind: the modules that own them reach them', () => {
    expect(
      forbiddenReach(join(RENDERER_SRC, 'lib/room-html-layer-publisher.ts'), LIVEKIT)
    ).not.toEqual([])
    expect(
      forbiddenReach(join(RENDERER_SRC, 'lib/studio-actions/studio-context.ts'), AGENT_CATALOG)
    ).not.toEqual([])
  })
})
