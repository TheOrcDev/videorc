// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { ScopeReconnectPlatform } from '@/lib/backend'

import {
  RemoveMessagesReconnectRows,
  removeMessagesReconnectStarted
} from './remove-messages-reconnect'

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

async function render(
  platforms: ScopeReconnectPlatform[],
  onReconnect: (platform: ScopeReconnectPlatform) => void = vi.fn()
): Promise<void> {
  await act(async () =>
    root.render(createElement(RemoveMessagesReconnectRows, { platforms, onReconnect }))
  )
}

const rows = (): HTMLElement[] => [
  ...container.querySelectorAll<HTMLElement>('[data-slot="remove-messages-reconnect"] li')
]

describe('RemoveMessagesReconnectRows (plan 140, S5)', () => {
  it('renders nothing when every platform can remove messages', async () => {
    await render([])
    expect(container.innerHTML).toBe('')
  })

  it('says what a reconnect gives, one quiet row per platform', async () => {
    await render(['twitch', 'kick'])
    expect(rows().map((row) => row.dataset.platform)).toEqual(['twitch', 'kick'])
    expect(rows()[0].textContent).toContain('Reconnect Twitch to let Golem remove messages.')
    expect(rows()[1].textContent).toContain('Reconnect Kick to let Golem remove messages.')
    // Quiet: plain outline buttons, no alert and no tinted status.
    expect(container.querySelector('[role="alert"]')).toBeNull()
    expect(container.querySelector('[data-slot="alert"]')).toBeNull()
    expect(
      [...container.querySelectorAll('button')].map((button) => button.dataset.variant)
    ).toEqual(['outline', 'outline'])
  })

  it('Reconnect names the row platform and nothing else', async () => {
    const onReconnect = vi.fn()
    await render(['twitch', 'kick'], onReconnect)
    const kick = rows()[1].querySelector('button')
    expect(kick?.textContent).toBe('Reconnect')
    await act(async () => kick!.click())
    expect(onReconnect).toHaveBeenCalledTimes(1)
    expect(onReconnect).toHaveBeenCalledWith('kick')
  })

  it('confirms the browser opened in plain words', () => {
    expect(removeMessagesReconnectStarted('twitch')).toEqual({
      title: 'Approve the Twitch permission in your browser',
      description: 'Golem can remove messages once Twitch confirms.'
    })
    expect(removeMessagesReconnectStarted('kick').title).toBe(
      'Approve the Kick permission in your browser'
    )
  })
})
