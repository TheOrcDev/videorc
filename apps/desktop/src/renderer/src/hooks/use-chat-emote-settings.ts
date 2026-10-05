import { useCallback, useEffect, useRef, useState } from 'react'

import { BackendClient } from '@/backendClient'
import type { ChatEmotesSettings, ChatEmotesSettingsPatch, TwitchGifMode } from '@/lib/backend'

export interface ChatEmoteSettingsState {
  /** `null` until the backend answers. */
  settings: ChatEmotesSettings | null
  /** Set when the setting could not be read or saved. */
  error: string | null
  setSevenTv: (on: boolean) => void
  /** "GIFs in Twitch chat" (plan 154, D6). */
  setTwitchGifs: (mode: TwitchGifMode) => void
}

/**
 * Settings → General → "Show 7TV emotes in chat" (plan 089) and "GIFs in
 * Twitch chat" (plan 154): one backend row, one client. It opens its own
 * backend client while the panel is mounted, as Upcoming does, so the
 * controls add nothing to the main window's startup bundle. `liveChat.emotes`
 * keeps the status line current while Settings is open, for example when a
 * stream that just went live finishes loading its emotes.
 */
export function useChatEmoteSettings(): ChatEmoteSettingsState {
  const client = useRef<BackendClient | null>(null)
  const [settings, setSettings] = useState<ChatEmotesSettings | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let disposed = false
    let active: BackendClient | null = null
    void window.videorc
      .getBackendConnection()
      .then(async (connection) => {
        if (!connection) throw new Error('The backend is offline.')
        if (disposed) return
        active = new BackendClient(connection)
        await active.connect()
        if (disposed) {
          active.close()
          return
        }
        client.current = active
        active.on('liveChat.emotes', (next) => {
          if (!disposed) setSettings(next)
        })
        const current = await active.request<ChatEmotesSettings>('liveChat.emotes.get')
        if (!disposed) setSettings(current)
      })
      .catch(() => {
        if (!disposed) setError("Couldn't read this setting. Reopen Settings to try again.")
      })
    return () => {
      disposed = true
      active?.close()
      client.current = null
    }
  }, [])

  const patch = useCallback((change: ChatEmotesSettingsPatch) => {
    const active = client.current
    if (!active) return
    setError(null)
    setSettings((current) => current && { ...current, ...change })
    active
      .request<ChatEmotesSettings>('liveChat.emotes.set', change)
      .then(setSettings)
      .catch(() => {
        setError("Couldn't save this setting. Try again.")
        void active
          .request<ChatEmotesSettings>('liveChat.emotes.get')
          .then(setSettings)
          .catch(() => undefined)
      })
  }, [])
  const setSevenTv = useCallback((on: boolean) => patch({ sevenTv: on }), [patch])
  const setTwitchGifs = useCallback((mode: TwitchGifMode) => patch({ twitchGifs: mode }), [patch])

  return { settings, error, setSevenTv, setTwitchGifs }
}
