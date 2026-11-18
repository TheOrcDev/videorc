// @vitest-environment happy-dom
import { isValidElement, type ReactElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const sonner = vi.hoisted(() => {
  const base = vi.fn()
  return Object.assign(base, {
    error: vi.fn(),
    warning: vi.fn(),
    success: vi.fn(),
    info: vi.fn(),
    message: vi.fn(),
    loading: vi.fn(),
    dismiss: vi.fn()
  })
})
vi.mock('sonner', () => ({ toast: sonner }))

import type { CloudStatus } from './backend'
import { toastCloudStatus } from './cloud-notices'
import { TOAST_DETAILS_SAVED } from './toast'

// Plan 243 R2 B-M2: a device name is the streamer's own text, and braces,
// tags and entities are all valid in one. The taken-over toast shows it
// exactly, as React text, and never hands it to the raw-provider-text guard,
// which would hide the sentence and log the name for support.

const base: CloudStatus = {
  phase: 'hold',
  entitled: true,
  settings: { enabled: true, holdMaxSeconds: 1800, holdMaxChoices: [1800] },
  show: { id: 'sh_1', nodeId: 'livekit', resumable: true, kind: 'solo' },
  connected: true,
  directFallbackAvailable: false
}
const takenOver = (name: string): CloudStatus => ({
  ...base,
  onAir: {
    name,
    kind: 'computer',
    source: 'feed',
    waiting: false,
    thisDevice: false,
    since: '2026-11-16T20:01:02.000Z'
  },
  stoppedBy: 'taken-over'
})

/** The title's words, as the user reads them. */
function words(title: unknown): string {
  if (typeof title === 'string') return title
  if (!isValidElement(title)) return String(title)
  const markup = renderToStaticMarkup(title as ReactElement)
  const reader = document.createElement('div')
  reader.innerHTML = markup
  expect(reader.children).toHaveLength(0)
  return reader.textContent ?? ''
}

describe('the taken-over toast (plan 243 R2 B-M2)', () => {
  const logs = ['warn', 'error', 'log', 'info', 'debug'] as const
  beforeEach(() => {
    for (const level of logs) vi.spyOn(console, level).mockImplementation(() => {})
  })
  afterEach(() => {
    vi.restoreAllMocks()
    sonner.info.mockReset()
  })

  it.each(['Alice {work}', '<b>x</b>', '&amp;', 'MacBook "Pro" {"a":1}'])(
    'shows %s exactly and logs nothing',
    (name) => {
      toastCloudStatus(base, takenOver(name))
      expect(sonner.info).toHaveBeenCalledTimes(1)
      const [title, options] = sonner.info.mock.calls[0]!
      expect(words(title)).toBe(`Your show continues on ${name}.`)
      expect(title).not.toBe(TOAST_DETAILS_SAVED)
      expect(options).toMatchObject({ id: 'videorc-cloud' })
      for (const level of logs) expect(console[level]).not.toHaveBeenCalled()
    }
  )

  it('replaces an earlier cloud toast whole: no leftover description, action or endless duration (plan 243 C6)', () => {
    toastCloudStatus(base, takenOver('Smoke phone'))
    const [, options] = sonner.info.mock.calls[0]!
    // sonner merges a replacement into the toast with the same id.
    const earlier = {
      id: 'videorc-cloud',
      description: 'Your stream stays on air if this computer drops. Set it up in Destinations.',
      action: { label: 'Open Destinations', onClick: () => {} },
      duration: Infinity
    }
    const shown = { ...earlier, ...options }
    expect(shown.id).toBe('videorc-cloud')
    expect(shown.description).toBeUndefined()
    expect(shown.action).toBeUndefined()
    expect(Number.isFinite(shown.duration)).toBe(true)
  })

  it('toasts once per take-over, and names the kind without a name', () => {
    const { name: _name, ...nameless } = takenOver('x').onAir!
    toastCloudStatus(base, { ...takenOver('x'), onAir: nameless })
    toastCloudStatus({ ...takenOver('x'), onAir: nameless }, { ...takenOver('x'), onAir: nameless })
    expect(sonner.info).toHaveBeenCalledTimes(1)
    expect(words(sonner.info.mock.calls[0]![0])).toBe('Your show continues on another computer.')
  })
})

it('announces an external show end once, and never an end requested here', () => {
  sonner.info.mockReset()
  const ended: CloudStatus = { ...base, phase: 'off', endReason: 'ended-elsewhere' }
  toastCloudStatus(base, ended)
  toastCloudStatus(ended, ended)
  expect(sonner.info).toHaveBeenCalledTimes(1)
  expect(sonner.info.mock.calls[0]![0]).toBe('The show was ended from videorc.com.')
  sonner.info.mockReset()
  toastCloudStatus(base, { ...base, phase: 'off', endReason: 'ended-by-host' })
  expect(sonner.info).not.toHaveBeenCalled()
})
