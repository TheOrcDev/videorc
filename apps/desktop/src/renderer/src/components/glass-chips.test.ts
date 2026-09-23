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
  | 'secondary'
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
  it('maps default and secondary to neutral glass with primary text', () => {
    for (const variant of ['default', 'secondary'] as const) {
      const classes = classOf(badge(variant))
      expect(classes).toContain('glass-chip')
      expect(classes).toContain('text-foreground')
      expect(classes).not.toContain('bg-primary')
    }
  })

  it('maps outline to a tag: the same glass, secondary text, 20 px, 7 px radius', () => {
    const classes = classOf(badge('outline'))
    expect(classes).toContain('glass-chip')
    expect(classes).toContain('text-muted-foreground')
    expect(classes).toContain('h-5')
    expect(classes).toContain('rounded-[7px]')
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
      createElement(StatusDot, { tone: 'error', label: 'recording', pulse: true })
    )
    expect(markup).toContain('tone-live')
    expect(markup).toContain('glass-dot')
    expect(markup).toContain('motion-safe:animate-ping')
    expect(markup).not.toMatch(TONE_TEXT)
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
    // The dark values are the D9 spec.
    expect(dark).toContain('--chip-fill-top: oklch(1 0 0 / 10%);')
    expect(dark).toContain('--chip-fill-bottom: oklch(1 0 0 / 3.5%);')
    expect(dark).toContain('--chip-rim: oklch(1 0 0 / 13%);')
    expect(dark).toContain('--chip-highlight: oklch(1 0 0 / 12%);')
    expect(dark).toContain('--chip-drop: oklch(0 0 0 / 30%);')
  })
})
