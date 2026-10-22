// @vitest-environment happy-dom
import { act, createElement as h, type ComponentProps, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { OFFLINE_LOCK_REASON, SESSION_LOCK_REASON } from '@/lib/lock-view'
import { VIDEORC_PREMIUM_URL } from '@/lib/premium-upgrade'
import { LockAlert, OfflineAlert, SessionLockAlert } from './lock-alert'

// Plan 174 S1.5 (D-13, J2-9): a lock says why in one line and offers at most
// one action. Premium features stay on screen behind it (owner call
// 2026-10-10), so the lock is a row, never a replacement for the page.

const links = vi.hoisted(() => ({
  open: vi.fn(),
  signIn: vi.fn()
}))
vi.mock('@/lib/videorc-web-links', () => ({
  openVideorcWebLink: links.open,
  beginVideorcSignIn: links.signIn
}))

let root: Root
let container: HTMLDivElement

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  links.open.mockReset()
  links.signIn.mockReset()
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})

async function render(element: ReactElement): Promise<HTMLElement> {
  await act(async () => root.render(element))
  return container.querySelector<HTMLElement>('[data-slot="alert"]')!
}

describe('LockAlert', () => {
  it('is a polite locked line: the lock, the reason, no action', async () => {
    const alert = await render(h(LockAlert, { reason: 'Clean cut is part of Videorc Premium.' }))
    expect(alert.getAttribute('role')).toBe('status')
    expect(alert.dataset.variant).toBe('locked')
    expect(alert.querySelectorAll('svg')).toHaveLength(1)
    expect(alert.textContent).toBe('Clean cut is part of Videorc Premium.')
    expect(alert.querySelector('button')).toBeNull()
  })

  it('opens Premium from its one action', async () => {
    const props: ComponentProps<typeof LockAlert> & { 'data-testid': string } = {
      action: { kind: 'view-premium', url: VIDEORC_PREMIUM_URL },
      'data-testid': 'lock',
      reason: 'Live captions are part of Videorc Premium.'
    }
    const alert = await render(h(LockAlert, props))
    expect(alert.dataset.testid).toBe('lock')
    const buttons = alert.querySelectorAll('button')
    expect(buttons).toHaveLength(1)
    expect(buttons[0]!.textContent).toBe('View Premium')
    await act(async () => buttons[0]!.click())
    expect(links.open).toHaveBeenCalledWith(VIDEORC_PREMIUM_URL)
    expect(links.signIn).not.toHaveBeenCalled()
  })

  it('starts sign-in from its one action', async () => {
    const alert = await render(
      h(LockAlert, { action: { kind: 'sign-in' }, reason: 'Sign in to use Buddy.' })
    )
    const button = alert.querySelector('button')!
    expect(button.textContent).toBe('Sign in')
    await act(async () => button.click())
    expect(links.signIn).toHaveBeenCalledTimes(1)
    expect(links.open).not.toHaveBeenCalled()
  })
})

describe('SessionLockAlert and OfflineAlert', () => {
  it('say the one session-lock wording', async () => {
    const alert = await render(h(SessionLockAlert))
    expect(alert.textContent).toBe(SESSION_LOCK_REASON)
    expect(alert.dataset.variant).toBe('locked')
    expect(alert.querySelector('button')).toBeNull()
  })

  it('say the one offline wording', async () => {
    const alert = await render(h(OfflineAlert))
    expect(alert.textContent).toBe(OFFLINE_LOCK_REASON)
    expect(alert.getAttribute('role')).toBe('status')
  })
})
