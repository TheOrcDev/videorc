import { readFileSync } from 'node:fs'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { StatusBadge, type StatusTone } from './status-badge'
import { StatusDot } from './status-dot'
import { Badge } from './ui/badge'
import { Kbd } from './ui/kbd'

// Plan 050, D9: every badge, status pill, tag, and key chip is glass. Colour
// is information: it lives in the dot or the tint, never in status text.

const styles = readFileSync(new URL('../styles.css', import.meta.url), 'utf8')

type BadgeVariant =
  | 'default'
  | 'outline'
  | 'success'
  | 'warning'
  | 'neutral'
  | 'destructive'
  | 'live'

const badge = (variant: BadgeVariant): string =>
  renderToStaticMarkup(createElement(Badge, { variant }, 'Ready'))

const classOf = (markup: string): string[] => /class="([^"]*)"/.exec(markup)?.[1].split(' ') ?? []

const TONE_TEXT = /(^|\s)(text-success|text-warning|text-destructive|text-live)(\s|$)/

describe('Badge glass chips', () => {
  it('maps default to neutral glass with primary text', () => {
    const classes = classOf(badge('default'))
    expect(classes).toContain('glass-chip')
    expect(classes).toContain('text-foreground')
    expect(classes).not.toContain('bg-primary')
  })

  it('maps outline to a tag: the same glass, secondary text, 20 px, 7 px radius', () => {
    const classes = classOf(badge('outline'))
    expect(classes).toContain('glass-chip')
    expect(classes).toContain('text-muted-foreground')
    expect(classes).toContain('h-5')
    expect(classes).toContain('rounded-tag')
    expect(classes).toContain('text-[11px]')
  })

  it('gives status variants a toned dot and monochrome text', () => {
    for (const [variant, tone] of [
      ['success', 'tone-success'],
      ['warning', 'tone-warning'],
      ['neutral', 'tone-neutral']
    ] as const) {
      const markup = badge(variant)
      const classes = classOf(markup)
      expect(classes).toContain('glass-chip')
      expect(classes).toContain(tone)
      expect(classes).toContain('before:glass-dot')
      // A leading icon carries the tone instead of the dot.
      expect(classes).toContain('has-data-[icon=inline-start]:before:hidden')
      expect(markup).not.toMatch(TONE_TEXT)
    }
  })

  it('tints the glass for emphasis: failed and on air', () => {
    for (const [variant, tone] of [
      ['destructive', 'tone-destructive'],
      ['live', 'tone-live']
    ] as const) {
      const classes = classOf(badge(variant))
      expect(classes).toContain('glass-chip-tinted')
      expect(classes).toContain(tone)
      expect(classes).not.toContain('before:glass-dot')
    }
  })

  it('never moves', () => {
    for (const variant of ['default', 'outline', 'success', 'destructive'] as const) {
      expect(badge(variant)).not.toMatch(/transition|animate-/)
    }
  })
})

describe('StatusBadge', () => {
  const render = (tone: StatusTone, label?: string): string =>
    renderToStaticMarkup(createElement(StatusBadge, { tone, value: 'Ready', label }))

  it('is a 22 px round glass pill with a glowing tone dot', () => {
    const markup = render('good', 'Camera')
    const classes = classOf(markup)
    expect(classes).toContain('h-[22px]')
    expect(classes).toContain('rounded-full')
    expect(classes).toContain('glass-chip')
    expect(classes).toContain('tone-success')
    expect(markup).toContain('glass-dot')
    expect(markup).toContain('data-tone="good"')
  })

  it('keeps the label secondary and the value primary for every status tone', () => {
    for (const tone of ['good', 'warn', 'neutral'] as const) {
      const markup = render(tone, 'Camera')
      expect(markup).toContain('text-foreground')
      expect(markup).toContain('text-muted-foreground')
      expect(markup).not.toMatch(TONE_TEXT)
    }
  })

  it('tints an error instead of dotting it', () => {
    const markup = render('error')
    const classes = classOf(markup)
    expect(classes).toContain('glass-chip-tinted')
    expect(classes).toContain('tone-destructive')
    expect(markup).not.toContain('glass-dot')
  })

  it('tints an on-air session in the live tone (plan 095 S5)', () => {
    const markup = render('live')
    const classes = classOf(markup)
    expect(classes).toContain('glass-chip-tinted')
    expect(classes).toContain('tone-live')
    expect(classes).not.toContain('tone-destructive')
    expect(markup).not.toContain('glass-dot')
    expect(markup).toContain('data-tone="live"')
  })
})

describe('Kbd and StatusDot', () => {
  it('draws the key chip as a glass keycap', () => {
    const classes = classOf(renderToStaticMarkup(createElement(Kbd, null, '⌘')))
    expect(classes).toContain('glass-keycap')
    expect(classes).toContain('text-muted-foreground')
    expect(classes).not.toContain('bg-foreground/10')
  })

  it('draws the ambient dot as a glass dot with a monochrome label', () => {
    const markup = renderToStaticMarkup(
      createElement(StatusDot, { tone: 'live', label: 'Recording', pulse: true })
    )
    expect(markup).toContain('tone-live')
    expect(markup).toContain('glass-dot')
    expect(markup).toContain('motion-safe:animate-ping')
    expect(markup).not.toMatch(TONE_TEXT)
  })

  it('shares the StatusBadge tones: live is record and on air, error is a failure (plan 174 S1.3)', () => {
    const dotTone = (tone: StatusTone): string =>
      renderToStaticMarkup(createElement(StatusDot, { tone }))
    expect(dotTone('live')).toContain('tone-live')
    expect(dotTone('error')).toContain('tone-destructive')
    expect(dotTone('error')).not.toContain('tone-live')
    expect(dotTone('good')).toContain('tone-success')
    expect(dotTone('warn')).toContain('tone-warning')
    expect(dotTone('neutral')).toContain('tone-neutral')
  })
})

// Plan 174 S1.3 (A-6): the primitives used to `capitalize` whatever they got,
// so raw enums read as Title Case chips ("Device-Missing", "Checked On First
// Use"). They now print the word they are given, and refuse a raw value.
describe('status words, not enums', () => {
  it('never recase the word they are given', () => {
    for (const markup of [
      renderToStaticMarkup(createElement(StatusBadge, { value: 'Checked on first use' })),
      renderToStaticMarkup(createElement(StatusDot, { label: 'Needs reconnect' }))
    ]) {
      expect(classOf(markup)).not.toContain('capitalize')
      expect(markup).not.toMatch(/(^|[\s"])(capitalize|uppercase|lowercase)([\s"]|$)/)
    }
    expect(
      renderToStaticMarkup(createElement(StatusBadge, { value: 'Checked on first use' }))
    ).toContain('>Checked on first use<')
  })

  it('keep no text-transform class in their source', () => {
    for (const file of ['./status-badge.tsx', './status-dot.tsx']) {
      const source = readFileSync(new URL(file, import.meta.url), 'utf8')
      expect(source).not.toMatch(/\b(capitalize|uppercase|lowercase)\b/)
    }
  })

  it('reject a raw machine value', () => {
    for (const value of ['connected', 'device-missing', 'permission-needed', 'live']) {
      expect(() => renderToStaticMarkup(createElement(StatusBadge, { value }))).toThrow(
        /raw status value/
      )
      expect(() => renderToStaticMarkup(createElement(StatusDot, { label: value }))).toThrow(
        /raw status value/
      )
    }
  })

  it('accept words, counts and measurements', () => {
    for (const value of ['On air', 'Not ready', '2', '30.0 fps', '1/2 live', 'Fallback (JPEG)']) {
      expect(() => renderToStaticMarkup(createElement(StatusBadge, { value }))).not.toThrow()
      expect(() => renderToStaticMarkup(createElement(StatusDot, { label: value }))).not.toThrow()
    }
  })
})

describe('chip tokens', () => {
  const utility = (name: string): string => {
    const match = new RegExp(`@utility ${name} \\{([\\s\\S]*?)\\n\\}`).exec(styles)
    if (!match) throw new Error(`@utility ${name} is missing from styles.css`)
    return match[1]
  }

  it('defines every chip utility once, without backdrop blur or motion', () => {
    for (const name of ['glass-chip', 'glass-chip-tinted', 'glass-dot', 'glass-keycap']) {
      const body = utility(name)
      expect(body).not.toMatch(/backdrop-filter|transition|animation/)
      expect(styles.match(new RegExp(`@utility ${name} \\{`, 'g'))).toHaveLength(1)
    }
  })

  it('gives both themes the full chip token set', () => {
    const tokens = [
      '--chip-fill-top',
      '--chip-fill-bottom',
      '--chip-rim',
      '--chip-highlight',
      '--chip-drop',
      '--chip-tint-top',
      '--chip-tint-bottom',
      '--chip-tint-rim',
      '--chip-tint-ink',
      '--chip-tint-ink-base',
      '--chip-dot-glow',
      '--keycap-fill-top',
      '--keycap-fill-bottom',
      '--keycap-rim',
      '--keycap-highlight',
      '--keycap-base'
    ]
    const light = /:root \{([\s\S]*?)\n\}/.exec(styles)?.[1] ?? ''
    const dark = /\n\.dark \{([\s\S]*?)\n\}/.exec(styles)?.[1] ?? ''
    for (const token of tokens) {
      expect(light).toContain(`${token}:`)
      expect(dark).toContain(`${token}:`)
    }
    // The values are plan 208 S4's crisper highlight (D9's glass, retuned).
    expect(dark).toContain('--chip-fill-top: oklch(1 0 0 / 13%);')
    expect(dark).toContain('--chip-fill-bottom: oklch(1 0 0 / 3%);')
    expect(dark).toContain('--chip-rim: oklch(1 0 0 / 9%);')
    expect(dark).toContain('--chip-highlight: oklch(1 0 0 / 18%);')
    expect(dark).toContain('--chip-drop: oklch(0 0 0 / 30%);')
    expect(light).toContain('--chip-fill-top: oklch(1 0 0 / 95%);')
    expect(light).toContain('--chip-fill-bottom: oklch(1 0 0 / 55%);')
    expect(light).toContain('--chip-rim: oklch(0 0 0 / 9%);')
    expect(light).toContain('--chip-highlight: oklch(1 0 0);')
    expect(light).toContain('--chip-drop: oklch(0 0 0 / 5%);')
  })
})

// Plan 208 S4 (D2): the Welcome screen's Liquid Chrome on the controls you
// touch. Four materials, defined once, with a dark and a light column; red
// stays the LED's alone (D6, D8).
describe('chrome materials (plan 208 S4)', () => {
  const MATERIALS = [
    'chrome-fill',
    'chrome-plate',
    'chrome-bead',
    'chrome-bead-ink',
    'chrome-led',
    'chrome-row-live',
    'chrome-row-member'
  ]
  const body = (name: string): string => {
    const match = new RegExp(`@utility ${name} \\{([\\s\\S]*?)\\n\\}`).exec(styles)
    if (!match) throw new Error(`@utility ${name} is missing from styles.css`)
    return match[1]
  }
  const light = /:root \{([\s\S]*?)\n\}/.exec(styles)?.[1] ?? ''
  const dark = /\n\.dark \{([\s\S]*?)\n\}/.exec(styles)?.[1] ?? ''

  it('defines each material once, flat and still: no transition, motion or backdrop blur', () => {
    for (const name of MATERIALS) {
      expect(styles.match(new RegExp(`@utility ${name} \\{`, 'g')), name).toHaveLength(1)
      expect(body(name), name).not.toMatch(/backdrop-filter|transition|animation/)
      // Each composes with Tailwind's ring stack, so focus rings still draw.
      expect(body(name), name).toContain('var(--tw-ring-shadow)')
    }
  })

  it('gives both themes the full chrome token set', () => {
    const tokens = [
      '--chrome-fill-stops',
      '--chrome-fill-flat',
      '--chrome-fill-ink',
      '--chrome-fill-hi',
      '--chrome-fill-lo',
      '--chrome-fill-drop',
      '--chrome-fill-lift',
      '--chrome-press',
      '--chrome-plate-top',
      '--chrome-plate-bottom',
      '--chrome-plate-hi',
      '--chrome-plate-rim',
      '--chrome-bead-stops',
      '--chrome-bead-drop',
      '--chrome-bead-ink-stops',
      '--chrome-bead-ink-drop',
      '--chrome-led-stops',
      '--chrome-led-flat',
      '--chrome-led-hi',
      '--chrome-led-lo',
      '--chrome-led-drop',
      '--chrome-led-lift',
      '--chrome-led-glow',
      '--chrome-edge',
      '--chrome-row-edge-stops',
      '--chrome-row-live-top',
      '--chrome-row-live-bottom',
      '--chrome-row-live-hi',
      '--chrome-row-member-top',
      '--chrome-row-member-bottom',
      '--chrome-row-member-hi',
      '--chrome-row-member-edge',
      '--chrome-row-rim',
      '--chrome-row-lift'
    ]
    for (const token of tokens) {
      expect(light, token).toContain(`${token}:`)
      expect(dark, token).toContain(`${token}:`)
    }
    // Dark is silver with dark ink; light is the crisp invert, graphite with
    // white ink (D3).
    expect(dark).toContain('--chrome-fill-ink: oklch(0.13 0 0);')
    expect(light).toContain('--chrome-fill-ink: oklch(0.985 0 0);')
    // The chrome is neutral; only the LED carries a hue, the brand red's.
    for (const column of [light, dark]) {
      const chroma = [
        ...column.matchAll(/--chrome-(?!led)[\w-]+:[^;]*oklch\(\s*[\d.]+\s+(?!0[\s/)])/g)
      ]
      expect(chroma.map(([match]) => match)).toEqual([])
      expect(column).toMatch(
        /--chrome-led-glow: color-mix\(in oklch, var\(--live\) \d+%, transparent\);/
      )
    }
  })

  it('lights the LED only with data-lit, and gives fill and plate an edge under Increase Contrast', () => {
    expect(body('chrome-led')).toMatch(
      /&\[data-lit\] \{\s*--tw-shadow: var\(--chrome-led-shadow\), 0 0 12px var\(--chrome-led-glow\);/
    )
    expect(body('chrome-fill')).not.toContain('data-lit')
    const contrast = /@media \(prefers-contrast: more\) \{([\s\S]*?)\n\}/.exec(styles)?.[1] ?? ''
    expect(contrast.match(/--chrome-edge: oklch\(/g)).toHaveLength(2)
    expect(contrast.match(/--chrome-plate-rim: oklch\(/g)).toHaveLength(2)
    expect(contrast.match(/--chrome-row-rim: oklch\(/g)).toHaveLength(2)
  })

  // Plan 0011: the chrome rows are cheap on a CPU-only compositor. Static
  // gradients and inset shadows on the row's own box: no filter, no blur, no
  // fixed or viewport-sized background, no layer promotion.
  it('keeps the chrome rows static and paint-cheap', () => {
    for (const name of ['chrome-row-live', 'chrome-row-member']) {
      expect(body(name), name).not.toMatch(
        /filter|blur|will-change|background-attachment|vw|vh|transform|::?(?:before|after)/
      )
    }
    // The member hue is only the member row's edge; the on-stream row is neutral.
    expect(body('chrome-row-member')).toContain('inset 2px 0 0 var(--chrome-row-member-edge)')
    for (const column of [light, dark]) {
      expect(column).toContain(
        '--chrome-row-member-edge: color-mix(in oklch, var(--member) 80%, transparent);'
      )
    }
    expect(body('chrome-row-live')).not.toContain('--member')
    // Each plate stands on the theme's solid, its last layer, also on hover.
    for (const name of ['chrome-row-live', 'chrome-row-member']) {
      const stacks = [...body(name).matchAll(/background-image:([^;]*);/g)].map(([, layers]) =>
        layers.trim()
      )
      expect(stacks, name).toHaveLength(2)
      for (const layers of stacks) {
        expect(
          layers.endsWith('linear-gradient(var(--glass-solid), var(--glass-solid))'),
          name
        ).toBe(true)
      }
    }
  })
})
