import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import type { SystemAccessRow } from '@/lib/system-access'

import { SystemAccessList } from './system-access-list'

// Plan 174 S3.17 (I-10, A-16): the first-run dialog and Settings →
// Permissions draw these same rows.

const rows: SystemAccessRow[] = [
  {
    id: 'screen-recording',
    label: 'Screen Recording',
    purpose: 'Capture displays, app windows and system audio.',
    state: 'granted',
    detail: 'Permission granted.'
  },
  {
    id: 'camera',
    label: 'Camera',
    purpose: 'Camera overlay in your scenes.',
    state: 'not-granted',
    detail: 'System Settings is blocking the camera. Allow Videorc there.'
  },
  {
    id: 'microphone',
    label: 'Microphone',
    purpose: 'Voice audio and live captions.',
    state: 'first-use',
    detail: 'Checked when you test the microphone or start recording.'
  }
]

const render = (): string =>
  renderToStaticMarkup(
    createElement(SystemAccessList, {
      rows,
      platform: 'darwin',
      mediaAccess: { camera: 'denied', microphone: 'not-determined', screen: 'granted' },
      onAction: async () => undefined
    })
  )

describe('SystemAccessList', () => {
  it('shows every purpose and every open detail in full, never on hover only', () => {
    const markup = render()
    for (const row of rows) expect(markup).toContain(row.purpose)
    expect(markup).toContain('System Settings is blocking the camera. Allow Videorc there.')
    expect(markup).toContain('Checked when you test the microphone or start recording.')
    // A granted row's chip already says it.
    expect(markup).not.toContain('Permission granted.')
    expect(markup).not.toMatch(/\btitle="/)
  })

  it('maps each state to one chip', () => {
    const markup = render()
    expect(markup).toMatch(/data-tone="good"[^>]*>.*?Granted</)
    expect(markup).toMatch(/data-tone="warn"[^>]*>.*?Not granted</)
    expect(markup).toMatch(/data-tone="neutral"[^>]*>.*?Checked on first use</)
  })

  it('offers the one action each open row supports, named for where it goes', () => {
    const markup = render()
    expect(markup).toContain('aria-label="Camera: Open System Settings…"')
    expect(markup).toContain('aria-label="Microphone: Allow access…"')
    expect(markup).not.toContain('Screen Recording: ')
  })
})
