// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { CleanCutClient } from '@/hooks/use-clean-cut'
import { resetCleanCutDraftsForTests } from '@/lib/clean-cut-drafts'
import type { CleanCutTabRequest } from '@/lib/clean-cut-events'

import { CleanCutTab } from './clean-cut-tab'

vi.mock('@/components/clean-cut/clean-cut-review', async () => {
  const { createElement: h } = await import('react')
  return {
    CleanCutReview: ({ target, onClose }: { target: unknown; onClose: () => void }) =>
      h(
        'div',
        { 'data-slot': 'review-stub', 'data-target': JSON.stringify(target) },
        h('button', { type: 'button', onClick: onClose }, 'Close review')
      )
  }
})
vi.mock('@/components/clean-cut/clean-cut-card', async () => {
  const { createElement: h } = await import('react')
  return {
    CleanCutCard: ({
      focus,
      onReview
    }: {
      focus: { sessionId: string; origin?: string } | null
      onReview: (target: unknown) => void
    }) =>
      h(
        'div',
        { 'data-slot': 'card-stub', 'data-focus': JSON.stringify(focus) },
        h(
          'button',
          {
            type: 'button',
            onClick: () =>
              onReview({
                sessionId: focus?.sessionId ?? 'rec-9',
                mode: 'clean',
                jobId: 'job-9',
                ...(focus?.origin ? { origin: focus.origin } : {})
              })
          },
          'Review'
        )
      )
  }
})

let root: Root
let container: HTMLDivElement
const onOpenLibrarySession = vi.fn()
const client = {} as CleanCutClient

async function render(request: CleanCutTabRequest | null): Promise<void> {
  await act(async () =>
    root.render(createElement(CleanCutTab, { client, request, onOpenLibrarySession }))
  )
  // The review is lazy.
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

/** A page switch: the Buddy page unmounts, then mounts again. */
async function remount(request: CleanCutTabRequest | null): Promise<void> {
  await act(async () => root.unmount())
  root = createRoot(container)
  await render(request)
}

function reviewTarget(): Record<string, unknown> | null {
  const stub = document.querySelector<HTMLElement>('[data-slot="review-stub"]')
  return stub ? (JSON.parse(stub.dataset.target ?? '{}') as Record<string, unknown>) : null
}

function click(label: string): Promise<void> {
  const target = [...document.querySelectorAll('button')].find(
    (candidate) => candidate.textContent === label
  )
  expect(target, label).toBeTruthy()
  return act(async () => target!.click())
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  resetCleanCutDraftsForTests(null)
  onOpenLibrarySession.mockClear()
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})

describe('Clean cut tab (plan 174 S3.13)', () => {
  it('keeps the open review across a page switch, and closes it on Back', async () => {
    await render(null)
    await click('Review')
    expect(reviewTarget()).toEqual({ sessionId: 'rec-9', mode: 'clean', jobId: 'job-9' })
    await remount(null)
    expect(reviewTarget()).toEqual({ sessionId: 'rec-9', mode: 'clean', jobId: 'job-9' })
    await click('Close review')
    expect(reviewTarget()).toBeNull()
    expect(document.querySelector('[data-slot="card-stub"]')).toBeTruthy()
  })

  it("opens a Review ask's cut once, and the Library's ask carries its origin", async () => {
    const ask: CleanCutTabRequest = {
      sessionId: 'rec-1',
      mode: 'condensed',
      jobId: 'job-1',
      review: true,
      origin: 'library',
      nonce: 1
    }
    await render(ask)
    expect(reviewTarget()).toEqual({
      sessionId: 'rec-1',
      mode: 'condensed',
      jobId: 'job-1',
      origin: 'library'
    })
    await click('Close review')
    // The same ask, still held by the shell, never reopens what was closed.
    await remount(ask)
    expect(reviewTarget()).toBeNull()
  })

  it("selects the Library's recording, and its review goes back to the Library", async () => {
    await render(null)
    await click('Review')
    // "Make a clean cut…" closes the open review (its draft stays kept) and
    // selects the recording.
    await render({ sessionId: 'rec-2', origin: 'library', nonce: 2 })
    expect(reviewTarget()).toBeNull()
    const card = document.querySelector<HTMLElement>('[data-slot="card-stub"]')
    expect(JSON.parse(card?.dataset.focus ?? 'null')).toEqual({
      sessionId: 'rec-2',
      nonce: 2,
      origin: 'library'
    })
    await click('Review')
    expect(reviewTarget()).toMatchObject({ sessionId: 'rec-2', origin: 'library' })
  })
})
