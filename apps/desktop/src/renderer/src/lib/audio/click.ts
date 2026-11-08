import { getSharedAudioContext } from '@/hooks/use-audio-context'

export interface ClickSoundParams {
  /** A ring: a sine at `hz` that fades over `decayMs`. */
  readonly tone: {
    readonly hz: number
    readonly decayMs: number
    readonly gain: number
  }
  /** A snap: white noise that fades over `decayMs`. */
  readonly noise: { readonly decayMs: number; readonly gain: number }
  readonly lengthMs: number
  /** Random pitch per click, as a ratio: 0.04 is ±4%. */
  readonly pitchSpread: number
  /** Linear output gain. */
  readonly volume: number
}

export type ClickSoundChanges = {
  readonly [Key in keyof ClickSoundParams]?: Partial<ClickSoundParams[Key]>
}

export type ClickPlayOptions = {
  /** Unset or null: the shared page context. */
  context?: AudioContext | null
  /** Default: the context's speakers. */
  destination?: AudioNode
} & (
  | {
      when?: undefined
      /** Clicks closer than this to this sound's last one are dropped. */
      minIntervalMs?: number
    }
  | {
      /** Context time to play at. Scheduled clicks are never held back. */
      when: number
      minIntervalMs?: never
    }
)

export interface ClickSound {
  /**
   * Plays once. A suspended context is resumed, which needs a user gesture,
   * and holds one click until it runs; more clicks meanwhile are dropped,
   * and a refused resume cancels the held click.
   */
  readonly play: (options?: ClickPlayOptions) => void
  /** A new sound with these parameters deep-merged over this one's. */
  readonly with: (changes: ClickSoundChanges) => ClickSound
  /** The full parameters after merging, for docs or a tuning UI. */
  readonly params: ClickSoundParams
}

/** A short noise snap over a high, fast-damped ring: a tick, not a thud. */
const DEFAULT_PARAMS: ClickSoundParams = {
  lengthMs: 6,
  noise: { decayMs: 0.4, gain: 0.6 },
  pitchSpread: 0.04,
  tone: { decayMs: 1.2, gain: 0.4, hz: 4200 },
  volume: 0.12
}

const MS_PER_SECOND = 1000

const merge = (base: ClickSoundParams, changes: ClickSoundChanges): ClickSoundParams => ({
  lengthMs: changes.lengthMs ?? base.lengthMs,
  noise: {
    decayMs: changes.noise?.decayMs ?? base.noise.decayMs,
    gain: changes.noise?.gain ?? base.noise.gain
  },
  pitchSpread: changes.pitchSpread ?? base.pitchSpread,
  tone: {
    decayMs: changes.tone?.decayMs ?? base.tone.decayMs,
    gain: changes.tone?.gain ?? base.tone.gain,
    hz: changes.tone?.hz ?? base.tone.hz
  },
  volume: changes.volume ?? base.volume
})

/** The sum of a decaying noise snap and a decaying sine ring. */
const synthesize = (context: BaseAudioContext, { lengthMs, noise, tone }: ClickSoundParams) => {
  const { sampleRate } = context
  const buffer = context.createBuffer(
    1,
    Math.ceil((lengthMs / MS_PER_SECOND) * sampleRate),
    sampleRate
  )
  const noiseDecay = noise.decayMs / MS_PER_SECOND
  const toneDecay = tone.decayMs / MS_PER_SECOND
  const samples = buffer.getChannelData(0)
  for (let index = 0; index < samples.length; index += 1) {
    const time = index / sampleRate
    const snap = noise.gain * (Math.random() * 2 - 1) * Math.exp(-time / noiseDecay)
    const ring = tone.gain * Math.sin(2 * Math.PI * tone.hz * time) * Math.exp(-time / toneDecay)
    samples[index] = snap + ring
  }
  return buffer
}

/** Whether the context resumed. Without a user gesture the browser refuses. */
const resumeContext = async (context: AudioContext) => {
  try {
    await context.resume()
    return true
  } catch {
    return false
  }
}

const clickSound = (params: ClickSoundParams): ClickSound => {
  const buffers = new WeakMap<BaseAudioContext, AudioBuffer>()
  let lastPlayedAt = Number.NEGATIVE_INFINITY
  const queued = new WeakSet<BaseAudioContext>()

  const bufferFor = (context: BaseAudioContext) => {
    const cached = buffers.get(context)
    if (cached) {
      return cached
    }
    const buffer = synthesize(context, params)
    buffers.set(context, buffer)
    return buffer
  }

  const start = (context: AudioContext, { destination, when }: ClickPlayOptions) => {
    const source = context.createBufferSource()
    source.buffer = bufferFor(context)
    source.playbackRate.value = 1 + (Math.random() - 0.5) * params.pitchSpread * 2
    const gain = context.createGain()
    gain.gain.value = params.volume
    source.connect(gain)
    gain.connect(destination ?? context.destination)
    source.addEventListener('ended', () => {
      source.disconnect()
      gain.disconnect()
    })
    source.start(when)
    return source
  }

  const heldBack = (minIntervalMs = 0) => {
    const now = performance.now()
    if (now - lastPlayedAt < minIntervalMs) {
      return true
    }
    lastPlayedAt = now
    return false
  }

  /** Frees the context's queue, cancelling the click if it never resumed. */
  const releaseWhenResumed = async (
    context: AudioContext,
    resumed: Promise<boolean>,
    source: AudioBufferSourceNode
  ) => {
    if (!(await resumed)) {
      source.stop()
      source.disconnect()
    }
    queued.delete(context)
  }

  const play = (options: ClickPlayOptions = {}) => {
    const context = options.context ?? getSharedAudioContext()
    if (!context || context.state === 'closed') {
      return
    }
    if (options.when !== undefined) {
      if (context.state === 'suspended') {
        resumeContext(context)
      }
      start(context, options)
      return
    }
    if (context.state !== 'suspended') {
      if (!heldBack(options.minIntervalMs)) {
        start(context, options)
      }
      return
    }
    // Always ask again: only a resume inside a user gesture starts it.
    const resumed = resumeContext(context)
    if (queued.has(context) || heldBack(options.minIntervalMs)) {
      return
    }
    queued.add(context)
    releaseWhenResumed(context, resumed, start(context, options))
  }

  return {
    params,
    play,
    with: (changes) => clickSound(merge(params, changes))
  }
}

/** A synthesised click. Without changes, Knob's tick. */
export const createClickSound = (changes: ClickSoundChanges = {}): ClickSound =>
  clickSound(merge(DEFAULT_PARAMS, changes))
