import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { BackendClient } from '@/backendClient'
import type { ScreenPrivacy } from '@/lib/backend'
import { toast } from '@/lib/toast'
import {
  screenPrivacyAction,
  SCREEN_HIDE_UNAVAILABLE,
  type PrivacyCaller
} from '@/lib/studio-actions/privacy'

export function useScreenPrivacy(
  client: BackendClient | null,
  sessionState: string,
  connectionState?: string
) {
  const [screenPrivacy, setPrivacy] = useState<ScreenPrivacy>({ hidden: false })
  const revision = useRef(0)
  const tail = useRef<Promise<unknown>>(Promise.resolve())
  useEffect(() => {
    if (!client || (connectionState !== undefined && connectionState !== 'connected')) return
    let active = true
    const read = () => {
      const expected = ++revision.current
      void client
        .request<ScreenPrivacy>('screen.privacy.get')
        .then((value) => {
          if (active && expected === revision.current) setPrivacy(value)
        })
        .catch((error) => console.warn('[screen-privacy] refresh failed', error))
    }
    const off = client.on('screen.privacy.changed', (value) => {
      ++revision.current
      setPrivacy(value)
      read()
    })
    read()
    return () => {
      active = false
      off()
    }
  }, [client, sessionState, connectionState])
  const runScreenPrivacy = useCallback(
    async (
      mode: 'hide' | 'show' | 'toggle',
      caller: PrivacyCaller = 'you',
      reason: 'you' | 'password-manager' = 'you'
    ) => {
      if (!client) return { ok: false, message: 'Videorc is reconnecting. Try again in a moment.' }
      const turn = tail.current
        .catch(() => undefined)
        .then(async () => {
          const expected = ++revision.current
          const result = await screenPrivacyAction(client, mode, caller, reason)
          if (result.privacy && expected === revision.current) setPrivacy(result.privacy)
          if (result.message === SCREEN_HIDE_UNAVAILABLE)
            toast.warning(SCREEN_HIDE_UNAVAILABLE, { id: 'screen-hide-unavailable' })
          return result
        })
      tail.current = turn
      return turn
    },
    [client]
  )
  const hideScreen = useCallback(
    (reason: 'you' | 'password-manager' = 'you') => runScreenPrivacy('hide', 'you', reason),
    [runScreenPrivacy]
  )
  const showScreen = useCallback(() => runScreenPrivacy('show'), [runScreenPrivacy])
  const toggleScreenHidden = useCallback(() => runScreenPrivacy('toggle'), [runScreenPrivacy])
  return useMemo(
    () => ({ screenPrivacy, hideScreen, showScreen, toggleScreenHidden, runScreenPrivacy }),
    [screenPrivacy, hideScreen, showScreen, toggleScreenHidden, runScreenPrivacy]
  )
}
