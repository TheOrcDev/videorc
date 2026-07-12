import { readFileSync } from 'fs'
import { join } from 'path'

import { describe, expect, it } from 'vitest'

import { parseSceneCollection } from '../../../main/obs-import'
import type { Device, ObsSetup } from '@/lib/backend'
import { mapObsSetup, type ObsImportPlanResult } from './obs-import-map'

// O2 (OBS import plan): every mapping-table row is a test, and the owner's
// real (scrubbed) collection must produce a report a human can read aloud.

const collectionJson = readFileSync(
  join(__dirname, '../../../main/obs-fixtures/collection.json'),
  'utf8'
)

function device(kind: Device['kind'], id: string, name: string): Device {
  return { id, name, kind, status: 'available' }
}

const DEVICES: Device[] = [
  device('screen', 'screen:1', 'Display 1'),
  device('window', 'window:42', 'Visual Studio Code — videorc'),
  device('camera', 'camera:mbp', 'MacBook Pro Camera'),
  device('microphone', 'mic:usb', 'USB PnP Audio Device')
]

function setupFrom(overrides: Partial<ObsSetup>): ObsSetup {
  return {
    collectionName: 'Test',
    canvasWidth: 1920,
    canvasHeight: 1080,
    outputWidth: 1920,
    outputHeight: 1080,
    fps: 30,
    sources: [],
    scenes: [],
    hasDesktopAudio: false,
    ...overrides
  }
}

function reportNotes(result: ObsImportPlanResult, verdict?: string): string[] {
  return result.report
    .filter((line) => !verdict || line.verdict === verdict)
    .map((line) => `${line.subject}: ${line.note}`)
}

describe('mapObsSetup on the real fixture', () => {
  const parsed = parseSceneCollection(collectionJson)
  const setup = setupFrom({
    collectionName: parsed.name,
    canvasWidth: 3840,
    canvasHeight: 2160,
    outputWidth: 3840,
    outputHeight: 2160,
    fps: 24,
    recordingDirectory: {
      capabilityId: 'resource:11111111-1111-4111-8111-111111111111',
      directoryHandleId: 'directory:22222222-2222-4222-8222-222222222222',
      kind: 'output-directory',
      displayName: 'Movies'
    },
    sources: parsed.sources,
    scenes: parsed.scenes,
    hasDesktopAudio: parsed.hasDesktopAudio,
    service: { type: 'rtmp_common', service: 'YouTube - RTMPS', server: 'rtmps://x', hasKey: true }
  })
  const result = mapObsSetup(setup, DEVICES)

  it('maps output, recording folder, and a real layout preset', () => {
    expect(result.video).toEqual({ width: 3840, height: 2160, fps: 24 })
    expect(result.outputDirectory?.displayName).toBe('Movies')
    expect(['screen-camera', 'screen-only', 'camera-only']).toContain(result.layout.layoutPreset)
  })

  it('reports every visible source of the imported scene — no silent drops', () => {
    const scene =
      setup.scenes.find((candidate) => candidate.current && candidate.items.length > 0) ??
      setup.scenes.find((candidate) => candidate.items.length > 0)
    const visibleNames = new Set(
      scene!.items
        .filter((item) => item.visible)
        .map((item) => item.sourceName)
        .filter((name) => setup.sources.some((source) => source.name === name))
    )
    const mentioned = result.report.map((line) => line.subject).join('\n')
    for (const name of visibleNames) {
      expect(mentioned).toContain(name)
    }
  })

  it('imports a YouTube rtmp_common service as Manual RTMP', () => {
    expect(result.stream).toMatchObject({
      kind: 'rtmp-platform',
      platform: 'youtube',
      serverUrl: 'rtmps://x',
      hasKey: true
    })
  })

  it('never emits OBS kind ids in the report', () => {
    const text = JSON.stringify(result.report)
    expect(text).not.toMatch(/av_capture_input|coreaudio|screen_capture|rtmp_common/)
  })

  it('lists non-imported scenes as skipped with the switch-layouts note', () => {
    expect(reportNotes(result, 'skipped').join('\n')).toContain('one active scene')
  })
})

describe('mapping table rows', () => {
  const camera = {
    name: 'Cam',
    kind: 'camera' as const,
    obsKind: 'av_capture_input',
    deviceName: 'MacBook Pro Camera',
    presetWidth: 1920,
    presetHeight: 1080
  }
  const display = { name: 'Screen', kind: 'display' as const, obsKind: 'screen_capture' }
  const mic = {
    name: 'Mic',
    kind: 'microphone' as const,
    obsKind: 'coreaudio_input_capture',
    deviceName: 'USB PnP Audio Device',
    volume: 0.5,
    muted: true
  }
  const item = (sourceName: string, extra: Record<string, number | boolean> = {}) => ({
    sourceName,
    visible: true,
    x: 0,
    y: 0,
    scaleX: 1,
    scaleY: 1,
    boundsType: 0,
    boundsX: 0,
    boundsY: 0,
    cropLeft: 0,
    cropTop: 0,
    cropRight: 0,
    cropBottom: 0,
    ...extra
  })

  it('screen+camera scene → screen-camera preset with a custom camera box', () => {
    const result = mapObsSetup(
      setupFrom({
        sources: [display, camera],
        scenes: [
          {
            name: 'Main',
            current: true,
            items: [item('Screen'), item('Cam', { x: 1440, y: 810, scaleX: 0.25, scaleY: 0.25 })]
          }
        ]
      }),
      DEVICES
    )
    expect(result.layout.layoutPreset).toBe('screen-camera')
    expect(result.sources.cameraId).toBe('camera:mbp')
    expect(result.layout.cameraTransformMode).toBe('custom')
    expect(result.layout.cameraTransform).toMatchObject({ x: 0.75, y: 0.75 })
    expect(result.layout.cameraTransform!.width).toBeCloseTo(0.25, 2)
  })

  it('portrait-cropped camera → portrait aspect', () => {
    const result = mapObsSetup(
      setupFrom({
        sources: [camera],
        scenes: [
          {
            name: 'Vertical',
            current: true,
            items: [item('Cam', { boundsType: 2, boundsX: 607, boundsY: 1080 })]
          }
        ]
      }),
      DEVICES
    )
    expect(result.layout.layoutPreset).toBe('camera-only')
    expect(result.layout.cameraAspect).toBe('portrait')
  })

  it('two cameras visible → topmost kept, the other approximated', () => {
    const camera2 = { ...camera, name: 'Cam2', deviceName: 'Other Cam' }
    const result = mapObsSetup(
      setupFrom({
        sources: [camera, camera2],
        scenes: [{ name: 'S', current: true, items: [item('Cam'), item('Cam2')] }]
      }),
      DEVICES
    )
    // last item = topmost = Cam2 wins
    expect(reportNotes(result, 'approximated').join('\n')).toContain(
      'Cam: Videorc scenes hold one camera'
    )
  })

  it('mic volume and mute map to gain dB and muted', () => {
    const result = mapObsSetup(
      setupFrom({
        sources: [mic],
        scenes: [{ name: 'S', current: true, items: [item('Mic')] }]
      }),
      DEVICES
    )
    expect(result.sources.microphoneId).toBe('mic:usb')
    expect(result.audio.microphoneGainDb).toBe(-6)
    expect(result.audio.microphoneMuted).toBe(true)
  })

  it('rtmp_custom imports server + key presence', () => {
    const result = mapObsSetup(
      setupFrom({
        sources: [display],
        scenes: [{ name: 'S', current: true, items: [item('Screen')] }],
        service: { type: 'rtmp_custom', server: 'rtmp://my.server/live', hasKey: true }
      }),
      DEVICES
    )
    expect(result.stream).toMatchObject({ kind: 'rtmp-custom', serverUrl: 'rtmp://my.server/live' })
  })

  it('browser/text/media sources are skipped with human reasons; desktop audio names the roadmap', () => {
    const browser = { name: 'Chat overlay', kind: 'browser' as const, obsKind: 'browser_source' }
    const result = mapObsSetup(
      setupFrom({
        sources: [display, browser],
        scenes: [{ name: 'S', current: true, items: [item('Screen'), item('Chat overlay')] }],
        hasDesktopAudio: true
      }),
      DEVICES
    )
    const skipped = reportNotes(result, 'skipped').join('\n')
    expect(skipped).toContain('Chat overlay: Videorc has no browser source')
    expect(skipped).toContain('Desktop audio')
  })

  it('an image source becomes the background; extra images are skipped', () => {
    const bg = {
      name: 'BG',
      kind: 'image' as const,
      obsKind: 'image_source',
      managedBackground: {
        id: 'bg-managed',
        name: 'BG',
        assetPath: 'videorc-asset://background/bg-managed.png',
        thumbnailPath: 'videorc-asset://background/bg-managed.png',
        fileName: 'bg-managed.png'
      }
    }
    const bg2 = {
      name: 'BG2',
      kind: 'image' as const,
      obsKind: 'image_source',
      managedBackground: {
        id: 'bg2-managed',
        name: 'BG2',
        assetPath: 'videorc-asset://background/bg2-managed.png',
        thumbnailPath: 'videorc-asset://background/bg2-managed.png',
        fileName: 'bg2-managed.png'
      }
    }
    const result = mapObsSetup(
      setupFrom({
        sources: [display, bg, bg2],
        scenes: [{ name: 'S', current: true, items: [item('BG'), item('BG2'), item('Screen')] }]
      }),
      DEVICES
    )
    expect(result.backgroundAsset?.id).toBe('bg-managed')
    expect(reportNotes(result, 'skipped').join('\n')).toContain('BG2')
  })
})
