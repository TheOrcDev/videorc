import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { TooltipProvider } from '@/components/ui/tooltip'
import type { Device } from '@/lib/backend'
import { VideoSourcesView, type VideoSourcesViewProps } from './video-sources'

// Plan 173: the Video column, Screen and Camera as SourceItems.

const noop = (): void => {}

const screens: Device[] = [
  { id: 'screen:1', name: 'Display 1', kind: 'screen', status: 'available' },
  { id: 'window:9', name: 'Notes - Script', kind: 'window', status: 'available' }
]
const cameras: Device[] = [
  { id: 'cam:built-in', name: 'MacBook Pro Camera', kind: 'camera', status: 'available' }
]

function render(overrides: Partial<VideoSourcesViewProps> = {}): string {
  const props: VideoSourcesViewProps = {
    sessionActive: false,
    discoveryPending: false,
    screen: {
      devices: screens,
      value: 'screen:1',
      selectedName: 'Display 1',
      allowNone: true,
      disabled: false,
      status: { label: 'Receiving', tone: 'good' },
      facts: '2560 × 1664',
      onChange: noop
    },
    camera: {
      devices: cameras,
      value: 'cam:built-in',
      selectedName: 'MacBook Pro Camera',
      disabled: false,
      status: { label: 'Receiving', tone: 'good' },
      facts: '1920 × 1080 · 30 fps',
      shortfall: null,
      onChange: noop
    },
    synthetic: null,
    ...overrides
  }
  return renderToStaticMarkup(
    createElement(TooltipProvider, null, createElement(VideoSourcesView, props))
  )
}

describe('Sources Video column (plan 173)', () => {
  it('is one Video section with a Screen row, then a Camera row', () => {
    const markup = render()
    expect(markup).toContain('>Video<')
    expect(markup).toContain('data-slot="grouped-list"')
    const screen = markup.indexOf('data-source="screen"')
    const camera = markup.indexOf('data-source="camera"')
    expect(screen).toBeGreaterThan(-1)
    expect(camera).toBeGreaterThan(screen)
    expect(markup).toContain('>Screen<')
    expect(markup).toContain('>Camera<')
  })

  it('keeps each picker’s accessible name while the row title names it', () => {
    const markup = render()
    expect(markup).toMatch(/<label[^>]*class="[^"]*sr-only[^"]*"[^>]*>Screen \/ window<\/label>/)
    expect(markup).toMatch(/<label[^>]*class="[^"]*sr-only[^"]*"[^>]*>Camera<\/label>/)
  })

  it('shows each live source’s status and facts', () => {
    const markup = render()
    expect(markup.match(/>Receiving</g)).toHaveLength(2)
    expect(markup).toContain('>2560 × 1664<')
    expect(markup).toContain('>1920 × 1080 · 30 fps<')
  })

  it('replaces the camera facts with its format shortfall', () => {
    const markup = render({
      camera: {
        devices: cameras,
        value: 'cam:built-in',
        disabled: false,
        status: { label: 'Receiving', tone: 'good' },
        facts: '3840 × 2160 · 25 fps',
        shortfall: 'This camera only offers 3840×2160 at 25 fps.',
        onChange: noop
      }
    })
    expect(markup).toContain('This camera only offers 3840×2160 at 25 fps.')
    expect(markup).not.toContain('3840 × 2160 · 25 fps')
    // A warning is an Alert, never amber text (plan 174 S3.8).
    expect(markup).toMatch(/data-slot="alert"[^>]*data-variant="warning"/)
  })

  it('says Not found with its hint for a missing camera', () => {
    const markup = render({
      camera: {
        devices: cameras,
        value: 'cam:unplugged',
        selectedName: 'Cam Link 4K',
        disabled: false,
        status: {
          label: 'Not found',
          tone: 'warn',
          hint: "It isn't connected. Reconnect it, or choose another."
        },
        facts: null,
        shortfall: null,
        onChange: noop
      }
    })
    expect(markup).toContain('>Not found<')
    expect(markup).toContain('It isn&#x27;t connected. Reconnect it, or choose another.')
  })

  it('locks the screen picker while nothing can be captured, with no alert in the column', () => {
    const markup = render({
      screen: {
        devices: screens.map((device) => ({ ...device, status: 'permission-required' as const })),
        value: undefined,
        allowNone: true,
        disabled: true,
        status: null,
        facts: null,
        onChange: noop
      }
    })
    // The page's permission alert carries the fix (plan 174 S3.8).
    expect(markup).not.toContain('data-slot="alert"')
    expect(markup).toMatch(
      /data-disabled="true"[^>]*data-slot="source-item"[^>]*data-source="screen"/
    )
  })

  it('says how a live switch lands only while a session runs', () => {
    expect(render()).not.toContain('takes over once it sends fresh frames')
    expect(render({ sessionActive: true })).toContain(
      'A new source takes over once it sends fresh frames.'
    )
  })

  it('keeps the development synthetic switch visible for the smokes', () => {
    expect(render()).not.toContain('data-videorc-synthetic-source-toggle')
    const markup = render({ synthetic: { checked: false, disabled: false, onChange: noop } })
    const toggle = markup.match(/<span[^>]*data-videorc-synthetic-source-toggle[^>]*>/)?.[0]
    expect(toggle).toContain('role="switch"')
    expect(toggle).toContain('aria-checked="false"')
  })
})
