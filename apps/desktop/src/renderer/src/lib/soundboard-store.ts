// Plan 189: the soundboard, kept outside React like the audio levels. The
// Studio provider connects its backend client here and feeds `sounds.changed`
// and `sounds.playback`; the shell's host (soundboard-host.ts) runs the
// monitor and the Stream Manager's copy from it, and the pages read it
// through `use-soundboard` (a lazy chunk). Only types are imported: this
// module is in the eager bundle.

import type { SoundboardState, SoundsPlayback, SoundVoice } from './backend'

/** The part of the backend client the soundboard uses. */
export type SoundboardClient = {
  request<T>(method: string, params?: unknown, options?: { timeoutMs?: number }): Promise<T>
}

export interface SoundboardSnapshot {
  /** Null until `sounds.list` first answers: never "No sounds yet" before (J2-8). */
  board: SoundboardState | null
  /** Every playing voice, oldest first, as `sounds.playback` last said. */
  voices: readonly SoundVoice[]
  /** Removed in Assets with the Undo still up: every surface leaves them out. */
  hidden: ReadonlySet<string>
  /** Studio's backend connection is up. */
  online: boolean
  /** A recording or stream runs that sounds can't reach (release test 147). */
  sessionWithoutSounds: boolean
}

export interface SoundboardStore {
  getSnapshot: () => SoundboardSnapshot
  subscribe: (listener: () => void) => () => void
  /** Studio's backend client while it is connected. */
  client: () => SoundboardClient | null
  /** A connection came up: read the board on it. */
  connect: (client: SoundboardClient) => void
  /** That connection went away: nothing plays, the board stays as last read. */
  disconnect: (client: SoundboardClient) => void
  acceptBoard: (board: SoundboardState) => void
  acceptPlayback: (playback: SoundsPlayback) => void
  /** The removals waiting for their Undo (`soundboard-actions.ts` keeps them). */
  setHidden: (hidden: ReadonlySet<string>) => void
}

const NO_VOICES: readonly SoundVoice[] = []
const NOTHING_HIDDEN: ReadonlySet<string> = new Set()

export function createSoundboardStore(): SoundboardStore {
  const listeners = new Set<() => void>()
  let snapshot: SoundboardSnapshot = {
    board: null,
    voices: NO_VOICES,
    hidden: NOTHING_HIDDEN,
    online: false,
    sessionWithoutSounds: false
  }
  let current: SoundboardClient | null = null
  // Bumped by every board that arrives, so a `sounds.list` answer older than
  // a `sounds.changed` never wins.
  let boardRevision = 0

  const publish = (next: Partial<SoundboardSnapshot>): void => {
    snapshot = { ...snapshot, ...next }
    for (const listener of listeners) listener()
  }
  const acceptBoard = (board: SoundboardState): void => {
    boardRevision += 1
    publish({ board })
  }

  return {
    getSnapshot: () => snapshot,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    client: () => current,
    connect: (client) => {
      current = client
      publish({ online: true })
      const revision = boardRevision
      client.request<SoundboardState>('sounds.list').then(
        (board) => {
          if (current === client && revision === boardRevision) acceptBoard(board)
        },
        (error: unknown) => console.warn('[sounds] list read failed:', error)
      )
    },
    disconnect: (client) => {
      if (current !== client) return
      current = null
      publish({ online: false, voices: NO_VOICES, sessionWithoutSounds: false })
    },
    acceptBoard,
    acceptPlayback: (playback) =>
      publish({
        voices: playback.voices,
        sessionWithoutSounds: playback.sessionWithoutSounds === true
      }),
    setHidden: (hidden) => publish({ hidden })
  }
}

/** The app's one soundboard: Studio's provider feeds it, the shell's host and the pages read it. */
export const soundboard = createSoundboardStore()
