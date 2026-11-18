import { describe, expect, it } from 'vitest'

import type { LayoutSettings, Scene, SrtInputState, StreamingSettings } from './backend'
import { defaultCaptureConfig, type CaptureConfig } from './capture'
import { streamingWithoutTargets } from './go-live-exclusions'
import {
  SRT_CAMERA_ID,
  SRT_CONNECTION_OPTIONS,
  goLiveSrtNoSignal,
  isSrtCameraId,
  srtAskFacts,
  parseSrtPort,
  srtCameraFacts,
  srtCameraHasNoSignal,
  srtCameraSourceStatus,
  srtInputHidden
} from './srt-input-view'

/** Destinations that are on; `vertical` ones stream the vertical leg. */
const streamingTo = (...targets: { id: string; vertical?: boolean }[]): StreamingSettings =>
  ({
    enabled: targets.length > 0,
    mode: targets.length > 1 ? 'multi' : 'single',
    enabledTargetIds: targets.map((target) => target.id),
    targets: targets.map((target) => ({
      id: target.id,
      platform: target.vertical ? 'tiktok' : 'twitch',
      label: target.id,
      enabled: true,
      ...(target.vertical ? { outputOrientation: 'vertical' } : {})
    }))
  }) as unknown as StreamingSettings

/** What goes out: the SRT Camera picked, in a layout that shows it, streamed. */
const going = (
  cameraId: string | undefined = SRT_CAMERA_ID,
  layout: Partial<LayoutSettings> = {},
  extra: {
    scene?: Scene
    simulcast?: { layout: LayoutSettings; scene?: Scene }
    streaming?: StreamingSettings
  } = {}
) => ({
  sources: { ...defaultCaptureConfig.sources, cameraId },
  layout: { ...defaultCaptureConfig.layout, layoutPreset: 'screen-camera' as const, ...layout },
  streaming: streamingTo(
    { id: 'twitch' },
    ...(extra.simulcast ? [{ id: 'tiktok', vertical: true }] : [])
  ),
  ...extra
})

const state = (patch: Partial<SrtInputState> = {}): SrtInputState => ({
  supported: true,
  enabled: true,
  port: 9000,
  connection: 'wifi',
  latencyMs: 120,
  passphrase: 'a'.repeat(32),
  cameraId: SRT_CAMERA_ID,
  cameraName: 'SRT Camera (port 9000)',
  status: {
    listening: true,
    senderConnected: false,
    senderSession: 0,
    framesDecoded: 0,
    signal: 'waiting',
    detail: 'Waiting'
  },
  ...patch
})

describe('SRT input view (plan 250)', () => {
  it('is hidden until the backend answers and where it is not supported (D9)', () => {
    expect(srtInputHidden(null)).toBe(true)
    expect(srtInputHidden(state({ supported: false }))).toBe(true)
    expect(srtInputHidden(state({ enabled: false }))).toBe(false)
  })

  it('names each Connection with its latency (D11)', () => {
    expect(SRT_CONNECTION_OPTIONS).toEqual([
      { value: 'cable', label: 'Cable or Ethernet · 0 ms' },
      { value: 'wifi', label: 'Wi-Fi · 120 ms' },
      { value: 'internet', label: 'Internet · 500 ms' }
    ])
  })

  it('takes a port from 1024 to 65535', () => {
    expect(parseSrtPort('9000')).toEqual({ kind: 'port', port: 9000 })
    expect(parseSrtPort(' 65535 ')).toEqual({ kind: 'port', port: 65535 })
    for (const refused of ['80', '65536', '9000.5', '', 'abc']) {
      expect(parseSrtPort(refused)).toEqual({
        kind: 'refused',
        message: 'Choose a port from 1024 to 65535.'
      })
    }
  })

  it('knows the SRT Camera by its id', () => {
    expect(isSrtCameraId('camera:srt-input')).toBe(true)
    expect(isSrtCameraId('camera:avfoundation-native:00')).toBe(false)
    expect(isSrtCameraId(undefined)).toBe(false)
  })

  it('shows the status as the camera facts line (D17)', () => {
    expect(srtCameraFacts(state())).toBe('Waiting')
    expect(
      srtCameraFacts(
        state({
          status: {
            listening: true,
            senderConnected: true,
            senderSession: 1,
            framesDecoded: 50,
            signal: 'receiving',
            width: 3840,
            height: 2160,
            fps: 25,
            codec: 'HEVC',
            detail: 'Receiving · 3840 × 2160 · 25 fps · HEVC'
          }
        })
      )
    ).toBe('Receiving · 3840 × 2160 · 25 fps · HEVC')
    expect(srtCameraFacts(null)).toBeNull()
  })

  // Soak, 2026-11-15: the backend keeps a refusal off a receiving line, and
  // the facts line shows that line as it is, never the refusal on top.
  it('shows a receiving line as it is when a refusal is in the status', () => {
    const receiving = state({
      status: {
        listening: true,
        senderConnected: true,
        senderSession: 1,
        framesDecoded: 900,
        signal: 'receiving',
        width: 1920,
        height: 1080,
        fps: 30,
        codec: 'HEVC',
        refusal: 'secondSender',
        detail: 'Receiving · 1920 × 1080 · 30 fps · HEVC'
      }
    })
    expect(srtCameraFacts(receiving)).toBe('Receiving · 1920 × 1080 · 30 fps · HEVC')
  })

  // Live QA, 2026-11-15: the pacer keeps the camera's pipeline busy with
  // the held frame or the still, so the pipeline alone read "Receiving"
  // after the sender quit. The badge follows the SRT signal instead.
  it('badges the SRT Camera by its signal, never Receiving once no frames arrive', () => {
    const pipeline = { label: 'Receiving', tone: 'good' as const }
    const withSignal = (
      signal: SrtInputState['status']['signal'],
      refusal?: SrtInputState['status']['refusal']
    ) =>
      state({
        status: {
          listening: true,
          senderConnected: false,
          senderSession: 2,
          framesDecoded: 900,
          signal,
          ...(refusal ? { refusal } : {}),
          detail: refusal ? 'Second sender refused' : 'x'
        }
      })
    expect(srtCameraSourceStatus(withSignal('receiving'), pipeline)).toEqual(pipeline)
    expect(srtCameraSourceStatus(withSignal('holding', 'secondSender'), pipeline)).toEqual({
      label: 'No frames',
      tone: 'warn'
    })
    expect(srtCameraSourceStatus(withSignal('waiting', 'secondSender'), pipeline)).toEqual({
      label: 'No signal',
      tone: 'neutral'
    })
    expect(srtCameraSourceStatus(withSignal('unsupportedCodec'), pipeline)).toEqual({
      label: 'No picture',
      tone: 'warn'
    })
    // Anything the pipeline says other than Receiving stands.
    const starting = { label: 'Starting', tone: 'warn' as const }
    expect(srtCameraSourceStatus(withSignal('waiting'), starting)).toEqual(starting)
    expect(srtCameraSourceStatus(null, pipeline)).toEqual(pipeline)
    expect(srtCameraSourceStatus(withSignal('waiting'), null)).toBeNull()
  })

  it('has no signal while waiting or on a codec it cannot show, never while frames arrive', () => {
    expect(srtCameraHasNoSignal(state(), going())).toBe(true)
    expect(
      srtCameraHasNoSignal(
        state({
          status: {
            listening: true,
            senderConnected: false,
            senderSession: 1,
            framesDecoded: 0,
            signal: 'unsupportedCodec',
            detail: 'x'
          }
        }),
        going()
      )
    ).toBe(true)
    for (const signal of ['receiving', 'holding'] as const) {
      expect(
        srtCameraHasNoSignal(
          state({
            status: {
              listening: true,
              senderConnected: false,
              senderSession: 0,
              framesDecoded: 0,
              signal,
              detail: 'x'
            }
          }),
          going()
        )
      ).toBe(false)
    }
    // Only when the camera going live is the SRT Camera.
    expect(srtCameraHasNoSignal(state(), going('camera:avfoundation-native:00'))).toBe(false)
    expect(
      srtCameraHasNoSignal(state(), {
        ...going(),
        sources: { ...defaultCaptureConfig.sources, cameraId: undefined }
      })
    ).toBe(false)
    expect(srtCameraHasNoSignal(state({ enabled: false }), going())).toBe(false)
    expect(srtCameraHasNoSignal(null, going())).toBe(false)
  })

  // D15 is about a scene that goes live using the SRT
  // Camera, not a camera merely picked. The composition says so, as the
  // backend builds it (scene.rs): screen-only never composites the camera.
  it('asks only when the composition going out shows the SRT Camera', () => {
    const waiting = state()
    expect(
      srtCameraHasNoSignal(waiting, going(SRT_CAMERA_ID, { layoutPreset: 'screen-only' }))
    ).toBe(false)
    expect(
      srtCameraHasNoSignal(waiting, going(SRT_CAMERA_ID, { layoutPreset: 'vertical-screen-only' }))
    ).toBe(false)
    expect(
      srtCameraHasNoSignal(
        waiting,
        going(SRT_CAMERA_ID, { sourceVisibility: { camera: false, capture: true } })
      )
    ).toBe(false)
    // Freeform composites the picked camera whatever the preset says.
    expect(
      srtCameraHasNoSignal(
        waiting,
        going(SRT_CAMERA_ID, { layoutPreset: 'screen-only', arrangementMode: 'freeform' })
      )
    ).toBe(true)
    // A scene sent with the session decides by its own camera source.
    const scene = (visible: boolean | null): Scene =>
      ({
        sources: visible === null ? [] : [{ id: 'source:camera', kind: 'camera', visible } as never]
      }) as unknown as Scene
    expect(srtCameraHasNoSignal(waiting, going(SRT_CAMERA_ID, {}, { scene: scene(true) }))).toBe(
      true
    )
    expect(srtCameraHasNoSignal(waiting, going(SRT_CAMERA_ID, {}, { scene: scene(false) }))).toBe(
      false
    )
    expect(srtCameraHasNoSignal(waiting, going(SRT_CAMERA_ID, {}, { scene: scene(null) }))).toBe(
      false
    )
    // A vertical leg that shows the camera counts, even over a screen-only main leg.
    const verticalWithCamera = {
      ...defaultCaptureConfig.layout,
      layoutPreset: 'vertical-camera-bottom' as const
    }
    expect(
      srtCameraHasNoSignal(
        waiting,
        going(
          SRT_CAMERA_ID,
          { layoutPreset: 'screen-only' },
          { simulcast: { layout: verticalWithCamera } }
        )
      )
    ).toBe(true)
  })

  it("asks from the capture setup the same way for the dialog and an agent's go_live", () => {
    const config = (layoutPreset: LayoutSettings['layoutPreset']): CaptureConfig => ({
      ...defaultCaptureConfig,
      sources: { ...defaultCaptureConfig.sources, cameraId: SRT_CAMERA_ID },
      layout: { ...defaultCaptureConfig.layout, layoutPreset },
      streaming: streamingTo({ id: 'twitch' })
    })
    expect(goLiveSrtNoSignal(state(), config('screen-only'))).toBe(false)
    expect(goLiveSrtNoSignal(state(), config('screen-camera'))).toBe(true)
  })

  // Only the legs that stream count (D15: a local
  // recording never asks). Destinations route as the backend sends them:
  // with a vertical leg armed, vertical destinations take it and the rest
  // take the main composition.
  it('counts only the legs that stream to a destination', () => {
    const waiting = state()
    const verticalScreenOnly = {
      ...defaultCaptureConfig.layout,
      layoutPreset: 'vertical-screen-only' as const
    }
    // Nothing streams: a recording never asks.
    expect(srtCameraHasNoSignal(waiting, { ...going(), streaming: undefined })).toBe(false)
    // Only vertical destinations: the camera main layout streams nowhere.
    expect(
      srtCameraHasNoSignal(
        waiting,
        going(
          SRT_CAMERA_ID,
          {},
          {
            simulcast: { layout: verticalScreenOnly },
            streaming: streamingTo({ id: 'tiktok', vertical: true })
          }
        )
      )
    ).toBe(false)
    // A horizontal destination as well: the main layout streams, and asks.
    expect(
      srtCameraHasNoSignal(
        waiting,
        going(
          SRT_CAMERA_ID,
          {},
          {
            simulcast: { layout: verticalScreenOnly },
            streaming: streamingTo({ id: 'twitch' }, { id: 'tiktok', vertical: true })
          }
        )
      )
    ).toBe(true)
  })

  it("leaves this attempt's excluded destinations out, for the dialog and go_live", () => {
    // A screen-only main layout and a camera-bearing vertical leg.
    const config: CaptureConfig = {
      ...defaultCaptureConfig,
      streamEnabled: false,
      sources: { ...defaultCaptureConfig.sources, cameraId: SRT_CAMERA_ID },
      layout: { ...defaultCaptureConfig.layout, layoutPreset: 'screen-only' },
      simulcastFollowsProgram: false,
      lastVerticalPreset: 'vertical-camera-bottom',
      streaming: streamingTo({ id: 'twitch' }, { id: 'tiktok', vertical: true })
    }
    expect(goLiveSrtNoSignal(state(), config)).toBe(true)
    const withoutTikTok = {
      ...config,
      streaming: streamingWithoutTargets(config.streaming, ['tiktok'])
    }
    expect(goLiveSrtNoSignal(state(), withoutTikTok)).toBe(false)
  })

  // The facts an answer covers, and nothing
  // incidental or passing (a refusal clears on its own).
  it('names what the SRT ask covers: signal, streamed legs and port', () => {
    const base = srtAskFacts(state(), going())
    expect(base).not.toBeNull()
    expect(srtAskFacts(state({ enabled: false }), going())).toBeNull()
    const withVertical = srtAskFacts(
      state(),
      going(
        SRT_CAMERA_ID,
        {},
        {
          simulcast: {
            layout: { ...defaultCaptureConfig.layout, layoutPreset: 'vertical-camera-bottom' }
          }
        }
      )
    )
    const status = state().status
    const differs = [
      withVertical,
      srtAskFacts(state({ status: { ...status, signal: 'unsupportedCodec' } }), going()),
      srtAskFacts(state({ port: 9001 }), going())
    ]
    for (const facts of differs) {
      expect(facts).not.toBeNull()
      expect(facts).not.toBe(base)
    }
    // Counters, the rate, the detail line and a refusal change nothing.
    expect(
      srtAskFacts(
        state({ status: { ...status, framesDecoded: 99, fps: 30, detail: 'Waiting for SRT' } }),
        going()
      )
    ).toBe(base)
    expect(srtAskFacts(state({ status: { ...status, refusal: 'wrongPassphrase' } }), going())).toBe(
      base
    )
  })
})
