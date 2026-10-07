import { afterEach, describe, expect, it, vi } from 'vitest'

import type { Scene } from './backend'
import {
  defaultCaptureConfig,
  loadCaptureConfig,
  normalizeSeparateSourceRecordings,
  separateSourceRecordingsForSession,
  separateSourceRecordingsIneligibility,
  separateSourceRecordingsIneligibilityCopy,
  type CaptureConfig
} from './capture'
import {
  recordingRoleLabel,
  recordingRoleRowNote,
  takeSiblings
} from './separate-source-recordings-view'
import { buildStartSessionParams } from './session-params'

const scene: Scene = { id: 'scene-1', name: 'Studio', sources: [], outputs: [] }
const settings = { outputDirectory: '', keepOriginalRecording: false }

function config(patch: Partial<CaptureConfig> = {}): CaptureConfig {
  return {
    ...defaultCaptureConfig,
    recordEnabled: true,
    sources: { screenId: 'screen:1', cameraId: 'camera:1', testPattern: false },
    ...patch
  }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('separate source recordings (plan 157)', () => {
  it('is off by default and normalizes loose stored values', () => {
    expect(defaultCaptureConfig.separateSourceRecordings).toEqual({
      enabled: false,
      keepCombined: true
    })
    expect(normalizeSeparateSourceRecordings(undefined)).toEqual({
      enabled: false,
      keepCombined: true
    })
    expect(normalizeSeparateSourceRecordings({ enabled: true })).toEqual({
      enabled: true,
      keepCombined: true
    })
    expect(
      normalizeSeparateSourceRecordings({ enabled: 'yes', keepCombined: 0 } as unknown as {
        enabled: boolean
      })
    ).toEqual({
      enabled: false,
      keepCombined: true
    })
  })

  it('loads a stored config without the key as Off', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => JSON.stringify({ recordEnabled: true }),
      setItem: vi.fn(),
      removeItem: vi.fn()
    })
    expect(loadCaptureConfig().separateSourceRecordings).toEqual({
      enabled: false,
      keepCombined: true
    })
  })

  it('names the exact reason a selection cannot produce both files', () => {
    expect(separateSourceRecordingsIneligibility(config())).toBeNull()
    expect(
      separateSourceRecordingsIneligibility(
        config({ sources: { windowId: 'window:1', cameraId: 'camera:1', testPattern: false } })
      )
    ).toBeNull()
    expect(separateSourceRecordingsIneligibility(config({ recordEnabled: false }))).toBe(
      'record-disabled'
    )
    expect(
      separateSourceRecordingsIneligibility(
        config({ sources: { screenId: 'screen:1', testPattern: false } })
      )
    ).toBe('missing-camera')
    expect(
      separateSourceRecordingsIneligibility(
        config({ sources: { cameraId: 'camera:1', testPattern: false } })
      )
    ).toBe('missing-screen')
    for (const reason of ['record-disabled', 'missing-camera', 'missing-screen'] as const) {
      expect(separateSourceRecordingsIneligibilityCopy(reason).length).toBeGreaterThan(10)
    }
  })

  it('sends the settings only when armed and eligible', () => {
    expect(separateSourceRecordingsForSession(config())).toBeUndefined()
    const armed = config({ separateSourceRecordings: { enabled: true, keepCombined: true } })
    expect(separateSourceRecordingsForSession(armed)).toEqual({
      enabled: true,
      keepCombined: true
    })
    expect(
      separateSourceRecordingsForSession({
        ...armed,
        sources: { screenId: 'screen:1', testPattern: false }
      })
    ).toBeUndefined()
  })

  it('keeps an ISO-off session.start byte-identical to before', () => {
    const params = buildStartSessionParams({ captureConfig: config(), scene, settings })
    expect('separateSourceRecordings' in params.output).toBe(true)
    expect(params.output.separateSourceRecordings).toBeUndefined()
    expect(JSON.stringify(params.output)).not.toContain('separateSourceRecordings')
  })

  it('carries the armed settings on session.start', () => {
    const params = buildStartSessionParams({
      captureConfig: config({ separateSourceRecordings: { enabled: true, keepCombined: true } }),
      scene,
      settings
    })
    expect(params.output.separateSourceRecordings).toEqual({ enabled: true, keepCombined: true })
    expect(params.output.recordEnabled).toBe(true)
  })

  it('labels take rows and orders siblings Combined → Screen → Camera', () => {
    expect(recordingRoleLabel('combined')).toBe('Combined')
    expect(recordingRoleLabel('screen')).toBe('Screen')
    expect(recordingRoleLabel('camera')).toBe('Camera')
    expect(recordingRoleRowNote('screen')).toContain('system audio')
    expect(recordingRoleRowNote('camera')).toContain('microphone')
    const rows = [
      { id: 'take-camera', takeId: 'take', recordingRole: 'camera' as const },
      { id: 'other', takeId: undefined, recordingRole: undefined },
      { id: 'take', takeId: 'take', recordingRole: 'combined' as const },
      { id: 'take-screen', takeId: 'take', recordingRole: 'screen' as const }
    ]
    expect(takeSiblings({ id: 'take', takeId: 'take' }, rows).map((row) => row.id)).toEqual([
      'take-screen',
      'take-camera'
    ])
    expect(takeSiblings({ id: 'other', takeId: undefined }, rows)).toEqual([])
  })
})
