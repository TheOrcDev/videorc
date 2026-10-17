// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { CloudResumeNotice } from '@/components/studio/cloud-resume-notice'
import { TooltipProvider } from '@/components/ui/tooltip'
import type { CloudStatus } from '@/lib/backend'
import { cloudResumeNotice } from '@/lib/cloud-view'

import { CloudSection } from './cloud-section'

// Plan 184 C5 and C6: the Livestream page's Videorc Cloud section and the
// Studio's Resume notice. Locked means disabled with one reason: a Basic
// account sees the Premium sentence over the switched-off controls, a paid
// account the cloud isn't on for yet sees why, and a running session locks
// the section under the page's own lock.

const studio = vi.hoisted(() => ({
  cloud: {
    cloudStatus: null as CloudStatus | null,
    setCloudSettings: vi.fn(async () => {}),
    refreshCloudAllowance: vi.fn(async () => {}),
    endCloudShow: vi.fn(async () => {})
  },
  core: {
    isSessionActive: false,
    screens: [{ id: 'screen-1', name: 'Starting soon' }]
  }
}))

vi.mock('@/hooks/use-studio', () => ({
  useStudioCloud: () => studio.cloud,
  useStudioCore: () => studio.core
}))

function status(overrides: Partial<CloudStatus> = {}): CloudStatus {
  return {
    phase: 'off',
    entitled: true,
    plan: 'premium',
    settings: { enabled: true, holdMaxSeconds: 1800, holdMaxChoices: [300, 900, 1800, 3600] },
    allowance: {
      enabled: true,
      secondsPerMonth: 36_000,
      secondsUsed: 3_600,
      overageSeconds: 0,
      resetAt: '2026-11-01T00:00:00.000Z',
      talkShows: false
    },
    connected: false,
    directFallbackAvailable: false,
    ...overrides
  }
}

function renderSection(next: CloudStatus | null, sessionActive = false): string {
  studio.cloud.cloudStatus = next
  studio.core.isSessionActive = sessionActive
  return renderToStaticMarkup(createElement(TooltipProvider, null, createElement(CloudSection)))
}

function switchMarkup(html: string): string {
  return html.match(/<button[^>]*role="switch"[^>]*>/)?.[0] ?? ''
}

function checkedHold(html: string): string | undefined {
  return html.match(/aria-checked="true"[^>]*>([^<]+)</)?.[1]
}

beforeEach(() => {
  studio.cloud.setCloudSettings.mockClear()
  studio.cloud.endCloudShow.mockClear()
})

describe('Videorc Cloud section (plan 184 C6)', () => {
  it('stays away until the backend answers', () => {
    expect(renderSection(null)).toBe('')
  })

  it('locks behind the Premium sentence for a Basic account, switched off', () => {
    const html = renderSection(status({ entitled: false, plan: undefined }))
    expect(html).toContain('Videorc Cloud is part of Videorc Premium.')
    expect(html).toContain('View Premium')
    expect(switchMarkup(html)).toContain('aria-checked="false"')
    expect(switchMarkup(html)).toContain('disabled=""')
    // The locked section still shows what the cloud does.
    expect(html).toContain('End the stream after')
    expect(html).not.toContain('cloud hours left')
  })

  it('says the cloud is not on yet for a paid account, with no Premium prompt', () => {
    const html = renderSection(status({ entitled: false, plan: 'max' }))
    expect(html).toContain('Videorc Cloud isn&#x27;t on for your account yet.')
    expect(html).not.toContain('View Premium')
    expect(switchMarkup(html)).toContain('disabled=""')
  })

  it('opens for an entitled account: the switch, the hours and the hold choices', () => {
    const html = renderSection(status())
    expect(html).not.toContain('data-variant="locked"')
    expect(switchMarkup(html)).toContain('aria-checked="true"')
    expect(switchMarkup(html)).not.toContain('disabled=""')
    expect(html).toContain('9 of 10 cloud hours left · resets Nov 1')
    expect(html).toContain('If this computer drops, show')
    expect(checkedHold(html)).toBe('30 min')
    for (const choice of ['5 min', '15 min', '1 hour']) expect(html).toContain(choice)
  })

  it('folds the hold choices away while the switch is off', () => {
    const html = renderSection(status({ settings: { ...status().settings, enabled: false } }))
    expect(switchMarkup(html)).toContain('aria-checked="false"')
    expect(html).not.toContain('End the stream after')
  })

  it('locks every control while a recording or livestream runs', () => {
    const html = renderSection(status(), true)
    expect(switchMarkup(html)).toContain('disabled=""')
    expect(html).toContain('aria-disabled="true"')
  })
})

describe('Videorc Cloud resume notice (plan 184 C5)', () => {
  let container: HTMLDivElement
  let root: Root
  const holding = status({
    phase: 'hold',
    show: { id: 'sh_1', nodeId: 'eu-hel-1', resumable: true },
    hold: { active: true, remainingSeconds: 1_650 }
  })

  beforeEach(() => {
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
    document.body.innerHTML = ''
  })

  function renderNotice(props: { blockedReason?: string | null; pending?: boolean } = {}): {
    onResume: ReturnType<typeof vi.fn>
  } {
    const onResume = vi.fn()
    act(() => {
      root.render(
        createElement(
          TooltipProvider,
          null,
          createElement(CloudResumeNotice, {
            blockedReason: props.blockedReason ?? null,
            notice: cloudResumeNotice(holding, false)!,
            pending: props.pending ?? false,
            onResume
          })
        )
      )
    })
    return { onResume }
  }

  function button(testId: string): HTMLButtonElement {
    const element = document.querySelector<HTMLButtonElement>(`[data-testid="${testId}"]`)
    if (!element) throw new Error(`missing ${testId}`)
    return element
  }

  it('says the show is still live and resumes through Go Live', () => {
    const { onResume } = renderNotice()
    expect(container.textContent).toContain("You're still live through Videorc Cloud.")
    expect(container.textContent).toContain('The stream ends in 28 min unless you resume.')
    act(() => button('cloud-resume').click())
    expect(onResume).toHaveBeenCalledOnce()
  })

  it('keeps Resume off while Go Live is blocked or a start runs', () => {
    renderNotice({ blockedReason: 'Turn on a destination first.' })
    expect(button('cloud-resume').disabled).toBe(true)
    renderNotice({ pending: true })
    expect(button('cloud-resume').textContent).toBe('Resuming…')
    expect(button('cloud-end').disabled).toBe(true)
  })

  it('asks before ending the stream, and Keep streaming changes nothing', () => {
    renderNotice()
    act(() => button('cloud-end').click())
    expect(document.body.textContent).toContain('End livestream?')
    act(() => button('cloud-end-livestream-cancel').click())
    expect(studio.cloud.endCloudShow).not.toHaveBeenCalled()
    act(() => button('cloud-end').click())
    act(() => button('cloud-end-livestream-confirm').click())
    expect(studio.cloud.endCloudShow).toHaveBeenCalledOnce()
  })
})
