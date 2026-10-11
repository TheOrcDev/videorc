import type {
  CameraAspect,
  BackgroundImportResult,
  CameraTransform,
  Device,
  LayoutPreset,
  ObsScene,
  ObsSetup,
  ObsSource,
  ResourceSelection,
  SourceSelection
} from '@/lib/backend'
import { formatVideoQuality } from '@/lib/format-video'

// OBS import O2 — the mapping core (plan: vault "2026-07-07 - Videorc OBS
// Import Plan"). Pure: (ObsSetup, Device[]) → a Videorc config patch + the
// truthful three-verdict report. THE law: every OBS source the user can see
// lands in the report as imported / approximated / skipped(reason) — no
// silent drops, no fake promises. All mapping decisions live HERE.

export type ObsImportVerdict = 'imported' | 'approximated' | 'skipped'

export interface ObsImportReportLine {
  verdict: ObsImportVerdict
  /** The OBS-side name the user recognizes. */
  subject: string
  /** One human phrase — never OBS kind ids. */
  note: string
}

export interface ObsImportPlanResult {
  sources: Partial<SourceSelection>
  layout: {
    layoutPreset: LayoutPreset
    cameraTransformMode?: 'custom'
    cameraTransform?: CameraTransform
    cameraAspect?: CameraAspect
  }
  video: { width: number; height: number; fps: number }
  audio: { microphoneGainDb?: number; microphoneMuted?: boolean; systemAudioEnabled?: boolean }
  outputDirectory?: ResourceSelection
  stream?:
    | { kind: 'rtmp-custom'; serverUrl: string; hasKey: boolean }
    | {
        kind: 'rtmp-platform'
        platform: 'youtube' | 'kick'
        serviceLabel: string
        serverUrl: string
        hasKey: boolean
      }
    | { kind: 'oauth-suggest'; platform: 'twitch' | 'other'; serviceLabel: string }
  backgroundAsset?: BackgroundImportResult
  /** The Assets slot the background goes into; set exactly when the report
   * promises the background (plan 174, C-7). */
  backgroundSlotId?: string
  report: ObsImportReportLine[]
}

/** Where an imported OBS image goes in Assets, resolved before the report is
 * built so the report says what will happen (`unattendedImportSlot`). */
export interface ObsBackgroundTarget {
  slotId: string
  /** The background the slot holds now, which the import replaces; null for an empty slot. */
  replaces: string | null
}

const FALLBACK_CAMERA_NATIVE = { width: 1920, height: 1080 }

function fuzzyIncludes(haystack: string, needle: string): boolean {
  return haystack.toLowerCase().includes(needle.toLowerCase())
}

function matchDevice(devices: Device[], kind: Device['kind'], name?: string): Device | undefined {
  const pool = devices.filter((device) => device.kind === kind)
  if (!name) {
    return undefined
  }
  return (
    pool.find((device) => device.name === name) ??
    pool.find((device) => fuzzyIncludes(device.name, name) || fuzzyIncludes(name, device.name))
  )
}

/** Last visible item wins: OBS renders items bottom-to-top, so last = topmost. */
function pickTopmost(
  scene: ObsScene,
  sourcesByName: Map<string, ObsSource>,
  kinds: ObsSource['kind'][]
): { item: ObsScene['items'][number]; source: ObsSource; extras: ObsSource[] } | null {
  const matches = scene.items
    .filter((item) => item.visible)
    .map((item) => ({ item, source: sourcesByName.get(item.sourceName) }))
    .filter((entry): entry is { item: ObsScene['items'][number]; source: ObsSource } =>
      Boolean(entry.source && kinds.includes(entry.source.kind))
    )
  if (matches.length === 0) {
    return null
  }
  const winner = matches[matches.length - 1]
  return {
    ...winner,
    extras: matches.slice(0, -1).map((entry) => entry.source)
  }
}

function cameraBox(
  item: ObsScene['items'][number],
  source: ObsSource,
  canvasWidth: number,
  canvasHeight: number
): { transform: CameraTransform; assumedNative: boolean } | null {
  let width: number
  let height: number
  let assumedNative = false
  if (item.boundsType !== 0 && item.boundsX > 0 && item.boundsY > 0) {
    width = item.boundsX
    height = item.boundsY
  } else {
    const native =
      source.presetWidth && source.presetHeight
        ? { width: source.presetWidth, height: source.presetHeight }
        : ((assumedNative = true), FALLBACK_CAMERA_NATIVE)
    const cropX = item.cropLeft + item.cropRight
    const cropY = item.cropTop + item.cropBottom
    width = Math.max(1, native.width - cropX) * item.scaleX
    height = Math.max(1, native.height - cropY) * item.scaleY
  }
  if (!(width > 0) || !(height > 0) || canvasWidth <= 0 || canvasHeight <= 0) {
    return null
  }
  const clamp01 = (value: number): number => Math.min(1, Math.max(0, value))
  const transform: CameraTransform = {
    x: clamp01(item.x / canvasWidth),
    y: clamp01(item.y / canvasHeight),
    width: clamp01(width / canvasWidth),
    height: clamp01(height / canvasHeight)
  }
  if (transform.width < 0.02 || transform.height < 0.02) {
    return null
  }
  return { transform, assumedNative }
}

function aspectFromBox(
  transform: CameraTransform,
  canvasWidth: number,
  canvasHeight: number
): CameraAspect {
  const ratio = (transform.width * canvasWidth) / Math.max(1, transform.height * canvasHeight)
  if (ratio < 0.9) {
    return 'portrait'
  }
  if (ratio <= 1.15) {
    return 'square'
  }
  return 'source'
}

function volumeToGainDb(volume: number): number {
  if (!(volume > 0)) {
    return -20
  }
  return Math.max(-20, Math.min(20, Math.round(20 * Math.log10(volume))))
}

// Kick's ingest is an IVS `*.live-video.net` host, which Twitch's newer ingest
// shares, so the host alone never means Kick: it counts only with "kick" in
// the service label or the server URL.
function detectPlatform(
  serviceLabel: string,
  serverUrl?: string
): 'youtube' | 'twitch' | 'kick' | 'other' {
  if (fuzzyIncludes(serviceLabel, 'youtube')) {
    return 'youtube'
  }
  if (fuzzyIncludes(serviceLabel, 'kick') || fuzzyIncludes(serverUrl ?? '', 'kick')) {
    return 'kick'
  }
  if (fuzzyIncludes(serviceLabel, 'twitch')) {
    return 'twitch'
  }
  return 'other'
}

// Every note is a sentence the streamer reads before applying (plan 174,
// C-29): what happens, then what to do if it is not right.
const SKIP_NOTES: Partial<Record<ObsSource['kind'], string>> = {
  browser: 'Videorc has no browser source.',
  text: 'Videorc has no text overlay source.',
  media: 'Videorc has no media-file source.',
  other: 'Videorc has nothing like it.'
}

export function mapObsSetup(
  setup: ObsSetup,
  devices: Device[],
  backgroundTarget: ObsBackgroundTarget | null = null
): ObsImportPlanResult {
  const report: ObsImportReportLine[] = []
  const sourcesByName = new Map(setup.sources.map((source) => [source.name, source]))
  const scene =
    setup.scenes.find((candidate) => candidate.current && candidate.items.length > 0) ??
    setup.scenes.find((candidate) => candidate.items.length > 0)

  const result: ObsImportPlanResult = {
    sources: {},
    layout: { layoutPreset: 'screen-only' },
    video: { width: setup.outputWidth, height: setup.outputHeight, fps: setup.fps },
    audio: {},
    report
  }

  report.push({
    verdict: 'imported',
    subject: 'Output',
    note: formatVideoQuality(
      { width: setup.outputWidth, height: setup.outputHeight, fps: setup.fps },
      { size: 'full' }
    )
  })
  if (setup.recordingDirectory) {
    result.outputDirectory = setup.recordingDirectory
    report.push({
      verdict: 'imported',
      subject: 'Recording folder',
      note: setup.recordingDirectory.displayName
    })
  }

  if (!scene) {
    report.push({
      verdict: 'skipped',
      subject: setup.collectionName,
      note: 'No scene with visible sources was found.'
    })
    return result
  }

  // --- screen -------------------------------------------------------------
  const screenPick = pickTopmost(scene, sourcesByName, ['display', 'window', 'application'])
  if (screenPick) {
    const { source, extras } = screenPick
    if (source.kind === 'display') {
      const firstScreen = devices.find(
        (device) => device.kind === 'screen' && device.status === 'available'
      )
      if (firstScreen) {
        result.sources.screenId = firstScreen.id
        result.sources.screenName = firstScreen.name
        report.push({
          verdict: 'approximated',
          subject: source.name,
          note: `Captures ${firstScreen.name}. OBS displays can't be matched exactly, so check it in Sources.`
        })
      } else {
        report.push({
          verdict: 'approximated',
          subject: source.name,
          note: 'Pick the display in Sources once Screen Recording is allowed.'
        })
      }
    } else {
      const hint = source.applicationHint ?? source.name
      const window =
        matchDevice(devices, 'window', hint) ?? matchDevice(devices, 'window', source.name)
      if (window) {
        result.sources.windowId = window.id
        result.sources.windowName = window.name
        report.push({
          verdict: 'imported',
          subject: source.name,
          note: `Captures the ${window.name} window.`
        })
      } else {
        report.push({
          verdict: 'approximated',
          subject: source.name,
          note: `No open window matches "${hint}" right now. Pick it in Sources.`
        })
      }
    }
    for (const extra of extras) {
      report.push({
        verdict: 'approximated',
        subject: extra.name,
        note: 'Videorc scenes hold one screen, so the topmost one is kept.'
      })
    }
  }

  // --- camera ---------------------------------------------------------------
  const cameraPick = pickTopmost(scene, sourcesByName, ['camera'])
  if (cameraPick) {
    const { item, source, extras } = cameraPick
    const camera = matchDevice(devices, 'camera', source.deviceName ?? source.name)
    if (camera) {
      result.sources.cameraId = camera.id
      result.sources.cameraName = camera.name
      report.push({ verdict: 'imported', subject: source.name, note: `Uses ${camera.name}.` })
    } else {
      report.push({
        verdict: 'approximated',
        subject: source.name,
        note: `No connected camera is named "${source.deviceName ?? source.name}". Pick one in Sources.`
      })
    }
    const box = cameraBox(item, source, setup.canvasWidth, setup.canvasHeight)
    if (box) {
      result.layout.cameraTransformMode = 'custom'
      result.layout.cameraTransform = box.transform
      result.layout.cameraAspect = aspectFromBox(
        box.transform,
        setup.canvasWidth,
        setup.canvasHeight
      )
      if (box.assumedNative) {
        report.push({
          verdict: 'approximated',
          subject: `${source.name} position`,
          note: "The camera's size is estimated from a 1080p feed. Adjust it on the Scene stage if it's off."
        })
      }
    }
    for (const extra of extras) {
      report.push({
        verdict: 'approximated',
        subject: extra.name,
        note: 'Videorc scenes hold one camera, so the topmost one is kept.'
      })
    }
  }

  result.layout.layoutPreset =
    cameraPick && screenPick ? 'screen-camera' : cameraPick ? 'camera-only' : 'screen-only'

  // --- microphone -----------------------------------------------------------
  const micPick = pickTopmost(scene, sourcesByName, ['microphone'])
  const micSource = micPick?.source ?? setup.sources.find((source) => source.kind === 'microphone')
  if (micSource) {
    const microphone = matchDevice(devices, 'microphone', micSource.deviceName ?? micSource.name)
    if (microphone) {
      result.sources.microphoneId = microphone.id
      result.sources.microphoneName = microphone.name
      report.push({
        verdict: 'imported',
        subject: micSource.name,
        note: `Uses ${microphone.name}.`
      })
    } else {
      report.push({
        verdict: 'approximated',
        subject: micSource.name,
        note: 'No microphone matches this name. Pick it in Sources.'
      })
    }
    if (typeof micSource.volume === 'number' && micSource.volume !== 1) {
      result.audio.microphoneGainDb = volumeToGainDb(micSource.volume)
      report.push({
        verdict: 'approximated',
        subject: `${micSource.name} level`,
        note: `The OBS volume becomes ${result.audio.microphoneGainDb} dB of gain.`
      })
    }
    if (micSource.muted) {
      result.audio.microphoneMuted = true
      report.push({
        verdict: 'imported',
        subject: `${micSource.name} mute`,
        note: 'Muted, as in OBS.'
      })
    }
  }

  // --- background image -------------------------------------------------------
  // The report promises the background only where apply delivers it: an
  // Assets slot is resolved first, and apply imports it there and makes it
  // the scene background (plan 174, C-7). The old note promised it while
  // apply dropped it whenever no slot was empty, which is every profile.
  const imageItems = scene.items.filter(
    (item) => item.visible && sourcesByName.get(item.sourceName)?.kind === 'image'
  )
  if (imageItems.length > 0) {
    const bottom = sourcesByName.get(imageItems[0].sourceName)
    if (bottom?.managedBackground && backgroundTarget) {
      result.backgroundAsset = bottom.managedBackground
      result.backgroundSlotId = backgroundTarget.slotId
      report.push({
        verdict: 'approximated',
        subject: bottom.name,
        note: backgroundTarget.replaces
          ? `Becomes the scene background, in place of ${backgroundTarget.replaces} in Assets.`
          : 'Becomes the scene background, in an empty slot in Assets.'
      })
    } else if (bottom) {
      report.push({
        verdict: 'skipped',
        subject: bottom.name,
        note: bottom.managedBackground
          ? 'Assets has no slot for it. Import it from Assets.'
          : "The image couldn't be copied. Check that the file still exists and is a PNG, JPEG or WebP."
      })
    }
    for (const item of imageItems.slice(1)) {
      report.push({
        verdict: 'skipped',
        subject: item.sourceName,
        note: 'Videorc uses one background image per scene.'
      })
    }
  }

  // --- everything else in the scene -------------------------------------------
  for (const item of scene.items) {
    const source = sourcesByName.get(item.sourceName)
    if (!source || !item.visible) {
      continue
    }
    const note = SKIP_NOTES[source.kind]
    if (note) {
      report.push({ verdict: 'skipped', subject: source.name, note })
    }
  }
  // --- desktop audio -----------------------------------------------------------
  // Plan 069: OBS's Desktop Audio is Videorc's System audio. It turns on only
  // where this computer can capture it; the row is hidden everywhere else.
  if (setup.hasDesktopAudio) {
    const systemAudio = devices.find((device) => device.kind === 'system-audio')
    if (systemAudio?.status === 'available') {
      result.audio.systemAudioEnabled = true
      report.push({ verdict: 'imported', subject: 'Desktop audio', note: 'Turns System audio on.' })
    } else if (systemAudio?.status === 'permission-required') {
      result.audio.systemAudioEnabled = true
      report.push({
        verdict: 'approximated',
        subject: 'Desktop audio',
        note: 'Turns System audio on, once Screen Recording is allowed.'
      })
    } else {
      report.push({
        verdict: 'skipped',
        subject: 'Desktop audio',
        note: "This computer can't capture system audio."
      })
    }
  }

  // --- other scenes -------------------------------------------------------------
  for (const other of setup.scenes) {
    if (other.name === scene.name) {
      continue
    }
    report.push({
      verdict: 'skipped',
      subject: `Scene "${other.name}"`,
      note: 'Videorc keeps one active scene, so only the current OBS scene is imported.'
    })
  }

  // --- stream service --------------------------------------------------------
  if (setup.service) {
    if (setup.service.type === 'rtmp_custom' && setup.service.server) {
      result.stream = {
        kind: 'rtmp-custom',
        serverUrl: setup.service.server,
        hasKey: setup.service.hasKey
      }
      report.push({
        verdict: 'imported',
        subject: 'Custom RTMP destination',
        note: setup.service.hasKey
          ? 'Imports the server and the stream key.'
          : 'Imports the server. OBS had no stream key.'
      })
    } else {
      const label = setup.service.service ?? 'streaming service'
      const platform = detectPlatform(label, setup.service.server)
      const platformName = platform === 'kick' ? 'Kick' : 'YouTube'
      if ((platform === 'youtube' || platform === 'kick') && setup.service.server) {
        result.stream = {
          kind: 'rtmp-platform',
          platform,
          serviceLabel: label,
          serverUrl: setup.service.server,
          hasKey: setup.service.hasKey
        }
        report.push({
          verdict: 'imported',
          subject: label,
          note: setup.service.hasKey
            ? `Imports the server and the stream key to ${platformName} Manual RTMP.`
            : `Imports the server to ${platformName} Manual RTMP. OBS had no stream key.`
        })
      } else if (platform === 'youtube' || platform === 'kick') {
        report.push({
          verdict: 'approximated',
          subject: label,
          note: `OBS had no server URL. Set up ${platformName} Manual RTMP in Livestream.`
        })
      } else {
        result.stream = {
          kind: 'oauth-suggest',
          platform,
          serviceLabel: label
        }
        report.push({
          verdict: 'approximated',
          subject: label,
          note: 'Connect the account in Livestream instead. Signing in is safer than a pasted stream key.'
        })
      }
    }
  }

  return result
}
