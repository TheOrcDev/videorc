// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { EndLivestreamDialog, type SessionStopConfirmation } from './end-livestream-dialog'

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

const confirmation: SessionStopConfirmation = {
  origin: 'palette',
  sessionId: 'live-1',
  platforms: ['Twitch', 'YouTube'],
  alsoRecords: true
}

async function render(
  value: SessionStopConfirmation | null,
  handlers: { onCancel: () => void; onConfirm: () => void }
): Promise<void> {
  await act(async () =>
    root.render(createElement(EndLivestreamDialog, { confirmation: value, ...handlers }))
  )
}

const byTestId = (id: string): HTMLElement | null =>
  document.querySelector<HTMLElement>(`[data-testid="${id}"]`)

describe('EndLivestreamDialog (plan 174 S0.1, D2, D19)', () => {
  it('asks the question, names the audience, and focuses Keep streaming', async () => {
    const onCancel = vi.fn()
    const onConfirm = vi.fn()
    await render(confirmation, { onCancel, onConfirm })

    const dialog = byTestId('end-livestream-dialog')
    expect(dialog?.getAttribute('role')).toBe('alertdialog')
    expect(dialog?.textContent).toContain('End livestream?')
    expect(dialog?.textContent).toContain(
      'Viewers on Twitch and YouTube are disconnected. Your recording stops too and is saved to the Library.'
    )
    // No close button: the two answers are the only way out.
    expect(dialog?.querySelector('button[aria-label="Close"], .sr-only')).toBeNull()
    expect(document.activeElement).toBe(byTestId('end-livestream-keep'))
    expect(onCancel).not.toHaveBeenCalled()
    expect(onConfirm).not.toHaveBeenCalled()
  })

  it('keeps streaming from the safe button and from Escape', async () => {
    const onCancel = vi.fn()
    const onConfirm = vi.fn()
    await render(confirmation, { onCancel, onConfirm })
    await act(async () => byTestId('end-livestream-keep')!.click())
    expect(onCancel).toHaveBeenCalledTimes(1)
    expect(onConfirm).not.toHaveBeenCalled()

    await render(null, { onCancel, onConfirm })
    await render(confirmation, { onCancel, onConfirm })
    await act(async () =>
      byTestId('end-livestream-dialog')!.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })
      )
    )
    expect(onCancel).toHaveBeenCalledTimes(2)
    expect(onConfirm).not.toHaveBeenCalled()
  })

  it('ends the livestream only from the destructive button, without a cancel', async () => {
    const onCancel = vi.fn()
    const onConfirm = vi.fn()
    await render(confirmation, { onCancel, onConfirm })
    const confirm = byTestId('end-livestream-confirm')
    expect(confirm?.textContent).toBe('End livestream')
    expect(confirm?.getAttribute('data-variant')).toBe('destructive')
    await act(async () => confirm!.click())
    expect(onConfirm).toHaveBeenCalledTimes(1)
    expect(onCancel).not.toHaveBeenCalled()
  })

  it('leaves the recording line out of a stream-only session', async () => {
    await render(
      { ...confirmation, alsoRecords: false, platforms: ['X'] },
      { onCancel: vi.fn(), onConfirm: vi.fn() }
    )
    expect(byTestId('end-livestream-dialog')?.textContent).toContain(
      'Viewers on X are disconnected.'
    )
    expect(byTestId('end-livestream-dialog')?.textContent).not.toContain('recording')
  })
})
