// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { CohostPane } from '@/components/cohost-pane'
import type { CohostFlag, CohostState } from '@/lib/backend'
import { EMPTY_COHOST_STATE } from '@/lib/cohost-view'

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

const flag: CohostFlag = {
  messageId: 'session-1:twitch:default:m-9',
  kind: 'toxicity',
  severity: 'high',
  reason: 'Insult aimed at another viewer.',
  at: '2026-10-04T11:59:50.000Z'
}

function state(overrides: Partial<CohostState> = {}): CohostState {
  return {
    ...EMPTY_COHOST_STATE,
    sessionId: 'session-1',
    status: 'listening',
    flags: [flag],
    ...overrides
  }
}

async function renderPane(props: Partial<Parameters<typeof CohostPane>[0]> = {}): Promise<void> {
  await act(async () =>
    root.render(
      createElement(CohostPane, {
        consented: true,
        enabled: true,
        gate: { allowed: true },
        state: state(),
        onAnswered: () => undefined,
        onDismissFlag: () => undefined,
        onDismissQuestion: () => undefined,
        onReply: () => undefined,
        onJumpToMessage: () => undefined,
        onRemoveFlagged: () => undefined,
        removableMessageIds: new Set([flag.messageId]),
        ...props
      })
    )
  )
}

function action(label: string): HTMLButtonElement | undefined {
  return [
    ...container.querySelectorAll<HTMLButtonElement>('[data-slot="cohost-actions"] button')
  ].find((button) => button.textContent?.startsWith(label))
}

function pressOnList(key: string, init: KeyboardEventInit = {}): void {
  const list = container.querySelector<HTMLElement>('[data-slot="command"]')
  expect(list).toBeTruthy()
  list!.dispatchEvent(
    new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init })
  )
}

describe('CohostPane: Remove from chat on a flagged message (plan 140, S6)', () => {
  it('sits next to the flag actions as the one destructive action, with its key', async () => {
    const onRemoveFlagged = vi.fn()
    await renderPane({ onRemoveFlagged })
    const remove = action('Remove from chat')
    expect(remove).toBeTruthy()
    expect(remove!.dataset.variant).toBe('destructive')
    expect(remove!.title).toBe('Remove from chat (⇧⌫)')
    expect(action('Dismiss')?.dataset.variant).toBe('ghost')
    await act(async () => remove!.click())
    expect(onRemoveFlagged).toHaveBeenCalledWith(flag)
  })

  it('stays away for a message that cannot be removed now', async () => {
    await renderPane({ removableMessageIds: new Set() })
    expect(action('Remove from chat')).toBeUndefined()
    expect(action('Dismiss')).toBeTruthy()
    await renderPane({ onRemoveFlagged: undefined })
    expect(action('Remove from chat')).toBeUndefined()
  })

  it('⇧⌫ removes, ⌫ alone still dismisses, and ⇧⌫ never falls back to a dismissal', async () => {
    const onRemoveFlagged = vi.fn()
    const onDismissFlag = vi.fn()
    await renderPane({ onRemoveFlagged, onDismissFlag })
    await act(async () => pressOnList('Backspace', { shiftKey: true }))
    expect(onRemoveFlagged).toHaveBeenCalledWith(flag)
    expect(onDismissFlag).not.toHaveBeenCalled()
    await act(async () => pressOnList('Backspace'))
    expect(onDismissFlag).toHaveBeenCalledWith(flag)

    onRemoveFlagged.mockClear()
    onDismissFlag.mockClear()
    await renderPane({ removableMessageIds: new Set(), onRemoveFlagged, onDismissFlag })
    await act(async () => pressOnList('Delete', { shiftKey: true }))
    expect(onRemoveFlagged).not.toHaveBeenCalled()
    expect(onDismissFlag).not.toHaveBeenCalled()
  })

  it('says Golem acts only when asked', async () => {
    await renderPane()
    const hint = container.querySelector<HTMLElement>('[data-slot="cohost-acts-on-ask"]')
    expect(hint?.textContent).toBe('Golem never acts on its own.')
    expect(hint?.title).toBe(
      'Golem never acts on its own. It removes a comment only when you tell it to.'
    )
  })
})
