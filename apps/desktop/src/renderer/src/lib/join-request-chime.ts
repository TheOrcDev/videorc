// "Ada wants to join" rings on the host's computer (owner, 2026-11-19): a host
// talking on stream isn't watching the Show stage, and a guest left waiting
// gives up. The chime is synthesized, so there is no asset to ship, and it
// plays from this renderer to the system output only. It never reaches the
// room or the program: macOS system-audio capture excludes Videorc's own audio
// (`AudioServiceOutOfProcess` is off, so renderer audio plays from the main
// process), the same rule that keeps the guests' voices the host hears out of
// the room.

/** Requests that land together (one poll, a group link) ring once. */
export const JOIN_CHIME_MIN_GAP_MS = 2_000

/** Two rising notes, a fifth apart: a doorbell, soft enough to talk over. */
export const JOIN_CHIME_NOTES: readonly { hz: number; atS: number; lengthS: number }[] = [
  { hz: 659.25, atS: 0, lengthS: 0.35 },
  { hz: 987.77, atS: 0.14, lengthS: 0.55 }
]
export const JOIN_CHIME_PEAK_GAIN = 0.25
/** Silence for an exponential ramp, which can't reach zero. */
const FLOOR_GAIN = 0.0001
const ATTACK_S = 0.012

export type JoinChimeDeps = {
  now: () => number
  play: () => void
}

/** Rings for a new request unless one already rang within the gap. */
export function createJoinRequestChime(deps: JoinChimeDeps): { ring: () => boolean } {
  let lastRangAt = -Infinity
  return {
    ring() {
      const at = deps.now()
      if (at - lastRangAt < JOIN_CHIME_MIN_GAP_MS) return false
      lastRangAt = at
      deps.play()
      return true
    }
  }
}

/** The part of an AudioContext the chime uses (a fake one in tests). */
export type ChimeAudioContext = Pick<
  AudioContext,
  'currentTime' | 'destination' | 'createOscillator' | 'createGain'
>

/** Schedules the notes straight to the context's output; resolves when the last ends. */
export function scheduleJoinChime(context: ChimeAudioContext): Promise<void> {
  const start = context.currentTime + 0.01
  const endings = JOIN_CHIME_NOTES.map((note) => {
    const oscillator = context.createOscillator()
    const gain = context.createGain()
    const at = start + note.atS
    oscillator.type = 'sine'
    oscillator.frequency.setValueAtTime(note.hz, at)
    gain.gain.setValueAtTime(FLOOR_GAIN, at)
    gain.gain.exponentialRampToValueAtTime(JOIN_CHIME_PEAK_GAIN, at + ATTACK_S)
    gain.gain.exponentialRampToValueAtTime(FLOOR_GAIN, at + note.lengthS)
    oscillator.connect(gain)
    gain.connect(context.destination)
    oscillator.start(at)
    oscillator.stop(at + note.lengthS + 0.02)
    return new Promise<void>((resolve) => {
      oscillator.onended = () => {
        oscillator.disconnect()
        gain.disconnect()
        resolve()
      }
    })
  })
  return Promise.all(endings).then(() => undefined)
}

/**
 * The window's player: a context per ring, closed once the notes end, so no
 * output stream stays open between requests.
 */
export function playJoinChime(createContext: () => AudioContext = defaultContext): void {
  let context: AudioContext
  try {
    context = createContext()
  } catch (error) {
    warn(error)
    return
  }
  void scheduleJoinChime(context)
    .catch(warn)
    .finally(() => void context.close().catch(() => {}))
}

function defaultContext(): AudioContext {
  return new AudioContext({ latencyHint: 'interactive' })
}

function warn(error: unknown): void {
  console.warn(
    '[talk-show] the join chime could not play',
    error instanceof Error ? error.message : String(error)
  )
}
