// `videorc://golem` (plan 170 D18): "Open in Videorc" and "Make it Alive" on
// videorc.com. Pure helpers, so the routing and the follow-up are tested in
// node; main wires them to the window, the renderer event and the backend.

import { isGolemLibraryId } from '../shared/golem-library'

export const GOLEM_DEEP_LINK_HOST = 'golem'

/** A Golem deep link: optionally the avatar "Make it Alive" was pressed on. */
export interface GolemDeepLink {
  alive: string | null
}

/**
 * `videorc://golem` or `videorc://golem/library`, with an optional
 * `?alive=<uuid or official:<slug>>`. Anything else (another host, another
 * path, another scheme) is null and stays ignored. An `alive` that is not a
 * library id is dropped; the link still opens the Golem tab.
 */
export function parseGolemDeepLink(rawUrl: string, scheme = 'videorc'): GolemDeepLink | null {
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    return null
  }
  if (url.protocol !== `${scheme}:` || url.hostname !== GOLEM_DEEP_LINK_HOST) return null
  if (url.username || url.password || url.port) return null
  const path = url.pathname.replace(/\/+$/, '')
  if (path !== '' && path !== '/library') return null
  const alive = url.searchParams.get('alive')
  return { alive: alive && isGolemLibraryId(alive) ? alive : null }
}

/** The library state fields the follow-up reads (`cohost.library.get`). */
interface LibraryProgress {
  activeAvatarId: string | null
  busy: { kind: string; avatarId?: string } | null
  error?: { code: string; message: string }
}

export interface GolemDeepLinkDeps {
  /** Focus the main window and open the Golem tab; `openCreator` also opens
   * the creator with the Golem's idle as its reference. */
  showGolemTab: (openCreator: boolean) => void
  /** A backend call on main's admin channel. */
  request: <T>(method: string, params: Record<string, unknown>) => Promise<T>
  sleep: (ms: number) => Promise<void>
  log: (message: string) => void
}

export type GolemDeepLinkOutcome = 'synced' | 'opened' | 'failed'

/**
 * Open the Golem tab and sync the library at once (D18). With `alive`, use
 * that avatar after the sync (the backend runs library jobs in order), wait
 * until the Golem wears it, then open the creator. A failed use (shown in
 * the library's error) or a slow one never opens the creator.
 */
export async function runGolemDeepLink(
  link: GolemDeepLink,
  deps: GolemDeepLinkDeps,
  options: { pollMs?: number; timeoutMs?: number } = {}
): Promise<GolemDeepLinkOutcome> {
  const pollMs = options.pollMs ?? 500
  const timeoutMs = options.timeoutMs ?? 90_000
  deps.showGolemTab(false)
  try {
    await deps.request('cohost.library.sync', { reason: 'deep-link' })
  } catch (error) {
    deps.log(`Golem deep link: the library sync was refused (${errorText(error)}).`)
  }
  const alive = link.alive
  if (!alive) return 'synced'
  try {
    await deps.request('cohost.library.use', { avatarId: alive })
  } catch (error) {
    deps.log(`Golem deep link: the avatar could not be used (${errorText(error)}).`)
    return 'failed'
  }
  let sawUse = false
  for (let waited = 0; waited <= timeoutMs; waited += pollMs) {
    await deps.sleep(pollMs)
    let state: LibraryProgress | undefined
    try {
      state = await deps.request<LibraryProgress>('cohost.library.get', {})
    } catch {
      continue
    }
    if (!state) continue
    if (state.busy?.kind === 'use' && state.busy.avatarId === alive) sawUse = true
    if (state.busy === null && state.activeAvatarId === alive) {
      deps.showGolemTab(true)
      return 'opened'
    }
    if (state.busy === null && sawUse && state.error) {
      deps.log(`Golem deep link: ${state.error.message}`)
      return 'failed'
    }
  }
  deps.log('Golem deep link: the avatar took too long to apply; the creator was not opened.')
  return 'failed'
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
