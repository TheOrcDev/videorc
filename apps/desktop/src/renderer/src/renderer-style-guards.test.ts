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
// - No hand-rolled gradient on a screen, and the chrome materials only on the
//   primitives (plan 208 S4): the shine is the controls', never a screen's.

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
  'src/components/ui/chart.tsx',
  // audiocn's LCD (plan 196): the screen's bezel and glass are the
  // instrument's own materials, and the hardware inks are choices Videorc
  // never makes. Videorc draws the ink in --primary (MicLevelMeter).
  'src/components/ui/lcd-display.tsx'
])

// Plan 208 S4 (D2): the shine lives on the controls. The chrome materials are
// defined once in styles.css and worn by the primitives in components/ui (and
// the two primitives outside it: the sidebar's page row and MediaCard). A
// screen never rolls its own gradient, so the shine can't spread screen by
// screen. Each exception draws a picture or stream content, never chrome.
const HAND_ROLLED_GRADIENT =
  /\bbg-(?:linear|radial|conic|gradient)-|\b(?:linear|radial|conic)-gradient\(/
const GRADIENT_ALLOWLIST = new Set([
  // A scrim under a picture's name, over the picture itself.
  'src/components/live-backgrounds-group.tsx',
  'src/components/background-replace-dialog.tsx',
  'src/components/tabs/assets-tab.tsx',
  // The checkerboard behind a banner's transparent pixels.
  'src/components/banner-thumbnail.tsx',
  // The blank picture a scene thumbnail shows before its first frame.
  'src/components/studio/scenes-gallery.tsx',
  // The level meter's zones (healthy, hot, clipping) as one gradient.
  'src/components/studio/mic-level-meter.tsx',
  // Caption style previews: stand-ins for the stream behind a caption.
  'src/components/captions/caption-preview.tsx'
])
const CHROME_MATERIAL = /\bchrome-(?:fill|plate|bead|bead-ink|led|row-live|row-member)\b/
const CHROME_PRIMITIVES_OUTSIDE_UI = new Set([
  'src/components/sidebar.tsx',
  'src/components/media-card.tsx'
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
const LABELLED_BY_CONTROLS = new Set(['ToggleGroup', 'TabsList', 'SegmentedControl', 'Slider'])
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
      if (
        (tag === 'SelectTrigger' || tag === 'Slider' || tag === 'SegmentedControl') &&
        !inField &&
        !inLabel &&
        !ownName
      ) {
        report(node, `<${tag}> has no name`)
      }
      if (tag === 'Switch' && inButton) report(node, 'a Switch inside a button')
      // A SettingsRow is a Field whose `label` prop is its FieldLabel (S3.17).
      inField ||= tag === 'Field' || tag === 'SettingsRow'
      inLabel ||= LABEL_TAGS.has(tag)
      inButton ||= tag === 'button' || tag === 'Button' || attributes.get('role') === 'button'
    }
    ts.forEachChild(node, (child) => visit(child, inField, inLabel, inButton))
  }
  visit(file, false, false, false)
  return found
}

// Whole-renderer source scans are CPU-bound: under a parallel full run on a
// laptop they pass vitest's 5 s default (ogre 2026-10-12: 6.9 s; 1.5 s alone).
const SOURCE_SCAN_TIMEOUT = { timeout: 30_000 }

describe('renderer style guards (plan 050)', SOURCE_SCAN_TIMEOUT, () => {
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

  it('paints no chrome ground under the windows: nothing imports its stills (owner, 2026-10-29)', () => {
    // The owner took the Liquid Chrome still out from under every window. Only
    // the phone remote serves it now, from the backend.
    expect(offenders(/chrome-ground-(?:dark|light)\.webp/)).toEqual([])
  })

  it('keeps hand-rolled gradients out of the screens: the shine is the primitives (plan 208 S4)', () => {
    const screens = (path: string): boolean =>
      path !== 'src/styles.css' && !path.startsWith('src/components/ui/')
    expect(
      offenders(HAND_ROLLED_GRADIENT, (path) => screens(path) && !GRADIENT_ALLOWLIST.has(path))
    ).toEqual([])
    // Each exception still draws its gradient, so the list cannot rot.
    for (const path of GRADIENT_ALLOWLIST) {
      expect(
        offenders(HAND_ROLLED_GRADIENT, (candidate) => candidate === path),
        path
      ).not.toEqual([])
    }
    expect(HAND_ROLLED_GRADIENT.test("'bg-linear-to-b from-foreground/10'")).toBe(true)
    expect(HAND_ROLLED_GRADIENT.test("'bg-gradient-to-t from-background/95'")).toBe(true)
    expect(HAND_ROLLED_GRADIENT.test("'bg-[radial-gradient(circle,white,black)]'")).toBe(true)
    expect(HAND_ROLLED_GRADIENT.test('`linear-gradient(to right, ${stops})`')).toBe(true)
    expect(HAND_ROLLED_GRADIENT.test("'chrome-fill border-0'")).toBe(false)
  })

  it('wears the chrome materials only in the primitives (plan 208 S4)', () => {
    expect(
      offenders(
        CHROME_MATERIAL,
        (path) =>
          /\.(tsx|ts)$/.test(path) &&
          !path.startsWith('src/components/ui/') &&
          !CHROME_PRIMITIVES_OUTSIDE_UI.has(path)
      )
    ).toEqual([])
    for (const path of CHROME_PRIMITIVES_OUTSIDE_UI) {
      expect(
        offenders(CHROME_MATERIAL, (candidate) => candidate === path),
        path
      ).not.toEqual([])
    }
    // The chrome rows (plan 0011) are materials too: screens take them from
    // components/ui/chrome-row.ts.
    expect(CHROME_MATERIAL.test("'chrome-row-member'")).toBe(true)
    expect(CHROME_MATERIAL.test("'chrome-row-live'")).toBe(true)
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

// Plan 174 S1.8 (J1-5, D-35, I-26, C-19): status copy is monochrome. A tone
// colours an icon, a dot, a chip or an Alert row, never words. The shadcn
// primitives in components/ui own their variants (a destructive menu item,
// an invalid field, FieldError until it is restyled).
const TONE_TEXT = /(?:^|[\s'"`:])text-(?:warning|success|destructive|live|info)(?![\w-])/

/**
 * Every class string in a TSX source that colours text with a status tone,
 * as `path:line: classes`, unless it sits on an icon (a JSX tag ending in
 * Icon, an svg, or an icon-named prop, property or variable) or targets svg
 * children. Parsed, so a className on its own line still counts.
 */
function toneTextOffenders(path: string, source: string): string[] {
  const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  const found: string[] = []
  const onIcon = (node: ts.Node): boolean => {
    for (let parent = node.parent; parent; parent = parent.parent) {
      if (ts.isJsxOpeningElement(parent) || ts.isJsxSelfClosingElement(parent)) {
        const tag = parent.tagName.getText(file)
        return /Icon$/.test(tag) || tag === 'svg'
      }
      if (
        (ts.isPropertyAssignment(parent) ||
          ts.isVariableDeclaration(parent) ||
          ts.isJsxAttribute(parent)) &&
        /icon/i.test(parent.name.getText(file))
      ) {
        return true
      }
    }
    return false
  }
  const visit = (node: ts.Node): void => {
    if (
      ts.isStringLiteralLike(node) ||
      ts.isTemplateHead(node) ||
      ts.isTemplateMiddle(node) ||
      ts.isTemplateTail(node)
    ) {
      const toned = node.text
        .split(/\s+/)
        .filter((token) => TONE_TEXT.test(` ${token}`) && !/svg\]/.test(token))
      if (toned.length > 0 && !onIcon(node)) {
        const { line } = file.getLineAndCharacterOfPosition(node.getStart(file))
        found.push(`${path}:${line + 1}: ${toned.join(' ')}`)
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(file)
  return found
}

describe('status colour discipline (plan 174 S1.8)', SOURCE_SCAN_TIMEOUT, () => {
  it('never colours status words: the tone rides on an icon, a dot, a chip or an Alert', () => {
    const offending = files
      .filter(({ path }) => path.endsWith('.tsx') && !path.startsWith('src/components/ui/'))
      .flatMap(({ path }) =>
        toneTextOffenders(path, readFileSync(join(RENDERER_ROOT, path), 'utf8'))
      )
    expect(offending).toEqual([])
  })

  it('catches coloured words however the props wrap, and leaves icons alone', () => {
    const oldFolderWarning = [
      '<p className="flex items-center gap-1.5 text-xs text-warning">',
      '  <WarningIcon className="size-3.5 shrink-0" />',
      '  This folder is not writable.',
      '</p>'
    ].join('\n')
    expect(toneTextOffenders('folder.tsx', oldFolderWarning)).toEqual([
      'folder.tsx:1: text-warning'
    ])
    const oldCounter =
      "<span className={cn('text-xs', over ? 'text-destructive' : 'text-subtle')} />"
    expect(toneTextOffenders('counter.tsx', oldCounter)).toEqual([
      'counter.tsx:1: text-destructive'
    ])
    const icons = [
      '<>',
      '  <WarningIcon',
      '    className="size-4 shrink-0 text-warning"',
      '  />',
      "  <MicrophoneIcon className={cn('size-3.5', on ? 'text-success' : 'text-muted-foreground')} />",
      '  <Alert className="*:[svg]:text-destructive" />',
      '  <span className="text-warning-foreground" />',
      '</>'
    ].join('\n')
    expect(toneTextOffenders('icons.tsx', icons)).toEqual([])
    expect(
      toneTextOffenders('meta.tsx', "const META = { ok: { iconClassName: 'text-success' } }")
    ).toEqual([])
  })

  it('sets no text below 11 px in the chrome (F-14, H-17)', () => {
    // Not words: the caption preview draws the burned-in caption at the
    // stage's scale (content).
    const CONTENT = new Set(['src/components/captions/captions-controls.tsx'])
    expect(
      offenders(
        /\btext-\[(?:[0-9]|10)(?:\.\d+)?px\]/,
        (path) => /\.(tsx|ts)$/.test(path) && !CONTENT.has(path)
      )
    ).toEqual([])
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

describe('dialog anatomy (plan 174 S1.6b)', SOURCE_SCAN_TIMEOUT, () => {
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

describe('renderer accessible names (plan 174 S0.5)', SOURCE_SCAN_TIMEOUT, () => {
  const withControls = files.filter(
    ({ path, code }) =>
      path.endsWith('.tsx') &&
      /\b(?:Field|SelectTrigger|Slider|Switch|SegmentedControl)\b/.test(code)
  )
  const controlOffenders = withControls.flatMap(({ path }) =>
    unnamedControls(path, readFileSync(join(RENDERER_ROOT, path), 'utf8'))
  )

  it('names every SelectTrigger, Slider and SegmentedControl outside a Field: an id, aria-label or aria-labelledby', () => {
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
    // Plan 174 S1.7: a segmented control is named like any other group.
    expect(unnamedControls('remote.tsx', '<SegmentedControl options={networks} />')).toEqual([
      'remote.tsx:1: <SegmentedControl> has no name'
    ])
    const named = [
      '<>',
      '  <Field><FieldLabel>Theme</FieldLabel><ToggleGroup type="single" /></Field>',
      '  <Field><FieldLabel>Default privacy</FieldLabel><SelectTrigger /></Field>',
      '  <Field><FieldLabel htmlFor="title">Title</FieldLabel><Input id="title" /></Field>',
      '  <Field><FieldLabel>Motion</FieldLabel><Slider max={1} /></Field>',
      '  <Field><FieldLabel>Fit</FieldLabel><SegmentedControl options={fits} /></Field>',
      '  <SettingsRow label="Theme"><SegmentedControl options={themes} /></SettingsRow>',
      '  <SegmentedControl aria-label="Network" options={networks} />',
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

// Plan 174 S4.1 (J1-11, J1-12, J1-24): the guardrails earlier slices relied
// on, consolidated. Each allowlist names files, with the reason, and stays
// short: a list that grows past about 20 means the rule is wrong.

const NATIVE_TITLE_TAGS = new Set(['Button', 'button', 'ToggleGroupItem', 'Badge'])

/**
 * A control's job, said through `title=`, as `path:line: <Tag title>` (S1.10):
 * a native title never shows on a disabled control, never on keyboard focus,
 * and repeats the name to a screen reader. A Tooltip says it.
 */
function nativeTitles(path: string, source: string): string[] {
  const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  const found: string[] = []
  const visit = (node: ts.Node): void => {
    const parts = jsxParts(file, node)
    if (parts && NATIVE_TITLE_TAGS.has(parts.tag) && parts.attributes.has('title')) {
      const { line } = file.getLineAndCharacterOfPosition(node.getStart(file))
      found.push(`${path}:${line + 1}: <${parts.tag} title>`)
    }
    ts.forEachChild(node, visit)
  }
  visit(file)
  return found
}

/**
 * Every `aria-pressed` set inside a `.map()` callback, as `path:line:
 * <Tag aria-pressed>`: a list of pressed buttons is a choice built by hand.
 * One of 2–4 is a SegmentedControl, filters are a ToggleGroup (S1.7, D13).
 */
function pressedButtonGroups(path: string, source: string): string[] {
  const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  const found: string[] = []
  const visit = (node: ts.Node, inMap: boolean): void => {
    const parts = jsxParts(file, node)
    // LcdPanelPressRow is a pressed button too: it sets aria-pressed inside (plan 197).
    const pressed =
      parts && (parts.attributes.has('aria-pressed') || parts.tag === 'LcdPanelPressRow')
    if (parts && inMap && pressed) {
      const { line } = file.getLineAndCharacterOfPosition(node.getStart(file))
      found.push(`${path}:${line + 1}: <${parts.tag} aria-pressed>`)
    }
    const mapCall =
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.getText(file) === 'map'
    ts.forEachChild(node, (child) => visit(child, inMap || mapCall))
  }
  visit(file, false)
  return found
}

const COMPACT_SIZED_TAGS = new Set([
  'Button',
  'Toggle',
  'ToggleGroup',
  'ToggleGroupItem',
  'SelectTrigger',
  'Badge'
])

/**
 * A control's height set at the call site, as `path:line: <Tag className>`:
 * 28 px is the default and `xs` (24 px) the one compact size (J1-11).
 */
function handSizedControls(path: string, source: string): string[] {
  const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  const found: string[] = []
  const visit = (node: ts.Node): void => {
    const parts = jsxParts(file, node)
    if (parts && COMPACT_SIZED_TAGS.has(parts.tag)) {
      const className = parts.attributes.get('className') ?? ''
      if (/(?:^|[\s'"`])(?:min-)?(?:h|size)-(?:\d|\[|control)/.test(className)) {
        const { line } = file.getLineAndCharacterOfPosition(node.getStart(file))
        found.push(`${path}:${line + 1}: <${parts.tag} className=${className}>`)
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(file)
  return found
}

/** Radii off the tiers: Tailwind's size scale and arbitrary values. */
const OFF_TIER_RADIUS =
  /\brounded(?:-[trblse]{1,2})?-(?:xs|sm|md|xl|2xl|3xl|4xl|\[(?!inherit\])[^\]]+\])(?![\w-])/
/** The popup tier (10 px, `rounded-lg`): menus, selects, popovers, chart tooltips. */
const POPUP_RADIUS = /\brounded(?:-[trblse]{1,2})?-lg(?![\w-])/

const POPUP_TIER_FILES = new Set([
  'src/components/ui/dropdown-menu.tsx',
  'src/components/ui/context-menu.tsx',
  'src/components/ui/select.tsx',
  'src/components/ui/popover.tsx',
  'src/components/ui/hover-card.tsx',
  'src/components/ui/chart.tsx',
  // audiocn (plan 092): its channel chips and slider well keep the kit's look.
  'src/components/ui/channel-toggle.tsx',
  'src/components/ui/parameter-slider.tsx',
  // audiocn (plan 196): the LCD's bezel, 10 px like a row.
  'src/components/ui/lcd-display.tsx'
])

const OFF_TIER_RADIUS_ALLOWLIST = new Set([
  // Content, not chrome: the caption preview draws the burned-in caption's
  // box at the stage's scale, and the scene thumbnails draw each layout's
  // sources in miniature.
  'src/components/captions/captions-controls.tsx',
  'src/components/studio/scenes-gallery.tsx',
  // Word marks hug the transcript's text, smaller than any control.
  'src/components/clean-cut/clean-cut-transcript.tsx',
  // shadcn: the chart legend's 2 px swatches and the 16 px checkbox's corner.
  'src/components/ui/chart.tsx',
  'src/components/ui/checkbox.tsx',
  // audiocn (plan 092): the mixer's dashed empty well.
  'src/components/ui/mixer.tsx',
  // audiocn (plan 189): the pad root's `rounded-xl`; Videorc passes
  // `rounded-row` from outside (docs/audiocn.md), so no pad shows it.
  'src/components/ui/sound-pad.tsx',
  // audiocn (plan 196): the LCD's screen, its select and the CLIP flag.
  'src/components/ui/lcd-display.tsx',
  'src/components/ui/lcd-meter.tsx'
])

describe('guardrails consolidated (plan 174 S4.1)', SOURCE_SCAN_TIMEOUT, () => {
  const tsx = files.filter(({ path }) => path.endsWith('.tsx'))
  const parsed = (check: (path: string, source: string) => string[]): string[] =>
    tsx.flatMap(({ path }) => check(path, readFileSync(join(RENDERER_ROOT, path), 'utf8')))

  it('never puts a native title on a Button, button, ToggleGroupItem or Badge (S1.10)', () => {
    expect(parsed(nativeTitles)).toEqual([])
  })

  it('never hand-rolls a choice from pressed buttons in a list (S1.7)', () => {
    // The Studio's takeovers: any number of them, one on at a time, each a
    // button (or, with Retro LCD, a row on the Takeover screen; plan 197)
    // with its own disabled reason. A ToggleGroup would need the reasons
    // rebuilt; a follow-up, not a mechanical swap.
    const allowed = [
      'src/components/studio/session-panel.tsx',
      'src/components/studio/retro-lcd-studio.tsx'
    ]
    const found = parsed(pressedButtonGroups)
    expect(found.filter((line) => !allowed.some((path) => line.startsWith(`${path}:`)))).toEqual([])
    // Each exception stays real, so it cannot outlive its reason.
    for (const path of allowed) {
      expect(
        found.some((line) => line.startsWith(`${path}:`)),
        path
      ).toBe(true)
    }
  })

  it('sizes controls in components/ui, never per call site (J1-11)', () => {
    // A borderless text link that wraps: its height is the text's.
    const ALLOWED = new Set(['src/components/streaming/go-live-panel.tsx'])
    expect(parsed(handSizedControls).filter((line) => !ALLOWED.has(line.split(':')[0]))).toEqual([])
  })

  it('keeps radii on the tiers: panel, row, chip, tag, full, and popup for floating surfaces', () => {
    const tiers = (path: string): boolean => /\.(tsx|ts)$/.test(path)
    expect(
      offenders(OFF_TIER_RADIUS, (path) => tiers(path) && !OFF_TIER_RADIUS_ALLOWLIST.has(path))
    ).toEqual([])
    expect(offenders(POPUP_RADIUS, (path) => tiers(path) && !POPUP_TIER_FILES.has(path))).toEqual(
      []
    )
    for (const path of [...OFF_TIER_RADIUS_ALLOWLIST, ...POPUP_TIER_FILES]) {
      expect(
        files.some((file) => file.path === path),
        path
      ).toBe(true)
    }
  })

  it('never sets cursor-not-allowed: a disabled control takes no pointer events (J1-24)', () => {
    expect(offenders(/\bcursor-not-allowed\b/)).toEqual([])
  })

  it('catches each rule however the props wrap, and leaves the allowed forms alone', () => {
    expect(
      nativeTitles('theme.tsx', '<Button\n  size="icon"\n  title="Switch theme (D)"\n/>')
    ).toEqual(['theme.tsx:1: <Button title>'])
    expect(nativeTitles('row.tsx', '<ListRow title="Follow" />')).toEqual([])
    const fits = [
      '<div role="group">',
      '  {FITS.map((fit) => (',
      '    <Button aria-pressed={value === fit} key={fit} />',
      '  ))}',
      '</div>'
    ].join('\n')
    expect(pressedButtonGroups('fit.tsx', fits)).toEqual(['fit.tsx:3: <Button aria-pressed>'])
    expect(pressedButtonGroups('pin.tsx', '<Button aria-pressed={pinned} />')).toEqual([])
    expect(
      handSizedControls('chat.tsx', "<Button className={cn('h-7 shrink-0 px-2', NARROW)} />")
    ).toEqual(["chat.tsx:1: <Button className=cn('h-7 shrink-0 px-2', NARROW)>"])
    expect(handSizedControls('ok.tsx', '<Button className="w-full" size="xs" />')).toEqual([])
    expect(OFF_TIER_RADIUS.test("'rounded-md border px-2'")).toBe(true)
    expect(OFF_TIER_RADIUS.test("'rounded-[5px]'")).toBe(true)
    expect(OFF_TIER_RADIUS.test("'rounded-t-xl'")).toBe(true)
    expect(OFF_TIER_RADIUS.test("'rounded-row rounded-[inherit] rounded-full'")).toBe(false)
    expect(POPUP_RADIUS.test("'rounded-lg border glass-float'")).toBe(true)
  })
})
