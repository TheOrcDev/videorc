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
    required: true,
    label: 'Screen Recording',
    purpose: 'Capture displays, app windows and system audio.',
    state: 'granted',
    detail: 'Permission granted.'
  },
  {
    id: 'camera',
    required: false,
    label: 'Camera',
    purpose: 'Camera overlay in your scenes.',
    state: 'not-granted',
    detail: 'System Settings is blocking the camera. Allow Videorc there.'
  },
  {
    id: 'microphone',
    required: true,
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
    expect(markup).toMatch(/data-tone="neutral"[^>]*>.*?Not asked yet</)
  })

  it('offers the one action each open row supports, named for where it goes', () => {
    const markup = render()
    expect(markup).toContain('aria-label="Camera: Open System Settings…"')
    expect(markup).toContain('aria-label="Microphone: Allow…"')
    expect(markup).not.toContain('Screen Recording: ')
  })
})

// Plan 203 S5: the setup variant adds the tags and the microphone's proof.
describe('SystemAccessList setup variant (plan 203 S5)', () => {
  const setupRows = (microphone: SystemAccessRow['state']): SystemAccessRow[] => [
    rows[0],
    {
      id: 'system-audio',
      required: false,
      label: 'System audio',
      purpose: 'The sound your Mac plays. Comes with Screen Recording.',
      state: 'granted',
      detail: ''
    },
    { ...rows[2], state: microphone },
    rows[1]
  ]
  const renderSetup = (microphone: SystemAccessRow['state'], variant?: 'setup'): string =>
    renderToStaticMarkup(
      createElement(SystemAccessList, {
        rows: setupRows(microphone),
        platform: 'darwin',
        mediaAccess: { camera: 'denied', microphone: 'granted', screen: 'granted' },
        onAction: async () => undefined,
        variant,
        microphoneProof: createElement('div', { 'data-proof': '' })
      })
    )

  it('tags what recording needs and what is optional, in the setup variant only', () => {
    const markup = renderSetup('granted', 'setup')
    expect(markup.match(/Needed to record/g)).toHaveLength(2)
    expect(markup.match(/>Optional</g)).toHaveLength(1)
    const plain = renderSetup('granted')
    expect(plain).not.toContain('Needed to record')
    expect(plain).not.toContain('Optional')
  })

  it('shows the microphone proof only under a granted microphone', () => {
    expect(renderSetup('granted', 'setup')).toContain('data-proof=""')
    expect(renderSetup('first-use', 'setup')).not.toContain('data-proof=""')
    expect(renderSetup('granted')).not.toContain('data-proof=""')
  })

  it('announces a chip that changes', () => {
    const markup = renderSetup('granted', 'setup')
    expect(markup.match(/aria-live="polite"/g)).toHaveLength(4)
  })
})
