// Plan 189 S9 and S10: sounds from the live controls. The Stream Manager, the
// chat composer's `/sound`, ⌘K and the remotes see a sound the same way: its
// opaque id, the name the streamer typed and how a press plays it. Never its
// file, a path or any audio. Pure and schema-free, so the Stream Manager
// carries only what it runs: the IPC schemas live in `electron-ipc-contract`.

import type {
  CommentsCommandResolution,
  ResourceSelection,
  Sound,
  SoundHotkey,
  SoundMode,
  SoundVoice
} from './backend'

/** One sound as the live controls see it. */
export interface SoundSummary {
  id: string
  name: string
  mode: SoundMode
}

/** One playing sound, enough to draw its pad's progress. */
export interface SoundVoiceSummary {
  soundId: string
  startedAtMs: number
  durationMs: number
  loop: boolean
}

/** What Studio pushes to the Stream Manager: the board, in board order, and what plays. */
export interface SoundboardSummary {
  sounds: SoundSummary[]
  voices: SoundVoiceSummary[]
}

/**
 * A sound asked for away from Studio. A pad already applied its mode, so it
 * sends `play` or `stop`; `/sound` sends `press` and the backend applies the
 * mode, like a key. `stopAll` stops every sound.
 */
export type SoundRelayAction =
  | { action: 'play' | 'stop' | 'press'; id: string }
  | { action: 'stopAll' }

/** Stream Manager → main → Studio: one sound action with main's request id. */
export type SoundRelayCommand = SoundRelayAction & { requestId: string }

/** A starter sound as main reads it from the bundled manifest. */
export interface StarterSound {
  slug: string
  name: string
  hotkey?: SoundHotkey
}

/** A starter sound with its single-use `input-file` capability, for `sounds.import`. */
export interface StarterSoundFile extends StarterSound {
  selection: ResourceSelection
}

// The preload API's soundboard methods (plan 189). `VideorcApi` lives in
// `backend.ts`, pinned while plan 189 ran in parallel tracks, so they join it
// here by module augmentation; every program that types `VideorcApi` also
// compiles this file (both tsconfigs include `src/shared`).
declare module './backend' {
  interface VideorcApi {
    /** Assets → Sounds → Import sounds…: one `input-file` capability per picked
     * file, for `sounds.import`; empty when canceled. */
    pickSoundFiles: () => Promise<ResourceSelection[]>
    /** The bundled starter sounds' slugs, names and keys: no capability, no path. */
    getStarterSounds: () => Promise<StarterSound[]>
    /** The starter sounds with one capability each; only `slugs` when given. */
    getStarterSoundFiles: (slugs?: string[]) => Promise<StarterSoundFile[]>
    /** Sounds in the Stream Manager (plan 189 S9): the Studio renderer pushes
     * the read-only board (null until it loads); the window seeds from main's
     * copy and follows. */
    getCommentsSounds: () => Promise<SoundboardSummary | null>
    pushCommentsSounds: (board: SoundboardSummary | null) => Promise<boolean>
    onCommentsSounds: (callback: (board: SoundboardSummary | null) => void) => () => void
    /** A pad or `/sound` in the Stream Manager: relayed to the MAIN renderer,
     * which owns the backend socket; a refusal comes back as the reply's error. */
    soundFromCommentsWindow: (command: SoundRelayCommand) => Promise<boolean>
    onSoundRequest: (callback: (command: SoundRelayCommand) => void) => () => void
    pushSoundResult: (resolution: CommentsCommandResolution<boolean>) => Promise<boolean>
  }
}

/** The ids playing now. */
export function playingSoundIds(voices: readonly Pick<SoundVoice, 'soundId'>[]): Set<string> {
  return new Set(voices.map((voice) => voice.soundId))
}

/**
 * True when a press stops the sound instead of starting it: a playing
 * Play/stop or Loop sound (audiocn's pad mapping, applied by the backend for
 * keys and remotes). Play once restarts and While held starts.
 */
export function pressStops(mode: SoundMode, playing: boolean): boolean {
  return playing && (mode === 'toggle' || mode === 'loop')
}

/**
 * The projection Studio pushes: only these fields, whatever the board
 * carries, without the sounds waiting for their Undo to close.
 */
export function soundboardSummary(
  sounds: readonly Pick<Sound, 'id' | 'name' | 'mode'>[],
  voices: readonly SoundVoiceSummary[],
  hidden: ReadonlySet<string> = new Set()
): SoundboardSummary {
  const shown = sounds.filter((sound) => !hidden.has(sound.id))
  const ids = new Set(shown.map((sound) => sound.id))
  return {
    sounds: shown.map(({ id, name, mode }) => ({ id, name, mode })),
    voices: voices
      .filter((voice) => ids.has(voice.soundId))
      .map(({ soundId, startedAtMs, durationMs, loop }) => ({
        soundId,
        startedAtMs,
        durationMs,
        loop
      }))
  }
}

const folded = (name: string): string => name.trim().toLowerCase()

/**
 * The sound `/sound <name>` means (plan 189): case-insensitive, the first
 * sound in board order whose name starts with what was typed. Null when none.
 */
export function matchSoundName<T extends Pick<SoundSummary, 'name'>>(
  query: string,
  sounds: readonly T[]
): T | null {
  const wanted = folded(query)
  if (!wanted) return null
  return sounds.find((sound) => folded(sound.name).startsWith(wanted)) ?? null
}

/** What `/sound` alone says. */
export const SOUND_COMMAND_USAGE =
  "Type a sound's name after /sound, or /sound stop to stop them all."
/** `/sound` with no sounds on the board. */
export const NO_SOUNDS_YET = 'No sounds yet. Add sounds in Assets.'

/**
 * `/sound <name>` and `/sound stop` (plan 189): a press of the sound the name
 * means (the backend applies its mode), every sound stopped, or the
 * composer's words for why not. "stop" is reserved: it stops them all.
 */
export function classifySoundCommand(
  query: string,
  sounds: readonly SoundSummary[]
): { kind: 'sound'; action: SoundRelayAction } | { kind: 'error'; message: string } {
  const typed = query.trim()
  if (typed.toLowerCase() === 'stop') return { kind: 'sound', action: { action: 'stopAll' } }
  if (!sounds.length) return { kind: 'error', message: NO_SOUNDS_YET }
  if (!typed) return { kind: 'error', message: SOUND_COMMAND_USAGE }
  const sound = matchSoundName(typed, sounds)
  if (!sound) return { kind: 'error', message: `No sound called “${typed}”.` }
  return { kind: 'sound', action: { action: 'press', id: sound.id } }
}

/** One row of the composer's completion list: the text and what it does. */
export interface SoundCompletion {
  value: string
  hint: string
}

const SOUND_COMMAND = /^\/sound(?:\s+([\s\S]*))?$/i

/**
 * The completions under `/sound` (plan 189): each sound whose name starts
 * with what follows, with what Enter does to it, then `/sound stop`. Null
 * when the draft isn't a `/sound` command.
 */
export function soundCompletions(
  draft: string,
  board: SoundboardSummary
): SoundCompletion[] | null {
  const command = SOUND_COMMAND.exec(draft.trimStart())
  if (!command) return null
  const typed = folded(command[1] ?? '')
  const playing = playingSoundIds(board.voices)
  const seen = new Set<string>()
  const completions: SoundCompletion[] = []
  for (const sound of board.sounds) {
    const value = `/sound ${sound.name.trim()}`
    if (!folded(sound.name).startsWith(typed) || seen.has(value)) continue
    seen.add(value)
    completions.push({
      value,
      hint: pressStops(sound.mode, playing.has(sound.id)) ? ' · Stop' : ' · Play'
    })
  }
  if (board.sounds.length && 'stop'.startsWith(typed)) {
    completions.push({ value: '/sound stop', hint: ' · Stop all sounds' })
  }
  return completions
}
