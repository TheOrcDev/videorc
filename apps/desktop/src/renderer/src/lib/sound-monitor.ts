// Plan 189: "Hear sounds yourself". The main window plays each sound the
// backend plays (`sounds.playback`) through one lazily created AudioContext:
// the same WAV the bus mixes, at the same gain, so what the streamer hears is
// what viewers hear, ahead by the playout delay. It plays a voice that isn't
// on air (no session runs), and an on-air one while the monitor is on. Only
// the main window starts it (soundboard-host.ts), so there is one copy.
// Loaded on the first voice: no Web Audio code rides the eager bundle.

import { soundAssetUrl } from '../../../shared/sound-assets'
import type { Sound, SoundVoice } from './backend'
import type { SoundboardSnapshot } from './soundboard-store'

/** A stop or a restart fades the old voice out over 5 ms, like the bus. */
export const MONITOR_RAMP_SECONDS = 0.005
/** A board level or trim change glides over 10 ms: no zipper. */
export const MONITOR_GAIN_GLIDE_SECONDS = 0.01
/**
 * A voice whose sound is ready within this of its press plays from the top;
 * one ready later (the monitor turned on mid-sound, a slow first decode)
 * joins where the bus is.
 */
export const MONITOR_LATE_JOIN_MS = 300
/** With nothing playing this long, the context suspends and lets the output go. */
export const MONITOR_IDLE_SUSPEND_MS = 5_000

/** Decibels as linear gain. */
export function dbToGain(db: number): number {
  return 10 ** (db / 20)
}

/** The gain a voice plays at, on the bus and here alike: level + trim + board. */
export function voiceGainDb(
  sound: Pick<Sound, 'levelDb' | 'volumeDb'>,
  boardVolumeDb: number
): number {
  return sound.levelDb + sound.volumeDb + boardVolumeDb
}

/** Plan 189 D2: off air the streamer always hears a press; on air only with the monitor on. */
export function monitorHears(voice: Pick<SoundVoice, 'onAir'>, monitor: boolean): boolean {
  return !voice.onAir || monitor
}

/**
 * The voices to start and stop, given the ones playing (or loading) here and
 * the backend's next list. A voice plays when the board still has its sound
 * and the monitor hears it; anything else that plays here stops.
 */
export function monitorPlan(
  playing: ReadonlySet<string>,
  voices: readonly SoundVoice[],
  monitor: boolean,
  hasSound: (soundId: string) => boolean
): { start: SoundVoice[]; stop: string[] } {
  const wanted = voices.filter((voice) => hasSound(voice.soundId) && monitorHears(voice, monitor))
  const wantedIds = new Set(wanted.map((voice) => voice.voiceId))
  return {
    start: wanted.filter((voice) => !playing.has(voice.voiceId)),
    stop: [...playing].filter((voiceId) => !wantedIds.has(voiceId))
  }
}

/** Where in its sound a voice starts here, in seconds (`MONITOR_LATE_JOIN_MS`). */
export function monitorStartOffsetSeconds(
  voice: Pick<SoundVoice, 'startedAtMs' | 'loop'>,
  nowMs: number,
  bufferSeconds: number
): number {
  const ageMs = nowMs - voice.startedAtMs
  if (!(ageMs > MONITOR_LATE_JOIN_MS) || !(bufferSeconds > 0)) return 0
  const ageSeconds = ageMs / 1000
  return voice.loop ? ageSeconds % bufferSeconds : Math.min(ageSeconds, bufferSeconds)
}

export interface SoundMonitor {
  update: (snapshot: SoundboardSnapshot) => void
  dispose: () => void
}

export interface SoundMonitorDeps {
  createContext: () => AudioContext
  fetchBytes: (url: string) => Promise<ArrayBuffer>
  now: () => number
  setTimer: (callback: () => void, delayMs: number) => unknown
  clearTimer: (handle: unknown) => void
}

const browserDeps: SoundMonitorDeps = {
  createContext: () => new AudioContext({ latencyHint: 'interactive' }),
  fetchBytes: async (url) => {
    const response = await fetch(url)
    if (!response.ok) throw new Error(`The sound file answered ${response.status}.`)
    return response.arrayBuffer()
  },
  now: () => Date.now(),
  setTimer: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>)
}

type PlayingVoice = {
  soundId: string
  source: AudioBufferSourceNode
  gain: GainNode
  gainValue: number
}

/** Decoded once per sound and edit: a re-import or a new file decodes again. */
const bufferKey = (sound: Pick<Sound, 'file' | 'updatedAt'>): string =>
  `${sound.file}:${sound.updatedAt}`

export function createSoundMonitor(deps: SoundMonitorDeps = browserDeps): SoundMonitor {
  let context: AudioContext | null = null
  let latest: SoundboardSnapshot | null = null
  let disposed = false
  let idleTimer: unknown = null
  const buffers = new Map<string, { key: string; buffer: Promise<AudioBuffer> }>()
  const playing = new Map<string, PlayingVoice>()
  const loading = new Set<string>()
  const warned = new Set<string>()

  const audio = (): AudioContext => {
    context ??= deps.createContext()
    if (context.state === 'suspended') void context.resume().catch(() => undefined)
    return context
  }
  const soundFor = (soundId: string): Sound | undefined =>
    latest?.board?.sounds.find((sound) => sound.id === soundId)
  const gainFor = (sound: Sound): number =>
    dbToGain(voiceGainDb(sound, latest?.board?.volumeDb ?? 0))

  const cancelIdle = (): void => {
    if (idleTimer === null) return
    deps.clearTimer(idleTimer)
    idleTimer = null
  }
  const watchIdle = (): void => {
    cancelIdle()
    if (playing.size || loading.size || !context) return
    idleTimer = deps.setTimer(() => {
      idleTimer = null
      if (!playing.size && !loading.size) void context?.suspend().catch(() => undefined)
    }, MONITOR_IDLE_SUSPEND_MS)
  }

  const bufferFor = (sound: Sound): Promise<AudioBuffer> => {
    const key = bufferKey(sound)
    const cached = buffers.get(sound.id)
    if (cached?.key === key) return cached.buffer
    const buffer = deps
      .fetchBytes(soundAssetUrl(sound.file))
      .then((bytes) => audio().decodeAudioData(bytes))
    buffers.set(sound.id, { key, buffer })
    // A failed read or decode is tried again on the next press.
    buffer.catch(() => {
      if (buffers.get(sound.id)?.buffer === buffer) buffers.delete(sound.id)
    })
    return buffer
  }

  const rampTo = (voice: PlayingVoice, value: number, seconds: number): void => {
    const now = voice.gain.context.currentTime
    voice.gain.gain.cancelScheduledValues(now)
    voice.gain.gain.setValueAtTime(voice.gain.gain.value, now)
    voice.gain.gain.linearRampToValueAtTime(value, now + seconds)
    voice.gainValue = value
  }

  const stopVoice = (voiceId: string): void => {
    loading.delete(voiceId)
    const voice = playing.get(voiceId)
    if (!voice) return
    playing.delete(voiceId)
    rampTo(voice, 0, MONITOR_RAMP_SECONDS)
    try {
      voice.source.stop(voice.gain.context.currentTime + MONITOR_RAMP_SECONDS)
    } catch {
      // Already ended on its own.
    }
  }

  const startVoice = (voice: SoundVoice, sound: Sound): void => {
    loading.add(voice.voiceId)
    cancelIdle()
    bufferFor(sound).then(
      (buffer) => {
        // Stopped, or the monitor went away, while it decoded.
        if (disposed || !loading.delete(voice.voiceId)) return watchIdle()
        const now = soundFor(voice.soundId) ?? sound
        const ctx = audio()
        const source = ctx.createBufferSource()
        source.buffer = buffer
        source.loop = voice.loop
        const gain = ctx.createGain()
        const value = gainFor(now)
        gain.gain.value = value
        source.connect(gain)
        gain.connect(ctx.destination)
        const entry: PlayingVoice = { soundId: voice.soundId, source, gain, gainValue: value }
        source.onended = () => {
          source.disconnect()
          gain.disconnect()
          if (playing.get(voice.voiceId) === entry) playing.delete(voice.voiceId)
          watchIdle()
        }
        playing.set(voice.voiceId, entry)
        source.start(0, monitorStartOffsetSeconds(voice, deps.now(), buffer.duration))
      },
      (error: unknown) => {
        loading.delete(voice.voiceId)
        const key = bufferKey(sound)
        if (!warned.has(key)) {
          warned.add(key)
          console.warn(`[sounds] the monitor couldn't play ${sound.name}:`, error)
        }
        watchIdle()
      }
    )
  }

  return {
    update(snapshot) {
      if (disposed) return
      latest = snapshot
      const sounds = new Map((snapshot.board?.sounds ?? []).map((sound) => [sound.id, sound]))
      for (const [soundId, entry] of buffers) {
        const sound = sounds.get(soundId)
        if (!sound || bufferKey(sound) !== entry.key) buffers.delete(soundId)
      }
      const plan = monitorPlan(
        new Set([...playing.keys(), ...loading]),
        snapshot.voices,
        snapshot.board?.monitor ?? true,
        (soundId) => sounds.has(soundId)
      )
      for (const voiceId of plan.stop) stopVoice(voiceId)
      for (const voice of plan.start) startVoice(voice, sounds.get(voice.soundId)!)
      for (const voice of playing.values()) {
        const sound = sounds.get(voice.soundId)
        const value = sound ? gainFor(sound) : voice.gainValue
        if (Math.abs(value - voice.gainValue) > 1e-4) {
          rampTo(voice, value, MONITOR_GAIN_GLIDE_SECONDS)
        }
      }
      watchIdle()
    },
    dispose() {
      if (disposed) return
      for (const voiceId of [...playing.keys(), ...loading]) stopVoice(voiceId)
      disposed = true
      cancelIdle()
      buffers.clear()
      void context?.close().catch(() => undefined)
      context = null
    }
  }
}
