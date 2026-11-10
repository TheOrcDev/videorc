// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ChatCommandFailureRows } from './chat-command-failures'
import { StreamManagerStatusBar } from './stream-manager-status-bar'

// Plan 226 S4: ⋯ Chat commands… opens the section in the main window, and a
// reply that couldn't go out shows once over the chat, until dismissed.

let root: Root
let container: HTMLDivElement

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  // Base UI finishes closing the menu on an animation frame.
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) =>
    window.setTimeout(() => callback(performance.now()), 16)
  )
  vi.stubGlobal('cancelAnimationFrame', (id: number) => window.clearTimeout(id))
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

async function moreMenuItems(): Promise<HTMLElement[]> {
  const more = container.querySelector<HTMLButtonElement>(
    '[aria-label="More Stream Manager actions"]'
  )!
  await act(async () => more.click())
  await vi.waitFor(() => expect(document.querySelector('[role=menu]')).not.toBeNull())
  return [...document.querySelectorAll<HTMLElement>('[role=menuitem]')]
}

describe('Stream Manager chat commands (plan 226 S4)', () => {
  it('opens the section from the ⋯ menu, and leaves the item out without the door', async () => {
    const onOpenChatCommands = vi.fn()
    await act(async () =>
      root.render(
        createElement(StreamManagerStatusBar, {
          providers: [],
          audience: null,
          alwaysOnTop: false,
          onOpenChatCommands
        })
      )
    )
    const item = (await moreMenuItems()).find((row) => row.textContent === 'Chat commands…')
    expect(item).toBeDefined()
    await act(async () => item!.click())
    expect(onOpenChatCommands).toHaveBeenCalledOnce()

    await act(async () => root.unmount())
    document.body.innerHTML = ''
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    await act(async () =>
      root.render(
        createElement(StreamManagerStatusBar, { providers: [], audience: null, alwaysOnTop: false })
      )
    )
    const items = await moreMenuItems()
    expect(items.some((row) => row.textContent === 'Chat commands…')).toBe(false)
  })

  it('keeps the door in the bar above 640 px, where the ⋯ menu is hidden', async () => {
    const onOpenChatCommands = vi.fn()
    await act(async () =>
      root.render(
        createElement(StreamManagerStatusBar, {
          providers: [],
          audience: null,
          alwaysOnTop: false,
          onOpenChatCommands
        })
      )
    )
    const actions = container.querySelector('[data-slot="stream-manager-actions"]')!
    const door = actions.querySelector<HTMLButtonElement>('[aria-label="Chat commands…"]')
    expect(door).not.toBeNull()
    expect(door!.textContent).toContain('Commands')
    await act(async () => door!.click())
    expect(onOpenChatCommands).toHaveBeenCalledOnce()
  })

  it('names each failed reply with the platform, once, until dismissed', async () => {
    const failures = [
      {
        sessionId: 's1',
        destinationId: 'youtube-main',
        platform: 'youtube' as const,
        command: 'go',
        reason: 'reconnect YouTube to allow chat posts.'
      },
      {
        sessionId: 's1',
        destinationId: 'twitch',
        platform: 'twitch' as const,
        command: 'faq',
        reason: 'Twitch is limiting messages right now.'
      }
    ]
    await act(async () => root.render(createElement(ChatCommandFailureRows, { failures })))
    const rows = () =>
      [...container.querySelectorAll('[data-testid="chat-command-failure"]')].map(
        (row) => row.textContent
      )
    expect(rows()).toEqual([
      "!go couldn't answer on YouTube: reconnect YouTube to allow chat posts.",
      "!faq couldn't answer on Twitch: Twitch is limiting messages right now."
    ])
    const dismiss = container.querySelector<HTMLButtonElement>(
      `[aria-label="Dismiss: !go couldn't answer on YouTube: reconnect YouTube to allow chat posts."]`
    )!
    await act(async () => dismiss.click())
    expect(rows()).toEqual([
      "!faq couldn't answer on Twitch: Twitch is limiting messages right now."
    ])
    await act(async () => root.render(createElement(ChatCommandFailureRows, { failures: [] })))
    expect(container.querySelector('[data-slot="chat-command-failures"]')).toBeNull()
  })
})
