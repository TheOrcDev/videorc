import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

// Plan 174 S0.3 (E-2, J2-1): what a streamer reads is never an identifier.
// A codemod once turned "Trash" into "DeleteIcon" inside a sentence, and
// the dialog said "You can restore them from the DeleteIcon." for months.
// This guard reads every string literal, template literal and JSX text in
// the renderer and fails on an icon component's name.
//
// Plan 174 S2.1 (J2-6, J2-10, J2-21, A-26) adds the rules of docs/ui-copy.md
// ("No internals"): no engineering word, no retired page or control name and
// no three-dot ellipsis in copy. Today's offenders are a ratchet that S2.2 to
// S2.5 shrink to zero.

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

/** The words docs/ui-copy.md keeps out of copy, one rule each. */
const COPY_RULES: ReadonlyArray<{ id: string; pattern: RegExp }> = [
  { id: 'backend', pattern: /\bbackend\b/i },
  { id: 'socket', pattern: /\b(?:web)?sockets?\b/i },
  { id: 'RPC', pattern: /\bRPC\b/ },
  { id: 'OAuth', pattern: /\bOAuth\b/i },
  { id: 'callback', pattern: /\bcallbacks?\b/i },
  { id: 'provider', pattern: /\bproviders?\b/i },
  { id: 'revision', pattern: /\brevisions?\b/i },
  { id: 'compositor', pattern: /\bcompositors?\b/i },
  { id: 'entitlement', pattern: /\bentitlements?\b/i },
  { id: 'VIDEORC_', pattern: /\bVIDEORC_/ },
  { id: 'Electron', pattern: /\bElectron\b/ },
  { id: 'diagnostics', pattern: /\bdiagnostics\b/i },
  { id: 'Manual RTMP', pattern: /\bManual RTMP\b/i },
  { id: 'X / Twitter', pattern: /\bX \/ Twitter\b/ },
  { id: 'Streaming tab', pattern: /\bStreaming tab\b/i },
  { id: 'Recording → Output', pattern: /\bRecording → Output\b/ },
  { id: 'Open Live', pattern: /\bOpen Live\b/ },
  { id: 'Open Recording', pattern: /\bOpen Recording\b/ },
  { id: 'Customize', pattern: /\bCustomize\b/ },
  { id: 'Command Palette', pattern: /\bCommand Palette\b/i },
  { id: 'receive-only', pattern: /\breceive-only\b/i },
  { id: '...', pattern: /\.\.\./ }
]

/**
 * The ratchet: per file, how many strings broke a copy rule when S2.1 landed.
 * Plan 174 S2.2 to S2.5 shrink it to nothing. When you fix one, lower that
 * file's count (the test names the new number) or delete the line at zero.
 * Never raise a count or add a file: rewrite the new copy instead
 * (docs/ui-copy.md says how).
 */
const COPY_RULE_RATCHET: Readonly<Record<string, number>> = {
  'src/backendClient.ts': 20,
  'src/components/captions/captions-controls.tsx': 1,
  'src/components/comments-destination-status.tsx': 2,
  'src/components/preview-stage.tsx': 3,
  'src/components/settings/encoder-preference-field.tsx': 1,
  'src/components/streaming/go-live-panel.tsx': 1,
  'src/components/studio/session-panel.tsx': 3,
  'src/components/tabs/assets-tab.tsx': 1,
  'src/components/tabs/diagnostics-tab.tsx': 13,
  'src/components/tabs/studio-tab.tsx': 2,
  'src/hooks/use-scheduled-streams.ts': 3,
  'src/hooks/use-studio.tsx': 80,
  'src/lib/backend-transport.ts': 3,
  'src/lib/buddy-tab-view.ts': 1,
  'src/lib/capture.ts': 3,
  'src/lib/clean-cut-view.ts': 1,
  'src/lib/format.ts': 5,
  'src/lib/go-live-output.ts': 1,
  'src/lib/live-source-selection.ts': 1,
  'src/lib/native-preview-surface-lifecycle.ts': 1,
  'src/lib/obs-import-map.ts': 3,
  'src/lib/record-latency.ts': 1,
  'src/lib/session-runtime-recovery.ts': 5,
  'src/lib/studio-health.ts': 2,
  'src/lib/system-permission-orchestration.ts': 1,
  'src/lib/toast.ts': 1
}

/** JSX attributes a reader sees or hears; any other attribute's string is code. */
const COPY_ATTRIBUTES = new Set([
  'alt',
  'aria-description',
  'aria-label',
  'aria-roledescription',
  'aria-valuetext',
  'description',
  'detail',
  'hint',
  'label',
  'placeholder',
  'title',
  'tooltip'
])

/** Calls whose string arguments are code: imports, class lists, console output. */
const CODE_CALLS = /^(?:console\.\w+|cn|cva|clsx|require|import)$/

/** A string a streamer could read: it has a space, a capitalised word, or "...". */
function readsAsProse(text: string): boolean {
  const trimmed = text.trim()
  if (!/[A-Za-z]/.test(trimmed)) return false
  // A developer invariant names a hook ("useX must be used within…"); no streamer meets it.
  if (/\buse[A-Z]\w*/.test(trimmed)) return false
  return /\s/.test(trimmed) || /^[A-Z][a-z]/.test(trimmed) || trimmed.endsWith('...')
}

/**
 * Copy, not code: JSX text, and every string or template literal that reads as
 * prose. Imports and exports, type literals, property names, class lists,
 * console output and the attributes outside COPY_ATTRIBUTES are code. A thrown
 * error is copy: raw error messages still reach toasts (J2-7).
 */
function copyTexts(path: string, source: string): Array<{ line: number; text: string }> {
  const file = ts.createSourceFile(
    path,
    source,
    ts.ScriptTarget.Latest,
    true,
    path.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  )
  const found: Array<{ line: number; text: string }> = []
  const textOf = (node: ts.Node): string | null => {
    if (ts.isJsxText(node)) return node.text.trim() ? node.text : null
    if (
      !ts.isStringLiteral(node) &&
      !ts.isNoSubstitutionTemplateLiteral(node) &&
      !ts.isTemplateHead(node) &&
      !ts.isTemplateMiddle(node) &&
      !ts.isTemplateTail(node)
    ) {
      return null
    }
    const parent = node.parent
    if (ts.isPropertyAssignment(parent) && parent.name === node) return null
    if (ts.isElementAccessExpression(parent) && parent.argumentExpression === node) return null
    return readsAsProse(node.text) ? node.text : null
  }
  const visit = (node: ts.Node): void => {
    if (
      ts.isImportDeclaration(node) ||
      ts.isExportDeclaration(node) ||
      ts.isImportTypeNode(node) ||
      ts.isLiteralTypeNode(node)
    ) {
      return
    }
    if (ts.isCallExpression(node) && CODE_CALLS.test(node.expression.getText(file))) return
    if (
      ts.isJsxAttribute(node) &&
      node.initializer !== undefined &&
      ts.isStringLiteral(node.initializer) &&
      !COPY_ATTRIBUTES.has(node.name.getText(file))
    ) {
      return
    }
    const text = textOf(node)
    if (text !== null) {
      const { line } = file.getLineAndCharacterOfPosition(node.getStart(file))
      found.push({ line: line + 1, text })
    }
    ts.forEachChild(node, visit)
  }
  visit(file)
  return found
}

/** Each string in `source` that breaks a copy rule, as `path:line [rules] text`. */
function copyRuleOffenders(path: string, source: string): string[] {
  return copyTexts(path, source).flatMap(({ line, text }) => {
    const broken = COPY_RULES.filter(({ pattern }) => pattern.test(text)).map(({ id }) => id)
    return broken.length > 0
      ? [`${path}:${line} [${broken.join(', ')}] ${text.trim().replace(/\s+/g, ' ').slice(0, 100)}`]
      : []
  })
}

/** What breaks the ratchet: a file over its allowance, or an allowance above its file's count. */
function ratchetProblems(
  offenders: ReadonlyMap<string, readonly string[]>,
  ratchet: Readonly<Record<string, number>>
): string[] {
  const problems: string[] = []
  for (const [path, found] of offenders) {
    const allowed = ratchet[path] ?? 0
    if (found.length > allowed) {
      problems.push(
        `${path}: copy-rule offenders ${found.length}, allowance ${allowed}. Rewrite the new ones (docs/ui-copy.md); never raise the allowance.\n  ${found.join('\n  ')}`
      )
    }
  }
  for (const [path, allowed] of Object.entries(ratchet)) {
    const count = offenders.get(path)?.length ?? 0
    if (count < allowed) {
      problems.push(
        `${path}: copy-rule offenders ${count}, allowance ${allowed}. Lower its COPY_RULE_RATCHET count to ${count}${count === 0 ? ' (delete the line)' : ''}.`
      )
    }
  }
  return problems
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

  it('keeps internals, retired names and "..." out of copy, and its ratchet only shrinks', () => {
    const offenders = new Map(
      files.map(({ path, source }) => [path, copyRuleOffenders(path, source)] as const)
    )
    expect(ratchetProblems(offenders, COPY_RULE_RATCHET)).toEqual([])
  })

  it('fails a ratchet that grows, a new file, and an allowance left above the count', () => {
    const offenders = new Map([
      ['src/a.tsx', ['src/a.tsx:1 [backend] Backend is offline.', 'src/a.tsx:2 [...] Wait...']],
      ['src/b.tsx', ['src/b.tsx:4 [OAuth] OAuth failed.']],
      ['src/c.tsx', []]
    ])
    expect(ratchetProblems(offenders, { 'src/a.tsx': 1, 'src/c.tsx': 2, 'src/d.tsx': 1 })).toEqual([
      'src/a.tsx: copy-rule offenders 2, allowance 1. Rewrite the new ones (docs/ui-copy.md); never raise the allowance.\n  src/a.tsx:1 [backend] Backend is offline.\n  src/a.tsx:2 [...] Wait...',
      'src/b.tsx: copy-rule offenders 1, allowance 0. Rewrite the new ones (docs/ui-copy.md); never raise the allowance.\n  src/b.tsx:4 [OAuth] OAuth failed.',
      'src/c.tsx: copy-rule offenders 0, allowance 2. Lower its COPY_RULE_RATCHET count to 0 (delete the line).',
      'src/d.tsx: copy-rule offenders 0, allowance 1. Lower its COPY_RULE_RATCHET count to 0 (delete the line).'
    ])
    expect(ratchetProblems(offenders, { 'src/a.tsx': 2, 'src/b.tsx': 1 })).toEqual([])
  })

  it('reads copy where a streamer meets it, and leaves code alone', () => {
    const source = [
      "import { BackendClient } from '@/lib/backend'",
      "type Phase = 'backend restart' | 'socket closed'",
      "const LABELS = { 'Backend socket': 'Videorc is reconnecting' }",
      "console.warn('Backend socket closed')",
      "const classes = cn('backend socket', 'hover:bg-accent')",
      "void client.request('session.start')",
      "const env = 'VIDEORC_NOTES_WINDOW'",
      "throw new Error('useWorkspaceNav must be used within a provider')",
      'export const a = <div className="backend socket" data-slot="provider row" />',
      "toast.error('Backend socket is not connected.')",
      'throw new Error(`Backend request "${method}" failed`)',
      'export const b = <Input placeholder="Search commands..." />',
      'export const c = <p>Allow it under Customize.</p>',
      'export const d = <Button title="Open Recording">Open Livestream</Button>',
      "export const e = { label: 'X / Twitter', detail: 'Notes are off: VIDEORC_NOTES_WINDOW=0.' }"
    ].join('\n')
    expect(copyRuleOffenders('sample.tsx', source)).toEqual([
      'sample.tsx:10 [backend, socket] Backend socket is not connected.',
      'sample.tsx:11 [backend] Backend request "',
      'sample.tsx:12 [...] Search commands...',
      'sample.tsx:13 [Customize] Allow it under Customize.',
      'sample.tsx:14 [Open Recording] Open Recording',
      'sample.tsx:15 [X / Twitter] X / Twitter',
      'sample.tsx:15 [VIDEORC_] Notes are off: VIDEORC_NOTES_WINDOW=0.'
    ])
  })
})
