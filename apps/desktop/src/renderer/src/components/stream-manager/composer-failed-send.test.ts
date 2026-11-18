// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { CommentsSendOperation, LiveChatProviderState } from '@/lib/backend'
import { chatSendFailures } from '@/lib/chat-send'
import { Composer } from './chat-pane'

// QA F22: a send that reached nobody puts its words back in the composer
// (plan 174 S3.16a). The restore was deduped on destination + reason, so a
// second, different message failing the same way stayed blank.

const provider = {
  id: 'fixture-twitch',
  platform: 'twitch',
  read: 'ready',
  write: 'ready',
  phase: 'connected'
} as unknown as LiveChatProviderState

let root: Root
let container: HTMLDivElement
const onSend = vi.fn()

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  )
  onSend.mockClear()
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})

async function render(pending: boolean, operation: CommentsSendOperation | null): Promise<void> {
  await act(async () =>
    root.render(
      createElement(Composer, {
        providers: [provider],
        prefill: null,
        cohostNudge: false,
        onSend,
        pending,
        operation,
        failures: chatSendFailures(operation)
      })
    )
  )
}

const input = (): HTMLInputElement => container.querySelector('input')!

async function send(text: string): Promise<void> {
  await act(async () => {
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!.call(
      input(),
      text
    )
    input().dispatchEvent(new Event('input', { bubbles: true }))
  })
  await act(async () =>
    input().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
  )
  await render(true, null)
}

function failed(id: string, text: string, reason: string): CommentsSendOperation {
  return {
    id,
    sessionId: 'fixture-session',
    text,
    phase: 'failed',
    destinations: [{ destinationId: provider.id, platform: 'twitch', phase: 'failed', reason }],
    createdAt: '2026-11-18T00:00:00Z',
    updatedAt: '2026-11-18T00:00:01Z'
  } as unknown as CommentsSendOperation
}

describe('Composer after a send that reached nobody', () => {
  for (const sameReason of [true, false]) {
    it(`puts each failed message back (same reason: ${sameReason})`, async () => {
      await render(false, null)
      await send('First unsent message')
      await render(false, failed('first', 'First unsent message', 'Sender unavailable'))
      expect(input().value).toBe('First unsent message')

      await send('Second unsent message')
      expect(input().value).toBe('')
      const reason = sameReason ? 'Sender unavailable' : 'Different transport error'
      await render(false, failed('second', 'Second unsent message', reason))
      expect(onSend).toHaveBeenCalledTimes(2)
      expect(input().value).toBe('Second unsent message')
    })
  }

  it('never writes over a draft typed while the send was failing', async () => {
    await render(false, null)
    await send('Unsent message')
    await act(async () => {
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!.call(
        input(),
        'New words'
      )
      input().dispatchEvent(new Event('input', { bubbles: true }))
    })
    await render(false, failed('one', 'Unsent message', 'Sender unavailable'))
    expect(input().value).toBe('New words')
  })
})
