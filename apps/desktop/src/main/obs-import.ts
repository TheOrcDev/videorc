import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync } from 'fs'
import { homedir } from 'os'
import { isAbsolute, join, relative, resolve } from 'path'

import type {
  ObsDiscovery,
  ObsScene,
  ObsSceneItem,
  ObsSetup,
  ObsSource,
  ObsStreamService
} from '../shared/backend'

// OBS setup import, O1 (plan: vault "2026-07-07 - Videorc OBS Import Plan").
// Read-only over OBS Studio's own config files — never OBS code (the Phase 0
// ADR boundary). Parsing is pure and fixture-tested; only the discovery
// entrypoints touch the filesystem. `.bak` twins are the corruption fallback.

export function obsRootPath(): string {
  return (
    process.env.VIDEORC_OBS_ROOT ?? join(homedir(), 'Library', 'Application Support', 'obs-studio')
  )
}

// --- INI ---------------------------------------------------------------

/** Minimal INI parser covering OBS's basic.ini/global.ini shape. */
export function parseIni(text: string): Record<string, Record<string, string>> {
  const sections: Record<string, Record<string, string>> = {}
  let current = ''
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#') || line.startsWith(';')) {
      continue
    }
    const section = /^\[(.+)\]$/.exec(line)
    if (section) {
      current = section[1]
      sections[current] ??= {}
      continue
    }
    const eq = line.indexOf('=')
    if (eq > 0) {
      ;(sections[current] ??= {})[line.slice(0, eq).trim()] = line.slice(eq + 1).trim()
    }
  }
  return sections
}

/** OBS FPSCommon strings → a Videorc-usable integer fps (report the rounding). */
export function parseObsFps(video: Record<string, string>): number {
  const type = video.FPSType ?? '0'
  if (type === '1' && video.FPSInt) {
    return Math.max(1, Math.round(Number(video.FPSInt)))
  }
  if (type === '2' && video.FPSNum && video.FPSDen) {
    const den = Number(video.FPSDen) || 1
    return Math.max(1, Math.round(Number(video.FPSNum) / den))
  }
  const common = (video.FPSCommon ?? '30').trim()
  // "24 NTSC" = 23.976, "29.97", "59.94" — round to the container int.
  const numeric = Number.parseFloat(common)
  if (Number.isFinite(numeric) && numeric > 0) {
    return Math.max(1, Math.round(numeric))
  }
  return 30
}

// --- Scene collection ----------------------------------------------------

interface RawObsSource {
  id?: string
  name?: string
  settings?: Record<string, unknown>
  volume?: number
  muted?: boolean
}

function classifySource(raw: RawObsSource): ObsSource | null {
  const obsKind = String(raw.id ?? '')
  const name = String(raw.name ?? '')
  if (!obsKind || !name || obsKind === 'scene' || obsKind === 'group') {
    return null
  }
  const settings = raw.settings ?? {}
  const mixer = {
    ...(typeof raw.volume === 'number' ? { volume: raw.volume } : {}),
    ...(raw.muted === true ? { muted: true } : {})
  }
  const str = (key: string): string | undefined => {
    const value = settings[key]
    return typeof value === 'string' && value ? value : undefined
  }

  if (obsKind === 'screen_capture') {
    // ScreenCaptureKit source: type 0 = display, 1 = window, 2 = application.
    const captureType = Number(settings.type ?? 0)
    if (captureType === 0) {
      return { name, kind: 'display', obsKind }
    }
    return {
      name,
      kind: captureType === 2 ? 'application' : 'window',
      obsKind,
      applicationHint: str('application') ?? str('window_name') ?? name
    }
  }
  if (obsKind === 'display_capture') {
    return { name, kind: 'display', obsKind }
  }
  if (obsKind === 'window_capture') {
    return { name, kind: 'window', obsKind, applicationHint: str('window_name') ?? name }
  }
  if (obsKind === 'av_capture_input') {
    // "AVCaptureSessionPreset3840x2160" carries the native capture dimensions.
    const preset = /Preset(\d+)x(\d+)/.exec(str('preset') ?? '')
    return {
      name,
      kind: 'camera',
      obsKind,
      deviceName: str('device_name'),
      ...(preset ? { presetWidth: Number(preset[1]), presetHeight: Number(preset[2]) } : {}),
      ...mixer
    }
  }
  if (obsKind === 'coreaudio_input_capture') {
    return { name, kind: 'microphone', obsKind, deviceName: str('device_name'), ...mixer }
  }
  if (obsKind === 'image_source') {
    return { name, kind: 'image', obsKind, filePath: str('file') }
  }
  if (obsKind === 'browser_source') {
    return { name, kind: 'browser', obsKind }
  }
  if (obsKind.startsWith('text_')) {
    return { name, kind: 'text', obsKind }
  }
  if (obsKind === 'ffmpeg_source' || obsKind === 'vlc_source') {
    return { name, kind: 'media', obsKind }
  }
  return { name, kind: 'other', obsKind }
}

function sceneItems(raw: RawObsSource): ObsSceneItem[] {
  const items = raw.settings?.items
  if (!Array.isArray(items)) {
    return []
  }
  return items.map((item) => {
    const record = item as Record<string, unknown>
    const point = (key: string, axis: 'x' | 'y'): number => {
      const value = record[key]
      const number =
        value && typeof value === 'object' ? (value as Record<string, unknown>)[axis] : undefined
      return typeof number === 'number' && Number.isFinite(number) ? number : 0
    }
    const num = (key: string, fallback = 0): number => {
      const value = record[key]
      return typeof value === 'number' && Number.isFinite(value) ? value : fallback
    }
    return {
      sourceName: String(record.name ?? ''),
      visible: record.visible !== false,
      x: point('pos', 'x'),
      y: point('pos', 'y'),
      scaleX: point('scale', 'x') || 1,
      scaleY: point('scale', 'y') || 1,
      boundsType: num('bounds_type'),
      boundsX: point('bounds', 'x'),
      boundsY: point('bounds', 'y'),
      cropLeft: num('crop_left'),
      cropTop: num('crop_top'),
      cropRight: num('crop_right'),
      cropBottom: num('crop_bottom')
    }
  })
}

export function parseSceneCollection(json: string): {
  name: string
  sources: ObsSource[]
  scenes: ObsScene[]
  globalMicDeviceName?: string
  hasDesktopAudio: boolean
} {
  const doc = JSON.parse(json) as Record<string, unknown>
  const rawSources = Array.isArray(doc.sources) ? (doc.sources as RawObsSource[]) : []
  const currentScene = String(doc.current_program_scene ?? doc.current_scene ?? '')

  const sources: ObsSource[] = []
  const scenes: ObsScene[] = []
  for (const raw of rawSources) {
    if (raw.id === 'scene') {
      scenes.push({
        name: String(raw.name ?? ''),
        current: String(raw.name ?? '') === currentScene,
        items: sceneItems(raw)
      })
      continue
    }
    const classified = classifySource(raw)
    if (classified) {
      sources.push(classified)
    }
  }

  const aux = doc.AuxAudioDevice1 as RawObsSource | undefined
  const auxDevice = aux?.settings?.device_id
  return {
    name: String(doc.name ?? 'OBS collection'),
    sources,
    scenes,
    globalMicDeviceName:
      typeof auxDevice === 'string' && auxDevice && auxDevice !== 'default'
        ? String(aux?.name ?? 'Mic/Aux')
        : undefined,
    hasDesktopAudio: Boolean(doc.DesktopAudioDevice1)
  }
}

export function parseService(json: string): (ObsStreamService & { key?: string }) | undefined {
  try {
    const doc = JSON.parse(json) as {
      type?: string
      settings?: { service?: string; server?: string; key?: string }
    }
    if (doc.type !== 'rtmp_common' && doc.type !== 'rtmp_custom') {
      return undefined
    }
    return {
      type: doc.type,
      service: doc.settings?.service,
      server: doc.settings?.server,
      hasKey: Boolean(doc.settings?.key),
      key: doc.settings?.key
    }
  } catch {
    return undefined
  }
}

// --- Filesystem discovery -------------------------------------------------

function pathInsideRoot(candidate: string, root: string): boolean {
  const rel = relative(resolve(root), resolve(candidate))
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

function readWithBakFallback(path: string, allowedRoot: string): string | null {
  for (const candidate of [path, `${path}.bak`]) {
    try {
      if (
        existsSync(candidate) &&
        !lstatSync(candidate).isSymbolicLink() &&
        pathInsideRoot(realpathSync(candidate), realpathSync(allowedRoot))
      ) {
        return readFileSync(candidate, 'utf8')
      }
    } catch {
      // fall through to the .bak twin
    }
  }
  return null
}

export function discoverObs(root = obsRootPath()): ObsDiscovery {
  const scenesDir = join(root, 'basic', 'scenes')
  const profilesDir = join(root, 'basic', 'profiles')
  if (!existsSync(scenesDir)) {
    return { available: false, collections: [], profiles: [] }
  }
  const collections = [
    ...new Set(
      readdirSync(scenesDir, { withFileTypes: true })
        .filter(
          (entry) =>
            entry.isFile() && (entry.name.endsWith('.json') || entry.name.endsWith('.json.bak'))
        )
        .map((entry) => entry.name.replace(/\.json(?:\.bak)?$/, ''))
    )
  ]
  const profiles = existsSync(profilesDir)
    ? readdirSync(profilesDir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
    : []
  const globalIni = parseIni(readWithBakFallback(join(root, 'global.ini'), root) ?? '')
  const userIni = parseIni(readWithBakFallback(join(root, 'user.ini'), root) ?? '')
  const basic = { ...globalIni.Basic, ...userIni.Basic }
  return {
    available: collections.length > 0,
    collections,
    profiles,
    currentCollection: basic?.SceneCollection ?? collections[0],
    currentProfile: basic?.Profile ?? profiles[0]
  }
}

/** Full read of one collection+profile. The stream KEY stays in this process:
 *  the returned setup carries hasKey only; `readObsStreamKey` hands the secret
 *  out exactly once, at apply time. */
export function readObsSetup(
  collection: string,
  profile: string,
  root = obsRootPath()
): ObsSetup | null {
  const discovery = discoverObs(root)
  if (!discovery.collections.includes(collection) || !discovery.profiles.includes(profile)) {
    return null
  }
  const scenesRoot = join(root, 'basic', 'scenes')
  const profilesRoot = join(root, 'basic', 'profiles')
  const profileRoot = join(profilesRoot, profile)
  const collectionJson = readWithBakFallback(join(scenesRoot, `${collection}.json`), scenesRoot)
  if (!collectionJson) {
    return null
  }
  const parsed = parseSceneCollection(collectionJson)
  const ini = parseIni(readWithBakFallback(join(profileRoot, 'basic.ini'), profileRoot) ?? '')
  const video = ini.Video ?? {}
  const service = parseService(
    readWithBakFallback(join(profileRoot, 'service.json'), profileRoot) ?? 'null'
  )
  const recordingPath =
    ini.SimpleOutput?.FilePath ?? ini.AdvOut?.RecFilePath ?? ini.Output?.RecFilePath

  return {
    collectionName: parsed.name,
    canvasWidth: Number(video.BaseCX ?? 1920) || 1920,
    canvasHeight: Number(video.BaseCY ?? 1080) || 1080,
    outputWidth: Number(video.OutputCX ?? video.BaseCX ?? 1920) || 1920,
    outputHeight: Number(video.OutputCY ?? video.BaseCY ?? 1080) || 1080,
    fps: parseObsFps(video),
    recordingPath,
    sources: parsed.sources,
    scenes: parsed.scenes,
    globalMicDeviceName: parsed.globalMicDeviceName,
    hasDesktopAudio: parsed.hasDesktopAudio,
    service: service
      ? {
          type: service.type,
          service: service.service,
          server: service.server,
          hasKey: service.hasKey
        }
      : undefined
  }
}

export function readObsStreamKey(profile: string, root = obsRootPath()): string | null {
  const discovery = discoverObs(root)
  if (!discovery.profiles.includes(profile)) {
    return null
  }
  const profileRoot = join(root, 'basic', 'profiles', profile)
  const service = parseService(
    readWithBakFallback(join(profileRoot, 'service.json'), profileRoot) ?? 'null'
  )
  return service?.key ?? null
}
