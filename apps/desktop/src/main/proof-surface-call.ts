// A web-contents call on the Electron proof surface, settled by the surface's
// own teardown. The preview-window close handler destroys the surface while
// the serialized placement mutation may still await a script on it; a
// BrowserWindow's destroy() settled that call, but the in-window
// WebContentsView (Linux, and macOS since plan 216 C) closes its web contents
// and the pending executeJavaScript/loadFile promise never settles. The
// mutation queue then holds `placement` past the close, and everything queued
// behind it (the close teardown) waits forever. Racing the call against the
// surface's `closed` event keeps the queue draining whichever host the
// surface has.

export interface ProofSurfaceCallHost {
  isDestroyed(): boolean
  on(event: 'closed', listener: () => void): unknown
  off(event: 'closed', listener: () => void): unknown
}

export class ProofSurfaceGoneError extends Error {
  readonly name = 'ProofSurfaceGoneError'

  constructor(detail = 'before the call settled') {
    super(`Proof surface was destroyed ${detail}.`)
  }
}

/**
 * Runs `call` on the proof surface and settles its result, or rejects with
 * ProofSurfaceGoneError as soon as the surface is destroyed, whichever comes
 * first. A surface that is already destroyed rejects without calling.
 */
export function settleWithProofSurface<Result>(
  surface: ProofSurfaceCallHost,
  call: () => Promise<Result>
): Promise<Result> {
  if (surface.isDestroyed()) {
    return Promise.reject(new ProofSurfaceGoneError('before the call started'))
  }
  return new Promise<Result>((resolve, reject) => {
    let settled = false
    const onClosed = (): void => {
      surface.off('closed', onClosed)
      if (settled) {
        return
      }
      settled = true
      reject(new ProofSurfaceGoneError())
    }
    surface.on('closed', onClosed)
    let pending: Promise<Result>
    try {
      pending = call()
    } catch (error) {
      surface.off('closed', onClosed)
      settled = true
      reject(error)
      return
    }
    pending.then(
      (value) => {
        surface.off('closed', onClosed)
        if (!settled) {
          settled = true
          resolve(value)
        }
      },
      (error) => {
        surface.off('closed', onClosed)
        if (!settled) {
          settled = true
          reject(error)
        }
      }
    )
  })
}

/** `webContents.executeJavaScript` on the proof surface, settled by its teardown. */
export function executeProofSurfaceScript<Result = unknown>(
  surface: ProofSurfaceCallHost & {
    readonly webContents: {
      executeJavaScript(code: string, userGesture?: boolean): Promise<Result>
    }
  },
  code: string,
  userGesture = true
): Promise<Result> {
  return settleWithProofSurface(surface, () =>
    surface.webContents.executeJavaScript(code, userGesture)
  )
}
