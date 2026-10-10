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
// - Every control has a name a screen reader can read (plan 174 S0.5): a
//   control in a Field is named by its FieldLabel or names itself, a
//   SelectTrigger or Slider outside one names itself, a FieldLabel never
//   points `htmlFor` at a group no label element can name, and no Switch
//   sits inside a button.

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

// Plan 174 S0.5. A label element names these through `htmlFor`; the Field
// gives each an id and points its FieldLabel at the first (field-context.ts).
const LABELABLE_CONTROLS = new Set([
  'Input',
  'Textarea',
  'SelectTrigger',
  'Switch',
  'Checkbox',
  'InputGroupInput',
  'InputGroupTextarea'
])
// No label element can name these (a group, a slider thumb): inside a Field
// they take the FieldLabel through `aria-labelledby`.
const LABELLED_BY_CONTROLS = new Set(['ToggleGroup', 'TabsList', 'Slider'])
const LABEL_TAGS = new Set(['FieldLabel', 'Label', 'label'])

/** A JSX element's tag and its attributes as source text (`true` when bare). */
function jsxParts(
  file: ts.SourceFile,
  node: ts.Node
): { tag: string; attributes: Map<string, string> } | null {
  const opening = ts.isJsxElement(node)
    ? node.openingElement
    : ts.isJsxSelfClosingElement(node)
      ? node
      : null
  if (!opening) return null
  const attributes = new Map<string, string>()
  for (const attribute of opening.attributes.properties) {
    if (!ts.isJsxAttribute(attribute)) continue
    const value = attribute.initializer
    attributes.set(
      attribute.name.getText(file),
      !value
        ? 'true'
        : ts.isStringLiteral(value)
          ? value.text
          : ts.isJsxExpression(value)
            ? (value.expression?.getText(file) ?? '')
            : value.getText(file)
    )
  }
  return { tag: opening.tagName.getText(file), attributes }
}

const namesItself = (attributes: Map<string, string>): boolean =>
  attributes.has('aria-label') || attributes.has('aria-labelledby')

/**
 * Every control in a TSX source a screen reader cannot name, as
 * `path:line: why` (plan 174 S0.5: J1-1, B-2, E-3, E-26, F-15, G-8, D-12).
 * Parsed like `passedSlots`, so a Switch passed in a prop still counts.
 */
function unnamedControls(path: string, source: string): string[] {
  const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  const found: string[] = []
  const report = (node: ts.Node, why: string): void => {
    const { line } = file.getLineAndCharacterOfPosition(node.getStart(file))
    found.push(`${path}:${line + 1}: ${why}`)
  }

  // A Field names its first labelable control and every group in it; any
  // other control names itself or has a FieldLabel `htmlFor` its id.
  const checkField = (field: ts.Node): void => {
    const labels: { node: ts.Node; htmlFor?: string }[] = []
    const controls: {
      node: ts.Node
      tag: string
      attributes: Map<string, string>
      inLabel: boolean
    }[] = []
    const collect = (node: ts.Node, inLabel: boolean): void => {
      const parts = node === field ? null : jsxParts(file, node)
      if (parts?.tag === 'Field') return // a nested Field names its own
      if (parts?.tag === 'FieldLabel') {
        labels.push({ node, htmlFor: parts.attributes.get('htmlFor') })
      }
      if (parts && (LABELABLE_CONTROLS.has(parts.tag) || LABELLED_BY_CONTROLS.has(parts.tag))) {
        controls.push({ node, ...parts, inLabel })
      }
      const wraps = inLabel || (parts !== null && LABEL_TAGS.has(parts.tag))
      ts.forEachChild(node, (child) => collect(child, wraps))
    }
    collect(field, false)
    const first = controls.find(({ tag }) => LABELABLE_CONTROLS.has(tag))
    for (const control of controls) {
      const id = control.attributes.get('id')
      const named =
        namesItself(control.attributes) ||
        control.inLabel ||
        (LABELABLE_CONTROLS.has(control.tag)
          ? labels.some(({ htmlFor }) => htmlFor !== undefined && htmlFor === id) ||
            (control === first && labels.some(({ htmlFor }) => htmlFor === undefined))
          : labels.length > 0)
      if (!named) report(control.node, `<${control.tag}> in a Field that does not name it`)
    }
    for (const label of labels) {
      const group = controls.find(
        ({ tag, attributes }) =>
          LABELLED_BY_CONTROLS.has(tag) &&
          label.htmlFor !== undefined &&
          attributes.get('id') === label.htmlFor
      )
      if (group) report(label.node, `FieldLabel htmlFor points at a <${group.tag}>`)
    }
  }

  const visit = (node: ts.Node, inField: boolean, inLabel: boolean, inButton: boolean): void => {
    const parts = jsxParts(file, node)
    if (parts) {
      const { tag, attributes } = parts
      if (tag === 'Field') checkField(node)
      const ownName = namesItself(attributes) || (tag === 'SelectTrigger' && attributes.has('id'))
      if ((tag === 'SelectTrigger' || tag === 'Slider') && !inField && !inLabel && !ownName) {
        report(node, `<${tag}> has no name`)
      }
      if (tag === 'Switch' && inButton) report(node, 'a Switch inside a button')
      inField ||= tag === 'Field'
      inLabel ||= LABEL_TAGS.has(tag)
      inButton ||= tag === 'button' || tag === 'Button' || attributes.get('role') === 'button'
    }
    ts.forEachChild(node, (child) => visit(child, inField, inLabel, inButton))
  }
  visit(file, false, false, false)
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

/**
 * Every DialogContent or AlertDialogContent whose className sets its own
 * width or height, as `path:line: <Tag className=...>` (plan 174 S1.6b,
 * J1-20): a dialog takes `size`, and DialogBody scrolls.
 */
function handSizedDialogs(path: string, source: string): string[] {
  const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  const found: string[] = []
  const visit = (node: ts.Node): void => {
    const parts = jsxParts(file, node)
    if (parts && (parts.tag === 'DialogContent' || parts.tag === 'AlertDialogContent')) {
      const className = parts.attributes.get('className') ?? ''
      if (/(?:^|[\s'"`:])max-[wh]-/.test(className)) {
        const { line } = file.getLineAndCharacterOfPosition(node.getStart(file))
        found.push(`${path}:${line + 1}: <${parts.tag} className=${className}>`)
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(file)
  return found
}

describe('dialog anatomy (plan 174 S1.6b)', () => {
  it('sizes every dialog with `size`, never a hand-set max width or height', () => {
    const offending = files
      .filter(({ path, code }) => path.endsWith('.tsx') && /DialogContent\b/.test(code))
      .flatMap(({ path }) =>
        handSizedDialogs(path, readFileSync(join(RENDERER_ROOT, path), 'utf8'))
      )
    expect(offending).toEqual([])
  })

  it('catches a hand-sized dialog however the props wrap', () => {
    const oldObsDialog =
      '<DialogContent\n  className="sm:max-w-xl"\n  onKeyDown={() => {}}\n>x</DialogContent>'
    expect(handSizedDialogs('obs.tsx', oldObsDialog)).toEqual([
      'obs.tsx:1: <DialogContent className=sm:max-w-xl>'
    ])
    expect(handSizedDialogs('ok.tsx', '<DialogContent size="lg" className="gap-4" />')).toEqual([])
  })
})

describe('renderer accessible names (plan 174 S0.5)', () => {
  const withControls = files.filter(
    ({ path, code }) =>
      path.endsWith('.tsx') && /\b(?:Field|SelectTrigger|Slider|Switch)\b/.test(code)
  )
  const controlOffenders = withControls.flatMap(({ path }) =>
    unnamedControls(path, readFileSync(join(RENDERER_ROOT, path), 'utf8'))
  )

  it('names every SelectTrigger and Slider outside a Field: an id, aria-label or aria-labelledby', () => {
    expect(withControls.length).toBeGreaterThan(50)
    // E-26: the Library filter was a bare select; B-2: so was the Inspector's Output.
    expect(controlOffenders.filter((line) => line.endsWith('has no name'))).toEqual([])
  })

  it('names every control a Field holds through its FieldLabel, unless it names itself', () => {
    // J1-1: fifteen Fields never tied their label to the control; F-15: a
    // label's htmlFor pointed at a ToggleGroup, which no label element names.
    expect(
      controlOffenders.filter((line) => / in a Field that | FieldLabel htmlFor /.test(line))
    ).toEqual([])
  })

  it('never nests a Switch inside a button or a role="button" row', () => {
    // G-8, D-12: the greeting and destination rows were buttons around their switches.
    expect(controlOffenders.filter((line) => line.endsWith('a Switch inside a button'))).toEqual([])
  })

  it('catches unnamed controls however the props wrap, and leaves named ones alone', () => {
    const oldGreetingRow = [
      '<ListRow',
      '  meta={<Switch aria-label="Follow greeting on" checked />}',
      '  role="button"',
      '  title="Follow"',
      '/>'
    ].join('\n')
    expect(unnamedControls('greeting.tsx', oldGreetingRow)).toEqual([
      'greeting.tsx:2: a Switch inside a button'
    ])
    const oldTone = [
      '<Field>',
      '  <FieldLabel htmlFor="cohost-tone">Reply tone</FieldLabel>',
      '  <ToggleGroup id="cohost-tone" type="single" />',
      '</Field>'
    ].join('\n')
    expect(unnamedControls('tone.tsx', oldTone)).toEqual([
      'tone.tsx:2: FieldLabel htmlFor points at a <ToggleGroup>'
    ])
    const oldCategory = [
      '<Field>',
      '  <FieldLabel htmlFor="kick-category">Category</FieldLabel>',
      '  <Input id="kick-category" />',
      '  <SelectTrigger className="w-full" />',
      '</Field>'
    ].join('\n')
    expect(unnamedControls('category.tsx', oldCategory)).toEqual([
      'category.tsx:4: <SelectTrigger> in a Field that does not name it'
    ])
    expect(unnamedControls('filter.tsx', '<SelectTrigger className="w-40" />')).toEqual([
      'filter.tsx:1: <SelectTrigger> has no name'
    ])
    expect(unnamedControls('player.tsx', '<Slider max={10} />')).toEqual([
      'player.tsx:1: <Slider> has no name'
    ])
    const named = [
      '<>',
      '  <Field><FieldLabel>Theme</FieldLabel><ToggleGroup type="single" /></Field>',
      '  <Field><FieldLabel>Default privacy</FieldLabel><SelectTrigger /></Field>',
      '  <Field><FieldLabel htmlFor="title">Title</FieldLabel><Input id="title" /></Field>',
      '  <Field><FieldLabel>Motion</FieldLabel><Slider max={1} /></Field>',
      '  <SelectTrigger aria-label="Filter" />',
      '  <SelectTrigger id="schedule-privacy" />',
      '  <Slider aria-label="Playhead" />',
      '  <Label>Fit<SelectTrigger /></Label>',
      '  <ListRow meta={<Switch aria-label="On" />} title={<ListRowButton>Follow</ListRowButton>} />',
      '</>'
    ].join('\n')
    expect(unnamedControls('named.tsx', named)).toEqual([])
  })
})
