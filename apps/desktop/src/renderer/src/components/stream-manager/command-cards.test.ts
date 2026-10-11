// @vitest-environment happy-dom
import { act, createElement, Fragment } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { CohostCommand, ModerationOperation } from '@/lib/backend'
import { removalPaneView } from '@/lib/chat-removal-view'
import { commandChooserView, commandConfirmView, commandStripView } from '@/lib/buddy-command-view'

import { CommandCards, CommandStrip, type CommandAnswer } from './command-cards'
import { RemovalCards } from './removal-cards'

const NOW = Date.parse('2026-10-04T12:00:10Z')

const candidates = [
  { messageId: 'm-1', authorName: 'coders_x', platform: 'twitch' as const, excerpt: 'first' },
  { messageId: 'm-2', authorName: 'coders_y', platform: 'kick' as const, excerpt: 'second' }
]

function command(patch: Partial<CohostCommand> = {}): CohostCommand {
  return {
    id: 'cmd-1',
    heard: 'buddy highlight the comment from coders',
    kind: 'highlight',
    status: 'ambiguous',
    message: 'Which comment from coders?',
    candidates,
    at: '2026-10-04T12:00:08Z',
    expiresAt: '2026-10-04T12:00:28Z',
    ...patch
  }
}

const flagged = (patch: Partial<CohostCommand> = {}): CohostCommand =>
  command({
    status: 'confirm',
    message: 'Buddy flagged this (harassment). Show it anyway?',
    candidates: undefined,
    target: candidates[0],
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
  current: CohostCommand | null,
  onAnswer: (commandId: string, answer: CommandAnswer) => void = vi.fn(),
  answering = false
): Promise<void> {
  await act(async () =>
    root.render(
      createElement(
        Fragment,
        null,
        createElement(CommandStrip, { view: commandStripView(current, NOW) }),
        createElement(CommandCards, {
          chooser: commandChooserView(current, NOW),
          confirm: commandConfirmView(current, NOW, answering),
          onAnswer
        })
      )
    )
  )
}

function press(key: string, init: KeyboardEventInit = {}, target: EventTarget = window): void {
  target.dispatchEvent(
    new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init })
  )
}

const slot = (name: string): HTMLElement | null =>
  container.querySelector<HTMLElement>(`[data-slot="${name}"]`)
// The cards are shadcn Alerts: their hook is a test id, never a slot (plan 168 S-00).
const byTestId = (name: string): HTMLElement | null =>
  container.querySelector<HTMLElement>(`[data-testid="${name}"]`)

describe('CommandStrip (plan 140, S6 part B)', () => {
  it('says what Buddy heard and did, quietly when nothing happened', async () => {
    await render(command({ status: 'done', message: "Highlighted coders_x's comment." }))
    const strip = slot('command-strip')!
    expect(strip.getAttribute('role')).toBe('status')
    expect(strip.textContent).toContain('Heard: “buddy highlight the comment from coders”')
    expect(strip.textContent).toContain("Highlighted coders_x's comment.")
    expect(strip.dataset.quiet).toBeUndefined()

    await render(command({ status: 'not-found', message: 'No comment from coders.' }))
    expect(slot('command-strip')!.dataset.quiet).toBe('true')
    expect(slot('command-strip-message')!.className).toContain('text-muted-foreground')
  })
})

describe('CommandCards: the chooser', () => {
  it('lists the comments with 1 to 3, and Cancel as its own button', async () => {
    const onAnswer = vi.fn()
    await render(command(), onAnswer)
    const chooser = byTestId('command-chooser')!
    expect(chooser.textContent).toContain('Which comment from coders?')
    expect(chooser.textContent).toContain('Expires in 18s')
    const picks = [
      ...chooser.querySelectorAll<HTMLButtonElement>('[data-testid="command-candidate"]')
    ]
    expect(picks.map((pick) => pick.textContent)).toEqual([
      '1Twitchcoders_x“first”',
      '2Kickcoders_y“second”'
    ])
    const cancel = chooser.querySelector<HTMLButtonElement>('[data-testid="command-cancel"]')!
    expect(cancel.closest('[data-testid="command-candidate"]')).toBeNull()
    for (const button of chooser.querySelectorAll('button')) {
      expect(button.querySelector('button')).toBeNull()
    }
    await act(async () => picks[1].click())
    expect(onAnswer).toHaveBeenLastCalledWith('cmd-1', { action: 'choose', index: 1 })
    await act(async () => cancel.click())
    expect(onAnswer).toHaveBeenLastCalledWith('cmd-1', { action: 'cancel' })
  })

  it('picks with 1 to 3 and cancels with Esc, never from the composer', async () => {
    const onAnswer = vi.fn()
    await render(command(), onAnswer)
    await act(async () => press('2'))
    expect(onAnswer).toHaveBeenLastCalledWith('cmd-1', { action: 'choose', index: 1 })
    await act(async () => press('3'))
    expect(onAnswer).toHaveBeenCalledTimes(1)
    await act(async () => press('Escape'))
    expect(onAnswer).toHaveBeenLastCalledWith('cmd-1', { action: 'cancel' })
    // Enter has nothing to confirm in a chooser.
    await act(async () => press('Enter'))
    expect(onAnswer).toHaveBeenCalledTimes(2)

    onAnswer.mockClear()
    const composer = document.createElement('input')
    document.body.append(composer)
    composer.focus()
    await act(async () => press('1', {}, composer))
    await act(async () => press('Escape', {}, composer))
    expect(onAnswer).not.toHaveBeenCalled()
  })

  it('a focused chooser answers its own keys, once', async () => {
    const onAnswer = vi.fn()
    await render(command(), onAnswer)
    const chooser = byTestId('command-chooser')!
    chooser.focus()
    await act(async () => press('1', {}, chooser))
    expect(onAnswer).toHaveBeenCalledTimes(1)
    expect(onAnswer).toHaveBeenLastCalledWith('cmd-1', { action: 'choose', index: 0 })
    await act(async () => press('Escape', {}, chooser))
    expect(onAnswer).toHaveBeenCalledTimes(2)
  })
})

describe('CommandCards: show a flagged comment anyway', () => {
  it('asks with Show and Cancel; Enter shows, Esc cancels', async () => {
    const onAnswer = vi.fn()
    await render(flagged(), onAnswer)
    const card = byTestId('command-confirm')!
    expect(card.textContent).toContain('Buddy flagged this (harassment). Show it anyway?')
    expect(card.textContent).toContain('coders_x')
    expect(card.textContent).toContain('“first”')
    await act(async () =>
      card.querySelector<HTMLButtonElement>('[data-testid="command-show"]')!.click()
    )
    expect(onAnswer).toHaveBeenLastCalledWith('cmd-1', { action: 'confirm' })
    await act(async () => press('Enter'))
    expect(onAnswer).toHaveBeenLastCalledWith('cmd-1', { action: 'confirm' })
    await act(async () => press('Escape'))
    expect(onAnswer).toHaveBeenLastCalledWith('cmd-1', { action: 'cancel' })
  })

  it('waits while the answer is on its way', async () => {
    const onAnswer = vi.fn()
    await render(flagged(), onAnswer, true)
    const buttons = [...byTestId('command-confirm')!.querySelectorAll('button')]
    expect(buttons.every((button) => button.disabled)).toBe(true)
    await act(async () => press('Enter'))
    expect(onAnswer).not.toHaveBeenCalled()
  })

  it('shows no second card for a removal: the moderation card is the one', async () => {
    await render(
      flagged({
        kind: 'remove',
        operationId: '6f1c2e9a-3b7d-4c51-9e2f-0a1b2c3d4e5f',
        message: "Remove coders_x's comment?"
      })
    )
    expect(slot('command-cards')).toBeNull()
    expect(slot('command-strip')).toBeTruthy()
  })

  it('takes Esc before an older removal card', async () => {
    const onCommand = vi.fn()
    const onRemoval = vi.fn()
    const operation: ModerationOperation = {
      operationId: 'op-1',
      sessionId: 's1',
      messageId: 'm-9',
      platform: 'twitch',
      authorName: 'spammer',
      excerpt: 'buy followers',
      source: 'orcle-voice',
      phase: 'pending-confirm',
      confirmMode: 'confirm',
      requiresExplicitConfirm: true,
      confirmBy: '2026-10-04T12:00:28Z',
      createdAt: '2026-10-04T12:00:01Z',
      updatedAt: '2026-10-04T12:00:01Z'
    }
    await act(async () =>
      root.render(
        createElement(
          Fragment,
          null,
          createElement(CommandCards, {
            chooser: commandChooserView(command(), NOW),
            confirm: null,
            onAnswer: onCommand
          }),
          createElement(RemovalCards, {
            view: removalPaneView([operation], NOW),
            onAnswer: onRemoval
          })
        )
      )
    )
    await act(async () => press('Escape'))
    expect(onCommand).toHaveBeenCalledWith('cmd-1', { action: 'cancel' })
    expect(onRemoval).not.toHaveBeenCalled()
  })
})
