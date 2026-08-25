import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  evaluateSessionDecayEvidence,
  evaluateSessionDecayLifecycleEvents,
  parseRecordingFrameAccounting,
  waitForSessionTerminalStatus
} from './session-decay-gates.mjs'

const finalAccountingMessage = ({
  durationSeconds = 60,
  targetFps = 30,
  screenFresh = 1708,
  screenHeld = 46,
  screenAgeMs = 100,
  cameraFresh = 1708,
  cameraHeld = 46,
  cameraAgeMs = 100,
  bridgeFresh = 1770,
  bridgeRepeated = 20,
  bridgeSynthetic = 0,
  liveOuter = 0,
  liveFifo = 0,
  liveResources = 0,
  detached = 0
} = {}) =>
  `Frame accounting: duration ${durationSeconds.toFixed(1)}s @ target ${targetFps.toFixed(2)} fps (~1800 frames); ` +
  `captured: screen 30.00 fps (~1800), camera 30.00 fps (~1800); ` +
  `source serves: screen ${screenFresh} fresh / ${screenHeld} held (oldest ${screenAgeMs}ms), ` +
  `camera ${cameraFresh} fresh / ${cameraHeld} held (oldest ${cameraAgeMs}ms); ` +
  `bridge input: ${bridgeFresh + bridgeRepeated + bridgeSynthetic} ` +
  `(${bridgeFresh} fresh, ${bridgeRepeated} repeat, ${bridgeSynthetic} synthetic) at 30.00 fps; ` +
  `encoderBridgeLifecycle liveOuter=${liveOuter} liveFifo=${liveFifo} ` +
  `liveResources=${liveResources} detached=${detached} teardownDurationMs=12.`

describe('evaluateSessionDecayEvidence', () => {
  it('accepts healthy real-screen accounting', () => {
    const result = evaluateSessionDecayEvidence({
      diagnostics: {
        encoderBridgeFreshFrames: 1770,
        encoderBridgeRepeatedFrames: 20,
        encoderBridgeSyntheticFrames: 0,
        compositorScreenSourceFreshServes: 1708,
        compositorScreenSourceHeldServes: 46,
        compositorScreenSourceServedAgeMaxMs: 100
      },
      requestedSources: { screen: true, camera: false },
      targetFps: 30,
      elapsedMs: 60_000
    })

    assert.deepEqual(result.failures, [])
    assert.equal(result.sources.screen.freshServes, 1708)
    assert.equal(result.bridge.inputFrames, 1790)
  })

  it('rejects the incident camera fresh-versus-held collapse', () => {
    const result = evaluateSessionDecayEvidence({
      diagnostics: {
        encoderBridgeFreshFrames: 1750,
        encoderBridgeRepeatedFrames: 40,
        encoderBridgeSyntheticFrames: 0,
        compositorCameraSourceFreshServes: 570,
        compositorCameraSourceHeldServes: 2034,
        compositorCameraSourceServedAgeMaxMs: 180
      },
      requestedSources: { screen: false, camera: true },
      targetFps: 30,
      elapsedMs: 60_000
    })

    assert.ok(
      result.failures.some((failure) => failure.includes('camera freshness')),
      result.failures.join('\n')
    )
  })

  it('uses fresh plus repeated plus synthetic input as the bridge denominator', () => {
    const result = evaluateSessionDecayEvidence({
      diagnostics: {
        encoderBridgeFreshFrames: 570,
        encoderBridgeRepeatedFrames: 1934,
        encoderBridgeSyntheticFrames: 100,
        // Output frames are not authoritative bridge-input accounting.
        encoderBridgeEncodedOutputFrames: 100_000
      },
      requestedSources: { screen: false, camera: false },
      targetFps: 30,
      elapsedMs: 60_000
    })

    assert.equal(result.bridge.inputFrames, 2604)
    assert.equal(result.bridge.degradedRatio, 2034 / 2604)
    assert.ok(
      result.failures.some((failure) => failure.includes('bridge degraded')),
      result.failures.join('\n')
    )
  })

  it('rejects a roughly 16fps producer even when fresh serves exceed held serves', () => {
    const result = evaluateSessionDecayEvidence({
      diagnostics: {
        encoderBridgeFreshFrames: 1750,
        encoderBridgeRepeatedFrames: 40,
        encoderBridgeSyntheticFrames: 0,
        compositorScreenSourceFreshServes: 960,
        compositorScreenSourceHeldServes: 50,
        compositorScreenSourceServedAgeMaxMs: 100
      },
      requestedSources: { screen: true, camera: false },
      targetFps: 30,
      elapsedMs: 60_000
    })

    assert.ok(
      result.failures.some((failure) => failure.includes('screen fresh rate')),
      result.failures.join('\n')
    )
  })

  it('rejects the incident screen source age spike', () => {
    const result = evaluateSessionDecayEvidence({
      diagnostics: {
        encoderBridgeFreshFrames: 1750,
        encoderBridgeRepeatedFrames: 40,
        encoderBridgeSyntheticFrames: 0,
        compositorScreenSourceFreshServes: 1590,
        compositorScreenSourceHeldServes: 1014,
        compositorScreenSourceServedAgeMaxMs: 4097
      },
      requestedSources: { screen: true, camera: false },
      targetFps: 30,
      elapsedMs: 60_000
    })

    assert.ok(
      result.failures.some((failure) => failure.includes('screen served age')),
      result.failures.join('\n')
    )
  })

  it('rejects short real-source accounting coverage', () => {
    const result = evaluateSessionDecayEvidence({
      diagnostics: {
        encoderBridgeFreshFrames: 1750,
        encoderBridgeRepeatedFrames: 40,
        encoderBridgeSyntheticFrames: 0,
        compositorCameraSourceFreshServes: 100,
        compositorCameraSourceHeldServes: 0,
        compositorCameraSourceServedAgeMaxMs: 50
      },
      requestedSources: { screen: false, camera: true },
      targetFps: 30,
      elapsedMs: 60_000
    })

    assert.ok(
      result.failures.some((failure) => failure.includes('camera coverage')),
      result.failures.join('\n')
    )
  })

  it('rejects short bridge-input accounting coverage', () => {
    const result = evaluateSessionDecayEvidence({
      diagnostics: {
        encoderBridgeFreshFrames: 100,
        encoderBridgeRepeatedFrames: 0,
        encoderBridgeSyntheticFrames: 0
      },
      requestedSources: { screen: false, camera: false },
      targetFps: 30,
      elapsedMs: 60_000
    })

    assert.ok(
      result.failures.some((failure) => failure.includes('bridge coverage')),
      result.failures.join('\n')
    )
  })

  it('fails closed when required source or bridge counters are missing', () => {
    const result = evaluateSessionDecayEvidence({
      diagnostics: {},
      requestedSources: { screen: false, camera: true },
      targetFps: 30,
      elapsedMs: 60_000
    })

    assert.ok(
      result.failures.some((failure) =>
        failure.includes('compositorCameraSourceFreshServes is missing')
      ),
      result.failures.join('\n')
    )
    assert.ok(
      result.failures.some((failure) => failure.includes('encoderBridgeFreshFrames is missing')),
      result.failures.join('\n')
    )
  })

  it('rejects a five-second producer stall hidden inside a healthy minute', () => {
    const result = evaluateSessionDecayEvidence({
      diagnostics: {
        encoderBridgeFreshFrames: 1750,
        encoderBridgeRepeatedFrames: 40,
        encoderBridgeSyntheticFrames: 0,
        compositorScreenSourceFreshServes: 1650,
        compositorScreenSourceHeldServes: 150,
        compositorScreenSourceServedAgeMaxMs: 5000
      },
      requestedSources: { screen: true, camera: false },
      targetFps: 30,
      elapsedMs: 60_000
    })

    assert.ok(
      result.failures.some((failure) => failure.includes('screen fresh rate')),
      result.failures.join('\n')
    )
    assert.ok(
      result.failures.some((failure) => failure.includes('screen served age')),
      result.failures.join('\n')
    )
  })

  it('fails closed on non-finite and negative accounting values', () => {
    const result = evaluateSessionDecayEvidence({
      diagnostics: {
        encoderBridgeFreshFrames: Number.NaN,
        encoderBridgeRepeatedFrames: -1,
        encoderBridgeSyntheticFrames: Number.POSITIVE_INFINITY
      },
      requestedSources: { screen: false, camera: false },
      targetFps: 30,
      elapsedMs: 60_000
    })

    assert.equal(
      result.failures.filter((failure) => failure.includes('finite non-negative number')).length,
      3
    )
  })

  it('fails closed on invalid timing inputs instead of accepting stale counters', () => {
    const result = evaluateSessionDecayEvidence({
      diagnostics: {
        encoderBridgeFreshFrames: 1800,
        encoderBridgeRepeatedFrames: 0,
        encoderBridgeSyntheticFrames: 0
      },
      requestedSources: { screen: false, camera: false },
      targetFps: Number.NaN,
      elapsedMs: 0
    })

    assert.match(result.failures.join(' '), /targetFps must be a finite positive number/)
    assert.match(result.failures.join(' '), /elapsedMs must be a finite positive number/)
    assert.match(result.failures.join(' '), /bridge coverage n\/a/)
  })
})

describe('parseRecordingFrameAccounting', () => {
  it('extracts final source, bridge, timing, and writer counters', () => {
    const parsed = parseRecordingFrameAccounting(finalAccountingMessage())

    assert.equal(parsed.elapsedMs, 60_000)
    assert.equal(parsed.targetFps, 30)
    assert.equal(parsed.diagnostics.compositorScreenSourceFreshServes, 1708)
    assert.equal(parsed.diagnostics.compositorCameraSourceHeldServes, 46)
    assert.equal(parsed.diagnostics.encoderBridgeInputFrames, 1790)
    assert.equal(parsed.diagnostics.encoderBridgeFreshFrames, 1770)
    assert.deepEqual(parsed.writerLifecycle, {
      liveOuter: 0,
      liveFifo: 0,
      liveResources: 0,
      detached: 0,
      teardownDurationMs: 12
    })
  })

  it('leaves absent or malformed final counters missing', () => {
    assert.deepEqual(parseRecordingFrameAccounting('not accounting'), {
      elapsedMs: null,
      targetFps: null,
      diagnostics: {},
      writerLifecycle: null
    })
  })
})

describe('evaluateSessionDecayLifecycleEvents', () => {
  it('accepts parseable final accounting for the stopped session', () => {
    const result = evaluateSessionDecayLifecycleEvents({
      events: [
        {
          event: 'health.event',
          payload: {
            sessionId: 'session-2',
            code: 'recording-frame-accounting',
            message: finalAccountingMessage()
          }
        }
      ],
      sessionId: 'session-2'
    })

    assert.deepEqual(result.failures, [])
    assert.equal(result.accounting.diagnostics.encoderBridgeFreshFrames, 1770)
    const evidence = evaluateSessionDecayEvidence({
      diagnostics: result.accounting.diagnostics,
      requestedSources: { screen: true, camera: true },
      targetFps: result.accounting.targetFps,
      elapsedMs: result.accounting.elapsedMs
    })
    assert.deepEqual(evidence.failures, [])
  })

  it('requires final accounting for the stopped session', () => {
    const result = evaluateSessionDecayLifecycleEvents({
      events: [
        {
          event: 'health.event',
          payload: {
            sessionId: 'stale-session',
            code: 'recording-frame-accounting',
            message: finalAccountingMessage()
          }
        }
      ],
      sessionId: 'session-2'
    })

    assert.ok(
      result.failures.some((failure) => failure.includes('missing recording-frame-accounting')),
      result.failures.join('\n')
    )
  })

  it('requires exactly one final accounting event for the stopped session', () => {
    const event = {
      event: 'health.event',
      payload: {
        sessionId: 'session-2',
        code: 'recording-frame-accounting',
        message: finalAccountingMessage()
      }
    }
    const result = evaluateSessionDecayLifecycleEvents({
      events: [event, structuredClone(event)],
      sessionId: 'session-2'
    })

    assert.match(result.failures.join(' '), /2 recording-frame-accounting events/)
    assert.equal(result.accounting, null)
  })

  it('rejects leaked or lingering encoder writers', () => {
    const result = evaluateSessionDecayLifecycleEvents({
      events: [
        {
          event: 'health.event',
          payload: {
            sessionId: 'session-2',
            code: 'recording-frame-accounting',
            message: finalAccountingMessage()
          }
        },
        {
          event: 'session.log',
          payload: {
            sessionId: 'session-2',
            code: 'encoder-bridge-writer-leaked'
          }
        },
        {
          event: 'health.event',
          payload: {
            sessionId: 'session-2',
            code: 'encoder-bridge-writer-lingering'
          }
        }
      ],
      sessionId: 'session-2'
    })

    assert.ok(
      result.failures.some((failure) => failure.includes('encoder-bridge-writer-leaked')),
      result.failures.join('\n')
    )
    assert.ok(
      result.failures.some((failure) => failure.includes('encoder-bridge-writer-lingering')),
      result.failures.join('\n')
    )
  })

  it('rejects malformed final accounting and live writer resources', () => {
    const malformed = evaluateSessionDecayLifecycleEvents({
      events: [
        {
          event: 'session.log',
          payload: {
            sessionId: 'session-2',
            code: 'recording-frame-accounting',
            message: 'Frame accounting unavailable.'
          }
        }
      ],
      sessionId: 'session-2'
    })
    assert.match(malformed.failures.join(' '), /no valid duration/)
    assert.match(malformed.failures.join(' '), /no bridge input counters/)

    const liveWriter = evaluateSessionDecayLifecycleEvents({
      events: [
        {
          event: 'health.event',
          payload: {
            sessionId: 'session-2',
            code: 'recording-frame-accounting',
            message: finalAccountingMessage({ liveOuter: 1, liveResources: 1 })
          }
        }
      ],
      sessionId: 'session-2'
    })
    assert.match(liveWriter.failures.join(' '), /reports live writer resources/)
  })

  it('rejects missing or invalid final writer lifecycle counters', () => {
    const withoutLifecycle = evaluateSessionDecayLifecycleEvents({
      events: [
        {
          event: 'health.event',
          payload: {
            sessionId: 'session-2',
            code: 'recording-frame-accounting',
            message: finalAccountingMessage().replace(/; encoderBridgeLifecycle.*$/, '.')
          }
        }
      ],
      sessionId: 'session-2'
    })
    assert.match(withoutLifecycle.failures.join(' '), /no writer lifecycle counters/)

    const negativeLifecycle = evaluateSessionDecayLifecycleEvents({
      events: [
        {
          event: 'health.event',
          payload: {
            sessionId: 'session-2',
            code: 'recording-frame-accounting',
            message: finalAccountingMessage().replace('liveOuter=0', 'liveOuter=-1')
          }
        }
      ],
      sessionId: 'session-2'
    })
    assert.match(negativeLifecycle.failures.join(' '), /no writer lifecycle counters/)
  })
})

describe('waitForSessionTerminalStatus', () => {
  it('waits for the ordered terminal barrier before evaluating delayed lifecycle events', async () => {
    const events = []
    let nowMs = 0
    let accountingDeliveries = 0
    const accountingEvent = () => ({
      event: 'health.event',
      payload: {
        sessionId: 'session-2',
        code: 'recording-frame-accounting',
        message: finalAccountingMessage()
      }
    })

    const terminal = await waitForSessionTerminalStatus({
      events,
      sessionId: 'session-2',
      timeoutMs: 250,
      pollIntervalMs: 25,
      now: () => nowMs,
      sleep: async (delayMs) => {
        nowMs += delayMs
        if (nowMs === 25) {
          events.push(accountingEvent())
          accountingDeliveries += 1
        } else if (nowMs === 50) {
          events.push(accountingEvent())
          accountingDeliveries += 1
        } else if (nowMs === 75) {
          events.push({
            event: 'health.event',
            payload: {
              sessionId: 'session-2',
              code: 'encoder-bridge-writer-leaked'
            }
          })
        } else if (nowMs === 100) {
          events.push({
            event: 'session.log',
            payload: {
              sessionId: 'session-2',
              code: 'encoder-bridge-writer-lingering'
            }
          })
        } else if (nowMs === 125) {
          events.push({
            event: 'recording.status',
            payload: { sessionId: 'session-2', state: 'idle' }
          })
        }
      }
    })

    assert.deepEqual(terminal, { sessionId: 'session-2', state: 'idle' })
    assert.equal(accountingDeliveries, 2)
    const lifecycle = evaluateSessionDecayLifecycleEvents({ events, sessionId: 'session-2' })
    assert.match(lifecycle.failures.join(' '), /2 recording-frame-accounting events/)
    assert.match(lifecycle.failures.join(' '), /encoder-bridge-writer-leaked/)
    assert.match(lifecycle.failures.join(' '), /encoder-bridge-writer-lingering/)
  })

  it('fails closed when no matching terminal status arrives before the deadline', async () => {
    let nowMs = 0
    await assert.rejects(
      waitForSessionTerminalStatus({
        events: [
          {
            event: 'recording.status',
            payload: { sessionId: 'another-session', state: 'idle' }
          },
          {
            event: 'recording.status',
            payload: { sessionId: 'session-2', state: 'stopping' }
          }
        ],
        sessionId: 'session-2',
        timeoutMs: 100,
        pollIntervalMs: 25,
        now: () => nowMs,
        sleep: async (delayMs) => {
          nowMs += delayMs
        }
      }),
      /session session-2 timed out waiting for terminal recording\.status/
    )
  })

  it('accepts a matching failed terminal status as a completed barrier', async () => {
    await assert.doesNotReject(async () => {
      const status = await waitForSessionTerminalStatus({
        events: [
          {
            event: 'recording.status',
            payload: { sessionId: 'session-2', state: 'failed' }
          }
        ],
        sessionId: 'session-2',
        timeoutMs: 100
      })
      assert.equal(status.state, 'failed')
    })
  })
})
