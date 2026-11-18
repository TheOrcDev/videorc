import { useCallback, useEffect, useRef, useState } from 'react'

import { useStudioDiagnostics } from '@/hooks/use-studio'
import type { ChatEmotesSettings, ChatEmotesSettingsPatch, TwitchGifMode } from '@/lib/backend'

export interface ChatEmoteSettingsState {
  /** `null` until the backend answers. */
  settings: ChatEmotesSettings | null
  /** Set when the setting could not be read or saved. */
  error: string | null
  setSevenTv: (on: boolean) => void
  /** "GIFs in Twitch chat" (plan 155, D6). */
  setTwitchGifs: (mode: TwitchGifMode) => void
}

const RECONNECTING = 'Videorc is reconnecting. Try again in a moment.'

/**
 * Settings → General → "Show 7TV emotes in chat" (plan 089) and "GIFs in
 * Twitch chat" (plan 155): one backend row. It uses the app's shared backend
 * client, which the Studio provider replaces on every reconnect, so a save
 * after the engine recovered goes to the live connection and the row reads
 * the setting again on it. `liveChat.emotes` keeps the status line current
 * while Settings is open, for example when a stream that just went live
 * finishes loading its emotes.
 */
export function useChatEmoteSettings(): ChatEmoteSettingsState {
  const { client } = useStudioDiagnostics()
  const [settings, setSettings] = useState<ChatEmotesSettings | null>(null)
  const [error, setError] = useState<string | null>(null)
  // The newest client and value, for a save to use rather than a closed one.
  const clientRef = useRef(client)
  const settingsRef = useRef(settings)
  clientRef.current = client
  settingsRef.current = settings

  useEffect(() => {
    if (!client) return undefined
    let disposed = false
    const off = client.on('liveChat.emotes', (next) => {
      if (!disposed) setSettings(next)
    })
    client
      .request<ChatEmotesSettings>('liveChat.emotes.get')
      .then((current) => {
        if (disposed) return
        setSettings(current)
        setError(null)
      })
      .catch(() => {
        if (!disposed) setError("Couldn't read the chat settings. Reopen Settings to try again.")
      })
    return () => {
      disposed = true
      off()
    }
  }, [client])

  const patch = useCallback((change: ChatEmotesSettingsPatch) => {
    const active = clientRef.current
    if (!active) {
      setError(RECONNECTING)
      return
    }
    const before = settingsRef.current
    setError(null)
    setSettings((current) => current && { ...current, ...change })
    active
      .request<ChatEmotesSettings>('liveChat.emotes.set', change)
      .then(setSettings)
      .catch(() => {
        setError("Couldn't save the chat settings. Try again.")
        // Show what is stored. When it cannot be read either, show what was
        // there before the flip, never the choice that did not save.
        const reconcile = clientRef.current ?? active
        reconcile
          .request<ChatEmotesSettings>('liveChat.emotes.get')
          .then(setSettings)
          .catch(() =>
            setSettings((current) =>
              current && before ? { ...current, ...pick(before, change) } : current
            )
          )
      })
  }, [])
  const setSevenTv = useCallback((on: boolean) => patch({ sevenTv: on }), [patch])
  const setTwitchGifs = useCallback((mode: TwitchGifMode) => patch({ twitchGifs: mode }), [patch])

  return { settings, error, setSevenTv, setTwitchGifs }
}

/** `settings`' values for the keys `change` set. */
function pick(
  settings: ChatEmotesSettings,
  change: ChatEmotesSettingsPatch
): ChatEmotesSettingsPatch {
  const before: Record<string, unknown> = {}
  for (const key of Object.keys(change) as (keyof ChatEmotesSettings)[]) before[key] = settings[key]
  return before as ChatEmotesSettingsPatch
}
