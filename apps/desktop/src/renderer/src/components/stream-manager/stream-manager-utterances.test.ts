// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { StreamManager, type StreamManagerProps } from '@/components/stream-manager/stream-manager'
import type { CohostUtterance, LiveChatSnapshot } from '@/lib/backend'
import { EMPTY_COHOST_STATE } from '@/lib/cohost-view'

const snapshot: LiveChatSnapshot = {
  sessionId: 's1',
  providers: [],
  messages: [],
  unreadCount: 0,
  updatedAt: '2026-10-10T12:00:05Z'
}

const proposed: CohostUtterance = {
  id: 'u-1',
  text: 'Welcome in, coders_x!',
  state: 'talk',
  trigger: { kind: 'greeting', eventId: 'e-1' },
  destinationIds: [],
  status: 'proposed',
  at: '2026-10-10T12:00:06Z',
  expiresAt: '2099-01-01T00:00:00Z'
}

let root: Root
let container: HTMLDivElement

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  document.body.innerHTML = ''
  vi.unstubAllGlobals()
})

async function render(
  utterances: CohostUtterance[],
  patch: Partial<StreamManagerProps> = {}
): Promise<void> {
  await act(async () =>
    root.render(
      createElement(StreamManager, {
        snapshot,
        dashboard: null,
        cohostGate: { allowed: true },
        cohostConsented: true,
        cohostEnabled: true,
        cohostState: { ...EMPTY_COHOST_STATE, sessionId: 's1', status: 'listening', utterances },
        onCohostUtteranceApprove: () => undefined,
        onCohostUtteranceDismiss: () => undefined,
        ...patch
      })
    )
  )
}

/** The active tab's label, without its unseen badge. */
function activeTab(slot: 'pane-tabs-narrow' | 'pane-tabs-wide'): string | null {
  const tab = container.querySelector<HTMLElement>(
    `[data-slot="${slot}"] [role="tab"][data-state="active"]`
  )
  if (!tab) return null
  const badge = tab.querySelector('[data-testid="pane-unseen"]')?.textContent ?? ''
  return (tab.textContent ?? '').replace(badge, '').trim().toLowerCase()
}

function buddyTabUnseen(slot: 'pane-tabs-narrow' | 'pane-tabs-wide'): string | null {
  const tab = [
    ...container.querySelectorAll<HTMLElement>(`[data-slot="${slot}"] [role="tab"]`)
  ].find((candidate) => candidate.textContent?.includes('Buddy'))
  return tab?.querySelector('[data-testid="pane-unseen"]')?.textContent ?? null
}

// The Buddy pane is never on screen in this DOM (no IntersectionObserver), the
// case these rules exist for: a proposed post behind a tab.
describe('StreamManager: a proposed Buddy post behind a tab (plan 174 S0.2)', () => {
  it('brings the Buddy pane forward for a new card, then returns to where you were', async () => {
    await render([])
    expect(activeTab('pane-tabs-narrow')).toBe('chat')
    expect(activeTab('pane-tabs-wide')).toBe('activity')

    await render([proposed])
    expect(activeTab('pane-tabs-narrow')).toBe('buddy')
    expect(activeTab('pane-tabs-wide')).toBe('buddy')
    expect(container.querySelector('[data-testid="buddy-utterance-card"]')).toBeTruthy()
    // It never takes focus from wherever the streamer is typing.
    expect(document.activeElement).toBe(document.body)

    // Sent (or dismissed, or expired): no card is open, so the panes go back.
    await render([{ ...proposed, status: 'sent' }])
    expect(container.querySelector('[data-testid="buddy-utterance-card"]')).toBeNull()
    expect(activeTab('pane-tabs-narrow')).toBe('chat')
    expect(activeTab('pane-tabs-wide')).toBe('activity')
  })

  it('counts a proposed post in the Buddy tab badge', async () => {
    await render([])
    expect(buddyTabUnseen('pane-tabs-wide')).toBeNull()
    await render([proposed])
    expect(buddyTabUnseen('pane-tabs-wide')).toBe('1')
    expect(buddyTabUnseen('pane-tabs-narrow')).toBe('1')
    await render([proposed, { ...proposed, id: 'u-2', at: '2026-10-10T12:00:09Z' }])
    expect(buddyTabUnseen('pane-tabs-wide')).toBe('2')
  })

  it('never posts on Enter while the Buddy pane is not on screen', async () => {
    const onCohostUtteranceApprove = vi.fn()
    const onCohostUtteranceDismiss = vi.fn()
    await render([proposed], { onCohostUtteranceApprove, onCohostUtteranceDismiss })
    expect(document.activeElement).toBe(document.body)
    await act(async () => {
      window.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
      )
      window.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Backspace', bubbles: true, cancelable: true })
      )
    })
    expect(onCohostUtteranceApprove).not.toHaveBeenCalled()
    expect(onCohostUtteranceDismiss).not.toHaveBeenCalled()
    // The buttons still work.
    const send = container.querySelector<HTMLButtonElement>('[data-testid="buddy-utterance-send"]')
    await act(async () => send!.click())
    expect(onCohostUtteranceApprove).toHaveBeenCalledWith(proposed)
  })
})
