// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ConfirmDialog } from './confirm-dialog'

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

async function render(props: Partial<Parameters<typeof ConfirmDialog>[0]> = {}): Promise<{
  onCancel: ReturnType<typeof vi.fn>
  onConfirm: ReturnType<typeof vi.fn>
}> {
  const onCancel = vi.fn()
  const onConfirm = vi.fn()
  await act(async () =>
    root.render(
      createElement(ConfirmDialog, {
        open: true,
        title: 'Delete takeover?',
        description: 'Its image file is deleted from this computer.',
        confirmLabel: 'Delete takeover',
        testId: 'confirm',
        onCancel,
        onConfirm,
        ...props
      })
    )
  )
  return { onCancel, onConfirm }
}

describe('ConfirmDialog (plan 174 S0.3, J1-3)', () => {
  it('is an alert dialog with no close button, the safe answer focused', async () => {
    await render()
    const dialog = byTestId('confirm-dialog')
    expect(dialog?.getAttribute('role')).toBe('alertdialog')
    expect(dialog?.textContent).toContain('Delete takeover?')
    expect(dialog?.textContent).toContain('Its image file is deleted from this computer.')
    expect(dialog?.querySelector('.sr-only')).toBeNull()
    const cancel = byTestId('confirm-cancel')
    expect(cancel?.textContent).toBe('Cancel')
    expect(cancel?.getAttribute('data-variant')).toBe('ghost')
    expect(document.activeElement).toBe(cancel)
    expect(byTestId('confirm-confirm')?.getAttribute('data-variant')).toBe('destructive')
  })

  it('cancels from the safe button and from Escape, never confirming', async () => {
    const { onCancel, onConfirm } = await render({ cancelLabel: 'Keep it' })
    expect(byTestId('confirm-cancel')?.textContent).toBe('Keep it')
    await act(async () => byTestId('confirm-cancel')!.click())
    expect(onCancel).toHaveBeenCalledTimes(1)
    await act(async () =>
      byTestId('confirm-dialog')!.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })
      )
    )
    expect(onCancel).toHaveBeenCalledTimes(2)
    expect(onConfirm).not.toHaveBeenCalled()
  })

  it('confirms from the destructive button only, and stays open for its owner', async () => {
    const { onCancel, onConfirm } = await render()
    await act(async () => byTestId('confirm-confirm')!.click())
    expect(onConfirm).toHaveBeenCalledTimes(1)
    expect(onCancel).not.toHaveBeenCalled()
    // Controlled: still open until the owner drops `open`.
    expect(byTestId('confirm-dialog')).not.toBeNull()
    await render({ open: false })
    expect(byTestId('confirm-dialog')).toBeNull()
  })

  it('locks the destructive answer while the owner says so', async () => {
    const { onConfirm } = await render({ confirmDisabled: true, confirmLabel: 'Deleting…' })
    const confirm = byTestId('confirm-confirm') as HTMLButtonElement
    expect(confirm.disabled).toBe(true)
    expect(confirm.textContent).toBe('Deleting…')
    await act(async () => confirm.click())
    expect(onConfirm).not.toHaveBeenCalled()
  })
})
