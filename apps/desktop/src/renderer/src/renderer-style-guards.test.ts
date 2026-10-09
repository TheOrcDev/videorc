import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

// Plan 050 (D5, D6, S20): the renderer stays on real glass and native feel.
// - No CSS backdrop blur anywhere: it wedged the compositor in June, the OS
//   draws the window glass now, and plan 072 found it never reaches the
//   screen on the vibrancy windows (Chromium's own capture shows the blur,
//   the display does not).
// - No cursor-pointer: desktop controls use the arrow.
// - No colour literals in chrome: colour comes from the tokens in styles.css.
//   The allowlist names the files whose literals are CONTENT (what ends up in
//   the video or a scanner), never chrome.
// - No `data-slot` passed to a component (plan 168 S-01): it belongs to the
//   element that renders it. A shadcn primitive sets its own slot and spreads
//   props after it, so a passed slot replaces it and silently drops every
//   selector keyed on it (the grouped card's row padding, S-00).

const RENDERER_ROOT = join(__dirname, '..')

const COLOUR_LITERAL_ALLOWLIST = new Set([
  // Caption rendering burned into the video, and its previews.
  'src/lib/caption-overlay.ts',
  'src/components/captions/caption-preview.tsx',
  'src/components/captions/captions-controls.tsx',
  'src/components/captions-reader.tsx',
  // The comment highlight overlay drawn onto the stream.
  'src/lib/comment-highlight.ts',
  // The Buddy's comic bubble as it is drawn onto the stream (plan 164 D17):
  // always the light variant, the stream is not themed.
  'src/lib/buddy-overlay.ts',
  // Chroma-key colours are the key itself.
  'src/lib/capture.ts',
  'src/components/tabs/layout-tab.tsx',
  // A QR code must stay black on white for scanners.
  'src/components/phone-remote-section.tsx',
  // The recording-invisibility smoke marker is loud red on purpose.
  'src/components/notes-window.tsx',
  // shadcn chart: selectors that MATCH Recharts' own default strokes
  // ([stroke='#ccc']) to restyle them with tokens; it paints no literal.
  'src/components/ui/chart.tsx'
])

function rendererFiles(): string[] {
  const files: string[] = []
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory)) {
      const path = join(directory, entry)
      if (statSync(path).isDirectory()) {
        if (entry !== 'node_modules') walk(path)
      } else if (/\.(tsx|ts|css|html)$/.test(entry) && !/\.test\.tsx?$/.test(entry)) {
        files.push(path)
      }
    }
  }
  walk(RENDERER_ROOT)
  return files
}

/** Comments may name the banned things to explain why; only code counts. */
function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1')
}

// Forward slashes on every platform, so the allowlist matches on Windows too.
const files = rendererFiles().map((path) => ({
  path: relative(RENDERER_ROOT, path).split(sep).join('/'),
  code: withoutComments(readFileSync(path, 'utf8'))
}))

function offenders(pattern: RegExp, filter: (path: string) => boolean = () => true): string[] {
  const found: string[] = []
  for (const { path, code } of files) {
    if (!filter(path)) continue
    code.split('\n').forEach((line, index) => {
      if (pattern.test(line)) found.push(`${path}:${index + 1}: ${line.trim().slice(0, 120)}`)
    })
  }
  return found
}

/**
 * Every `data-slot` passed to a component (a capitalized JSX tag) in a TSX
 * source, as `path:line: <Tag data-slot=...>`. Parsed, not matched line by
 * line: JSX props wrap, and a prop may hold `=>` or nested JSX.
 */
function passedSlots(path: string, source: string): string[] {
  const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  const found: string[] = []
  const visit = (node: ts.Node): void => {
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      const tag = node.tagName.getText(file)
      for (const attribute of node.attributes.properties) {
        if (
          /^[A-Z]/.test(tag) &&
          ts.isJsxAttribute(attribute) &&
          attribute.name.getText(file) === 'data-slot'
        ) {
          const { line } = file.getLineAndCharacterOfPosition(attribute.getStart(file))
          found.push(`${path}:${line + 1}: <${tag} ${attribute.getText(file)}>`)
        }
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(file)
  return found
}

describe('renderer style guards (plan 050)', () => {
  it('scans the renderer sources', () => {
    expect(files.length).toBeGreaterThan(100)
    expect(files.some(({ path }) => path === 'src/styles.css')).toBe(true)
  })

  it('never uses CSS backdrop blur or filters', () => {
    expect(
      offenders(
        /\bbackdrop-(?:blur|brightness|contrast|grayscale|hue-rotate|invert|opacity|saturate|sepia)\b|backdrop-filter\s*:/
      )
    ).toEqual([])
  })

  it('paints floating surfaces with glass-float, never the popover coat', () => {
    // Plan 072: a fresh shadcn add brings `bg-popover`, which read as a black
    // slab on the window glass. Floating surfaces use `border glass-float`.
    expect(offenders(/\bbg-popover\b/, (path) => /\.(tsx|ts)$/.test(path))).toEqual([])
  })

  it('keeps every toast the same neutral glass: a type colours its icon only', () => {
    // An amber-tinted rim and sheen made a warning toast read as a yellow
    // panel (owner call 2026-09-29). A typed toast rule may set its tone and
    // nothing else; the icon rule is the one place the tone paints.
    const styles = files.find(({ path }) => path === 'src/styles.css')?.code ?? ''
    const typed = [...styles.matchAll(/\[data-sonner-toast\]\[data-type='(\w+)'\]\s*\{([^}]*)\}/g)]
    expect(typed.map(([, type]) => type).sort()).toEqual(['error', 'info', 'success', 'warning'])
    for (const [, type, body] of typed) {
      expect(body.trim(), type).toMatch(/^@apply tone-\w+;$/)
    }
    expect(styles).not.toMatch(
      /glass-float-tinted|--(?:success|error|warning|info)-bg:(?!\s*var\(--glass-float\))/
    )
  })

  it('never uses cursor-pointer: desktop controls use the arrow', () => {
    expect(offenders(/\bcursor-pointer\b|cursor:\s*pointer/)).toEqual([])
  })

  it('keeps colour literals out of the chrome', () => {
    expect(
      offenders(
        /#[0-9a-fA-F]{3,8}(?![0-9a-zA-Z_-])|\brgba?\(|\boklch\(|\bhsla?\(/,
        (path) => /\.(tsx|ts)$/.test(path) && !COLOUR_LITERAL_ALLOWLIST.has(path)
      )
    ).toEqual([])
  })

  it('keeps every allowlisted file real, so the list cannot rot', () => {
    for (const path of COLOUR_LITERAL_ALLOWLIST) {
      expect(files.some((file) => file.path === path)).toBe(true)
    }
  })

  it('never passes data-slot to a component: hooks on components are data-testid', () => {
    // components/ui is shadcn's own: its primitives name their Radix parts.
    const offending = files
      .filter(({ path, code }) => path.endsWith('.tsx') && code.includes('data-slot'))
      .filter(({ path }) => !path.startsWith('src/components/ui/'))
      .flatMap(({ path }) => passedSlots(path, readFileSync(join(RENDERER_ROOT, path), 'utf8')))
    expect(offending).toEqual([])
  })

  it('catches a passed slot however the props wrap, and leaves elements alone', () => {
    // The helper that made Answers and Banter lose their padding (S-00).
    const oldHelper = `
      export function CohostCooldownField({ id }: { id: string }) {
        return (
          <Field
            onClick={() => setDraft((value) => (value > 0 ? value : 1))}
            data-slot={\`\${id}-field\`}
          >
            <div data-slot="cohost-cooldown">x</div>
          </Field>
        )
      }`
    expect(passedSlots('old.tsx', oldHelper)).toEqual([
      'old.tsx:6: <Field data-slot={`${id}-field`}>'
    ])
    expect(passedSlots('ok.tsx', '<FieldGroup variant="grouped" data-testid="x" />')).toEqual([])
    expect(passedSlots('ok.tsx', '<Ui.Alert data-slot="x" />')).toEqual([
      'ok.tsx:1: <Ui.Alert data-slot="x">'
    ])
  })
})
