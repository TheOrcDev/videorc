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
      status: { label: 'Live', tone: 'good' },
      facts: '2560 × 1664',
      onChange: noop
    },
    camera: {
      devices: cameras,
      value: 'cam:built-in',
      selectedName: 'MacBook Pro Camera',
      disabled: false,
      status: { label: 'Live', tone: 'good' },
      facts: '1920 × 1080 · 30 fps',
      shortfall: null,
      onChange: noop
    },
    screenPermission: null,
    cameraPermission: null,
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
    expect(markup.match(/>Live</g)).toHaveLength(2)
    expect(markup).toContain('>2560 × 1664<')
    expect(markup).toContain('>1920 × 1080 · 30 fps<')
  })

  it('replaces the camera facts with its format shortfall', () => {
    const markup = render({
      camera: {
        devices: cameras,
        value: 'cam:built-in',
        disabled: false,
        status: { label: 'Live', tone: 'good' },
        facts: '3840 × 2160 · 25 fps',
        shortfall: 'This camera only offers 3840×2160 at 25 fps.',
        onChange: noop
      }
    })
    expect(markup).toContain('This camera only offers 3840×2160 at 25 fps.')
    expect(markup).not.toContain('3840 × 2160 · 25 fps')
    expect(markup).toContain('data-tone="warning"')
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
          hint: 'It is not connected. Reconnect it, or pick another.'
        },
        facts: null,
        shortfall: null,
        onChange: noop
      }
    })
    expect(markup).toContain('>Not found<')
    expect(markup).toContain('It is not connected. Reconnect it, or pick another.')
  })

  it('leads with one permission alert and disables what it locks', () => {
    const markup = render({
      screen: {
        devices: screens.map((device) => ({ ...device, status: 'permission-required' as const })),
        value: undefined,
        allowNone: true,
        disabled: true,
        status: null,
        facts: null,
        onChange: noop
      },
      screenPermission: { targetName: 'videorc-backend', onOpen: noop, onReveal: noop }
    })
    expect(markup).toContain('Screen Recording permission is required for videorc-backend.')
    expect(markup).toContain('Open Screen Recording')
    expect(markup.match(/Screen Recording permission is required/g)).toHaveLength(1)
    // The alert comes before the list it is about.
    expect(markup.indexOf('Open Screen Recording')).toBeLessThan(
      markup.indexOf('data-slot="grouped-list"')
    )
    expect(markup).toMatch(
      /data-disabled="true"[^>]*data-slot="source-item"[^>]*data-source="screen"/
    )
  })

  it('names the camera action the platform offers', () => {
    const markup = render({
      cameraPermission: {
        targetName: 'Videorc',
        actionLabel: 'Enable Camera',
        onOpen: noop,
        onReveal: noop
      }
    })
    expect(markup).toContain('Camera permission is required for Videorc.')
    expect(markup).toContain('>Enable Camera<')
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
    const toggle = markup.match(/<button[^>]*data-videorc-synthetic-source-toggle[^>]*>/)?.[0]
    expect(toggle).toContain('role="switch"')
    expect(toggle).toContain('aria-checked="false"')
  })
})
