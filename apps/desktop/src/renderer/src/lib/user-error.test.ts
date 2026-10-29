import { beforeEach, describe, expect, it, vi } from 'vitest'

const toast = vi.hoisted(() => ({ error: vi.fn(), warning: vi.fn() }))
vi.mock('@/lib/toast', () => ({ toast }))

import { bannerActionContext } from './banners'
import { soundActionContext } from './sounds'
import {
  OFFLINE_REASON,
  OFFLINE_TOAST_ID,
  SECURE_STORAGE_REASON,
  UNKNOWN_REASON,
  UserFacingError,
  couldNotTitle,
  offlineError,
  toastOffline,
  toastUserError,
  inlineUserError,
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
        "Error invoking remote method 'comments-window:moderate': Error: Videorc's engine isn't connected."
      ),
      { action: 'remove', object: 'the message' }
    )
    expect(copy.raw).toBe("Videorc's engine isn't connected.")
    expect(copy.kind).toBe('offline')
    expect(copy.text).not.toContain('invoking remote method')
  })

  it('names the missing keyring when protected persistence refuses', () => {
    const copy = userErrorMessage(
      new Error(
        "Error invoking remote method 'system:pick-directory': Error: Protected desktop persistence is unavailable."
      ),
      { action: 'use', object: 'that folder' }
    )
    expect(copy).toMatchObject({
      kind: 'known',
      title: "Couldn't use that folder",
      description: SECURE_STORAGE_REASON,
      tone: 'error'
    })
  })

  it('says Videorc is reconnecting for every offline shape, as a warning', () => {
    for (const error of [
      offlineError(),
      new Error(OFFLINE_REASON),
      new Error("Videorc's engine isn't connected."),
      new Error("Videorc's engine connection closed."),
      new Error("Videorc's engine is shut down."),
      new Error("Couldn't connect to Videorc's engine."),
      new Error('The "clip.mark" request timed out before it was sent.'),
      new Error('Couldn\'t send the "clip.mark" request: InvalidStateError')
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
          'The "screens.activate" request timed out; its outcome is unknown.'
        )
      ).description
    ).toContain("didn't hear back")
    expect(
      userErrorMessage(new Error('The "x" request lost the socket; its outcome is unknown.')).kind
    ).toBe('known')
  })

  it('keeps a renderer-written reason, and an unmapped code stays generic', () => {
    expect(
      userErrorMessage(new UserFacingError('The selected output folder is unavailable.'), IMPORT)
    ).toMatchObject({
      kind: 'known',
      tone: 'error',
      description: 'The selected output folder is unavailable.'
    })
    // A refusal the renderer recognized keeps its sentence, as a warning (plan 186).
    expect(
      userErrorMessage(
        new UserFacingError('Hide this banner before you delete it.', 'warning'),
        IMPORT
      )
    ).toMatchObject({
      kind: 'known',
      tone: 'warning',
      description: 'Hide this banner before you delete it.'
    })
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

describe('inlineUserError', () => {
  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  })

  it('returns the one line and never the raw path', () => {
    const raw = 'EACCES: permission denied, open /Users/streamer/Buddy'
    const text = inlineUserError(new Error(raw), IMPORT, 'buddy-look')
    expect(text).toBe(`Couldn't import the image. ${UNKNOWN_REASON}`)
    expect(text).not.toContain('/Users/streamer')
    expect(console.warn).toHaveBeenCalledWith("[buddy-look] Couldn't import the image:", raw)
  })
})

// Plan 195 S4: a slow Record start or a long poster holds the liveControl
// lane, and a command that waits past its queue age is dropped. A live
// control the streamer pressed names itself; only a caller that passes no
// action gets "Videorc hit a problem", so background reads never toast.
describe('a live control a busy lane dropped (plan 195 S4)', () => {
  const BUSY = "Videorc was busy and didn't do it. Try again in a moment."
  const BUSY_CODES = ['command-expired-before-dispatch', 'command-lane-full', 'command-not-applied']
  const busy = (code = 'command-expired-before-dispatch'): Error =>
    backendError(code, 'The command expired while awaiting its reconciliation fence.')

  beforeEach(() => {
    vi.clearAllMocks()
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  })

  it.each([
    [bannerActionContext('show'), "Couldn't show the banner"],
    [bannerActionContext('hide'), "Couldn't hide the banner"],
    [bannerActionContext('hideAll'), "Couldn't hide the banners"],
    [soundActionContext('play'), "Couldn't play the sound"],
    [soundActionContext('press'), "Couldn't play the sound"],
    [soundActionContext('stop'), "Couldn't stop the sound"],
    [soundActionContext('stopAll'), "Couldn't stop the sounds"],
    [{ action: 'start', object: 'live captions' }, "Couldn't start live captions"],
    [{ action: 'show', object: 'the takeover' }, "Couldn't show the takeover"],
    [{ action: 'take off', object: 'the takeover' }, "Couldn't take off the takeover"],
    [{ action: 'restart', object: 'capture' }, "Couldn't restart capture"],
    [{ action: 'show', object: 'the message on stream' }, "Couldn't show the message on stream"]
  ])('names %j: "%s"', (context, title) => {
    for (const code of BUSY_CODES) {
      expect(userErrorMessage(busy(code), context)).toMatchObject({
        kind: 'known',
        title,
        description: BUSY,
        text: `${title}. ${BUSY}`,
        tone: 'warning'
      })
    }
    toastUserError(busy(), context, { id: 'live-control' })
    expect(toast.warning).toHaveBeenCalledWith(title, { id: 'live-control', description: BUSY })
    expect(toast.error).not.toHaveBeenCalled()
  })

  it('says "Videorc hit a problem" only when the caller names no action', () => {
    expect(userErrorMessage(busy())).toMatchObject({
      title: 'Videorc hit a problem',
      description: BUSY,
      tone: 'warning'
    })
  })
})
