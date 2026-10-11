import { createElement as h } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { MicrophoneIcon } from '@/components/icons'
import { Alert, AlertDescription, AlertTitle } from './alert'
import * as EmptyModule from './empty'
import { Empty, EmptyDescription, EmptyTitle } from './empty'
import { FieldError } from './field'
import { Progress } from './progress'
import { Spinner } from './spinner'

// Plan 174 S1.5: one primitive per kind of feedback.

const render = (element: Parameters<typeof renderToStaticMarkup>[0]): string =>
  renderToStaticMarkup(element)

const openingTag = (markup: string, slot: string): string =>
  markup.match(new RegExp(`<[^>]*data-slot="${slot}"[^>]*>`))?.[0] ?? ''

describe('Alert (J1-8, D-38, G-26, E-PAT)', () => {
  it('is assertive only when destructive; every other tone is a polite status', () => {
    expect(openingTag(render(h(Alert, { variant: 'destructive' })), 'alert')).toContain(
      'role="alert"'
    )
    for (const variant of ['default', 'quiet', 'locked', 'warning', 'success'] as const) {
      const tag = openingTag(render(h(Alert, { variant })), 'alert')
      expect(tag, variant).toContain('role="status"')
      expect(tag, variant).toContain(`data-variant="${variant}"`)
    }
    expect(openingTag(render(h(Alert, null)), 'alert')).toContain('role="status"')
  })

  it('keeps an explicit role (a card that is a group)', () => {
    expect(openingTag(render(h(Alert, { role: 'group' })), 'alert')).toContain('role="group"')
  })

  it("draws its tone's own icon once, in one weight, hidden from screen readers", () => {
    for (const variant of [
      'default',
      'quiet',
      'locked',
      'destructive',
      'warning',
      'success'
    ] as const) {
      const markup = render(h(Alert, { variant }, h(AlertTitle, null, 'Line')))
      expect(markup.match(/<svg/g), variant).toHaveLength(1)
      expect(openingTag(markup, 'alert-icon'), variant).toContain('aria-hidden="true"')
    }
    // Five tones, four glyphs: default and quiet share the info mark.
    const glyph = (variant: 'default' | 'locked' | 'destructive' | 'warning' | 'success') =>
      render(h(Alert, { variant })).replace(/<div[^>]*>|<\/div>/g, '')
    const glyphs = new Set(
      (['default', 'locked', 'destructive', 'warning', 'success'] as const).map(glyph)
    )
    expect(glyphs.size).toBe(5)
  })

  it("takes a subject's own mark, or none", () => {
    const withMic = render(h(Alert, { icon: MicrophoneIcon }))
    expect(withMic.match(/<svg/g)).toHaveLength(1)
    expect(withMic).not.toEqual(render(h(Alert, null)))
    expect(render(h(Alert, { icon: null }))).not.toContain('<svg')
  })

  it('reads a lone title as a message and a titled description as a heading', () => {
    const title = openingTag(render(h(Alert, null, h(AlertTitle, null, 'One line'))), 'alert-title')
    expect(title).toContain('font-normal')
    expect(title).toContain('group-has-data-[slot=alert-description]/alert:font-medium')
    const both = render(
      h(Alert, null, h(AlertTitle, null, 'Heading'), h(AlertDescription, null, 'Body'))
    )
    expect(both).toContain('data-slot="alert-description"')
  })

  it('mutes the quiet and locked lines in the variant, not per call site', () => {
    const title = openingTag(render(h(Alert, { variant: 'quiet' }, h(AlertTitle))), 'alert-title')
    expect(title).toContain('group-data-[variant=quiet]/alert:text-muted-foreground')
    expect(title).toContain('group-data-[variant=locked]/alert:text-muted-foreground')
  })

  it('stays a flush row: a tint, the row radius, no border and no shadow', () => {
    const tag = openingTag(render(h(Alert, { variant: 'warning' })), 'alert')
    expect(tag).toContain('rounded-row')
    expect(tag).toContain('bg-warning/10')
    expect(tag).not.toMatch(/\bborder\b|shadow/)
  })
})

describe('Empty (J1-13, V-X5, D11)', () => {
  it('has no media tile', () => {
    expect(Object.keys(EmptyModule)).not.toContain('EmptyMedia')
  })

  it('is short muted 14 px text with an optional 14 px / 500 title, centred', () => {
    const markup = render(
      h(Empty, null, h(EmptyTitle, null, 'No takeovers yet'), h(EmptyDescription, null, 'Upload'))
    )
    expect(openingTag(markup, 'empty')).toContain('text-center')
    const title = openingTag(markup, 'empty-title')
    expect(title).toContain('text-sm')
    expect(title).toContain('font-medium')
    expect(title).not.toMatch(/text-(lg|base)/)
    const description = openingTag(markup, 'empty-description')
    expect(description).toContain('text-sm')
    expect(description).toContain('text-muted-foreground')
    expect(markup).not.toMatch(/border-dashed|<svg|<img/)
  })
})

describe('Spinner (J1-21)', () => {
  it('announces itself as a status, named Loading unless told otherwise', () => {
    const tag = openingTag(render(h(Spinner)), 'spinner')
    expect(tag).toContain('role="status"')
    expect(tag).toContain('aria-label="Loading"')
    expect(tag).toContain('animate-spin')
    expect(openingTag(render(h(Spinner, { 'aria-label': 'Syncing' })), 'spinner')).toContain(
      'aria-label="Syncing"'
    )
  })

  it('stays silent beside its own words', () => {
    const tag = openingTag(render(h(Spinner, { 'aria-hidden': true })), 'spinner')
    expect(tag).toContain('aria-hidden="true"')
    expect(tag).not.toContain('role=')
    expect(tag).not.toContain('aria-label')
  })

  it('takes its size from the slot unless a class sets one', () => {
    expect(openingTag(render(h(Spinner)), 'spinner')).not.toMatch(/class="[^"]*size-/)
    expect(openingTag(render(h(Spinner, { className: 'size-3.5' })), 'spinner')).toContain(
      'size-3.5'
    )
  })
})

describe('Progress (J1-21)', () => {
  it('is a progressbar that reports its value against its max', () => {
    const markup = render(h(Progress, { 'aria-label': 'Build progress', value: 3, max: 4 }))
    const root = openingTag(markup, 'progress')
    expect(root).toContain('role="progressbar"')
    expect(root).toContain('aria-valuenow="3"')
    expect(root).toContain('aria-valuemax="4"')
    expect(root).toContain('aria-label="Build progress"')
    expect(root).toContain('rounded-full')
    expect(openingTag(markup, 'progress-indicator')).toContain('translateX(-25%)')
  })

  it('clamps the fill and defaults to percent', () => {
    expect(openingTag(render(h(Progress, { value: 40 })), 'progress-indicator')).toContain(
      'translateX(-60%)'
    )
    expect(openingTag(render(h(Progress, { value: 0, max: 0 })), 'progress-indicator')).toContain(
      'translateX(-100%)'
    )
  })
})

describe('FieldError (J1-5, I-26)', () => {
  it('is monochrome words with a destructive error glyph', () => {
    const markup = render(h(FieldError, null, 'Width must be even.'))
    const root = openingTag(markup, 'field-error')
    expect(root).toContain('role="alert"')
    expect(root).toContain('text-foreground')
    expect(root).not.toContain('text-destructive')
    const icon = openingTag(markup, 'field-error-icon')
    expect(icon).toContain('text-destructive')
    expect(icon).toContain('aria-hidden="true"')
    expect(markup).toContain('Width must be even.')
  })

  it('renders nothing without a message', () => {
    expect(render(h(FieldError, { errors: [] }))).toBe('')
  })
})
