import { useEffect, useMemo, useState, useSyncExternalStore } from 'react'

import type { Sound, SoundboardSettingsParams, SoundUpdateParams, SoundVoice } from '@/lib/backend'
import {
  changeSoundboardSettings,
  importSounds,
  moveSound,
  removeSoundWithUndo,
  restoreStarters,
  runSoundboardAction,
  updateSound
} from '@/lib/soundboard-actions'
import { soundboard, type SoundboardSnapshot } from '@/lib/soundboard-store'
import type { SoundImportPhase } from '@/lib/sounds'
import type { SoundRelayAction, StarterSound } from '../../../shared/sound-commands'

// Plan 189: the soundboard as the pages read it, from the store Studio's
// provider feeds (lib/soundboard-store.ts). Only lazy chunks import this:
// Studio's Soundboard, Assets → Sounds, Sources → Sounds and ⌘K.

export function useSoundboardSnapshot(): SoundboardSnapshot {
  return useSyncExternalStore(soundboard.subscribe, soundboard.getSnapshot, soundboard.getSnapshot)
}

/** The board as every page shows it. Pure, so the tests read it. */
export interface SoundboardView {
  /** Board order, without the sounds waiting for their Undo. */
  sounds: Sound[]
  /** `sounds.list` has answered once: "No sounds yet" waits for it. */
  loaded: boolean
  /** Videorc is reconnecting: every action waits for it. */
  offline: boolean
  voices: readonly SoundVoice[]
  /** Each playing sound's newest voice, for its pad's progress. */
  voiceBySound: ReadonlyMap<string, SoundVoice>
  /** "Hear sounds yourself". */
  monitor: boolean
  /** The board's Level, whole dB. */
  volumeDb: number
  /** A recording or stream runs that sounds can't reach (release test 147). */
  sessionWithoutSounds: boolean
}

export function soundboardView(snapshot: SoundboardSnapshot): SoundboardView {
  const board = snapshot.board
  const sounds = (board?.sounds ?? []).filter((sound) => !snapshot.hidden.has(sound.id))
  const voiceBySound = new Map<string, SoundVoice>()
  for (const voice of snapshot.voices) voiceBySound.set(voice.soundId, voice)
  return {
    sounds,
    loaded: board !== null,
    offline: !snapshot.online,
    voices: snapshot.voices,
    voiceBySound,
    monitor: board?.monitor ?? true,
    volumeDb: board?.volumeDb ?? 0,
    sessionWithoutSounds: snapshot.sessionWithoutSounds
  }
}

export interface SoundboardActions {
  play: (id: string) => Promise<boolean>
  stop: (id: string) => Promise<boolean>
  /** A key: the backend applies the sound's mode. */
  press: (id: string) => Promise<boolean>
  stopAll: () => Promise<boolean>
  importPhase: SoundImportPhase
  importSounds: () => Promise<void>
  updateSound: (id: string, patch: Omit<SoundUpdateParams, 'id'>) => Promise<Sound | null>
  moveSound: (id: string, targetIndex: number) => Promise<boolean>
  removeSound: (sound: Pick<Sound, 'id' | 'name'>) => void
  changeSettings: (settings: SoundboardSettingsParams) => Promise<boolean>
  restoring: boolean
  restoreStarters: () => Promise<void>
}

const run = (action: SoundRelayAction): Promise<boolean> => runSoundboardAction(soundboard, action)

export function useSoundboard(): SoundboardView & SoundboardActions {
  const snapshot = useSoundboardSnapshot()
  const view = useMemo(() => soundboardView(snapshot), [snapshot])
  const [importPhase, setImportPhase] = useState<SoundImportPhase>('idle')
  const [restoring, setRestoring] = useState(false)
  return {
    ...view,
    play: (id) => run({ action: 'play', id }),
    stop: (id) => run({ action: 'stop', id }),
    press: (id) => run({ action: 'press', id }),
    stopAll: () => run({ action: 'stopAll' }),
    importPhase,
    importSounds: () => importSounds(soundboard, setImportPhase),
    updateSound: (id, patch) => updateSound(soundboard, id, patch),
    moveSound: (id, targetIndex) => moveSound(soundboard, id, targetIndex),
    removeSound: (sound) => removeSoundWithUndo(soundboard, sound),
    changeSettings: (settings) => changeSoundboardSettings(soundboard, settings),
    restoring,
    restoreStarters: async () => {
      setRestoring(true)
      try {
        await restoreStarters(soundboard)
      } finally {
        setRestoring(false)
      }
    }
  }
}

// The bundled starters change only with an update, so one read serves the run.
let starterSounds: Promise<StarterSound[]> | null = null

/** The starter sounds main bundles (slug, name, key), or null until read. */
export function useStarterSounds(): StarterSound[] | null {
  const [starters, setStarters] = useState<StarterSound[] | null>(null)
  useEffect(() => {
    let disposed = false
    starterSounds ??= (window.videorc?.getStarterSounds?.() ?? Promise.resolve([])).catch(
      (error: unknown) => {
        starterSounds = null
        console.warn('[sounds] the starter sounds list was not read:', error)
        return []
      }
    )
    void starterSounds.then((list) => {
      if (!disposed) setStarters(list)
    })
    return () => {
      disposed = true
    }
  }, [])
  return starters
}
