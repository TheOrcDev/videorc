export interface ChannelLevel {
  /** Sample peak in dBFS. `-Infinity` is digital silence. */
  peakDb: number
  /** RMS level in dBFS, when the source measures it. */
  rmsDb?: number
}

/** One metering update: one entry per channel (1 = mono, 2 = stereo). */
export interface MeterFrame {
  channels: ChannelLevel[]
}

/** One visualisation update from an analyser. */
export interface VisualFrame {
  /** Frequency bands, 0..1 each, low to high. */
  bands: Float32Array
  /** Ring buffer of recent broadband levels, 0..1 each. */
  history: Float32Array
  /** Index of the oldest entry in `history`. */
  historyStart: number
  /** Number of valid entries in `history`. */
  historyLength: number
  /** Raw time-domain samples, −1..1, for line and scope drawing. */
  timeDomain?: Float32Array
  /** Sample peak of this frame in dBFS. */
  peakDb: number
}

/** Anything that can push frames to subscribers. */
export interface FrameSource<T> {
  subscribe: (listener: (frame: T) => void) => () => void
}

export type MeterZoneName = 'ok' | 'warn' | 'clip'

/** A colour zone of a meter, starting at `fromDb` and running to the next zone. */
export interface MeterZone {
  fromDb: number
  zone: MeterZoneName
}

/** Maps a value (usually dB) to a 0..1 position on a control, and back. */
export interface Taper {
  toPosition: (value: number) => number
  toValue: (position: number) => number
}

export type Orientation = 'horizontal' | 'vertical'
