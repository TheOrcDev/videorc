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
// no three-dot ellipsis in copy. S2.2 to S2.5 brought its offenders to zero,
// so there is no allowlist: a new offender fails.
//
// Plan 174 S2.5 (J2-21, V-X9) adds "Casing": a command's label (a button, a
// menu item, a tab) is sentence case. Only names keep their capitals.

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

/** Controls whose visible text is a command's label. */
const COMMAND_TAGS = new Set([
  'AlertDialogAction',
  'AlertDialogCancel',
  'Button',
  'ContextMenuItem',
  'DropdownMenuItem',
  'InputGroupButton',
  'TabsTrigger',
  'ToggleGroupItem'
])

/**
 * The words a label may capitalize after its first word (docs/ui-copy.md
 * "Casing"): the product, its pages, tabs and windows, the platforms, and the
 * Buddy modes and creator steps that copy names ("Switch to Still").
 */
const CAPITALIZED_NAMES = new Set([
  'Videorc',
  'Premium',
  'Buddy',
  'Live',
  'Go',
  'Stream',
  'Manager',
  'Studio',
  'Sources',
  'Scene',
  'Assets',
  'Livestream',
  'Captions',
  'Output',
  'Library',
  'Settings',
  'Health',
  'Preview',
  'Notes',
  'Setup',
  'Upcoming',
  'Permissions',
  'Shortcuts',
  'Clean',
  'Alive',
  'Still',
  'Auto',
  'Check',
  'YouTube',
  'Twitch',
  'Kick',
  'TikTok',
  'Instagram',
  'Facebook',
  'Google',
  'OBS',
  'Finder',
  'macOS',
  'Windows'
])

/**
 * A command's visible label: its JSX text, with each string an expression child
 * can render ("{busy ? 'Saving…' : 'Save scene…'}") read as its own label. An
 * icon or other element child splits nothing: it is not a word.
 */
function commandLabels(path: string, source: string): Array<{ line: number; text: string }> {
  const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  const found: Array<{ line: number; text: string }> = []
  const literals = (node: ts.Node, into: string[]): void => {
    if (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node) || ts.isCallExpression(node)) {
      return
    }
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      into.push(node.text)
      return
    }
    if (ts.isTemplateExpression(node)) {
      into.push(node.head.text, ...node.templateSpans.map((span) => span.literal.text))
      return
    }
    ts.forEachChild(node, (child) => literals(child, into))
  }
  const visit = (node: ts.Node): void => {
    if (ts.isJsxElement(node) && COMMAND_TAGS.has(node.openingElement.tagName.getText(file))) {
      const labels: string[] = []
      let text = ''
      for (const child of node.children) {
        if (ts.isJsxText(child)) text += child.text
        else if (ts.isJsxExpression(child) && child.expression) literals(child.expression, labels)
      }
      const { line } = file.getLineAndCharacterOfPosition(node.getStart(file))
      for (const label of [text, ...labels]) {
        if (/[a-z]/.test(label))
          found.push({ line: line + 1, text: label.replace(/\s+/g, ' ').trim() })
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(file)
  return found
}

/** The words that make `label` Title Case: capitalized after a part's first word, not a name. */
function titleCaseWords(label: string): string[] {
  return label
    .replace(/“[^”]*”/g, ' ')
    .split(/\s[·:]\s|[:·]\s/)
    .flatMap((part) => part.trim().split(/\s+/).slice(1))
    .map((word) => word.replace(/[^A-Za-z'’-]/g, ''))
    .filter(
      (word) => /^[A-Z][a-z]/.test(word) && !CAPITALIZED_NAMES.has(word.replace(/['’]s$/, ''))
    )
}

/** Each command label in `source` that is Title Case, as `path:line text <words>`. */
function titleCaseOffenders(path: string, source: string): string[] {
  return commandLabels(path, source).flatMap(({ line, text }) => {
    const words = titleCaseWords(text)
    return words.length > 0 ? [`${path}:${line} ${text} <${words.join(', ')}>`] : []
  })
}

// Whole-renderer source scans are CPU-bound: under a parallel full run on a
// laptop they pass vitest's 5 s default (ogre 2026-10-12: 6.9 s; 1.5 s alone).
const SOURCE_SCAN_TIMEOUT = { timeout: 30_000 }

describe('renderer copy guards (plan 174)', SOURCE_SCAN_TIMEOUT, () => {
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

  it('keeps internals, retired names and "..." out of copy', () => {
    const offenders = files.flatMap(({ path, source }) => copyRuleOffenders(path, source))
    expect(offenders).toEqual([])
  })

  it('writes every command label in sentence case', () => {
    const offenders = files
      .filter(({ path }) => path.endsWith('.tsx'))
      .flatMap(({ path, source }) => titleCaseOffenders(path, source))
    expect(offenders).toEqual([])
  })

  it('reads a command label as Title Case only past its names', () => {
    const source = [
      'export const a = <Button><PlusIcon />Import From OBS</Button>',
      'export const b = <Button>Open Stream Manager</Button>',
      "export const c = <Button>{busy ? 'Saving…' : 'New Recording'}</Button>",
      'export const d = <DropdownMenuItem>Go Live…</DropdownMenuItem>',
      'export const e = <Button>Update “{name}”…</Button>',
      'export const f = <TabsTrigger value="a">Schedule · Upcoming events</TabsTrigger>',
      'export const g = <span>Enable Camera</span>',
      "export const h = <Button>{label ?? 'Show Capture Helper'}</Button>"
    ].join('\n')
    expect(titleCaseOffenders('sample.tsx', source)).toEqual([
      'sample.tsx:1 Import From OBS <From>',
      'sample.tsx:3 New Recording <Recording>',
      'sample.tsx:8 Show Capture Helper <Capture, Helper>'
    ])
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
