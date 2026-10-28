// `get_settings` and `update_settings` (plan 209 S14, D16): the curated
// settings an agent may read and change, and nothing else. The list is the
// catalog's `update_settings` input schema; the backend refuses any other
// name before the call reaches the Studio, and this executor refuses it
// again. Never accounts, keys, permissions, Remote, Agents, updates,
// diagnostics or billing.
//
// Every change goes through its own control's setter, with that control's
// locks and gates: Output's size and rate wait while a session runs and for
// "Save a local recording", and pass the same entitlement gate; separate
// source recordings work on a Mac only; the captions language waits while a
// session runs. The recordings folder is chosen in a folder picker, so an
// agent can only put it back to the default.

import {
  layoutPresetOrientation,
  resolutionOptionsForOrientation,
  separateSourceRecordingsIneligibilityCopy,
  separateSourceRecordingsSupported
} from '@/lib/capture'
import { CAPTION_LANGUAGES } from '@/lib/caption-languages'
import { videoProfileEntitlementGate } from '@/lib/entitlement-ui'
import { SESSION_LOCK_REASON } from '@/lib/lock-view'
import { pickRecordingResolution } from '@/lib/output-quality'
import type { VideoSettings } from '../../../../shared/backend'
import type { AgentToolExecutor } from './agent'
import type { StudioSettingsAccess } from './context'

/** D16: every name `update_settings` takes. Its schema in the catalog lists
 * the same, and a test holds the two together. */
export const CURATED_SETTINGS = [
  'resolution',
  'frameRate',
  'keepOriginalRecording',
  'recordingFolder',
  'separateSourceRecordings',
  'clips',
  'captionsLanguage',
  'chatInStudio',
  'theme'
] as const
export type CuratedSetting = (typeof CURATED_SETTINGS)[number]

const THEMES = ['light', 'dark', 'system'] as const
const FRAME_RATE = { min: 24, max: 60 } as const

export const SETTINGS_TOOL_COPY = {
  unavailable: "Settings aren't available in this Studio.",
  empty: 'Say which settings to change.',
  recordOff:
    'Turn on Save a local recording in Videorc → Output first: the size and rate are the recording file’s.',
  folderPicker:
    'Only "default" is accepted: choose another recordings folder in Videorc → Output → Choose….',
  notCurated: (name: string) =>
    `"${name}" isn't a setting agents can change. get_settings lists the ones they can.`
} as const

/** The curated settings as they stand. */
export function curatedSettings(access: StudioSettingsAccess): Record<CuratedSetting, unknown> {
  const { video } = access.captureConfig
  const orientation = layoutPresetOrientation(access.captureConfig.layout.layoutPreset)
  const named = resolutionOptionsForOrientation(orientation).find(
    (option) => option.width === video.width && option.height === video.height
  )
  const folder = access.settings.outputDirectory.trim()
  const theme = THEMES.find((value) => value === access.theme) ?? 'system'
  return {
    resolution: named ? named.label : `${video.width}x${video.height}`,
    frameRate: video.fps,
    keepOriginalRecording: access.settings.keepOriginalRecording,
    recordingFolder: folder ? folder : 'default',
    separateSourceRecordings:
      separateSourceRecordingsSupported(access.platform) &&
      access.captureConfig.separateSourceRecordings.enabled,
    clips: access.captureConfig.replayBuffer.enabled,
    captionsLanguage: access.captureConfig.captions.language,
    chatInStudio: access.settings.studioChat === true,
    theme
  }
}

export const getSettings: AgentToolExecutor = async (context) => {
  const access = context.settings
  if (!access) return { ok: false, message: SETTINGS_TOOL_COPY.unavailable }
  return {
    ok: true,
    message: 'The settings agents can change, as they stand.',
    result: curatedSettings(access)
  }
}

type Plan = { refusal: string } | { apply: () => void; said: string[] }

/** Check every asked change against its control's locks and gates, then
 * hand back one apply step, so a refusal changes nothing. Pure. */
export function planSettingsUpdate(
  access: StudioSettingsAccess,
  sessionActive: boolean,
  args: Readonly<Record<string, unknown>>
): Plan {
  const names = Object.keys(args)
  if (names.length === 0) return { refusal: SETTINGS_TOOL_COPY.empty }
  for (const name of names) {
    if (!(CURATED_SETTINGS as readonly string[]).includes(name)) {
      return { refusal: SETTINGS_TOOL_COPY.notCurated(name) }
    }
  }
  const steps: (() => void)[] = []
  const said: string[] = []
  const { captureConfig } = access
  const orientation = layoutPresetOrientation(captureConfig.layout.layoutPreset)

  // Output's size and rate: the recording file's, so they wait for the
  // switch and for the session, like the fields.
  if ('resolution' in args || 'frameRate' in args) {
    if (sessionActive) return { refusal: SESSION_LOCK_REASON }
    if (!captureConfig.recordEnabled) return { refusal: SETTINGS_TOOL_COPY.recordOff }
    let video: VideoSettings = { ...captureConfig.video }
    if ('resolution' in args) {
      const option = resolutionOptionsForOrientation(orientation).find(
        (candidate) => candidate.label === args.resolution
      )
      if (!option) return { refusal: 'resolution must be 720p, 1080p, 1440p or 4K.' }
      video = pickRecordingResolution(video, option.width, option.height)
      said.push(`Resolution ${option.label}.`)
    }
    if ('frameRate' in args) {
      const fps = args.frameRate
      if (
        typeof fps !== 'number' ||
        !Number.isInteger(fps) ||
        fps < FRAME_RATE.min ||
        fps > FRAME_RATE.max
      ) {
        return {
          refusal: `frameRate must be a whole number from ${FRAME_RATE.min} to ${FRAME_RATE.max}.`
        }
      }
      video = { ...video, fps }
      said.push(`${fps} fps.`)
    }
    const gate = videoProfileEntitlementGate({
      entitlements: access.entitlements,
      kind: 'recording',
      video
    })
    if (!gate.allowed) return { refusal: gate.reason }
    const patch = {
      width: video.width,
      height: video.height,
      fps: video.fps,
      bitrateKbps: video.bitrateKbps
    }
    steps.push(() => access.patchVideo(patch))
  }

  if ('separateSourceRecordings' in args) {
    const on = args.separateSourceRecordings
    if (typeof on !== 'boolean')
      return { refusal: 'separateSourceRecordings must be true or false.' }
    if (on && !separateSourceRecordingsSupported(access.platform)) {
      return { refusal: separateSourceRecordingsIneligibilityCopy('unsupported-platform') }
    }
    if (sessionActive) return { refusal: SESSION_LOCK_REASON }
    if (!captureConfig.recordEnabled) return { refusal: SETTINGS_TOOL_COPY.recordOff }
    steps.push(() =>
      access.setCaptureConfig((current) => ({
        ...current,
        separateSourceRecordings: { ...current.separateSourceRecordings, enabled: on }
      }))
    )
    said.push(on ? 'Separate source recordings on.' : 'Separate source recordings off.')
  }

  if ('captionsLanguage' in args) {
    const language = CAPTION_LANGUAGES.find((candidate) => candidate.id === args.captionsLanguage)
    if (!language) {
      return {
        refusal: `captionsLanguage must be one of ${CAPTION_LANGUAGES.map((entry) => entry.id).join(', ')}.`
      }
    }
    if (sessionActive) return { refusal: SESSION_LOCK_REASON }
    steps.push(() =>
      access.setCaptureConfig((current) =>
        current.captions.language === language.id
          ? current
          : { ...current, captions: { ...current.captions, language: language.id } }
      )
    )
    said.push(`Captions language: ${language.label}.`)
  }

  if ('recordingFolder' in args) {
    if (args.recordingFolder !== 'default') return { refusal: SETTINGS_TOOL_COPY.folderPicker }
    steps.push(() =>
      access.setSettings((current) => ({
        ...current,
        outputDirectory: '',
        outputDirectoryHandle: undefined
      }))
    )
    said.push("Recordings go to Videorc's default folder.")
  }

  for (const [name, label] of [
    ['keepOriginalRecording', 'Keep original recording'],
    ['clips', 'Clips'],
    ['chatInStudio', 'Chat in Studio']
  ] as const) {
    if (!(name in args)) continue
    const on = args[name]
    if (typeof on !== 'boolean') return { refusal: `${name} must be true or false.` }
    if (name === 'clips') steps.push(() => access.setClipsEnabled(on))
    else if (name === 'keepOriginalRecording') {
      steps.push(() => access.setSettings((current) => ({ ...current, keepOriginalRecording: on })))
    } else steps.push(() => access.setSettings((current) => ({ ...current, studioChat: on })))
    said.push(`${label} ${on ? 'on' : 'off'}.`)
  }

  if ('theme' in args) {
    const theme = THEMES.find((value) => value === args.theme)
    if (!theme) return { refusal: 'theme must be light, dark or system.' }
    steps.push(() => access.setTheme(theme))
    said.push(`Theme: ${theme}.`)
  }

  return { apply: () => steps.forEach((step) => step()), said }
}

export const updateSettings: AgentToolExecutor = async (context, args) => {
  const access = context.settings
  if (!access) return { ok: false, message: SETTINGS_TOOL_COPY.unavailable }
  const plan = planSettingsUpdate(access, context.sessionActive, args)
  if ('refusal' in plan) return { ok: false, message: plan.refusal }
  plan.apply()
  // Every value was checked above, so the asked values are the new ones.
  return { ok: true, message: plan.said.join(' '), result: { changed: { ...args } } }
}
