// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { CohostPane } from '@/components/cohost-pane'
import type { CohostQuestion, CohostRecentlyResolved, CohostState } from '@/lib/backend'
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

function question(id: string, text: string): CohostQuestion {
  return {
    id,
    text,
    messageIds: [`twitch:${id}`],
    askers: ['Ada'],
    platforms: ['twitch'],
    priority: 'normal',
    suggestedReply: '',
    fromNotes: false,
    firstSeenAt: '2026-09-25T12:00:00.000Z',
    updatedAt: '2026-09-25T12:00:00.000Z'
  }
}

function resolved(id: string, text: string, resolvedAt: string): CohostRecentlyResolved {
  return { question: question(id, text), reason: 'voice', resolvedAt }
}

/** Inside the pane's 60 s recentlyResolved TTL. Hardcoded wall-clock stamps
 * expire the section as soon as that minute passes. */
function resolvedAtMsAgo(msAgo: number): string {
  return new Date(Date.now() - msAgo).toISOString()
}

function state(overrides: Partial<CohostState> = {}): CohostState {
  return { ...EMPTY_COHOST_STATE, sessionId: 'session-1', status: 'listening', ...overrides }
}

async function renderPane(
  current: CohostState,
  onRestoreQuestion?: (question: CohostQuestion) => void
): Promise<void> {
  await act(async () =>
    root.render(
      createElement(CohostPane, {
        consented: true,
        enabled: true,
        gate: { allowed: true },
        state: current,
        onAnswered: () => undefined,
        onDismissFlag: () => undefined,
        onDismissQuestion: () => undefined,
        onReply: () => undefined,
        onRestoreQuestion
      })
    )
  )
}

function lines(): string[] {
  return [...document.querySelectorAll('[data-slot="cohost-answered-on-air-text"]')].map(
    (line) => line.textContent ?? ''
  )
}

describe('CohostPane: Answered on air', () => {
  it('renders nothing while no question was answered on air', async () => {
    await renderPane(state({ questions: [question('q-open', 'Which mic is that?')] }))
    expect(document.querySelector('[data-slot="cohost-answered-on-air"]')).toBeNull()
  })

  it('shows the newest as one line under the open questions and restores it', async () => {
    const onRestore = vi.fn()
    await renderPane(
      state({
        questions: [question('q-open', 'Which mic is that?')],
        // The wire is oldest first; the pane shows the newest.
        recentlyResolved: [
          resolved('q-old', 'What keyboard is that?', resolvedAtMsAgo(20_000)),
          resolved('q-new', 'When is the next stream?', resolvedAtMsAgo(10_000))
        ]
      }),
      onRestore
    )
    expect(lines()).toEqual(['Answered on air: When is the next stream?'])
    const section = document.querySelector('[data-slot="cohost-answered-on-air"]')!
    // Under the open questions, not inside the keyboard row list.
    expect(section.closest('[cmdk-root]')).toBeNull()

    const more = [...section.querySelectorAll('button')].find(
      (button) => button.textContent === '+1'
    )!
    expect(more).toBeTruthy()
    await act(async () => more.click())
    expect(lines()).toEqual([
      'Answered on air: When is the next stream?',
      'Answered on air: What keyboard is that?'
    ])

    const restore = [...section.querySelectorAll('button')].filter(
      (button) => button.textContent === 'Restore'
    )
    expect(restore).toHaveLength(2)
    await act(async () => restore[0]!.click())
    expect(onRestore).toHaveBeenCalledTimes(1)
    expect(onRestore.mock.calls[0]![0]).toMatchObject({ id: 'q-new' })
  })

  it('keeps at most three, and disables Restore where nothing can restore', async () => {
    await renderPane(
      state({
        recentlyResolved: [
          resolved('q-1', 'One?', resolvedAtMsAgo(40_000)),
          resolved('q-2', 'Two?', resolvedAtMsAgo(30_000)),
          resolved('q-3', 'Three?', resolvedAtMsAgo(20_000)),
          resolved('q-4', 'Four?', resolvedAtMsAgo(10_000))
        ]
      })
    )
    const section = document.querySelector('[data-slot="cohost-answered-on-air"]')!
    const more = [...section.querySelectorAll('button')].find(
      (button) => button.textContent === '+2'
    )!
    await act(async () => more.click())
    expect(lines()).toEqual([
      'Answered on air: Four?',
      'Answered on air: Three?',
      'Answered on air: Two?'
    ])
    for (const button of section.querySelectorAll('button')) {
      if (button.textContent === 'Restore') expect(button.disabled).toBe(true)
    }
  })
})
