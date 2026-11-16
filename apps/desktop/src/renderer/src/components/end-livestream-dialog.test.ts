// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { CloudStatus } from '@/lib/backend'

const cloud = vi.hoisted(() => ({ status: null as CloudStatus | null }))
vi.mock('@/hooks/use-studio', () => ({ useStudioCloud: () => ({ cloudStatus: cloud.status }) }))

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
  cloud.status = null
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
  handlers: { onCancel: () => void; onConfirm: () => void; onHandOff?: () => void }
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
    expect(byTestId('end-livestream-cancel')?.textContent).toBe('Keep streaming')
    // Base UI moves the first focus on the next animation frame.
    await vi.waitFor(() => expect(document.activeElement).toBe(byTestId('end-livestream-cancel')))
    expect(onCancel).not.toHaveBeenCalled()
    expect(onConfirm).not.toHaveBeenCalled()
  })

  it('keeps streaming from the safe button and from Escape', async () => {
    const onCancel = vi.fn()
    const onConfirm = vi.fn()
    await render(confirmation, { onCancel, onConfirm })
    await act(async () => byTestId('end-livestream-cancel')!.click())
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

// Plan 243 C5: on a managed cloud show this computer is on air for, the
// question offers a third answer that keeps the show live for another device.
describe('EndLivestreamDialog hand-off answer (plan 243)', () => {
  const managed: CloudStatus = {
    phase: 'live',
    entitled: true,
    settings: { enabled: true, holdMaxSeconds: 1800, holdMaxChoices: [1800] },
    show: { id: 'sh_1', nodeId: 'livekit', resumable: false, kind: 'solo' },
    connected: true,
    directFallbackAvailable: false,
    onAir: {
      kind: 'computer',
      source: 'feed',
      waiting: false,
      thisDevice: true,
      since: '2026-11-16T20:01:02.000Z'
    }
  }
  beforeEach(() => {
    cloud.status = managed
  })

  it('is absent off a managed show this computer is on air for, or without a handler', async () => {
    await render(confirmation, { onCancel: vi.fn(), onConfirm: vi.fn() })
    expect(byTestId('end-livestream-hand-off')).toBeNull()
    cloud.status = { ...managed, onAir: { ...managed.onAir!, thisDevice: false } }
    await render(confirmation, { onCancel: vi.fn(), onConfirm: vi.fn(), onHandOff: vi.fn() })
    expect(byTestId('end-livestream-hand-off')).toBeNull()
    expect(byTestId('end-livestream-dialog')?.getAttribute('data-size')).toBe('md')
  })

  it('continues on another device beside Keep streaming and End livestream', async () => {
    const onCancel = vi.fn()
    const onConfirm = vi.fn()
    const onHandOff = vi.fn()
    await render(confirmation, { onCancel, onConfirm, onHandOff })
    const dialog = byTestId('end-livestream-dialog')
    expect(dialog?.getAttribute('data-size')).toBe('lg')
    expect(dialog?.textContent).toContain('End livestream?')
    expect(dialog?.textContent).toContain(
      'Viewers on Twitch and YouTube are disconnected. With Continue on another device, viewers see Be right back until you continue on your phone or another computer. Your recording stops either way and is saved to the Library.'
    )
    const buttons = [...dialog!.querySelectorAll('button')].map((button) => button.textContent)
    expect(buttons).toEqual(['Keep streaming', 'Continue on another device', 'End livestream'])
    expect(byTestId('end-livestream-hand-off')?.getAttribute('data-variant')).toBe('secondary')
    await vi.waitFor(() => expect(document.activeElement).toBe(byTestId('end-livestream-cancel')))
    await act(async () => byTestId('end-livestream-hand-off')!.click())
    expect(onHandOff).toHaveBeenCalledTimes(1)
    expect(onConfirm).not.toHaveBeenCalled()
    expect(onCancel).not.toHaveBeenCalled()
  })

  it('asks the quit question with Quit and keep it live', async () => {
    const onHandOff = vi.fn()
    const onConfirm = vi.fn()
    await render(
      { ...confirmation, origin: 'quit', alsoRecords: false },
      { onCancel: vi.fn(), onConfirm, onHandOff }
    )
    const dialog = byTestId('end-livestream-dialog')
    expect(dialog?.textContent).toContain('End livestream and quit?')
    expect(dialog?.textContent).toContain('With Quit and keep it live, viewers see Be right back')
    expect(dialog?.textContent).not.toContain('recording')
    expect(byTestId('end-livestream-hand-off')?.textContent).toBe('Quit and keep it live')
    expect(byTestId('end-livestream-confirm')?.textContent).toBe('End livestream and quit')
    await act(async () => byTestId('end-livestream-hand-off')!.click())
    expect(onHandOff).toHaveBeenCalledTimes(1)
    await render(
      { ...confirmation, origin: 'close-window' },
      { onCancel: vi.fn(), onConfirm, onHandOff }
    )
    expect(byTestId('end-livestream-hand-off')?.textContent).toBe('Close and keep it live')
    expect(onConfirm).not.toHaveBeenCalled()
  })
})
