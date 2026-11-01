import { afterEach, describe, expect, it, vi } from 'vitest'

import type { Scene } from './backend'
import {
  defaultCaptureConfig,
  loadCaptureConfig,
  normalizeSeparateSourceRecordings,
  separateSourceRecordingsEncoderNotice,
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

describe('separate files encoder notice (plan 200 D4)', () => {
  const on = { enabled: true, keepCombined: true }
  const video = (width: number, height: number, fps: number) => ({
    ...defaultCaptureConfig.video,
    width,
    height,
    fps
  })

  it('shows at 4K or 60 fps when the next take writes the separate files', () => {
    expect(
      separateSourceRecordingsEncoderNotice(
        config({ separateSourceRecordings: on, video: video(3840, 2160, 30) }),
        'darwin'
      )
    ).toBe(
      'Separate files at 4K · 30 fps use about 3× the encoder. If your Mac falls behind, Videorc stops the separate files and keeps the main recording.'
    )
    expect(
      separateSourceRecordingsEncoderNotice(
        config({ separateSourceRecordings: on, video: video(1920, 1080, 60) }),
        'darwin'
      )
    ).toContain('1080p · 60 fps')
    // A vertical 4K canvas is 4K too.
    expect(
      separateSourceRecordingsEncoderNotice(
        config({ separateSourceRecordings: on, video: video(2160, 3840, 30) }),
        'darwin'
      )
    ).not.toBeNull()
  })

  it('stays quiet below 4K at 30 fps, with the switch off, or when the take cannot arm', () => {
    expect(
      separateSourceRecordingsEncoderNotice(
        config({ separateSourceRecordings: on, video: video(2560, 1440, 30) }),
        'darwin'
      )
    ).toBeNull()
    expect(
      separateSourceRecordingsEncoderNotice(config({ video: video(3840, 2160, 30) }), 'darwin')
    ).toBeNull()
    // No camera: the row shows the ineligibility reason instead.
    expect(
      separateSourceRecordingsEncoderNotice(
        config({
          separateSourceRecordings: on,
          video: video(3840, 2160, 60),
          sources: { screenId: 'screen:1', testPattern: false }
        }),
        'darwin'
      )
    ).toBeNull()
    expect(
      separateSourceRecordingsEncoderNotice(
        config({ separateSourceRecordings: on, video: video(3840, 2160, 60) }),
        'win32'
      )
    ).toBeNull()
  })
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
    // Reserved: the backend refuses keepCombined=false and the UI cannot set
    // it, so a stored false must not turn Record into an unexplained refusal.
    expect(normalizeSeparateSourceRecordings({ enabled: true, keepCombined: false })).toEqual({
      enabled: true,
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

  it('never arms on Linux or Windows, and says why (release test 146, plan 0001)', () => {
    const armed = config({ separateSourceRecordings: { enabled: true, keepCombined: true } })
    for (const platform of ['linux', 'win32']) {
      expect(separateSourceRecordingsIneligibility(armed, platform)).toBe('unsupported-platform')
      expect(separateSourceRecordingsForSession(armed, platform)).toBeUndefined()
      expect(
        buildStartSessionParams({ captureConfig: armed, scene, settings, platform }).output
          .separateSourceRecordings
      ).toBeUndefined()
    }
    expect(separateSourceRecordingsIneligibilityCopy('unsupported-platform')).toContain('Mac only')
    // macOS, and a start before runtime info arrived, behave as before.
    expect(separateSourceRecordingsIneligibility(armed, 'darwin')).toBeNull()
    expect(separateSourceRecordingsForSession(armed, 'darwin')).toEqual({
      enabled: true,
      keepCombined: true
    })
    expect(separateSourceRecordingsForSession(armed)).toEqual({ enabled: true, keepCombined: true })
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
