// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { ModerationOperation } from '@/lib/backend'
import { removalPaneView, type RemovalAnswer } from '@/lib/chat-removal-view'

import { RemovalCards, removalKeyAnswer } from './removal-cards'

const NOW = Date.parse('2026-10-04T12:00:10Z')

function operation(patch: Partial<ModerationOperation> = {}): ModerationOperation {
  return {
    operationId: 'op-1',
    sessionId: 'session-1',
    messageId: 'session-1:twitch:default:m-1',
    platform: 'twitch',
    authorName: 'coders_x',
    excerpt: 'this stream is trash',
    source: 'orcle-voice',
    reason: 'toxic',
    phase: 'pending-confirm',
    confirmMode: 'confirm',
    requiresExplicitConfirm: true,
    confirmBy: '2026-10-04T12:00:28Z',
    createdAt: '2026-10-04T12:00:08Z',
    updatedAt: '2026-10-04T12:00:08Z',
    ...patch
  }
}

const countdown = (patch: Partial<ModerationOperation> = {}): ModerationOperation =>
  operation({
    confirmMode: 'countdown',
    requiresExplicitConfirm: false,
    confirmBy: undefined,
    executeAt: '2026-10-04T12:00:14Z',
    ...patch
  })

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
  operations: ModerationOperation[],
  onAnswer: (operationId: string, answer: RemovalAnswer) => void = vi.fn(),
  answering: ReadonlySet<string> = new Set()
): Promise<void> {
  await act(async () =>
    root.render(
      createElement(RemovalCards, {
        view: removalPaneView(operations, NOW, answering),
        onAnswer
      })
    )
  )
}

const cards = (): HTMLElement[] => [
  ...container.querySelectorAll<HTMLElement>('[data-testid="removal-card"]')
]

function buttons(card: HTMLElement): HTMLButtonElement[] {
  return [...card.querySelectorAll<HTMLButtonElement>('button')]
}

function press(key: string, init: KeyboardEventInit = {}, target: EventTarget = window): void {
  target.dispatchEvent(
    new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init })
  )
}

describe('RemovalCards (plan 140, S6)', () => {
  it('renders nothing without a card or a result', async () => {
    await render([])
    expect(container.innerHTML).toBe('')
  })

  it('confirm first: author, platform, reason, the words, and Remove then Cancel', async () => {
    await render([operation()])
    const [card] = cards()
    expect(card.getAttribute('role')).toBe('group')
    expect(card.dataset.mode).toBe('confirm')
    const text = card.textContent ?? ''
    expect(text).toContain('Remove from chat?')
    expect(text).toContain('Expires in 18s')
    expect(text).toContain('coders_x')
    expect(text).toContain('toxic')
    expect(text).toContain('“this stream is trash”')
    expect(card.querySelector('[aria-label="Twitch"]')).toBeTruthy()
    expect(buttons(card).map((button) => button.dataset.testid)).toEqual([
      'removal-confirm',
      'removal-cancel'
    ])
    expect(buttons(card)[0].dataset.variant).toBe('destructive')
    expect(buttons(card)[0].textContent).toBe('Remove↵')
    expect(buttons(card)[1].textContent).toBe('Cancelesc')
    // Cancel is its own button, never inside another one.
    for (const button of buttons(card)) expect(button.querySelector('button')).toBeNull()
  })

  it('countdown: Removing in Ns, Cancel first, then Remove now', async () => {
    await render([countdown()])
    const [card] = cards()
    expect(card.dataset.mode).toBe('countdown')
    expect(card.textContent).toContain('Removing in 4s')
    expect(buttons(card).map((button) => button.textContent)).toEqual(['Cancelesc', 'Remove now↵'])
    expect(buttons(card)[0].dataset.variant).toBe('secondary')
  })

  it('YouTube: confirm first, and the line that says why', async () => {
    await render([
      operation({ platform: 'youtube', confirmMode: 'countdown', requiresExplicitConfirm: true })
    ])
    const [card] = cards()
    expect(card.dataset.mode).toBe('confirm')
    expect(card.textContent).toContain('YouTube asks you to confirm.')
  })

  it('answers with the buttons, and waits while running', async () => {
    const onAnswer = vi.fn()
    await render([operation()], onAnswer)
    await act(async () => buttons(cards()[0])[1].click())
    expect(onAnswer).toHaveBeenLastCalledWith('op-1', 'cancel')
    await act(async () => buttons(cards()[0])[0].click())
    expect(onAnswer).toHaveBeenLastCalledWith('op-1', 'confirm')

    await render([operation({ phase: 'executing' })], onAnswer)
    const [card] = cards()
    expect(card.textContent).toContain('Removing…')
    expect(buttons(card).every((button) => button.disabled)).toBe(true)
  })

  it('Enter confirms and Esc cancels the topmost card while nothing is focused', async () => {
    const onAnswer = vi.fn()
    await render(
      [
        operation({ operationId: 'second', createdAt: '2026-10-04T12:00:09Z' }),
        operation({ operationId: 'first', createdAt: '2026-10-04T12:00:05Z' })
      ],
      onAnswer
    )
    expect(cards().map((card) => card.dataset.topmost)).toEqual(['true', undefined])
    await act(async () => press('Enter'))
    expect(onAnswer).toHaveBeenLastCalledWith('first', 'confirm')
    await act(async () => press('Escape'))
    expect(onAnswer).toHaveBeenLastCalledWith('first', 'cancel')
    // Held keys, modifiers and IME composition never answer.
    onAnswer.mockClear()
    await act(async () => press('Enter', { repeat: true }))
    await act(async () => press('Enter', { metaKey: true }))
    await act(async () => press('Enter', { isComposing: true }))
    expect(onAnswer).not.toHaveBeenCalled()
  })

  it('a focused card answers its own keys', async () => {
    const onAnswer = vi.fn()
    await render(
      [
        operation({ operationId: 'first', createdAt: '2026-10-04T12:00:05Z' }),
        operation({ operationId: 'second', createdAt: '2026-10-04T12:00:09Z' })
      ],
      onAnswer
    )
    const second = cards()[1]
    await act(async () => press('Enter', {}, second))
    expect(onAnswer).toHaveBeenCalledTimes(1)
    expect(onAnswer).toHaveBeenLastCalledWith('second', 'confirm')
    await act(async () => press('Escape', {}, second))
    expect(onAnswer).toHaveBeenLastCalledWith('second', 'cancel')
    expect(onAnswer).toHaveBeenCalledTimes(2)
  })

  it('never steals Enter from the composer, the search field or a chat row', async () => {
    const onAnswer = vi.fn()
    await render([operation()], onAnswer)
    const composer = document.createElement('input')
    const row = document.createElement('button')
    document.body.append(composer, row)
    for (const element of [composer, row]) {
      element.focus()
      expect(document.activeElement).toBe(element)
      await act(async () => press('Enter', {}, element))
    }
    expect(onAnswer).not.toHaveBeenCalled()
    // Esc still cancels from a row, never from a text field.
    composer.focus()
    await act(async () => press('Escape', {}, composer))
    expect(onAnswer).not.toHaveBeenCalled()
    row.focus()
    await act(async () => press('Escape', {}, row))
    expect(onAnswer).toHaveBeenLastCalledWith('op-1', 'cancel')
  })

  it('stays out of the way once no card is open', async () => {
    const onAnswer = vi.fn()
    await render(
      [
        operation({
          phase: 'removed',
          outcome: 'Removed from Twitch.',
          updatedAt: '2026-10-04T12:00:09Z'
        })
      ],
      onAnswer
    )
    expect(cards()).toHaveLength(0)
    const result = container.querySelector('[data-slot="removal-result"]')
    expect(result?.getAttribute('role')).toBe('status')
    expect(result?.textContent).toContain('Removed from Twitch.')
    await act(async () => press('Enter'))
    expect(onAnswer).not.toHaveBeenCalled()
  })
})

describe('removalKeyAnswer', () => {
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

  it('leaves keys another handler or an open menu owns', () => {
    const menu = document.createElement('div')
    menu.setAttribute('role', 'menu')
    const item = document.createElement('div')
    menu.append(item)
    document.body.append(menu)
    expect(removalKeyAnswer(key('Escape'), item, document.body)).toBeNull()
    expect(removalKeyAnswer(key('Enter', { defaultPrevented: true }), null, document.body)).toBe(
      null
    )
    expect(removalKeyAnswer(key('a'), null, document.body)).toBeNull()
    expect(removalKeyAnswer(key('Enter'), null, document.body)).toBe('confirm')
    expect(removalKeyAnswer(key('Escape'), document.body, document.body)).toBe('cancel')
  })
})
