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
  audio: { microphoneGainDb?: number; microphoneMuted?: boolean }
  outputDirectory?: ResourceSelection
  stream?:
    | { kind: 'rtmp-custom'; serverUrl: string; hasKey: boolean }
    | {
        kind: 'rtmp-platform'
        platform: 'youtube'
        serviceLabel: string
        serverUrl: string
        hasKey: boolean
      }
    | { kind: 'oauth-suggest'; platform: 'twitch' | 'other'; serviceLabel: string }
  backgroundAsset?: BackgroundImportResult
  report: ObsImportReportLine[]
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

function detectPlatform(serviceLabel: string): 'youtube' | 'twitch' | 'other' {
  if (fuzzyIncludes(serviceLabel, 'youtube')) {
    return 'youtube'
  }
  if (fuzzyIncludes(serviceLabel, 'twitch')) {
    return 'twitch'
  }
  return 'other'
}

const SKIP_NOTES: Partial<Record<ObsSource['kind'], string>> = {
  browser: 'Videorc has no browser source',
  text: 'Videorc has no text overlay source',
  media: 'Videorc has no media-file source',
  other: 'no Videorc equivalent'
}

export function mapObsSetup(setup: ObsSetup, devices: Device[]): ObsImportPlanResult {
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
    note: `${setup.outputWidth}×${setup.outputHeight} at ${setup.fps} fps`
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
      note: 'no scene with visible sources found'
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
          note: `display captures cannot be matched exactly — mapped to ${firstScreen.name}; re-pick in Sources if wrong`
        })
      } else {
        report.push({
          verdict: 'approximated',
          subject: source.name,
          note: 'pick the display in Sources once screen access is granted'
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
          note: `window capture → ${window.name}`
        })
      } else {
        report.push({
          verdict: 'approximated',
          subject: source.name,
          note: `no open window matches "${hint}" right now — pick it in Sources`
        })
      }
    }
    for (const extra of extras) {
      report.push({
        verdict: 'approximated',
        subject: extra.name,
        note: 'Videorc scenes hold one screen — kept the topmost'
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
      report.push({ verdict: 'imported', subject: source.name, note: `camera → ${camera.name}` })
    } else {
      report.push({
        verdict: 'approximated',
        subject: source.name,
        note: `no connected camera named "${source.deviceName ?? source.name}" — pick one in Sources`
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
          note: 'camera size estimated from a 1080p feed — nudge it on the Scene stage if off'
        })
      }
    }
    for (const extra of extras) {
      report.push({
        verdict: 'approximated',
        subject: extra.name,
        note: 'Videorc scenes hold one camera — kept the topmost'
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
        note: `microphone → ${microphone.name}`
      })
    } else {
      report.push({
        verdict: 'approximated',
        subject: micSource.name,
        note: 'could not match the mic by name — pick it in Sources'
      })
    }
    if (typeof micSource.volume === 'number' && micSource.volume !== 1) {
      result.audio.microphoneGainDb = volumeToGainDb(micSource.volume)
      report.push({
        verdict: 'approximated',
        subject: `${micSource.name} level`,
        note: `OBS volume mapped to ${result.audio.microphoneGainDb} dB gain`
      })
    }
    if (micSource.muted) {
      result.audio.microphoneMuted = true
      report.push({
        verdict: 'imported',
        subject: `${micSource.name} mute`,
        note: 'muted, as in OBS'
      })
    }
  }

  // --- background image -------------------------------------------------------
  const imageItems = scene.items.filter(
    (item) => item.visible && sourcesByName.get(item.sourceName)?.kind === 'image'
  )
  if (imageItems.length > 0) {
    const bottom = sourcesByName.get(imageItems[0].sourceName)
    if (bottom?.managedBackground) {
      result.backgroundAsset = bottom.managedBackground
      report.push({
        verdict: 'approximated',
        subject: bottom.name,
        note: 'image imported as the scene background'
      })
    }
    for (const item of imageItems.slice(1)) {
      report.push({
        verdict: 'skipped',
        subject: item.sourceName,
        note: 'Videorc supports one background image per scene'
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
  if (setup.hasDesktopAudio) {
    report.push({
      verdict: 'skipped',
      subject: 'Desktop audio',
      note: 'system-audio capture is on the Videorc roadmap'
    })
  }

  // --- other scenes -------------------------------------------------------------
  for (const other of setup.scenes) {
    if (other.name === scene.name) {
      continue
    }
    report.push({
      verdict: 'skipped',
      subject: `Scene "${other.name}"`,
      note: 'Videorc keeps one active scene — imported the current OBS scene; switch layouts in Studio'
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
          ? 'server and stream key imported'
          : 'server imported (no key found)'
      })
    } else {
      const label = setup.service.service ?? 'streaming service'
      const platform = detectPlatform(label)
      if (platform === 'youtube' && setup.service.server) {
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
            ? 'server and stream key imported to YouTube Manual RTMP'
            : 'server imported to YouTube Manual RTMP (no key found)'
        })
      } else if (platform === 'youtube') {
        report.push({
          verdict: 'approximated',
          subject: label,
          note: 'set up YouTube Manual RTMP in Livestream — OBS did not include a server URL'
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
          note: 'connect the account in Livestream instead — sign-in beats a pasted stream key'
        })
      }
    }
  }

  return result
}
