// Run the show, PR B (plan 209 S10, S11): the Studio tools an agent gets
// beyond a deck's keys. Each runs the Studio's own handler, the one the
// button, the switch or the picker runs, and refuses with the reason that
// control would show. Nothing here toasts; the D11 notice for `go_live` is
// the Studio's, from the catalog.

import { buildCameraSources, buildCaptureSources, buildMicrophoneSources } from '@/lib/capture'
import type { Device } from '@/lib/backend'
import { SYSTEM_AUDIO_GAIN_DB_MAX, SYSTEM_AUDIO_GAIN_DB_MIN } from '@/lib/backend'
import { destinationLabel } from '@/lib/platform-copy'
import { LIVE_BACKGROUND_CATALOG } from '../../../../shared/live-background-catalog'
import { isLiveBackgroundId } from '../../../../shared/live-background-ids'
import type { AgentToolExecutor } from './agent'
import { micMute, micUnmute, systemAudioOff, systemAudioOn } from './audio'
import type { StudioActionContext, StudioActionFields, StudioActionOutcome } from './context'
import { REMOTE_INTENT_COPY } from './copy'

/** What an agent reads when a Run the show tool refuses before any handler runs. */
export const RUN_THE_SHOW_COPY = {
  setAudioEmpty:
    'Say what to change: microphone (muted, gainDb, deviceId) or systemAudio (on, gainDb).',
  microphoneMissing: "That microphone isn't available. Use an id from list_sources.",
  setSourcesEmpty: 'Say what to change: screenId, windowId or cameraId.',
  screenOrWindow: 'Choose a screen or a window, not both.',
  screenMissing: "That screen isn't available. Use an id from list_sources.",
  windowMissing: "That window isn't available. Use an id from list_sources.",
  cameraMissing: "That camera isn't available. Use an id from list_sources.",
  captionsChanging: 'Live captions are changing. Try again in a moment.',
  backgroundMissing: "That live background isn't available. Use an id from list_assets.",
  backgroundFailed: "Couldn't change the background."
} as const

/** The microphone's Gain fader range (components/audio/gain-faders.tsx). */
export const MICROPHONE_GAIN_DB_RANGE = [-24, 24] as const
/** The System audio Gain fader range. */
export const SYSTEM_AUDIO_GAIN_DB_RANGE = [
  SYSTEM_AUDIO_GAIN_DB_MIN,
  SYSTEM_AUDIO_GAIN_DB_MAX
] as const

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function text(
  fields: StudioActionFields | Record<string, unknown>,
  key: string
): string | undefined {
  const value = fields[key]
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/** A fader value: whole dB inside the fader's range, as the renderer stores it. */
function gain(value: unknown, [min, max]: readonly [number, number]): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined
  return Math.min(max, Math.max(min, Math.round(value)))
}

/** "Choose …" refusals for the picker's own list, or the device. */
function pickable(
  devices: readonly Device[],
  id: string,
  missing: string
): { ok: true; device: Device } | { ok: false; message: string } {
  const device = devices.find((candidate) => candidate.id === id)
  if (!device) return { ok: false, message: missing }
  if (device.status !== 'available') {
    return { ok: false, message: `${device.name} isn't available right now.` }
  }
  return { ok: true, device }
}

function unsupported(): StudioActionOutcome {
  return { ok: false, message: REMOTE_INTENT_COPY.unsupported }
}

// --- go_live (S10, D13) -----------------------------------------------------

/** Go live without the dialog. The Studio runs the dialog's own preflight,
 * gate and confirm; a refusal is the dialog's own sentence. */
export const goLive: AgentToolExecutor = async (context, args) => {
  if (context.sessionActive) return { ok: false, message: REMOTE_INTENT_COPY.alreadyRunning }
  if (!context.goLive) return unsupported()
  const destinations = Array.isArray(args.destinations)
    ? args.destinations.filter((value): value is string => typeof value === 'string')
    : undefined
  const outcome = await context.goLive({
    destinations,
    title: text(args, 'title'),
    allowPartial: args.allowPartial === true,
    withoutCaptions: args.withoutCaptions === true
  })
  if (!outcome.ok) return outcome
  const live = outcome.destinations.map((destination) => ({
    ...destination,
    label: destinationLabel(destination.label)
  }))
  return {
    ok: true,
    message: `You're live on ${live.map((destination) => destination.label).join(', ')}.${
      outcome.recording ? ' Recording too.' : ''
    }`,
    result: { live: true, destinations: live, recording: outcome.recording }
  }
}

// --- set_audio (S6 + S11) ---------------------------------------------------

async function switchMicrophone(
  context: StudioActionContext,
  deviceId: string | null
): Promise<{ ok: true; name: string | null } | { ok: false; message: string }> {
  const picker = context.sourcePicker
  if (!picker || !context.switchSource)
    return { ok: false, message: REMOTE_INTENT_COPY.unsupported }
  let name: string | null = null
  if (deviceId !== null) {
    const found = pickable(picker.microphones, deviceId, RUN_THE_SHOW_COPY.microphoneMissing)
    if (!found.ok) return found
    name = found.device.name
  }
  const outcome = await context.switchSource(
    'microphone',
    buildMicrophoneSources(picker.sources, [...picker.microphones], deviceId ?? undefined)
  )
  return outcome.ok
    ? { ok: true, name }
    : { ok: false, message: outcome.message ?? REMOTE_INTENT_COPY.microphone }
}

/**
 * The microphone (`muted`, `gainDb`, `deviceId`) and System audio (`on`,
 * `gainDb`), each through the control the Studio shows for it: Mute, the
 * Gain faders, the microphone picker and the System audio switch. Changes
 * apply in that order; a refusal says what already changed.
 */
export const setAudio: AgentToolExecutor = async (context, args) => {
  const microphone = record(args.microphone)
  const systemAudio = record(args.systemAudio)
  const muted = typeof microphone?.muted === 'boolean' ? microphone.muted : undefined
  const microphoneGain = gain(microphone?.gainDb, MICROPHONE_GAIN_DB_RANGE)
  const deviceId =
    microphone && 'deviceId' in microphone
      ? typeof microphone.deviceId === 'string'
        ? microphone.deviceId
        : microphone.deviceId === null
          ? null
          : undefined
      : undefined
  const on = typeof systemAudio?.on === 'boolean' ? systemAudio.on : undefined
  const systemGain = gain(systemAudio?.gainDb, SYSTEM_AUDIO_GAIN_DB_RANGE)
  if (
    muted === undefined &&
    microphoneGain === undefined &&
    deviceId === undefined &&
    on === undefined &&
    systemGain === undefined
  ) {
    return { ok: false, message: RUN_THE_SHOW_COPY.setAudioEmpty }
  }
  const said: string[] = []
  const microphoneResult: Record<string, unknown> = {}
  const systemResult: Record<string, unknown> = {}
  const refuse = (message: string | undefined): StudioActionOutcome => ({
    ok: false,
    message: [...said, message ?? REMOTE_INTENT_COPY.failed].join(' ')
  })

  if (deviceId !== undefined) {
    const switched = await switchMicrophone(context, deviceId)
    if (!switched.ok) return refuse(switched.message)
    microphoneResult.deviceId = deviceId
    if (switched.name) microphoneResult.name = switched.name
    said.push(switched.name ? `The microphone is ${switched.name}.` : 'The microphone is off.')
  }
  if (muted !== undefined) {
    const outcome = await (muted ? micMute : micUnmute)(context, {})
    if (!outcome.ok) return refuse(outcome.message)
    microphoneResult.muted = muted
    said.push(muted ? 'The microphone is muted.' : 'The microphone is on.')
  }
  if (microphoneGain !== undefined) {
    if (!context.setAudioGain) return refuse(REMOTE_INTENT_COPY.unsupported)
    context.setAudioGain({ microphoneGainDb: microphoneGain })
    microphoneResult.gainDb = microphoneGain
    said.push(`Microphone gain is ${microphoneGain} dB.`)
  }
  if (on !== undefined) {
    const outcome = await (on ? systemAudioOn : systemAudioOff)(context, {})
    if (!outcome.ok) return refuse(outcome.message)
    systemResult.on = on
    said.push(on ? 'System audio is on.' : 'System audio is off.')
  }
  if (systemGain !== undefined) {
    // The fader is off while System audio can't be heard at all.
    if (context.systemAudio[0] !== 'available') return refuse(REMOTE_INTENT_COPY.systemAudio)
    if (!context.setAudioGain) return refuse(REMOTE_INTENT_COPY.unsupported)
    context.setAudioGain({ systemAudioGainDb: systemGain })
    systemResult.gainDb = systemGain
    said.push(`System audio gain is ${systemGain} dB.`)
  }
  const result: Record<string, unknown> = {}
  if (Object.keys(microphoneResult).length) result.microphone = microphoneResult
  if (Object.keys(systemResult).length) result.systemAudio = systemResult
  return { ok: true, message: said.join(' '), result }
}

// --- set_sources (S11) ------------------------------------------------------

/**
 * The screen, window or camera, through the Sources tab's own switch: idle
 * it saves the pick, while recording or live it is the live source switch.
 */
export const setSources: AgentToolExecutor = async (context, args) => {
  const picker = context.sourcePicker
  if (!picker || !context.switchSource) return unsupported()
  const screenId = text(args, 'screenId')
  const windowId = text(args, 'windowId')
  const cameraId =
    'cameraId' in args
      ? typeof args.cameraId === 'string'
        ? args.cameraId
        : args.cameraId === null
          ? null
          : undefined
      : undefined
  if (screenId && windowId) return { ok: false, message: RUN_THE_SHOW_COPY.screenOrWindow }
  if (!screenId && !windowId && cameraId === undefined) {
    return { ok: false, message: RUN_THE_SHOW_COPY.setSourcesEmpty }
  }
  const said: string[] = []
  const result: Record<string, unknown> = {}
  const captureId = screenId ?? windowId
  if (captureId) {
    const kind = screenId ? 'screen' : 'window'
    const found = pickable(
      picker.capture.filter((device) => device.kind === kind),
      captureId,
      kind === 'screen' ? RUN_THE_SHOW_COPY.screenMissing : RUN_THE_SHOW_COPY.windowMissing
    )
    if (!found.ok) return found
    const outcome = await context.switchSource(
      'capture',
      buildCaptureSources(picker.sources, [...picker.capture], captureId)
    )
    if (!outcome.ok) return outcome
    result[kind] = { id: captureId, name: found.device.name }
    said.push(`The ${kind} is ${found.device.name}.`)
  }
  if (cameraId !== undefined) {
    let name: string | null = null
    if (cameraId !== null) {
      const found = pickable(picker.cameras, cameraId, RUN_THE_SHOW_COPY.cameraMissing)
      if (!found.ok) return { ok: false, message: [...said, found.message].join(' ') }
      name = found.device.name
    }
    const outcome = await context.switchSource(
      'camera',
      buildCameraSources(picker.sources, [...picker.cameras], cameraId ?? undefined)
    )
    if (!outcome.ok) {
      return { ok: false, message: [...said, outcome.message].filter(Boolean).join(' ') }
    }
    result.camera = cameraId === null ? null : { id: cameraId, name }
    said.push(name ? `The camera is ${name}.` : 'The camera is off.')
  }
  return { ok: true, message: said.join(' '), result }
}

// --- set_captions (S11) -----------------------------------------------------

/** The Live captions switch: on needs what the switch needs (Premium, a
 * platform that can caption); off is always allowed. */
export const setCaptions: AgentToolExecutor = async (context, args) => {
  const captions = context.captions
  if (!captions) return unsupported()
  const on = args.on === true
  const message = on ? 'Live captions are on.' : 'Live captions are off.'
  if (on === captions.enabled) return { ok: true, message, result: { on } }
  if (captions.pending) return { ok: false, message: RUN_THE_SHOW_COPY.captionsChanging }
  if (on && captions.blockedReason) return { ok: false, message: captions.blockedReason }
  captions.set(on)
  return { ok: true, message, result: { on } }
}

// --- set_background (S11) ---------------------------------------------------

/** Assets → Backgrounds: a live background on the scene (its tile), or no
 * background at all (the active tile again, or None). */
export const setBackground: AgentToolExecutor = async (context, args) => {
  const background = context.background
  if (!background) return unsupported()
  const liveId = args.liveId
  if (liveId === null) {
    if (!background.liveId && !background.picture) {
      return { ok: true, message: 'There is no background.', result: { liveId: null } }
    }
    return (await background.apply(null))
      ? { ok: true, message: 'The background is off.', result: { liveId: null } }
      : { ok: false, message: RUN_THE_SHOW_COPY.backgroundFailed }
  }
  if (!isLiveBackgroundId(liveId))
    return { ok: false, message: RUN_THE_SHOW_COPY.backgroundMissing }
  const name = LIVE_BACKGROUND_CATALOG.find((entry) => entry.id === liveId)?.name ?? liveId
  if (background.liveId === liveId) {
    return { ok: true, message: `${name} is on the scene.`, result: { liveId, name } }
  }
  return (await background.apply(liveId))
    ? { ok: true, message: `${name} is on the scene.`, result: { liveId, name } }
    : { ok: false, message: RUN_THE_SHOW_COPY.backgroundFailed }
}
