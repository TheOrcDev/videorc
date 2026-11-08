// Plan 189: the soundboard's work that runs whatever page is in front, in the
// main window only (the Studio provider starts it). It keeps the Stream
// Manager's read-only copy of the board, answers that window's pads and
// `/sound`, starts the monitor on the first voice, and seeds the starter
// sounds once per profile. The provider loads this module at mount (the
// eager bundle carries only the store), and the monitor, the seeding and the
// relayed actions load on demand from here.

import {
  soundboardSummary,
  type SoundRelayAction,
  type SoundboardSummary
} from '../../../shared/sound-commands'
import type { SoundboardSnapshot, SoundboardStore } from './soundboard-store'
import type { SoundMonitor } from './sound-monitor'

type HostApi = {
  pushCommentsSounds?: (board: SoundboardSummary | null) => Promise<boolean>
  onSoundRequest?: (
    callback: (command: SoundRelayAction & { requestId: string }) => void
  ) => () => void
  pushSoundResult?: (resolution: {
    requestId: string
    ok: boolean
    value?: boolean
    error?: string
  }) => Promise<boolean>
}

export interface SoundboardHostDeps {
  api: HostApi | undefined
  loadMonitor: () => Promise<{ createSoundMonitor: () => SoundMonitor }>
  /** Seeds the starter sounds; resolves once it has tried. */
  seedStarters: (store: SoundboardStore) => Promise<void>
  runAction: (
    store: SoundboardStore,
    action: SoundRelayAction
  ) => Promise<{ ok: boolean; message?: string }>
}

const browserDeps = (): SoundboardHostDeps => ({
  api: window.videorc,
  loadMonitor: () => import('./sound-monitor'),
  seedStarters: async (store) => (await import('./sound-starters')).seedStarterSounds(store),
  runAction: async (store, action) => {
    const client = store.client()
    const { runSoundAction } = await import('./sounds')
    if (!client) return { ok: false, message: 'Videorc is reconnecting. Try again in a moment.' }
    return runSoundAction(client, action, store.getSnapshot().board?.sounds ?? [])
  }
})

/** The board the Stream Manager shows: null until it loads. */
export function streamManagerBoard(snapshot: SoundboardSnapshot): SoundboardSummary | null {
  return snapshot.board
    ? soundboardSummary(snapshot.board.sounds, snapshot.voices, snapshot.hidden)
    : null
}

/** Starts the host; the returned function stops it. */
export function startSoundboardHost(
  store: SoundboardStore,
  deps: SoundboardHostDeps = browserDeps()
): () => void {
  let disposed = false
  let pushed: string | undefined
  let monitor: SoundMonitor | null = null
  let monitorLoading = false
  // One seeding try per connection: a failure waits for the next one.
  let seededOn: unknown = null

  const sync = (): void => {
    const snapshot = store.getSnapshot()
    const board = streamManagerBoard(snapshot)
    const body = JSON.stringify(board)
    if (body !== pushed) {
      pushed = body
      void deps.api?.pushCommentsSounds?.(board)?.catch(() => undefined)
    }
    if (monitor) monitor.update(snapshot)
    else if (snapshot.voices.length && !monitorLoading) {
      monitorLoading = true
      deps.loadMonitor().then(
        ({ createSoundMonitor }) => {
          if (disposed) return
          monitor = createSoundMonitor()
          monitor.update(store.getSnapshot())
        },
        (error: unknown) => {
          monitorLoading = false
          console.warn('[sounds] the monitor did not load:', error)
        }
      )
    }
    const client = store.client()
    if (client && snapshot.board?.startersSeeded === false && seededOn !== client) {
      seededOn = client
      deps.seedStarters(store).catch((error: unknown) => {
        console.warn('[sounds] starter sounds were not added:', error)
      })
    }
  }

  const off = store.subscribe(sync)
  sync()
  // A pad, `/sound` or Stop all in the Stream Manager: quietly here; a
  // refusal's sentence goes back to the window that asked.
  const offRelay = deps.api?.onSoundRequest?.(({ requestId, ...action }) => {
    void deps
      .runAction(store, action)
      .catch(() => ({ ok: false, message: undefined }))
      .then(({ ok, message }) =>
        deps.api?.pushSoundResult?.(
          ok
            ? { requestId, ok, value: true }
            : { requestId, ok, error: message || "Couldn't play the sound." }
        )
      )
  })
  return () => {
    disposed = true
    off()
    offRelay?.()
    monitor?.dispose()
    monitor = null
  }
}
