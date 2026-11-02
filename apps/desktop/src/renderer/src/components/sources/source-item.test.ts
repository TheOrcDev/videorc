import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { MicrophoneIcon } from '@/components/icons'
import { TooltipProvider } from '@/components/ui/tooltip'
import { SourceControlRow, SourceFacts, SourceItem } from './source-item'

// Plan 173: the one shape every Sources row takes.

function render(overrides: Partial<Parameters<typeof SourceItem>[0]> = {}): string {
  return renderToStaticMarkup(
    createElement(
      TooltipProvider,
      null,
      createElement(SourceItem, {
        id: 'microphone',
        icon: MicrophoneIcon,
        title: 'Microphone',
        children: createElement('div', { 'data-test-body': '' }),
        ...overrides
      })
    )
  )
}

describe('SourceItem (plan 173)', () => {
  it('is a labelled section: header row, then the body', () => {
    const markup = render()
    expect(markup).toMatch(/<section[^>]*aria-labelledby="([^"]+)"[^>]*data-slot="source-item"/)
    const labelledBy = markup.match(/aria-labelledby="([^"]+)"/)?.[1]
    expect(markup).toContain(`id="${labelledBy}">Microphone<`)
    expect(markup).toContain('data-source="microphone"')
    expect(markup.indexOf('data-slot="list-row"')).toBeLessThan(
      markup.indexOf('data-slot="source-item-body"')
    )
    expect(markup).toContain('data-test-body=""')
  })

  it('puts the tag after the title, then the chip, the control and the chevron', () => {
    const markup = render({
      tag: createElement('span', { 'data-test-tag': '' }, 'Sync +150 ms'),
      status: { label: 'Muted', tone: 'neutral' },
      control: createElement('button', { 'data-test-control': '' }),
      more: createElement('div', null, 'rare')
    })
    const order = [
      '>Microphone<',
      'data-test-tag',
      'data-slot="source-status"',
      'data-test-control',
      'aria-label="More Microphone settings"'
    ].map((needle) => markup.indexOf(needle))
    expect(order.every((index) => index >= 0)).toBe(true)
    expect([...order].sort((a, b) => a - b)).toEqual(order)
    expect(markup).toContain('>Muted<')
  })

  it('keeps More closed by default and leaves out the chevron without it', () => {
    const closed = render({ more: createElement('div', null, 'rare settings') })
    expect(closed).toMatch(/aria-expanded="false"/)
    expect(closed).not.toContain('rare settings')
    expect(render()).not.toContain('More Microphone settings')
    expect(render()).not.toContain('data-testid="source-item-more"')
  })

  // Plan 213 A3: only the 24 px chevron opened More. Its button now stretches
  // over the header row; the control sits above it, the tag and chip under.
  it('opens More from the whole header row, with the control kept clickable', () => {
    const markup = render({
      tag: createElement('span', { 'data-test-tag': '' }, 'Sync +150 ms'),
      status: { label: 'Muted', tone: 'neutral' },
      control: createElement('button', { 'data-test-control': '' }),
      more: createElement('div', null, 'rare')
    })
    const rowClass = markup.match(/data-slot="list-row" class="([^"]*)"/)?.[1]?.split(' ')
    expect(rowClass).toEqual(expect.arrayContaining(['relative', 'hover:bg-accent']))
    const triggerClass = markup
      .match(/<button[^>]*aria-label="More Microphone settings"[^>]*class="([^"]*)"/)?.[1]
      ?.split(' ')
    expect(triggerClass).toEqual(
      expect.arrayContaining(['static', 'after:absolute', 'after:inset-0'])
    )
    expect(markup).toMatch(
      /<span class="relative [^"]*" data-slot="source-item-control"><button data-test-control=""/
    )
    // Decorations are never positioned: a click on them opens More.
    expect(markup).not.toMatch(/class="relative[^"]*"[^>]*>(<[^>]*>)*Sync \+150 ms/)
    expect(markup).not.toMatch(/class="relative[^"]*" data-slot="source-status"/)
  })

  it('stays a plain row without More: no hover, nothing stretched', () => {
    const markup = render({ control: createElement('button', { 'data-test-control': '' }) })
    const rowClass = markup.match(/data-slot="list-row" class="([^"]*)"/)?.[1]?.split(' ')
    expect(rowClass).not.toContain('relative')
    expect(rowClass).not.toContain('hover:bg-accent')
    expect(markup).not.toContain('after:inset-0')
  })

  it('renders More when opened, linked to its chevron', () => {
    const open = render({
      defaultMoreOpen: true,
      moreLabel: 'More microphone settings',
      more: createElement('div', null, 'rare settings')
    })
    expect(open).toContain('rare settings')
    const controls = open.match(/aria-controls="([^"]+)"[^>]*aria-label="More microphone/)?.[1]
    expect(controls).toBeTruthy()
    expect(open).toContain(`id="${controls}"`)
  })

  it('shows a hint as a visible status line in the body, never only a tooltip (C-10)', () => {
    const markup = render({
      status: { label: 'Not found', tone: 'warn', hint: 'Reconnect it, or choose another.' }
    })
    expect(markup).toContain('>Not found<')
    expect(markup).toMatch(
      /<p[^>]*data-slot="source-status-hint"[^>]*role="status"[^>]*>Reconnect it, or choose another\.<\/p>/
    )
    expect(markup).not.toContain('sr-only')
    expect(markup.indexOf('data-slot="source-item-body"')).toBeLessThan(
      markup.indexOf('data-slot="source-status-hint"')
    )
    expect(markup).toContain('data-tone="warn"')
    expect(render({ status: null })).not.toContain('data-slot="source-status"')
    expect(render({ status: { label: 'Muted', tone: 'neutral' } })).not.toContain(
      'source-status-hint'
    )
  })

  it('marks a disabled item for its styles', () => {
    expect(render({ disabled: true })).toMatch(/data-disabled="true"[^>]*data-slot="source-item"/)
    expect(render()).not.toContain('data-disabled')
  })
})

describe('SourceControlRow and SourceFacts (plan 173)', () => {
  it('lays a label, a control and its value on one line', () => {
    const markup = renderToStaticMarkup(
      createElement(SourceControlRow, {
        label: 'Gain',
        value: '0.0 dB',
        children: createElement('input', { 'aria-label': 'Microphone gain' })
      })
    )
    expect(markup).toContain('>Gain<')
    expect(markup).toContain('aria-label="Microphone gain"')
    expect(markup).toContain('data-slot="source-control-value">0.0 dB<')
  })

  it('keeps facts secondary text, never tinted', () => {
    const facts = renderToStaticMarkup(createElement(SourceFacts, { children: '1920 × 1080' }))
    expect(facts).toContain('data-slot="source-facts"')
    expect(facts).toContain('text-muted-foreground')
    expect(facts).not.toContain('text-warning')
  })

  it('makes the value a reset button only when given a reset', () => {
    const resettable = renderToStaticMarkup(
      createElement(
        TooltipProvider,
        null,
        createElement(SourceControlRow, {
          label: 'Gain',
          value: '+6.0 dB',
          reset: { label: 'Reset to 0.0 dB', onReset: () => {} },
          children: createElement('input', { 'aria-label': 'Microphone gain' })
        })
      )
    )
    expect(resettable).toMatch(/data-slot="source-control-value"[^>]*><button[^>]*>\+6\.0 dB/)
    expect(resettable).toContain('<span class="sr-only">. Reset to 0.0 dB</span>')
  })
})
