// What a start asks for (plan 174 S3.1, B-3 and A-3). Record and Go Live are
// explicit intents: each says whether the session writes a file and whether
// it streams, and neither writes the saved `recordEnabled` / `streamEnabled`.
// Those saved flags stay what the Output page and the Livestream page make
// them: "Save local recording" is the only thing that decides whether a Go
// Live also records, and a destination set up is what makes streaming
// possible. Pure: no React, so it runs under the node vitest runner.

import { sessionActivity, type SessionActivity } from '../../../shared/capture-state'

/** What a session start asks the backend to do. */
export interface SessionStartIntent {
  /** Write a local recording. */
  record: boolean
  /** Send the livestream to the enabled destinations. */
  stream: boolean
}

/** Record: a local take, never a stream, whatever the Output switch says. */
export const RECORD_INTENT: SessionStartIntent = Object.freeze({ record: true, stream: false })

/**
 * Go Live: a livestream, and a recording too only when the Output page's
 * "Save local recording" is on (D19: the two are one session).
 */
export function livestreamIntent(alsoRecord: boolean): SessionStartIntent {
  return { record: alsoRecord, stream: true }
}

/**
 * The saved output mode as an intent: what `startSession` (the smokes' hook)
 * still starts, and the fallback for a session this renderer did not start.
 */
export function savedModeIntent(config: {
  recordEnabled: boolean
  streamEnabled: boolean
}): SessionStartIntent {
  return { record: config.recordEnabled, stream: config.streamEnabled }
}

const RUNNING_INTENTS: Record<SessionActivity, SessionStartIntent> = {
  recording: RECORD_INTENT,
  'live-stream': { record: false, stream: true },
  'record+stream': { record: true, stream: true }
}

/**
 * What remotes (Stream Deck, phone) see as the session's outputs, so a
 * Record take never reads as live: the start's own intent; for a session
 * this renderer did not start, what its status says once it runs. Through
 * the stop tail, `previous` (the last answer) keeps what the session did.
 * Idle, or before anything is known, the saved mode a Go Live would follow.
 */
export function remoteOutputIntent(input: {
  sessionActive: boolean
  startIntent: SessionStartIntent | null
  status: { state?: string | null; streamUrl?: string | null }
  config: { recordEnabled: boolean; streamEnabled: boolean }
  previous: SessionStartIntent | null
}): SessionStartIntent {
  const { sessionActive, startIntent, status, config, previous } = input
  if (!sessionActive) return savedModeIntent(config)
  if (startIntent) return startIntent
  if (status.state === 'recording' || status.state === 'streaming') {
    return RUNNING_INTENTS[sessionActivity(status)]
  }
  return previous ?? savedModeIntent(config)
}

export function sameSessionStartIntent(
  left: SessionStartIntent | null | undefined,
  right: SessionStartIntent | null | undefined
): boolean {
  if (!left || !right) {
    return left === right
  }
  return left.record === right.record && left.stream === right.stream
}

/**
 * The capture config a start builds its session from: the saved config with
 * the intent's flags in place of the saved mode. The same object comes back
 * when nothing changes, so a start that matches the saved mode keeps the
 * request snapshot identity the in-flight dedupe compares.
 */
export function captureConfigForIntent<
  T extends { recordEnabled: boolean; streamEnabled: boolean }
>(config: T, intent: SessionStartIntent): T {
  if (config.recordEnabled === intent.record && config.streamEnabled === intent.stream) {
    return config
  }
  return { ...config, recordEnabled: intent.record, streamEnabled: intent.stream }
}
