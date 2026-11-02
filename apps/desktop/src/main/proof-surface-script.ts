interface ProofScriptContents {
  isDestroyed(): boolean
  once(event: 'destroyed', listener: () => void): unknown
  removeListener(event: 'destroyed', listener: () => void): unknown
  executeJavaScript(code: string, userGesture?: boolean): Promise<unknown>
}

/** A retired renderer cannot keep the preview mutation queue waiting for JavaScript. */
export function executeProofSurfaceScript<T = unknown>(
  contents: ProofScriptContents,
  code: string,
  userGesture = true
): Promise<T | undefined> {
  if (contents.isDestroyed()) return Promise.resolve(undefined)

  return new Promise((resolve, reject) => {
    let settled = false
    const finish = (result: { value: T | undefined } | { error: unknown }): void => {
      if (settled) return
      settled = true
      contents.removeListener('destroyed', onDestroyed)
      if ('error' in result) reject(result.error)
      else resolve(result.value)
    }
    const onDestroyed = (): void => finish({ value: undefined })
    contents.once('destroyed', onDestroyed)
    if (settled || contents.isDestroyed()) {
      onDestroyed()
      return
    }
    try {
      // Keep both handlers attached: Electron may settle this call after the
      // renderer retired. A late answer must neither revive it nor go unhandled.
      void contents.executeJavaScript(code, userGesture).then(
        (value) => finish({ value: value as T }),
        (error: unknown) => finish(contents.isDestroyed() ? { value: undefined } : { error })
      )
    } catch (error) {
      finish(contents.isDestroyed() ? { value: undefined } : { error })
    }
  })
}
