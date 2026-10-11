// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { TooltipProvider } from '@/components/ui/tooltip'
import type { GoLiveDestinationPreflight, GoLivePreflight } from '@/lib/backend'
import { defaultCaptureConfig } from '@/lib/capture'
import type { GoLiveCaptionsReadiness } from '@/lib/captions-preflight'
import type { EntitlementUiGate } from '@/lib/entitlement-ui'
import { DEFAULT_OVERLAY_LAYOUT } from '@/lib/overlay-layout'

import { GoLiveConfirmationDialog, GoLiveDestinationRow } from './go-live-dialog'

// Plan 174 S2.2 (D3, D-7, B-11): the Go Live dialog speaks the one verb pair.
// Its title is "Go live", its primary says what it starts, a blocked primary
// keeps its label and says why on hover and focus, and a destination reads
// "Sign in" or "Stream key", never OAuth or Manual RTMP.

vi.mock('@/hooks/use-studio', () => ({
  useStudioCore: () => ({
    captureConfig: defaultCaptureConfig,
    performanceCheck: undefined,
    streamOutputTopologyPreflight: { state: 'idle' },
    streamSharedEncodeFallbackVideo: null,
    overlayLayout: DEFAULT_OVERLAY_LAYOUT
  })
}))

const noop = (): void => {}
const ALLOWED: EntitlementUiGate = { allowed: true }
const CAPTIONS_OFF: GoLiveCaptionsReadiness = {
  kind: 'disabled',
  blocksStart: false,
  title: '',
  description: '',
  transport: null
}

function destination(
  overrides: Partial<GoLiveDestinationPreflight> = {}
): GoLiveDestinationPreflight {
  return {
    targetId: 'twitch',
    platform: 'twitch',
    label: 'Twitch',
    authMode: 'oauth',
    ready: true,
    title: 'Friday build',
    description: '',
    message: 'Ready to go live.',
    chatRead: 'ready',
    chatWrite: 'ready',
    chatMessage: '',
    ...overrides
  }
}

describe('GoLiveDestinationRow (plan 174 S2.2)', () => {
  it('says how a destination connects in the Livestream page words', () => {
    const signIn = renderToStaticMarkup(
      createElement(GoLiveDestinationRow, {
        destination: destination(),
        pending: false,
        onResolveBlocker: noop
      })
    )
    const key = renderToStaticMarkup(
      createElement(GoLiveDestinationRow, {
        destination: destination({ authMode: 'manual-rtmp' }),
        pending: false,
        onResolveBlocker: noop
      })
    )
    expect(signIn).toContain('>Sign in<')
    expect(key).toContain('>Stream key<')
    for (const markup of [signIn, key]) {
      expect(markup).not.toContain('OAuth')
      expect(markup).not.toContain('Manual RTMP')
    }
  })

  it('offers "Use stream key", the one name for that fix', () => {
    const onResolveBlocker = vi.fn()
    const markup = renderToStaticMarkup(
      createElement(GoLiveDestinationRow, {
        destination: destination({ ready: false }),
        pending: false,
        onResolveBlocker
      })
    )
    expect(markup).toContain('Use stream key')
    expect(markup).toContain('Go live without Twitch')
    expect(markup).not.toContain('Switch to')
  })
})

describe('GoLiveConfirmationDialog labels (plan 174 S2.2)', () => {
  let root: Root
  let container: HTMLDivElement

  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
    document.body.innerHTML = ''
    vi.unstubAllGlobals()
  })

  function renderDialog({
    preflight,
    partialSetup = null,
    pending = false
  }: {
    preflight: GoLivePreflight
    partialSetup?: { streaming: never; failures: never[]; readyLabels: string[] } | null
    pending?: boolean
  }): void {
    act(() =>
      root.render(
        createElement(
          TooltipProvider,
          null,
          createElement(GoLiveConfirmationDialog, {
            open: true,
            pending,
            partialSetup,
            preflight,
            entitlementGate: ALLOWED,
            draft: null,
            captionsReadiness: CAPTIONS_OFF,
            onPatchDraft: noop as never,
            onCancel: noop,
            onConfirm: noop,
            onContinuePartial: noop,
            onContinueWithoutCaptions: noop,
            onResolveBlocker: noop
          })
        )
      )
    )
  }

  const dialog = (): HTMLElement => document.querySelector<HTMLElement>('[role=dialog]')!
  const primary = (): HTMLButtonElement => {
    const buttons = [
      ...dialog().querySelectorAll<HTMLButtonElement>('[data-slot=dialog-footer] button')
    ]
    return buttons[buttons.length - 1]!
  }

  it('is titled "Go live" and counts the destinations it starts', () => {
    renderDialog({
      preflight: {
        valid: true,
        issues: [],
        destinations: [
          destination(),
          destination({ targetId: 'kick', platform: 'kick', label: 'Kick' })
        ]
      }
    })
    expect(dialog().querySelector('[data-slot=dialog-title]')?.textContent).toBe('Go live')
    expect(primary().textContent?.trim()).toBe('Go live on 2 destinations')
    expect(primary().disabled).toBe(false)
    expect(dialog().textContent).not.toMatch(/Confirm Go Live|metadata/)
  })

  it('reads plain "Go live" for one destination', () => {
    renderDialog({ preflight: { valid: true, issues: [], destinations: [destination()] } })
    expect(primary().textContent?.trim()).toBe('Go live')
  })

  it('keeps its label while blocked, and says why on hover and focus', () => {
    renderDialog({
      preflight: {
        valid: false,
        issues: [
          {
            severity: 'error',
            targetId: 'twitch',
            platform: 'twitch',
            message: 'Reconnect Twitch.'
          }
        ],
        destinations: [destination({ ready: false })]
      }
    })
    expect(primary().textContent?.trim()).toBe('Go live')
    expect(primary().disabled).toBe(true)
    const wrapper = primary().closest<HTMLElement>('[data-slot=disabled-reason]')
    expect(wrapper?.tabIndex).toBe(0)
    expect(
      document.getElementById(wrapper?.getAttribute('aria-describedby') ?? '')?.textContent
    ).toBe('Fix the items above, then go live.')
    expect(dialog().textContent).not.toMatch(/Resolve Blockers First/)
  })

  it('names the ready destination after a partial setup', () => {
    renderDialog({
      preflight: { valid: true, issues: [], destinations: [destination()] },
      partialSetup: { streaming: undefined as never, failures: [], readyLabels: ['Twitch'] }
    })
    expect(primary().textContent?.trim()).toBe('Go live on Twitch')
    expect(dialog().textContent).not.toMatch(/Continue With Ready/)
  })
})
