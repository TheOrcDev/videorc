import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { TooltipProvider } from '@/components/ui/tooltip'
import type { CaptionsStatus } from '@/lib/backend'
import { CAPTIONS_OFF_HINT } from '@/lib/captions-page-view'
import { defaultCaptureConfig, type CaptureConfig } from '@/lib/capture'
import { DEFAULT_OVERLAY_LAYOUT } from '@/lib/overlay-layout'

import { CaptionsControls } from './captions-controls'

// Plan 174 S3.7: the Captions page leads with its lock and disables what is
// under it (D-10), says its state once (V-5), and points to Sources and Scene
// for the microphone and the placement in one allowance unit (D-27).

const mocked = vi.hoisted(() => ({
  core: {} as Record<string, unknown>,
  gate: { allowed: true } as { allowed: boolean; reason?: string; upgradeUrl?: string }
}))
vi.mock('@/hooks/use-studio', () => ({
  useStudioCore: () => mocked.core,
  useStudioCaptions: () => ({ captionLines: [] })
}))
vi.mock('@/lib/entitlement-ui', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/entitlement-ui')>()),
  cloudAiUploadGate: () => mocked.gate
}))

function render({
  enabled = false,
  status = { state: 'idle' } as CaptionsStatus,
  microphoneId = 'mic-1' as string | null,
  overlayCaptions = { showOnStream: true, showInRecording: false },
  platform = 'darwin'
} = {}): string {
  const captureConfig: CaptureConfig = {
    ...defaultCaptureConfig,
    sources: {
      ...defaultCaptureConfig.sources,
      microphoneId: microphoneId ?? undefined,
      microphoneName: 'Shure MV7'
    },
    captions: { ...defaultCaptureConfig.captions, enabled }
  }
  mocked.core = {
    captionsCommandPending: false,
    captionsStatus: status,
    captionsWindow: { open: false, enabled: true },
    captureConfig,
    entitlements: null,
    isSessionActive: false,
    overlayLayout: {
      ...DEFAULT_OVERLAY_LAYOUT,
      captions: { ...DEFAULT_OVERLAY_LAYOUT.captions, ...overlayCaptions }
    },
    runtimeInfo: { platform },
    selectedMicrophone: undefined,
    setCaptureConfig: vi.fn(),
    startCaptions: vi.fn(),
    toggleCaptionsWindow: vi.fn()
  }
  return renderToStaticMarkup(createElement(TooltipProvider, null, createElement(CaptionsControls)))
}

/** The opening tag that carries `marker`. */
const tagWith = (markup: string, marker: string): string => {
  const at = markup.indexOf(marker)
  expect(at, marker).toBeGreaterThan(-1)
  return markup.slice(markup.lastIndexOf('<', at), markup.indexOf('>', at) + 1)
}

const disabledAttr = (markup: string, marker: string): boolean =>
  /\s(?:disabled=""|data-disabled=""|aria-disabled="true")/.test(tagWith(markup, marker))

const styleItemsDisabled = (markup: string): boolean[] =>
  [...markup.matchAll(/<button[^>]*data-slot="toggle-group-item"[^>]*>/g)].map((match) =>
    /\sdisabled=""/.test(match[0])
  )

beforeEach(() => {
  mocked.gate = { allowed: true }
})

describe('Captions page (plan 174 S3.7)', () => {
  it('leads with the Premium lock and disables every control under it (D-10)', () => {
    mocked.gate = {
      allowed: false,
      reason: 'Live captions is part of Videorc Premium.',
      upgradeUrl: 'https://videorc.com/premium'
    }
    const markup = render()
    const lock = markup.indexOf('Live captions is part of Videorc Premium.')
    expect(lock).toBeGreaterThan(-1)
    expect(lock).toBeLessThan(markup.indexOf('data-testid="captions-enabled-row"'))
    expect(disabledAttr(markup, 'role="switch"')).toBe(true)
    expect(styleItemsDisabled(markup)).not.toContain(false)
    expect(styleItemsDisabled(markup).length).toBeGreaterThan(0)
    expect(disabledAttr(markup, 'aria-label="Caption text size"')).toBe(true)
    expect(disabledAttr(markup, 'id="caption-language"')).toBe(true)
  })

  it('lets Linux choose captions on the shared microphone bus', () => {
    const off = render({ platform: 'linux' })
    expect(off).not.toContain('data-testid="captions-platform-unavailable"')
    expect(disabledAttr(off, 'role="switch"')).toBe(false)
    const on = render({ platform: 'linux', enabled: true })
    expect(disabledAttr(on, 'role="switch"')).toBe(false)
    expect(on).not.toContain('data-testid="captions-platform-unavailable"')
  })

  it('keeps everything usable when captions are part of the plan', () => {
    const markup = render()
    expect(markup).not.toContain('data-variant="locked"')
    expect(disabledAttr(markup, 'role="switch"')).toBe(false)
    expect(disabledAttr(markup, 'id="caption-language"')).toBe(false)
  })

  it('says the state once: no chip beside the switch, one dot while on (V-5)', () => {
    const off = render()
    expect(off).not.toContain('data-slot="status-badge"')
    expect(off).not.toContain('data-slot="status-dot"')
    expect(off).toContain(CAPTIONS_OFF_HINT)
    expect(off).toContain('>Live captions<')

    const failed = render({
      enabled: true,
      status: { state: 'error', message: 'The caption service refused the audio format.' }
    })
    expect(failed.match(/data-slot="status-dot"/g)).toHaveLength(1)
    expect(failed).toContain('>Failed<')
    expect(failed).toContain('The caption service refused the audio format.')
  })

  it('names the microphone and the placement, and opens their pages (D-27)', () => {
    const markup = render()
    expect(markup).toMatch(/Microphone<\/span>[^]*Shure MV7/)
    expect(markup).toContain('Bottom, on stream')
    expect(markup).not.toMatch(/Realtime|Live transcription|credits/)
    expect(
      markup.match(
        /data-slot="navigable-row"[^>]*type="button"|<button[^>]*data-slot="navigable-row"/g
      )
    ).toHaveLength(2)
    expect(render({ microphoneId: null })).toMatch(/Microphone<\/span>[^]*>Off</)
    expect(render({ overlayCaptions: { showOnStream: false, showInRecording: false } })).toContain(
      '>Hidden<'
    )
  })

  it('counts the allowance in minutes this month, once it is known', () => {
    expect(render()).not.toContain('left this month')
    expect(
      render({ enabled: true, status: { state: 'listening', remainingSeconds: 3_570 } })
    ).toContain('60 min left this month')
  })
})
