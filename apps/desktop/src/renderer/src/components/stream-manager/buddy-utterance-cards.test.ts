// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { CohostUtterance } from '@/lib/backend'

import {
  BuddyUtteranceCards,
  openProposedUtterances,
  utteranceKeyAnswer
} from './buddy-utterance-cards'

const NOW = Date.parse('2026-10-10T12:00:00Z')

function utterance(patch: Partial<CohostUtterance> = {}): CohostUtterance {
  return {
    id: 'u-1',
    text: 'Welcome in, coders_x!',
    state: 'talk',
    trigger: { kind: 'greeting', eventId: 'e-1' },
    destinationIds: [],
    status: 'proposed',
    at: '2026-10-10T11:59:50Z',
    expiresAt: '2099-01-01T00:00:00Z',
    ...patch
  }
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
  {
    active = true,
    pending = false,
    onApprove = vi.fn(),
    onDismiss = vi.fn()
  }: {
    active?: boolean
    pending?: boolean
    onApprove?: (utterance: CohostUtterance) => void
    onDismiss?: (utterance: CohostUtterance) => void
  } = {}
): Promise<void> {
  await act(async () =>
    root.render(
      createElement(BuddyUtteranceCards, { utterances, active, pending, onApprove, onDismiss })
    )
  )
}

const cards = (): HTMLElement[] => [
  ...container.querySelectorAll<HTMLElement>('[data-testid="buddy-utterance-card"]')
]

function press(key: string, init: KeyboardEventInit = {}, target: EventTarget = window): void {
  target.dispatchEvent(
    new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init })
  )
}

describe('BuddyUtteranceCards (plan 164 S-D2, plan 174 S0.2)', () => {
  it('renders nothing without a card or a recent line', async () => {
    await render([])
    expect(container.innerHTML).toBe('')
    await render([utterance({ status: 'dismissed' })])
    expect(container.innerHTML).toBe('')
  })

  it('shows every proposed card with Send and Dismiss, the key chips on the newest', async () => {
    const onApprove = vi.fn()
    const onDismiss = vi.fn()
    const first = utterance({ id: 'u-1' })
    const second = utterance({ id: 'u-2', trigger: { kind: 'answer', messageId: 'm-2' } })
    await render([first, second], { onApprove, onDismiss })
    expect(cards().map((card) => card.dataset.utteranceId)).toEqual(['u-1', 'u-2'])
    const [older, newest] = cards()
    expect(older.textContent).toContain('posts as you')
    expect(older.querySelector('kbd')).toBeNull()
    expect(newest.querySelectorAll('kbd')).toHaveLength(2)

    await act(async () =>
      older.querySelector<HTMLButtonElement>('[data-testid="buddy-utterance-send"]')!.click()
    )
    expect(onApprove).toHaveBeenLastCalledWith(first)
    await act(async () =>
      newest.querySelector<HTMLButtonElement>('[data-testid="buddy-utterance-dismiss"]')!.click()
    )
    expect(onDismiss).toHaveBeenLastCalledWith(second)
  })

  it('Enter sends and ⌫ dismisses the newest card while nothing is focused', async () => {
    const onApprove = vi.fn()
    const onDismiss = vi.fn()
    const first = utterance({ id: 'u-1' })
    const second = utterance({ id: 'u-2' })
    await render([first, second], { onApprove, onDismiss })
    expect(document.activeElement).toBe(document.body)
    await act(async () => press('Enter'))
    expect(onApprove).toHaveBeenLastCalledWith(second)
    await act(async () => press('Backspace'))
    expect(onDismiss).toHaveBeenLastCalledWith(second)
    await act(async () => press('Delete'))
    expect(onDismiss).toHaveBeenCalledTimes(2)
    expect(onApprove).toHaveBeenCalledTimes(1)
  })

  it('never posts from a focused chat row, the composer, a switch or a menu', async () => {
    const onApprove = vi.fn()
    const onDismiss = vi.fn()
    await render([utterance()], { onApprove, onDismiss })
    const row = document.createElement('button')
    const composer = document.createElement('input')
    const toggle = document.createElement('button')
    toggle.setAttribute('role', 'switch')
    const menu = document.createElement('div')
    menu.setAttribute('role', 'menu')
    const item = document.createElement('div')
    item.setAttribute('role', 'menuitem')
    item.tabIndex = 0
    menu.append(item)
    document.body.append(row, composer, toggle, menu)
    for (const element of [row, composer, toggle, item]) {
      element.focus()
      expect(document.activeElement).toBe(element)
      await act(async () => press('Enter', {}, element))
      await act(async () => press('Backspace', {}, element))
    }
    expect(onApprove).not.toHaveBeenCalled()
    expect(onDismiss).not.toHaveBeenCalled()
  })

  it('stays quiet while the pane is hidden, while a send is pending, and for taken keys', async () => {
    const onApprove = vi.fn()
    const onDismiss = vi.fn()
    await render([utterance()], { active: false, onApprove, onDismiss })
    await act(async () => press('Enter'))
    await act(async () => press('Backspace'))
    expect(onApprove).not.toHaveBeenCalled()
    expect(onDismiss).not.toHaveBeenCalled()

    await render([utterance()], { pending: true, onApprove, onDismiss })
    await act(async () => press('Enter'))
    expect(onApprove).not.toHaveBeenCalled()

    await render([utterance()], { onApprove, onDismiss })
    // Held keys, modifiers and IME composition never answer.
    await act(async () => press('Enter', { repeat: true }))
    await act(async () => press('Enter', { metaKey: true }))
    await act(async () => press('Enter', { shiftKey: true }))
    await act(async () => press('Enter', { isComposing: true }))
    await act(async () => press('Backspace', { ctrlKey: true }))
    expect(onApprove).not.toHaveBeenCalled()
    expect(onDismiss).not.toHaveBeenCalled()
    // A handler that took the key first keeps it: the cards listen in the
    // bubble phase, after a row's or the composer's own handler.
    const take = (event: KeyboardEvent): void => event.preventDefault()
    window.addEventListener('keydown', take, true)
    await act(async () => press('Enter'))
    window.removeEventListener('keydown', take, true)
    expect(onApprove).not.toHaveBeenCalled()
    // And it does answer once the key is free again.
    await act(async () => press('Enter'))
    expect(onApprove).toHaveBeenCalledTimes(1)
  })

  it('lists the last lines it said under the cards', async () => {
    await render([
      utterance({ id: 'u-1', status: 'sent', text: 'gg' }),
      utterance({ id: 'u-2', status: 'failed', text: 'oops' }),
      utterance({ id: 'u-3', status: 'bubble-only', text: 'hi there' })
    ])
    const lines = [
      ...container.querySelectorAll<HTMLElement>('[data-slot="buddy-utterance-recent"] li')
    ]
    expect(lines.map((line) => line.dataset.status)).toEqual(['bubble-only', 'failed', 'sent'])
    expect(lines.map((line) => line.textContent)).toEqual([
      'Greetinghi thereOn stream',
      'GreetingoopsNot sent',
      'GreetingggPosted'
    ])
  })
})

describe('openProposedUtterances', () => {
  it('keeps proposed cards that have not expired, oldest first', () => {
    const open = utterance({ id: 'open', expiresAt: '2026-10-10T12:00:30Z' })
    const noExpiry = utterance({ id: 'forever', expiresAt: undefined })
    const expired = utterance({ id: 'expired', expiresAt: '2026-10-10T11:59:59Z' })
    const sent = utterance({ id: 'sent', status: 'sent' })
    expect(
      openProposedUtterances([sent, expired, open, noExpiry], NOW).map((entry) => entry.id)
    ).toEqual(['open', 'forever'])
  })
})

describe('utteranceKeyAnswer', () => {
  const key = (value: string, patch: Partial<KeyboardEvent> = {}) => ({
    key: value,
    defaultPrevented: false,
    repeat: false,
    isComposing: false,
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    ...patch
  })

  it('sends on Enter and dismisses on ⌫, only with nothing focused', () => {
    expect(utteranceKeyAnswer(key('Enter'), null, document.body)).toBe('send')
    expect(utteranceKeyAnswer(key('Enter'), document.body, document.body)).toBe('send')
    expect(utteranceKeyAnswer(key('Backspace'), null, document.body)).toBe('dismiss')
    expect(utteranceKeyAnswer(key('Delete'), null, document.body)).toBe('dismiss')
    const row = document.createElement('button')
    expect(utteranceKeyAnswer(key('Enter'), row, document.body)).toBeNull()
    expect(utteranceKeyAnswer(key('Backspace'), row, document.body)).toBeNull()
  })

  it('leaves every other key, and a key another handler or a modifier owns', () => {
    expect(utteranceKeyAnswer(key('Escape'), null, document.body)).toBeNull()
    expect(utteranceKeyAnswer(key('a'), null, document.body)).toBeNull()
    expect(utteranceKeyAnswer(key('Enter', { defaultPrevented: true }), null, document.body)).toBe(
      null
    )
    expect(utteranceKeyAnswer(key('Enter', { repeat: true }), null, document.body)).toBeNull()
    expect(utteranceKeyAnswer(key('Enter', { isComposing: true }), null, document.body)).toBeNull()
    expect(utteranceKeyAnswer(key('Enter', { shiftKey: true }), null, document.body)).toBeNull()
    expect(utteranceKeyAnswer(key('Backspace', { altKey: true }), null, document.body)).toBeNull()
  })
})
