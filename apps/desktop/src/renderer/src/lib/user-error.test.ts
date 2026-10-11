import { beforeEach, describe, expect, it, vi } from 'vitest'

const toast = vi.hoisted(() => ({ error: vi.fn(), warning: vi.fn() }))
vi.mock('@/lib/toast', () => ({ toast }))

import {
  OFFLINE_REASON,
  OFFLINE_TOAST_ID,
  UNKNOWN_REASON,
  UserFacingError,
  couldNotTitle,
  offlineError,
  toastOffline,
  toastUserError,
  userErrorMessage
} from './user-error'

// Plan 174 S2.4 (J2-7, J2-14): every failure says what failed and what to do.

const IMPORT = { action: 'import', object: 'the image' }

function backendError(code: string, message: string): Error {
  return Object.assign(new Error(message), { name: 'BackendRequestError', code })
}

describe('userErrorMessage', () => {
  it('turns an unknown failure into "Couldn\'t {action} {object}" and the one next step', () => {
    const copy = userErrorMessage(new Error('EACCES: permission denied, open /x.png'), IMPORT)
    expect(copy).toEqual({
      kind: 'unknown',
      title: "Couldn't import the image",
      description: UNKNOWN_REASON,
      text: `Couldn't import the image. ${UNKNOWN_REASON}`,
      tone: 'error',
      raw: 'EACCES: permission denied, open /x.png'
    })
    expect(UNKNOWN_REASON).toBe(
      'Try again. If it keeps happening, export a support bundle from Health.'
    )
  })

  it("strips Electron's IPC wrapper from the raw text", () => {
    const copy = userErrorMessage(
      new Error(
        "Error invoking remote method 'comments-window:moderate': Error: Backend socket is not connected."
      ),
      { action: 'remove', object: 'the message' }
    )
    expect(copy.raw).toBe('Backend socket is not connected.')
    expect(copy.kind).toBe('offline')
    expect(copy.text).not.toContain('invoking remote method')
  })

  it('says Videorc is reconnecting for every offline shape, as a warning', () => {
    for (const error of [
      offlineError(),
      new Error('Backend socket is not connected.'),
      new Error('Backend WebSocket is not connected.'),
      new Error('Backend connection closed.'),
      new Error('Backend is not connected. Try again in a moment.'),
      new Error('Could not connect to the Rust backend.'),
      new Error('Backend request "clip.mark" timed out before it was sent.')
    ]) {
      const copy = userErrorMessage(error, { action: 'mark', object: 'the clip' })
      expect(copy).toMatchObject({
        kind: 'offline',
        title: "Couldn't mark the clip",
        description: OFFLINE_REASON,
        tone: 'warning'
      })
    }
    expect(userErrorMessage(offlineError())).toMatchObject({
      title: 'Videorc is reconnecting',
      description: 'Try again in a moment.'
    })
  })

  it('maps known backend codes to their own sentence', () => {
    expect(
      userErrorMessage(
        backendError('clean-cut-mutation-blocked', 'This recording cannot be deleted while…'),
        { action: 'delete', object: 'the recording' }
      )
    ).toMatchObject({
      kind: 'known',
      description: 'Clean cut is still working on this recording. Try again when it finishes.',
      tone: 'warning'
    })
    expect(
      userErrorMessage(backendError('session-rename-invalid', 'Titles must be 1-120 characters.'))
        .description
    ).toBe('A title needs 1 to 120 characters.')
    expect(
      userErrorMessage(
        backendError(
          'request-outcome-unknown',
          'Backend request "screens.activate" timed out; its outcome is unknown.'
        )
      ).description
    ).toContain("didn't hear back")
    expect(
      userErrorMessage(new Error('Backend request "x" lost the socket; its outcome is unknown.'))
        .kind
    ).toBe('known')
  })

  it('keeps a renderer-written reason, and an unmapped code stays generic', () => {
    expect(
      userErrorMessage(new UserFacingError('The selected output folder is unavailable.'), IMPORT)
    ).toMatchObject({ kind: 'known', description: 'The selected output folder is unavailable.' })
    expect(
      userErrorMessage(backendError('session-duplicate-failed', 'io error: disk full'), IMPORT)
        .description
    ).toBe(UNKNOWN_REASON)
  })

  it('calls a cancel a cancel, and names Videorc when it knows no action', () => {
    expect(userErrorMessage(Object.assign(new Error('x'), { name: 'AbortError' })).kind).toBe(
      'canceled'
    )
    expect(couldNotTitle(undefined)).toBe('Videorc hit a problem')
    expect(couldNotTitle({ action: 'sign out' })).toBe("Couldn't sign out")
    expect(userErrorMessage('a thrown string').raw).toBe('a thrown string')
  })
})

describe('toastUserError', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  })

  it('toasts the copy by meaning and logs the raw text', () => {
    toastUserError(new Error('ENOSPC'), IMPORT, { id: 'import' })
    expect(toast.error).toHaveBeenCalledWith("Couldn't import the image", {
      id: 'import',
      description: UNKNOWN_REASON
    })
    expect(console.warn).toHaveBeenCalledWith("[user-error] Couldn't import the image:", 'ENOSPC')
    toastOffline({ action: 'check', object: 'the microphone' })
    expect(toast.warning).toHaveBeenCalledWith("Couldn't check the microphone", {
      id: OFFLINE_TOAST_ID,
      description: OFFLINE_REASON
    })
  })

  it('stays quiet for a cancel', () => {
    toastUserError(Object.assign(new Error('x'), { name: 'AbortError' }), IMPORT)
    expect(toast.error).not.toHaveBeenCalled()
    expect(toast.warning).not.toHaveBeenCalled()
  })
})
