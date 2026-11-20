// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { SrtInputControls, SrtInputResult } from '@/hooks/use-srt-input'
import type { SrtInputState } from '@/lib/backend'

import { SrtCameraFieldsView } from './srt-camera-fields'

// Renewing the passphrase keeps its dialog up until the
// save settles, so focus goes back to an enabled "New passphrase".

const state: SrtInputState = {
  supported: true,
  enabled: true,
  port: 45678,
  connection: 'wifi',
  latencyMs: 120,
  passphrase: 'Abcdefghijklmnopqrstuvwxyz012345',
  cameraId: 'camera:srt-input',
  cameraName: 'SRT Camera (port 45678)',
  status: {
    listening: true,
    senderConnected: false,
    senderSession: 0,
    framesDecoded: 0,
    signal: 'waiting',
    detail: 'Waiting'
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

const byTestId = (id: string): HTMLElement | null =>
  document.querySelector<HTMLElement>(`[data-testid="${id}"]`)

const renewButton = (): HTMLButtonElement => {
  const button = [...container.querySelectorAll('button')].find(
    (candidate) => candidate.textContent === 'New passphrase'
  )
  if (!button) throw new Error('no New passphrase button')
  return button
}

/** Opens the renewal, confirms it, and hands back the pending save. */
async function confirmRenewal(): Promise<(result: SrtInputResult) => Promise<void>> {
  let settle: (result: SrtInputResult) => void = () => undefined
  const controls: SrtInputControls = {
    state,
    stateRef: { current: state },
    connected: true,
    set: async () => ({ ok: true }),
    renewPassphrase: () =>
      new Promise<SrtInputResult>((resolve) => {
        settle = resolve
      })
  }
  await act(async () =>
    root.render(createElement(SrtCameraFieldsView, { controls, onCameraListChanged: () => {} }))
  )
  renewButton().focus()
  await act(async () => renewButton().click())
  await vi.waitFor(() => expect(byTestId('srt-input-renew-dialog')).not.toBeNull())
  await act(async () => byTestId('srt-input-renew-confirm')!.click())
  return async (result) => {
    await act(async () => settle(result))
  }
}

describe('New passphrase (plan 255)', () => {
  it('keeps the dialog up while the save runs, then gives focus back to an enabled button', async () => {
    const settle = await confirmRenewal()
    // Pending: the dialog stays, its answers wait.
    expect(byTestId('srt-input-renew-dialog')).not.toBeNull()
    const confirm = byTestId('srt-input-renew-confirm')!
    expect(confirm.textContent).toBe('Saving…')
    expect(
      confirm.hasAttribute('disabled') || confirm.getAttribute('aria-disabled') === 'true'
    ).toBe(true)

    await settle({ ok: true })
    await vi.waitFor(() => expect(byTestId('srt-input-renew-dialog')).toBeNull())
    expect(renewButton().disabled).toBe(false)
    await vi.waitFor(() => expect(document.activeElement).toBe(renewButton()))
  })

  it('keeps the dialog up with the reason when the save fails', async () => {
    const settle = await confirmRenewal()
    await settle({ ok: false, message: "Couldn't renew the SRT input. Try again." })
    const dialog = byTestId('srt-input-renew-dialog')
    expect(dialog).not.toBeNull()
    expect(dialog!.textContent).toContain("Couldn't renew the SRT input. Try again.")
    const confirm = byTestId('srt-input-renew-confirm')!
    expect(confirm.textContent).toBe('New passphrase')
    expect(confirm.hasAttribute('disabled')).toBe(false)
  })

  // Closing after a failure leaves no stale reason behind
  // the dialog, nor in it when it opens again.
  it('clears the reason when the dialog closes after a failure', async () => {
    const reason = "Couldn't renew the SRT input. Try again."
    const settle = await confirmRenewal()
    await settle({ ok: false, message: reason })
    await act(async () => byTestId('srt-input-renew-cancel')!.click())
    await vi.waitFor(() => expect(byTestId('srt-input-renew-dialog')).toBeNull())
    expect(container.textContent).not.toContain(reason)

    await act(async () => renewButton().click())
    await vi.waitFor(() => expect(byTestId('srt-input-renew-dialog')).not.toBeNull())
    expect(byTestId('srt-input-renew-dialog')!.textContent).not.toContain(reason)
  })
})
