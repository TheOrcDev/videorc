// Plan 092: Videorc's visual microphone pipeline as audiocn frame sources.
// The pipeline stays the single owner of the browser stream, the analyser and
// the clock; these sources only read its frames and hand them to audiocn
// components (LevelMeter, DbReadout, ClipIndicator, BarVisualizer,
// LiveWaveform). No React here, and no import of the pipeline module: the
// pipeline is described structurally, so eager code never pulls it in.

import { SILENCE_DB } from './audio/decibels'
import type { ChannelLevel, FrameSource, MeterFrame } from './audio/types'
import { createMicVisualFrameBuffer, type MicVisualFrameBuffer } from './mic-visual-frame'

/** What the sources need from the visual mic pipeline (it satisfies this). */
export type MicFrameFeed = {
  /** Keeps the microphone open while a consumer exists; returns its release. */
  retain: () => () => void
  subscribeFrame: (listener: () => void) => () => void
  readFrame: (target: MicVisualFrameBuffer) => MicVisualFrameBuffer
}

export type MicMeterSettings = Readonly<{
  /** The configured microphone gain the recording gets, in dB. */
  gainDb: number
  muted: boolean
}>

/**
 * One pipeline subscription and one retain, shared by every consumer of the
 * source: the first subscriber opens it, the last one releases it. The
 * pipeline defers releases by a microtask, so a StrictMode unmount and
 * remount never closes the device in between.
 */
function createSharedSource<T>(feed: MicFrameFeed, read: () => T): FrameSource<T> {
  const listeners = new Set<(frame: T) => void>()
  let detach: (() => void) | null = null

  const deliver = (): void => {
    const frame = read()
    for (const listener of listeners) listener(frame)
  }

  return {
    subscribe(listener) {
      listeners.add(listener)
      if (!detach) {
        const release = feed.retain()
        const unsubscribe = feed.subscribeFrame(deliver)
        detach = () => {
          unsubscribe()
          release()
        }
      }
      return () => {
        listeners.delete(listener)
        if (listeners.size === 0 && detach) {
          const stop = detach
          detach = null
          stop()
        }
      }
    }
  }
}

/**
 * Write one meter reading into `level`: what the recording will hear. The
 * analyser opens the device in Chromium, before Videorc's gain and mute, so
 * the configured gain is added and a muted mic reads as silence. With no
 * analyser data it reads silence too, so a meter falls instead of freezing.
 */
export function writeMicMeterLevel(
  frame: MicVisualFrameBuffer,
  settings: MicMeterSettings,
  level: ChannelLevel
): ChannelLevel {
  if (settings.muted || frame.peakDb === null) {
    level.peakDb = SILENCE_DB
    level.rmsDb = SILENCE_DB
    return level
  }
  level.peakDb = frame.peakDbfs + settings.gainDb
  level.rmsDb = frame.rmsDbfs + settings.gainDb
  return level
}

/**
 * The microphone as a level-meter source (peak and RMS, mono). `settings` is
 * read on every frame, so a Gain drag never re-subscribes. The emitted frame
 * is one reused object: nothing is allocated per frame.
 */
export function createMicMeterSource(
  feed: MicFrameFeed,
  settings: () => MicMeterSettings
): FrameSource<MeterFrame> {
  const buffer = createMicVisualFrameBuffer()
  const level: ChannelLevel = { peakDb: SILENCE_DB, rmsDb: SILENCE_DB }
  const frame: MeterFrame = { channels: [level] }
  return createSharedSource(feed, () => {
    writeMicMeterLevel(feed.readFrame(buffer), settings(), level)
    return frame
  })
}
