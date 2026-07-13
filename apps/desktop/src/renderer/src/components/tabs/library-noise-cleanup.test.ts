import { readFileSync } from 'node:fs'

import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'

import { NoiseCleanupDirectAction } from './library-tab'
import { TooltipProvider } from '@/components/ui/tooltip'
import type { NoiseCleanupView } from '@/lib/noise-cleanup-view'

function view(overrides: Partial<NoiseCleanupView> = {}): NoiseCleanupView {
  return {
    directAction: 'start',
    menuAction: 'start',
    directLabel: 'Clean noise',
    menuLabel: 'Clean noise',
    disabledReason: null,
    detail: null,
    statusAnnouncement: null,
    busy: false,
    conflictsWithFileActions: false,
    premiumLocked: false,
    derivative: false,
    ...overrides
  }
}

function renderAction(
  title: string,
  actionView: NoiseCleanupView,
  sessionId = 'session-1'
): string {
  return renderToStaticMarkup(
    createElement(
      TooltipProvider,
      null,
      createElement(NoiseCleanupDirectAction, {
        sessionId,
        title,
        view: actionView,
        onAction: vi.fn()
      })
    )
  )
}

describe('Library Noise Cleanup direct action', () => {
  it('keeps the locked direct-action order: Play, Cleanup, Publish', () => {
    const source = readFileSync(new URL('./library-tab.tsx', import.meta.url), 'utf8')
    const rowActions = source.slice(source.indexOf('function RowActions'))
    const play = rowActions.indexOf('aria-label="Play recording"')
    const cleanup = rowActions.indexOf('<NoiseCleanupDirectAction')
    const publish = rowActions.indexOf('aria-label="Open in Publish"')

    expect(play).toBeGreaterThan(-1)
    expect(cleanup).toBeGreaterThan(play)
    expect(publish).toBeGreaterThan(cleanup)
  })

  it('uses a native accessible button for one-click cleanup', () => {
    const markup = renderAction('Weekly update', view())

    expect(markup).toContain('<button')
    expect(markup).toContain('aria-label="Clean up noise in Weekly update"')
    expect(markup).toContain('Clean noise')
    expect(markup).not.toContain('disabled=""')
    expect(markup).toContain('min-[1280px]:inline')
  })

  it('keeps Premium cleanup actionable and presents lock metadata', () => {
    const markup = renderAction(
      'Launch demo',
      view({
        directAction: 'upgrade',
        menuAction: 'upgrade',
        detail: 'Noise Cleanup requires Videorc Premium.',
        premiumLocked: true
      })
    )

    expect(markup).toContain('aria-label="Clean up noise in Launch demo"')
    expect(markup).toContain('data-icon="inline-start"')
    expect(markup).not.toContain('disabled=""')
  })

  it('uses session identity for unique descriptions when titles match', () => {
    const locked = view({
      directAction: 'upgrade',
      menuAction: 'upgrade',
      detail: 'Noise Cleanup requires Videorc Premium.',
      premiumLocked: true
    })
    const first = renderAction('Same title', locked, 'session-one')
    const second = renderAction('Same title', locked, 'session-two')

    expect(first).toContain('noise-cleanup-session-one-description')
    expect(second).toContain('noise-cleanup-session-two-description')
    expect(second).not.toContain('noise-cleanup-session-one-description')
  })

  it('makes a disabled progress control focusable with coarse live status', () => {
    const markup = renderAction(
      'Launch demo',
      view({
        directAction: null,
        menuAction: 'cancel',
        directLabel: 'Cleaning 42%',
        menuLabel: 'Cancel cleanup — 42%',
        detail: 'Cleaning noise: 42% complete.',
        statusAnnouncement: 'Cleaning noise, 40 percent.',
        busy: true,
        conflictsWithFileActions: true
      })
    )

    expect(markup).toContain('tabindex="0"')
    expect(markup).toContain('disabled=""')
    expect(markup).toContain('aria-busy="true"')
    expect(markup).toContain('aria-live="polite"')
    expect(markup).toContain('Cleaning noise, 40 percent.')
  })

  it('keeps a reconnect-disabled action focusable with a described reason', () => {
    const markup = renderAction(
      'Launch demo',
      view({
        directAction: null,
        disabledReason: 'Videorc is reconnecting. Try again in a moment.'
      })
    )

    expect(markup).toContain('tabindex="0"')
    expect(markup).toContain('disabled=""')
    expect(markup).toContain('aria-describedby="noise-cleanup-session-1-description"')
  })

  it('does not render a second cleanup control on a cleaned derivative', () => {
    const markup = renderAction(
      'Weekly update — Noise cleaned',
      view({
        directAction: null,
        menuAction: 'show-source',
        directLabel: null,
        menuLabel: 'Show source recording',
        derivative: true
      })
    )

    expect(markup).toBe('')
  })
})
