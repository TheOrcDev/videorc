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
    expect(render()).not.toContain('data-slot="source-item-more"')
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

  it('reads a hint out with the chip and shows no chip without a status', () => {
    const markup = render({
      status: { label: 'Not found', tone: 'warn', hint: 'Reconnect it, or pick another.' }
    })
    expect(markup).toContain('>Not found<')
    expect(markup).toContain('<span class="sr-only">Reconnect it, or pick another.</span>')
    expect(markup).toContain('data-tone="warn"')
    expect(render({ status: null })).not.toContain('data-slot="source-status"')
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

  it('gives a warning its icon in the tone, never tinted words', () => {
    const warning = renderToStaticMarkup(
      createElement(SourceFacts, { tone: 'warning', children: 'Runs at 25 fps.' })
    )
    expect(warning).toContain('data-tone="warning"')
    expect(warning).toContain('text-warning')
    expect(warning).toMatch(/<span class="min-w-0">Runs at 25 fps\.<\/span>/)
    const facts = renderToStaticMarkup(createElement(SourceFacts, { children: '1920 × 1080' }))
    expect(facts).not.toContain('text-warning')
  })
})
