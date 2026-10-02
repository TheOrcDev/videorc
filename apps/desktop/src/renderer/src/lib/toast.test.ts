import { beforeEach, describe, expect, it, vi } from 'vitest'

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

import { TOAST_DETAILS_IN_DIAGNOSTICS, guardToastText, toast } from '@/lib/toast'

// The exact texts from the owner's 2026-10-02 screenshot (Stop) and the
// other user's screen recording (YouTube connect).
const OWNER_STOP_BODY =
  'YouTube broadcast transition failed (403 Forbidden): {\n  "error": {\n    "code": 403,\n    "message": "The request cannot be completed because you have exceeded your \\u003ca href=\\"/youtube/v3/getting-started#quota\\"\\u003equota\\u003c/a\\u003e.",\n    "errors": [\n      {\n        "message": "The request cannot be completed because you have exceeded your \\u003ca href=\\"/youtube/v3/getting-started#quota\\"\\u003equota\\u003c/a\\u003e.",\n        "domain": "youtube.quota",\n        "reason": "quotaExceeded"\n      }\n    ]\n  }\n}'
const CONNECT_BODY =
  'OAuth account preparation failed and will be retried from its protected token checkpoint: YouTube profile lookup failed with HTTP 403 Forbidden: quotaExceeded: The request cannot be completed because you have exceeded your &lt;a href=&quot;/youtube/v3/getting-started#quota&quot;&gt;quota&lt;/a&gt;.'

describe('guardToastText (plan 094, S3)', () => {
  it('replaces a JSON blob with the diagnostics pointer', () => {
    const guarded = guardToastText(OWNER_STOP_BODY)
    expect(guarded.text).toBe(TOAST_DETAILS_IN_DIAGNOSTICS)
    expect(guarded.text).not.toContain('{"error"')
    expect(guarded.text).not.toContain('<')
    expect(guarded.withheld).toBe(OWNER_STOP_BODY)
  })

  it('strips escaped HTML from the connect flow text and keeps the sentence', () => {
    const guarded = guardToastText(CONNECT_BODY)
    expect(guarded.text).not.toContain('<a')
    expect(guarded.text).not.toContain('<')
    expect(guarded.text).not.toContain('&lt;')
    expect(guarded.text).not.toContain('&quot;')
    expect(guarded.text).toContain('exceeded your quota .')
    expect(guarded.withheld).toBe(CONNECT_BODY)
  })

  it('strips literal tags and leaves clean copy alone', () => {
    expect(guardToastText('Please <b>reconnect</b> YouTube.').text).toBe(
      'Please reconnect YouTube.'
    )
    expect(guardToastText('<html><body>boom</body></html>').text).toBe('boom')
    expect(guardToastText('<br/>').text).toBe(TOAST_DETAILS_IN_DIAGNOSTICS)
    const clean = "Couldn't end the YouTube broadcast."
    expect(guardToastText(clean)).toEqual({ text: clean, withheld: null })
    expect(
      guardToastText('Streaming to Twitch stopped at 12:30 (reconnecting).').withheld
    ).toBeNull()
  })
})

describe('toast wrapper', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  })

  it('guards the description and the title on every kind', () => {
    toast.error('Could not complete YouTube on YouTube.', { description: OWNER_STOP_BODY })
    expect(sonner.error).toHaveBeenCalledWith('Could not complete YouTube on YouTube.', {
      description: TOAST_DETAILS_IN_DIAGNOSTICS
    })
    toast.warning(CONNECT_BODY, { id: 'x' })
    const [title, options] = sonner.warning.mock.calls[0] as [string, { id: string }]
    expect(title).not.toContain('<')
    expect(options).toEqual({ id: 'x' })
    toast.success('Account connected.')
    expect(sonner.success).toHaveBeenCalledWith('Account connected.')
    toast('Plain', { id: 'p' })
    expect(sonner).toHaveBeenCalledWith('Plain', { id: 'p' })
    toast.dismiss('p')
    expect(sonner.dismiss).toHaveBeenCalledWith('p')
    expect(console.warn).toHaveBeenCalledTimes(2)
  })
})
