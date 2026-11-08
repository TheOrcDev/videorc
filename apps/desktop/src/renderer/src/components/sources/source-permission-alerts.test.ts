import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { sourcePermissionAlerts } from '@/lib/source-permissions'
import { SourcePermissionAlertsView } from './source-permission-alerts'

// Plan 174 S3.8 (C-8, C-14, C-28): the page's one style of permission recovery.

const noop = (): void => {}

function render(alerts: ReturnType<typeof sourcePermissionAlerts>, deviceProblem = false): string {
  return renderToStaticMarkup(
    createElement(SourcePermissionAlertsView, {
      alerts,
      deviceProblem,
      onOpen: noop,
      onReveal: noop,
      onOpenHealth: noop
    })
  )
}

const screenAndMicrophone = sourcePermissionAlerts({
  platform: 'darwin',
  targetName: 'Videorc',
  screenRecording: true,
  camera: { state: 'granted', action: null, chosen: true },
  microphone: { state: 'not-granted', action: 'open-settings', chosen: true }
})

describe('SourcePermissionAlertsView', () => {
  it('renders nothing when nothing blocks a source', () => {
    expect(render([])).toBe('')
  })

  it('is one flush warning Alert per missing permission, each with its fix', () => {
    const markup = render(screenAndMicrophone)
    expect(markup.match(/data-slot="alert"/g)).toHaveLength(2)
    expect(markup).toMatch(/data-variant="warning"[^>]*data-permission="screen-recording"/)
    expect(markup).toMatch(/data-variant="warning"[^>]*data-permission="microphone"/)
    expect(markup).toContain('>Open Screen Recording settings<')
    expect(markup).toContain('>Open Microphone settings<')
    // Plan 203 S2: capture restarts on its own after the grant.
    expect(markup).toContain('then come back here.')
  })

  it('names Videorc, never the capture helper (plan 203 S3; S0 confirms on a clean account)', () => {
    const markup = render(screenAndMicrophone)
    expect(markup).not.toContain('Show helper in')
    expect(markup).not.toContain('Show Capture Helper')
  })

  it('says other device trouble once, and sends it to Health', () => {
    const markup = render([], true)
    expect(markup).toMatch(/data-variant="quiet"/)
    expect(markup).toContain('Videorc couldn&#x27;t check every device.')
    expect(markup).toContain('>Open Health<')
  })
})
