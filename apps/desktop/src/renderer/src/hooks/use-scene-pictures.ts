import { useEffect, useRef, useState } from 'react'

import { BackendClient } from '@/backendClient'
import { useStudioCore } from '@/hooks/use-studio'
import type { ScenePictureTarget } from '@/lib/backend'

export function scenePictureTargetKey(target: ScenePictureTarget): string {
  switch (target.kind) {
    case 'app':
      return `app:${target.bundleId}`
    case 'window':
      return `window:${target.windowId}`
    case 'display':
      return `display:${target.screenId}`
  }
}

function targetsAdded(previous: ScenePictureTarget[], next: ScenePictureTarget[]): boolean {
  const remaining = new Map<string, number>()
  for (const target of previous) {
    const key = scenePictureTargetKey(target)
    remaining.set(key, (remaining.get(key) ?? 0) + 1)
  }
  return next.some((target) => {
    const key = scenePictureTargetKey(target)
    const count = remaining.get(key) ?? 0
    remaining.set(key, count - 1)
    return count === 0
  })
}

const VISIBILITY_COOLDOWN_MS = 30_000

/** Still pictures only. S6 mounts this on the scene surfaces. */
export function useScenePictures({
  targets,
  hidden,
  busy
}: {
  targets: ScenePictureTarget[]
  hidden: boolean
  busy: boolean
}): Map<string, string> {
  const { connection, wsStatus, runtimeInfo } = useStudioCore()
  const online = wsStatus === 'connected' && runtimeInfo?.platform === 'darwin' ? connection : null
  const [pictures, setPictures] = useState<Map<string, string>>(() => new Map())
  const current = useRef({ targets, hidden, busy, revision: 0 })
  // Compare content, so a render or reorder does not trigger another screenshot.
  const targetKey = JSON.stringify(targets.map(scenePictureTargetKey).sort())
  const signature = `${targetKey}:${hidden}:${busy}`
  const lastSignature = useRef(signature)
  if (lastSignature.current !== signature) {
    lastSignature.current = signature
    current.current.revision++
  }
  current.current.targets = targets
  current.current.hidden = hidden
  current.current.busy = busy
  const lastVisibilityRefresh = useRef<number | null>(null)
  const previousInputs = useRef({ targets, hidden, busy })
  const refresh = useRef<(() => void) | null>(null)
  // Survives connection changes: an old request must settle before another starts.
  const inFlight = useRef(false)

  useEffect(() => {
    if (!online) return
    let disposed = false
    let ready = false
    let unsupported = false
    let pending = true
    const client = new BackendClient(online)
    const eligible = (): boolean =>
      !disposed &&
      ready &&
      !unsupported &&
      document.visibilityState === 'visible' &&
      !current.current.hidden &&
      !current.current.busy &&
      current.current.targets.length > 0
    const run = (): void => {
      if (!eligible() || inFlight.current || !pending) return
      pending = false
      lastVisibilityRefresh.current ??= Date.now()
      inFlight.current = true
      const revision = current.current.revision
      const requested = current.current.targets
      void client
        .requestTyped('sources.scene_pictures', { targets: requested, maxWidth: 240 })
        .then(
          (result) => {
            if (!eligible() || revision !== current.current.revision || result.hidden) return
            if (result.unsupported) {
              unsupported = true
              setPictures(new Map())
              return
            }
            const next = new Map<string, string>()
            for (const picture of result.pictures) {
              if ('jpegBase64' in picture)
                next.set(
                  scenePictureTargetKey(picture.target),
                  `data:image/jpeg;base64,${picture.jpegBase64}`
                )
            }
            setPictures(next)
          },
          () => undefined // Keep the last stills if the backend is reconnecting.
        )
        .finally(() => {
          inFlight.current = false
          if (disposed) {
            refresh.current?.()
            return
          }
          if (pending) run()
        })
    }
    const request = (): void => {
      pending = true
      run()
    }
    const visibility = (): void => {
      // Invalidate even a request spanning hidden -> visible.
      current.current.revision++
      if (!eligible()) return
      // A deferred target/resume refresh has its own trigger; only a pure
      // visibility refresh is subject to the visibility cooldown.
      if (pending) {
        run()
        return
      }
      const now = Date.now()
      if (
        lastVisibilityRefresh.current !== null &&
        now - lastVisibilityRefresh.current < VISIBILITY_COOLDOWN_MS
      )
        return
      lastVisibilityRefresh.current = now
      request()
    }
    refresh.current = request
    document.addEventListener('visibilitychange', visibility)
    void client.connect().then(
      () => {
        ready = true
        run()
      },
      () => undefined
    )
    return () => {
      disposed = true
      document.removeEventListener('visibilitychange', visibility)
      if (refresh.current === request) refresh.current = null
      client.close()
    }
  }, [online])

  useEffect(() => {
    const previous = previousInputs.current
    const next = current.current
    previousInputs.current = { targets: next.targets, hidden, busy }
    if (
      targetsAdded(previous.targets, next.targets) ||
      (previous.busy && !busy) ||
      (previous.hidden && !hidden)
    )
      refresh.current?.()
  }, [targetKey, hidden, busy])
  return pictures
}
