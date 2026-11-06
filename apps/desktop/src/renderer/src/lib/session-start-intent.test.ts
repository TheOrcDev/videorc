import { describe, expect, it } from 'vitest'

import {
  RECORD_INTENT,
  captureConfigForIntent,
  livestreamIntent,
  remoteOutputIntent,
  sameSessionStartIntent,
  savedModeIntent,
  type SessionStartIntent
} from './session-start-intent'

// Plan 174 S3.1 (B-3, A-3): Record and Go Live are explicit intents, and the
// saved output mode is never what a start button writes.
describe('session start intents', () => {
  it('records a take without streaming, whatever the saved mode', () => {
    expect(RECORD_INTENT).toEqual({ record: true, stream: false })
    expect(Object.isFrozen(RECORD_INTENT)).toBe(true)
  })

  it('goes live, and records too only when Save local recording is on', () => {
    expect(livestreamIntent(true)).toEqual({ record: true, stream: true })
    expect(livestreamIntent(false)).toEqual({ record: false, stream: true })
  })

  describe('what remotes see as the session outputs', () => {
    const config = { recordEnabled: false, streamEnabled: false }
    const savedMode = { record: false, stream: false }
    const live = { state: 'recording', streamUrl: 'rtmp://x' }
    const outputs = (
      sessionActive: boolean,
      startIntent: SessionStartIntent | null,
      status: { state: string; streamUrl?: string },
      previous: SessionStartIntent | null = null
    ) => remoteOutputIntent({ sessionActive, startIntent, status, config, previous })

    it('is the saved mode while idle, whatever came before', () => {
      expect(outputs(false, RECORD_INTENT, { state: 'idle' }, RECORD_INTENT)).toEqual(savedMode)
    })

    it('is the start intent while the session runs', () => {
      expect(outputs(true, RECORD_INTENT, { state: 'recording' })).toEqual(RECORD_INTENT)
    })

    it('reads a session this renderer did not start from its status', () => {
      expect(outputs(true, null, { state: 'recording' })).toEqual(RECORD_INTENT)
      expect(outputs(true, null, live)).toEqual({ record: true, stream: true })
      expect(outputs(true, null, { state: 'streaming', streamUrl: 'rtmp://x' })).toEqual({
        record: false,
        stream: true
      })
    })

    it('keeps what the session did through its stop tail', () => {
      expect(outputs(true, null, { state: 'stopping' }, RECORD_INTENT)).toEqual(RECORD_INTENT)
      expect(outputs(true, null, { state: 'idle' }, RECORD_INTENT)).toEqual(RECORD_INTENT)
    })

    it('falls back to the saved mode while a session not started here still starts', () => {
      expect(outputs(true, null, { state: 'starting' })).toEqual(savedMode)
    })
  })

  it('reads the saved mode as an intent for the smokes and hydrated sessions', () => {
    expect(savedModeIntent({ recordEnabled: true, streamEnabled: false })).toEqual(RECORD_INTENT)
    expect(savedModeIntent({ recordEnabled: false, streamEnabled: true })).toEqual({
      record: false,
      stream: true
    })
  })

  it('compares intents by their two flags, and null only with null', () => {
    expect(sameSessionStartIntent(RECORD_INTENT, { record: true, stream: false })).toBe(true)
    expect(sameSessionStartIntent(RECORD_INTENT, livestreamIntent(true))).toBe(false)
    expect(sameSessionStartIntent(null, null)).toBe(true)
    expect(sameSessionStartIntent(null, RECORD_INTENT)).toBe(false)
    expect(sameSessionStartIntent(undefined, null)).toBe(false)
  })

  it('builds the session config from the intent without touching the saved one', () => {
    const saved = { recordEnabled: false, streamEnabled: true, video: { fps: 30 } }
    const forRecord = captureConfigForIntent(saved, RECORD_INTENT)
    expect(forRecord).toEqual({ recordEnabled: true, streamEnabled: false, video: { fps: 30 } })
    expect(saved).toEqual({ recordEnabled: false, streamEnabled: true, video: { fps: 30 } })
    // The same object when the intent already matches: the in-flight dedupe
    // compares snapshot identity.
    expect(captureConfigForIntent(saved, livestreamIntent(false))).toBe(saved)
  })
})
