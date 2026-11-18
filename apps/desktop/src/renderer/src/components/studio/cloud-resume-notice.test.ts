// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { CloudResumeNotice as NoticeCopy } from '@/lib/cloud-show-view'

import { CloudResumeNotice } from './cloud-resume-notice'

// Plan 243 C5: the Studio's cloud notice after a hand-off and while another
// device is on air: Continue here (the resume), End livestream (asks first),
// and the phone's address while the show waits.

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

async function render(notice: NoticeCopy, onResume = vi.fn(), pending = false): Promise<void> {
  await act(async () =>
    root.render(
      createElement(CloudResumeNotice, { blockedReason: null, notice, pending, onResume })
    )
  )
}

const waiting: NoticeCopy = {
  title: 'Your show is waiting for another device.',
  detail: 'Viewers see Be right back. The stream ends in 25 min unless you continue.',
  action: 'continue',
  tone: 'warning',
  pointer: 'On your phone, open videorc.com/live/continue.'
}

describe('CloudResumeNotice (plan 243 C5)', () => {
  it('shows a waiting show with Continue here, End livestream and the phone address', async () => {
    const onResume = vi.fn()
    await render(waiting, onResume)
    const notice = byTestId('cloud-resume-notice')
    expect(notice?.getAttribute('data-variant')).toBe('warning')
    expect(notice?.textContent).toContain('Your show is waiting for another device.')
    expect(notice?.textContent).toContain('The stream ends in 25 min unless you continue.')
    expect(byTestId('cloud-continue-pointer')?.textContent).toBe(
      'On your phone, open videorc.com/live/continue.'
    )
    expect(byTestId('cloud-resume')?.textContent).toBe('Continue here')
    expect(byTestId('cloud-end')?.textContent).toBe('End livestream')
    await act(async () => byTestId('cloud-resume')!.click())
    expect(onResume).toHaveBeenCalledTimes(1)
  })

  it('names the device on air elsewhere in a neutral notice', async () => {
    await render({
      title: 'Your show is live from iPhone.',
      detail: null,
      action: 'continue',
      tone: 'default',
      pointer: null
    })
    const notice = byTestId('cloud-resume-notice')
    expect(notice?.getAttribute('data-variant')).toBe('default')
    expect(notice?.textContent).toContain('Your show is live from iPhone.')
    expect(byTestId('cloud-continue-pointer')).toBeNull()
    expect(byTestId('cloud-resume')?.textContent).toBe('Continue here')
  })

  it('says Continuing… while it runs, and Resume for a show this computer stopped feeding', async () => {
    await render(waiting, vi.fn(), true)
    expect(byTestId('cloud-resume')?.textContent).toBe('Continuing…')
    expect(byTestId('cloud-resume')?.hasAttribute('disabled')).toBe(true)
    await render({
      title: "You're still live through Videorc Cloud.",
      detail: 'Your stream is still on air.',
      action: 'resume',
      tone: 'warning',
      pointer: null
    })
    expect(byTestId('cloud-resume')?.textContent).toBe('Resume')
  })

  it('asks before End livestream ends the show everywhere', async () => {
    await render(waiting)
    await act(async () => byTestId('cloud-end')!.click())
    const dialog = byTestId('cloud-end-livestream-dialog')
    expect(dialog?.textContent).toContain('End livestream?')
    expect(dialog?.textContent).toContain("The stream ends on every platform it's live on.")
  })
})
