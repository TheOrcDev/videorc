// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { LiveChatProviderState } from '@/lib/backend'

import { ChatSignInRows, chatSignInRows } from './chat-sign-in-rows'

const X_WORDS =
  'X chat needs Sign in. Your stream key still streams; X shares chat only with apps you sign in to.'

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
  vi.unstubAllGlobals()
})

function provider(overrides: Partial<LiveChatProviderState> = {}): LiveChatProviderState {
  return {
    id: 'youtube:youtube',
    platform: 'youtube',
    targetId: 'youtube',
    read: 'ready',
    write: 'ready',
    state: 'connected',
    message: 'YouTube live comments are ready.',
    ...overrides
  }
}

// What the backend sends for an X destination that streams with a key.
const streamKeyX = provider({
  id: 'x:x-manual',
  platform: 'x',
  targetId: 'x-manual',
  state: 'unsupported',
  read: 'needs-sign-in',
  write: 'unavailable',
  message: X_WORDS
})

describe('ChatSignInRows (plan 213 J1)', () => {
  it('lists only the destinations whose chat needs Sign in', () => {
    expect(chatSignInRows([provider(), streamKeyX])).toEqual([
      { id: 'x:x-manual', targetId: 'x-manual', platform: 'x', message: X_WORDS, kind: 'platform' }
    ])
    // A Sign-in X whose chat failed is a failure, not this row.
    expect(chatSignInRows([provider({ platform: 'x', state: 'failed', read: 'failed' })])).toEqual(
      []
    )
  })

  it('renders nothing when no destination needs Sign in', async () => {
    await act(async () =>
      root.render(createElement(ChatSignInRows, { providers: [provider()], onUseSignIn: vi.fn() }))
    )
    expect(container.innerHTML).toBe('')
  })

  it('says what brings chat, quietly, and Use Sign in opens that destination', async () => {
    const onUseSignIn = vi.fn()
    await act(async () =>
      root.render(
        createElement(ChatSignInRows, { providers: [provider(), streamKeyX], onUseSignIn })
      )
    )
    const rows = [...container.querySelectorAll<HTMLElement>('[data-slot="chat-sign-in"] li')]
    expect(rows.map((row) => row.dataset.platform)).toEqual(['x'])
    expect(rows[0].textContent).toContain(X_WORDS)
    // Neutral: no alert, no failure words, one outline button.
    expect(container.querySelector('[role="alert"]')).toBeNull()
    expect(container.textContent).not.toMatch(/failed|unavailable|not supported/i)
    const button = container.querySelector('button')
    expect(button?.textContent).toBe('Use Sign in')
    expect(button?.dataset.variant).toBe('outline')
    await act(async () => button?.click())
    expect(onUseSignIn).toHaveBeenCalledWith('x-manual')
  })

  // Plan 215 A3: a Sign-in X whose relay waits on the Videorc account. The
  // row names Videorc, and its button starts that sign-in, never Livestream.
  it('says Sign in to Videorc for a connector parked on the Videorc sign-in', async () => {
    const parkedX = provider({
      id: 'x:x-oauth',
      platform: 'x',
      targetId: 'x-oauth',
      accountLabel: 'Ram',
      state: 'waiting',
      read: 'needs-videorc-sign-in',
      write: 'ready',
      message: 'Sign in to Videorc to read X chat.'
    })
    expect(chatSignInRows([provider(), parkedX])).toEqual([
      {
        id: 'x:x-oauth',
        targetId: 'x-oauth',
        platform: 'x',
        message: 'Sign in to Videorc to read X chat.',
        kind: 'videorc'
      }
    ])

    const onUseSignIn = vi.fn()
    const onSignInToVideorc = vi.fn()
    await act(async () =>
      root.render(
        createElement(ChatSignInRows, {
          providers: [provider(), parkedX, streamKeyX],
          onUseSignIn,
          onSignInToVideorc
        })
      )
    )
    const rows = [...container.querySelectorAll<HTMLElement>('[data-slot="chat-sign-in"] li')]
    expect(rows.map((row) => row.dataset.kind)).toEqual(['videorc', 'platform'])
    expect(rows[0].textContent).toContain('Sign in to Videorc to read X chat.')
    expect(container.querySelector('[role="alert"]')).toBeNull()
    expect(container.textContent).not.toMatch(/failed/i)
    const buttons = [...container.querySelectorAll('button')]
    expect(buttons.map((button) => button.textContent)).toEqual([
      'Sign in to Videorc',
      'Use Sign in'
    ])
    expect(buttons[0].getAttribute('aria-label')).toBe('X: Sign in to Videorc')
    await act(async () => buttons[0].click())
    expect(onSignInToVideorc).toHaveBeenCalledTimes(1)
    expect(onUseSignIn).not.toHaveBeenCalled()

    // A view without that door (History) shows the words and no button.
    await act(async () =>
      root.render(createElement(ChatSignInRows, { providers: [parkedX], onUseSignIn }))
    )
    expect(container.textContent).toContain('Sign in to Videorc to read X chat.')
    expect(container.querySelector('button')).toBeNull()
  })
})
