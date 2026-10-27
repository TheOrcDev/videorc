import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { BackendClient, BackendRequestError } from '@/backendClient'
import type {
  DiscordAnnounceSnapshot,
  DiscordAnnounceUpdateParams,
  DiscordLinkTarget,
  DiscordLinksPreview,
  DiscordTestResult
} from '@/lib/backend'
import { userErrorMessage } from '@/lib/user-error'

export interface DiscordAnnounceState {
  /** `null` until the backend answers. */
  snapshot: DiscordAnnounceSnapshot | null
  preview: DiscordLinksPreview | null
  /** Set when the settings could not be read or a change could not be saved. */
  error: string | null
  /** Pastes a webhook; resolves to the refusal sentence, or null when saved. */
  saveWebhook: (url: string) => Promise<string | null>
  /** Removes one webhook; the others keep posting. */
  removeWebhook: (webhookId: string) => Promise<void>
  /** Sends the test post through one webhook; resolves to its outcome. */
  sendTest: (webhookId: string) => Promise<{ messageUrl?: string; error?: string }>
  update: (patch: DiscordAnnounceUpdateParams) => Promise<string | null>
}

/**
 * Livestream → Setup → Discord (plan 187). The settings live in the backend
 * (it posts at Go Live), so the section opens its own backend client while
 * it is mounted, as the privacy and chat rows do. `discord.announce.changed`
 * keeps it current, for example when a post fails mid-stream.
 */
export function useDiscordAnnounce(targets: readonly DiscordLinkTarget[]): DiscordAnnounceState {
  const client = useRef<BackendClient | null>(null)
  const [connected, setConnected] = useState(false)
  const [snapshot, setSnapshot] = useState<DiscordAnnounceSnapshot | null>(null)
  const [preview, setPreview] = useState<DiscordLinksPreview | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let disposed = false
    let active: BackendClient | null = null
    void window.videorc
      .getBackendConnection()
      .then(async (connection) => {
        if (!connection) throw new Error('No connection to Videorc yet.')
        if (disposed) return
        active = new BackendClient(connection)
        await active.connect()
        if (disposed) {
          active.close()
          return
        }
        client.current = active
        active.on('discord.announce.changed', (next) => {
          if (!disposed) setSnapshot(next)
        })
        const current = await active.requestTyped('discord.announce.get')
        if (disposed) return
        setSnapshot(current)
        setConnected(true)
      })
      .catch(() => {
        if (!disposed)
          setError("Couldn't read the Discord settings. Reopen Livestream to try again.")
      })
    return () => {
      disposed = true
      active?.close()
      client.current = null
    }
  }, [])

  // The preview follows the destinations and the choices that shape it.
  const targetsKey = JSON.stringify(targets)
  const previewKey = snapshot
    ? JSON.stringify([
        targetsKey,
        snapshot.excludedTargetIds,
        snapshot.linkOverrides,
        snapshot.postAs,
        snapshot.identities.length
      ])
    : null
  const stableTargets = useMemo(() => JSON.parse(targetsKey) as DiscordLinkTarget[], [targetsKey])
  useEffect(() => {
    const active = client.current
    if (!connected || !active || previewKey === null) return
    let stale = false
    void active
      .requestTyped('discord.links.preview', { targets: stableTargets })
      .then((next) => {
        if (!stale) setPreview(next)
      })
      .catch(() => undefined)
    return () => {
      stale = true
    }
  }, [connected, previewKey, stableTargets])

  const update = useCallback(async (patch: DiscordAnnounceUpdateParams) => {
    const active = client.current
    if (!active) return 'Videorc is reconnecting. Try again in a moment.'
    try {
      setSnapshot(await active.requestTyped('discord.announce.update', patch))
      setError(null)
      return null
    } catch (caught) {
      const message = discordRefusal(caught, 'save', 'the Discord settings')
      setError(message)
      return message
    }
  }, [])

  const saveWebhook = useCallback(async (url: string) => {
    const active = client.current
    if (!active) return 'Videorc is reconnecting. Try again in a moment.'
    try {
      setSnapshot(await active.requestTyped('discord.webhook.save', { url }))
      return null
    } catch (caught) {
      return discordRefusal(caught, 'connect', 'the webhook')
    }
  }, [])

  const removeWebhook = useCallback(async (webhookId: string) => {
    const active = client.current
    if (!active) return
    try {
      setSnapshot(await active.requestTyped('discord.webhook.remove', { webhookId }))
    } catch (caught) {
      setError(discordRefusal(caught, 'remove', 'the webhook'))
    }
  }, [])

  const sendTest = useCallback(
    async (webhookId: string) => {
      const active = client.current
      if (!active) return { error: 'Videorc is reconnecting. Try again in a moment.' }
      try {
        const result: DiscordTestResult = await active.requestTyped('discord.webhook.sendTest', {
          targets: stableTargets,
          webhookId
        })
        return result.messageUrl ? { messageUrl: result.messageUrl } : {}
      } catch (caught) {
        return { error: discordRefusal(caught, 'send', 'the test message') }
      }
    },
    [stableTargets]
  )

  return { snapshot, preview, error, saveWebhook, removeWebhook, sendTest, update }
}

/** The backend's Discord refusals are already section sentences. */
function discordRefusal(caught: unknown, action: string, object: string): string {
  if (caught instanceof BackendRequestError && caught.code.startsWith('discord-')) {
    return caught.message
  }
  return userErrorMessage(caught, { action, object }).text
}
