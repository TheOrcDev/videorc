import { isLoopbackRtmp } from './launch.mjs'
import { LAB_MIC_SOURCE } from './linux-desktop.mjs'
import { isLinux } from './platform.mjs'

// Plan 178 U6 (plan 176 L2 step 1). Seeds the lab profile before every run,
// through the app's own surfaces so nothing depends on private file formats:
//
// 1. `devices.list` (backend, renderer socket): the lab display must be a
//    screen source and BlackHole a microphone. Neither found is a refusal:
//    capturing anything but the lab display, or a room mic, is a STOP
//    condition of plan 178.
// 2. `streamTargets.manualKey.store` (backend): each stream key goes into the
//    app's secrets store (VIDEORC_SECRETS_PATH under the lab profile). The
//    key travels only as an RPC parameter over loopback; it is never put in
//    localStorage, the environment, argv or a log.
// 3. `remote.control.enable` (backend): the remote surface and its discovery file.
// 4. The renderer's saved Studio config (localStorage `videorc.captureConfig`,
//    written over CDP, then a reload): lab display as Screen, camera off,
//    BlackHole as mic, screen-only scene, stream on, record off, captions off,
//    and only the seeded destinations enabled. The renderer normalizes the
//    config on load (lib/capture.ts loadCaptureConfig), and seeding is checked
//    by reading it back after the reload.

export const CAPTURE_CONFIG_KEY = 'videorc.captureConfig'
export const ONBOARDING_KEY = 'videorc.onboardingComplete'
export const ONBOARDING_DISMISSED_VALUE = 'permissions-v1'
export const YOUTUBE_RTMPS_URL = 'rtmps://a.rtmps.youtube.com:443/live2'
export const LAB_SCENE = 'screen-only'
const MIC_NAME = /blackhole/i
// Plan 179: Linux lists exactly one screen row, the ScreenCast portal (the
// output it captures is the lab share picker's answer, see session.mjs), and
// names microphones by Pulse description with the source name in `detail`.
export const LINUX_PORTAL_SCREEN_ID = 'screen:portal:monitor'
const LINUX_LAB_MIC_DETAIL = new RegExp(`^PulseAudio/PipeWire source ${LAB_MIC_SOURCE}(?:\\s|$)`)

export const TARGET_SLOTS = Object.freeze({
  horizontal: { id: 'youtube', platform: 'youtube', defaultLabel: 'Videorc lab' },
  vertical: { id: 'youtube-vertical', platform: 'youtube', defaultLabel: 'Videorc lab vertical' }
})

export class SeedRefused extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'SeedRefused'
    this.code = code
  }
}

/** Picks the lab display and BlackHole from `devices.list` (pure). */
export function pickLabDevices(deviceList, labDisplayName) {
  const devices = Array.isArray(deviceList?.devices) ? deviceList.devices : []
  if (typeof labDisplayName !== 'string' || !labDisplayName.trim()) {
    throw new SeedRefused(
      'no-lab-display',
      'No lab display is configured (pnpm live:hookup --lab-display "<name>").'
    )
  }
  const wanted = labDisplayName.trim().toLowerCase()
  const screens = devices.filter((device) => device.kind === 'screen')
  const screen = screens.find((device) => String(device.name).trim().toLowerCase() === wanted)
  if (!screen) {
    throw new SeedRefused(
      'lab-display-missing',
      `Videorc does not list the lab display "${labDisplayName}" as a screen (it lists ${screens.length} screen(s)).`
    )
  }
  if (screen.status !== 'available') {
    throw new SeedRefused(
      'lab-display-unavailable',
      `The lab display is ${screen.status} in Videorc (Screen Recording grant?).`
    )
  }
  const microphone = devices.find(
    (device) => device.kind === 'microphone' && MIC_NAME.test(device.name)
  )
  if (!microphone) {
    throw new SeedRefused(
      'blackhole-missing',
      'BlackHole 2ch is not listed as a microphone; the lab never streams a room mic.'
    )
  }
  if (microphone.status !== 'available') {
    throw new SeedRefused(
      'blackhole-unavailable',
      `BlackHole is ${microphone.status} in Videorc (Microphone grant?).`
    )
  }
  return {
    screen: { id: screen.id, name: screen.name },
    microphone: { id: microphone.id, name: microphone.name }
  }
}

/**
 * Plan 179: the Linux twin of pickLabDevices (pure). The screen is the
 * portal source; the mic is the lab's remap source (videorc_lab_mic), never
 * a room mic.
 */
export function pickLinuxLabDevices(deviceList) {
  const devices = Array.isArray(deviceList?.devices) ? deviceList.devices : []
  const screens = devices.filter((device) => device.kind === 'screen')
  const screen = screens.find((device) => device.id === LINUX_PORTAL_SCREEN_ID)
  if (!screen) {
    throw new SeedRefused(
      'lab-display-missing',
      `Videorc lists no ScreenCast portal source (it lists ${screens.length} screen(s)).`
    )
  }
  if (screen.status !== 'available') {
    throw new SeedRefused(
      'lab-display-unavailable',
      `The portal screen source is ${screen.status} in Videorc${screen.detail ? `: ${screen.detail}` : ''}.`
    )
  }
  const microphone = devices.find(
    (device) =>
      device.kind === 'microphone' && LINUX_LAB_MIC_DETAIL.test(String(device.detail ?? ''))
  )
  if (!microphone) {
    throw new SeedRefused(
      'lab-mic-missing',
      `${LAB_MIC_SOURCE} is not listed as a microphone; the lab never streams a room mic.`
    )
  }
  if (microphone.status !== 'available') {
    throw new SeedRefused(
      'lab-mic-unavailable',
      `${LAB_MIC_SOURCE} is ${microphone.status} in Videorc.`
    )
  }
  return {
    screen: { id: screen.id, name: screen.name },
    microphone: { id: microphone.id, name: microphone.name }
  }
}

/**
 * What each seeded destination streams to (pure). Local-sink runs point the
 * horizontal YouTube card at the loopback sink and nothing else; YouTube runs
 * use the configured persistent keys.
 */
export function plannedTargets({ scenario, config, sink, titlePrefix }) {
  if (scenario.destination === 'local-sink') {
    if (!sink || !isLoopbackRtmp(sink.serverUrl)) {
      throw new SeedRefused(
        'sink-not-loopback',
        'A local-sink scenario needs a loopback RTMP sink.'
      )
    }
    return [
      {
        ...TARGET_SLOTS.horizontal,
        label: `${titlePrefix} sink`,
        serverUrl: sink.serverUrl,
        streamKey: sink.streamKey
      }
    ]
  }
  return scenario.orientations.map((slot) => {
    const entry = config?.streamKeys?.[slot]
    if (typeof entry?.key !== 'string' || entry.key.length < 16) {
      throw new SeedRefused(
        'stream-key-missing',
        `No ${slot} stream key is configured (pnpm live:hookup --stream-key ${slot}).`
      )
    }
    return {
      ...TARGET_SLOTS[slot],
      label: entry.label ?? TARGET_SLOTS[slot].defaultLabel,
      serverUrl: YOUTUBE_RTMPS_URL,
      streamKey: entry.key
    }
  })
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/**
 * The Studio config to save (pure). `existing` is the parsed saved config (or
 * null), `stored` maps target id to the manualKey.store result. The raw key
 * is never part of the result: streamKey is always ''.
 */
export function buildCaptureConfig({ existing, devices, targets, stored, now = new Date() }) {
  const base = isObject(existing) ? existing : {}
  const at = now.toISOString()
  const seededIds = targets.map((target) => target.id)
  const previousTargets = Array.isArray(base.streaming?.targets) ? base.streaming.targets : []
  const kept = previousTargets
    .filter((target) => isObject(target) && !seededIds.includes(target.id))
    .map((target) => ({ ...target, enabled: false }))
  const seeded = targets.map((target) => {
    const result = stored[target.id]
    if (!result?.streamKeyPresent || typeof result.streamKeySecretRef !== 'string') {
      throw new SeedRefused(
        'key-not-stored',
        `The app did not confirm the ${target.id} stream key.`
      )
    }
    const previous = previousTargets.find((entry) => entry?.id === target.id) ?? {}
    return {
      ...(isObject(previous) ? previous : {}),
      id: target.id,
      platform: target.platform,
      label: target.label,
      enabled: true,
      serverUrl: target.serverUrl,
      urlMode: 'server-and-key',
      streamKey: '',
      streamKeySecretRef: result.streamKeySecretRef,
      streamKeyPresent: true,
      streamKeyHint: result.streamKeyHint,
      authMode: 'manual-rtmp',
      accountId: undefined,
      accountLabel: undefined,
      scheduledEventId: undefined,
      ...(target.id === TARGET_SLOTS.vertical.id ? { outputOrientation: 'vertical' } : {}),
      createdAt: typeof previous.createdAt === 'string' ? previous.createdAt : at,
      updatedAt: at
    }
  })
  return {
    ...base,
    sources: {
      screenId: devices.screen.id,
      screenName: devices.screen.name,
      cameraOff: true,
      microphoneId: devices.microphone.id,
      microphoneName: devices.microphone.name,
      testPattern: false
    },
    layout: {
      ...(isObject(base.layout) ? base.layout : {}),
      layoutPreset: LAB_SCENE,
      arrangementMode: 'preset'
    },
    streamEnabled: true,
    recordEnabled: false,
    captions: { ...(isObject(base.captions) ? base.captions : {}), enabled: false },
    streaming: {
      ...(isObject(base.streaming) ? base.streaming : {}),
      enabled: true,
      mode: seeded.length > 1 ? 'multi' : 'single',
      targets: [...seeded, ...kept],
      selectedTargetId: seeded[0].id,
      enabledTargetIds: seededIds
    }
  }
}

/**
 * Checks the config the renderer saved after the reload (pure). Returns a
 * list of problems; empty means the seed took. For local-sink runs every
 * enabled destination must be the loopback sink.
 */
export function verifySeededConfig(saved, { targets, devices, scenario }) {
  const problems = []
  if (!isObject(saved)) return ['the renderer has no saved Studio config']
  if (saved.sources?.screenId !== devices.screen.id)
    problems.push('screen source is not the lab display')
  if (saved.sources?.microphoneId !== devices.microphone.id)
    problems.push(`microphone is not the lab mic (${devices.microphone.name})`)
  if (saved.sources?.cameraId) problems.push('a camera is selected')
  if (saved.streamEnabled !== true) problems.push('streaming is off')
  const enabled = (saved.streaming?.targets ?? []).filter((target) => target?.enabled)
  const enabledIds = enabled.map((target) => target.id).sort()
  const wantedIds = targets.map((target) => target.id).sort()
  if (JSON.stringify(enabledIds) !== JSON.stringify(wantedIds)) {
    problems.push(
      `enabled destinations are [${enabledIds.join(', ')}], expected [${wantedIds.join(', ')}]`
    )
  }
  for (const target of enabled) {
    if (target.streamKey) problems.push(`${target.id} has a raw key in the saved config`)
    if (scenario.destination === 'local-sink' && !isLoopbackRtmp(target.serverUrl)) {
      problems.push(`${target.id} is not the loopback sink`)
    }
  }
  return problems
}

/**
 * Runs the seed against a live app. `rpc(method, params)` is the renderer
 * backend socket; `evaluate(expression)` runs in the main renderer and
 * `reloadAndWait()` reloads it and resolves once it is back.
 */
export async function seedProfile({
  rpc,
  evaluate,
  reloadAndWait,
  scenario,
  config,
  sink,
  titlePrefix,
  platform = process.platform,
  log = () => {}
}) {
  const listed = await rpc('devices.list')
  const devices = isLinux(platform)
    ? pickLinuxLabDevices(listed)
    : pickLabDevices(listed, config?.labDisplay?.name)
  const targets = plannedTargets({ scenario, config, sink, titlePrefix })
  const stored = {}
  for (const target of targets) {
    stored[target.id] = await rpc('streamTargets.manualKey.store', {
      targetId: target.id,
      streamKey: target.streamKey
    })
  }
  log(`Seed: stored ${targets.length} stream key(s) in the lab profile's secrets store.`)
  const remote = await rpc('remote.control.enable')
  if (!remote?.enabled || !Number.isInteger(remote?.port) || typeof remote?.token !== 'string') {
    throw new SeedRefused(
      'remote-control',
      'remote.control.enable did not enable the remote surface.'
    )
  }
  const existingText = await evaluate(`localStorage.getItem(${JSON.stringify(CAPTURE_CONFIG_KEY)})`)
  let existing = null
  try {
    existing = existingText ? JSON.parse(existingText) : null
  } catch {
    existing = null
  }
  const next = buildCaptureConfig({ existing, devices, targets, stored })
  await evaluate(
    `(() => { localStorage.setItem(${JSON.stringify(CAPTURE_CONFIG_KEY)}, ${JSON.stringify(JSON.stringify(next))}); localStorage.setItem(${JSON.stringify(ONBOARDING_KEY)}, ${JSON.stringify(ONBOARDING_DISMISSED_VALUE)}); return true })()`
  )
  await reloadAndWait()
  const savedText = await evaluate(`localStorage.getItem(${JSON.stringify(CAPTURE_CONFIG_KEY)})`)
  let saved = null
  try {
    saved = JSON.parse(savedText)
  } catch {
    saved = null
  }
  const problems = verifySeededConfig(saved, { targets, devices, scenario })
  if (problems.length) {
    throw new SeedRefused(
      'seed-not-applied',
      `The lab profile seed did not take: ${problems.join('; ')}.`
    )
  }
  log(
    `Seed: lab display, ${devices.microphone.name} and ${targets.map((target) => target.id).join(', ')} are set.`
  )
  return {
    devices: { screen: devices.screen.name, microphone: devices.microphone.name },
    targetIds: targets.map((target) => target.id),
    // The remote socket's pairing; never written to the run folder.
    remote: { host: '127.0.0.1', port: remote.port, token: remote.token }
  }
}
