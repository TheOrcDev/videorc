import { beforeEach, describe, expect, it, vi } from 'vitest'

const toast = vi.hoisted(() => ({ error: vi.fn(), warning: vi.fn() }))
vi.mock('@/lib/toast', () => ({ toast }))

import {
  BANNER_ACTION_COPY,
  BANNER_COUNT_LIMIT_REASON,
  BANNER_REFUSALS,
  BANNER_SHOWN_LIMIT_REASON,
  bannerActionContext,
  bannerActionError,
  bannerImportBlockedReason,
  bannerImportLabel,
  bannerOrderAfterMove,
  bannerRefusal,
  bannerRefusalError,
  runBannerAction
} from './banners'
import { OFFLINE_REASON, toastUserError, userErrorMessage } from './user-error'

// Plan 186: the backend refuses with verbatim sentences, and every surface
// shows them as a warning with that sentence (plan 174 S2.4).

function backendError(code: string, message: string): Error {
  return Object.assign(new Error(message), { name: 'BackendRequestError', code })
}

beforeEach(() => {
  toast.error.mockClear()
  toast.warning.mockClear()
})

describe('banner refusals', () => {
  it('pins the plan sentences, the caps included', () => {
    expect(BANNER_REFUSALS).toContain(BANNER_COUNT_LIMIT_REASON)
    expect(BANNER_REFUSALS).toContain(BANNER_SHOWN_LIMIT_REASON)
    expect(BANNER_REFUSALS).toContain('Hide this banner before you delete it.')
    expect(BANNER_REFUSALS).toContain("This file isn't a PNG, JPEG or WebP image.")
    for (const sentence of BANNER_REFUSALS) {
      expect(sentence).not.toMatch(/—|\.\.\./)
      expect(sentence.endsWith('.')).toBe(true)
    }
  })

  it('finds the sentence in a backend error, behind any IPC or context prefix', () => {
    expect(
      bannerRefusal(backendError('banner-delete-failed', 'Hide this banner before you delete it.'))
    ).toBe('Hide this banner before you delete it.')
    expect(
      bannerRefusal(
        new Error(
          "Error invoking remote method 'x': Error: import failed: Animated images aren't supported yet. Export a still PNG."
        )
      )
    ).toBe("Animated images aren't supported yet. Export a still PNG.")
    expect(
      bannerRefusal(backendError('banner-import-failed', "Couldn't decode this image: eof"))
    ).toBe(null)
  })

  it('reads a refusal as a warning with its sentence, and anything else stays generic', () => {
    const refusal = bannerRefusalError(
      backendError('banner-show-failed', BANNER_SHOWN_LIMIT_REASON)
    )
    expect(refusal).not.toBeNull()
    expect(userErrorMessage(refusal, { action: 'show', object: 'the banner' })).toMatchObject({
      kind: 'known',
      tone: 'warning',
      title: "Couldn't show the banner",
      description: BANNER_SHOWN_LIMIT_REASON
    })
    expect(bannerRefusalError(new Error('io error: disk full'))).toBeNull()
  })

  it.each(BANNER_REFUSALS)('toasts "%s" as a warning through toastUserError', (sentence) => {
    const refusal = bannerRefusalError(backendError('banner-import-failed', sentence))
    toastUserError(refusal, { action: 'import', object: 'the image' })
    expect(toast.warning).toHaveBeenCalledExactlyOnceWith("Couldn't import the image", {
      description: sentence
    })
    expect(toast.error).not.toHaveBeenCalled()
  })
})

describe('banner import button', () => {
  it('says what it is doing while it runs', () => {
    expect(bannerImportLabel('idle')).toBe('Import image…')
    expect(bannerImportLabel('choosing')).toBe('Choosing image…')
    expect(bannerImportLabel('importing')).toBe('Importing…')
  })

  it('is off only while reconnecting, importing or at the 24-banner cap', () => {
    const ready = { offline: false, phase: 'idle' as const, count: 3 }
    expect(bannerImportBlockedReason(ready)).toBeNull()
    expect(bannerImportBlockedReason({ ...ready, offline: true })).toBe(OFFLINE_REASON)
    expect(bannerImportBlockedReason({ ...ready, phase: 'choosing' })).toBe(
      'Wait for this import to finish.'
    )
    expect(bannerImportBlockedReason({ ...ready, count: 23 })).toBeNull()
    expect(bannerImportBlockedReason({ ...ready, count: 24 })).toBe(BANNER_COUNT_LIMIT_REASON)
  })
})

describe('banner order', () => {
  it('moves one id and clamps the target, null when nothing moves', () => {
    const list = [{ id: 'a' }, { id: 'b' }, { id: 'c' }]
    expect(bannerOrderAfterMove(list, 'a', 1)).toEqual(['b', 'a', 'c'])
    expect(bannerOrderAfterMove(list, 'c', 0)).toEqual(['c', 'a', 'b'])
    expect(bannerOrderAfterMove(list, 'a', 99)).toEqual(['b', 'c', 'a'])
    expect(bannerOrderAfterMove(list, 'a', -1)).toBeNull()
    expect(bannerOrderAfterMove(list, 'missing', 0)).toBeNull()
  })
})

describe('banner actions away from Studio (plan 186 S7)', () => {
  const banners = [{ id: 'sponsor' }, { id: 'logo' }]
  function client(failure?: Error) {
    const calls: Array<[string, unknown]> = []
    return {
      calls,
      request: async <T>(method: string, params?: unknown): Promise<T> => {
        calls.push([method, params])
        if (failure) throw failure
        return undefined as T
      }
    }
  }

  it('runs the explicit backend call for each action, by id', async () => {
    const backend = client()
    for (const action of [
      { action: 'show', id: 'sponsor' },
      { action: 'hide', id: 'logo' },
      { action: 'hideAll' }
    ] as const) {
      expect(await runBannerAction(backend, action, banners)).toEqual({ ok: true })
    }
    expect(backend.calls).toEqual([
      ['banners.show', { id: 'sponsor' }],
      ['banners.hide', { id: 'logo' }],
      ['banners.hide', {}]
    ])
  })

  it('says a banner is gone without asking the backend', async () => {
    const backend = client()
    expect(await runBannerAction(backend, { action: 'show', id: 'deleted' }, banners)).toEqual({
      ok: false,
      message: "That banner isn't available anymore."
    })
    expect(backend.calls).toEqual([])
  })

  it('keeps a refusal verbatim and gives anything else the plain sentence', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const refused = client(backendError('banner-show-failed', BANNER_SHOWN_LIMIT_REASON))
    expect(await runBannerAction(refused, { action: 'show', id: 'sponsor' }, banners)).toEqual({
      ok: false,
      message: BANNER_SHOWN_LIMIT_REASON
    })
    const broken = client(new Error('socket closed'))
    for (const action of [
      { action: 'show', id: 'sponsor' },
      { action: 'hide', id: 'sponsor' },
      { action: 'hideAll' }
    ] as const) {
      expect(await runBannerAction(broken, action, banners)).toEqual({
        ok: false,
        message: BANNER_ACTION_COPY[action.action]
      })
    }
    warn.mockRestore()
  })

  it('turns a relayed refusal into a warning with its sentence, and a gone banner too', () => {
    const relayed = (message: string) =>
      new Error(`Error invoking remote method 'comments-window:banner': Error: ${message}`)
    for (const sentence of [BANNER_SHOWN_LIMIT_REASON, BANNER_ACTION_COPY.missing]) {
      expect(
        userErrorMessage(bannerActionError(relayed(sentence)), bannerActionContext('show'))
      ).toMatchObject({ title: "Couldn't show the banner", description: sentence, tone: 'warning' })
    }
    expect(
      userErrorMessage(bannerActionError(relayed(OFFLINE_REASON)), bannerActionContext('hideAll'))
    ).toMatchObject({ kind: 'offline', title: "Couldn't hide the banners", tone: 'warning' })
    const unknown = userErrorMessage(
      bannerActionError(relayed("Couldn't hide the banner.")),
      bannerActionContext('hide')
    )
    expect(unknown).toMatchObject({ kind: 'unknown', title: "Couldn't hide the banner" })
  })
})
