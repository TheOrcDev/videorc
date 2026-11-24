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
// 4. The renderer's saved Studio (the UI settings store since plan 260 S1.4b,
//    written over CDP through `window.__videorcUiSettings`, then a
//    reload): lab display as Screen, camera off, BlackHole as mic, the
//    screen-only scene on stream, stream on, record off, captions off, and
//    only the seeded destinations enabled. Since scenes v2 the Studio starts
//    from its working scene (`videorc.working-scene.v1`, use-studio.tsx's
//    storedCaptureConfig), which overrides `videorc.captureConfig`'s sources
//    and layout, and from the scene on stream (`videorc.scenes.v2`
//    onStreamId). So all three are written as one: a profile whose working
//    scene kept a camera ("Screen + camera", a new profile's first scene)
//    otherwise put it back over the seed seconds after the reload.
//    Seeding is checked against what the app does, not what was written:
//    the backend's scene (`scene.get`) must show no camera, and the config
//    the renderer saved after the reload must match.

export const CAPTURE_CONFIG_KEY = 'videorc.captureConfig'
export const WORKING_SCENE_KEY = 'videorc.working-scene.v1'
export const SCENES_KEY = 'videorc.scenes.v2'
export const ONBOARDING_KEY = 'videorc.onboardingComplete'
export const ONBOARDING_DISMISSED_VALUE = 'permissions-v1'
export const YOUTUBE_RTMPS_URL = 'rtmps://a.rtmps.youtube.com:443/live2'
export const LAB_SCENE = 'screen-only'
export const SEED_SETTLE_DEADLINE_MS = 20_000
const SEED_SETTLE_POLL_MS = 250
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
  // Plan 213 F1: macOS displays are listed as "<name> · <width> × <height>".
  const screen = screens.find((device) => {
    const name = String(device.name).trim().toLowerCase()
    return name === wanted || name.startsWith(`${wanted} · `)
  })
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
export function buildCaptureConfig({
  existing,
  devices,
  targets,
  stored,
  layout = null,
  now = new Date()
}) {
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
      ...(isObject(layout) ? layout : {}),
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

/** The scenes v2 scene the lab streams (pure): the first whose 16:9 layout is Screen only. */
export function labSceneOf(library) {
  const scenes = Array.isArray(library?.scenes) ? library.scenes : []
  return (
    scenes.find(
      (scene) =>
        isObject(scene) &&
        typeof scene.id === 'string' &&
        scene.layouts?.horizontal?.layoutPreset === LAB_SCENE &&
        scene.layouts.horizontal.arrangementMode !== 'freeform'
    ) ?? null
  )
}

/**
 * The working scene and scene library to save with the capture config (pure).
 * The Studio starts from the working scene and the scene on stream, so both
 * must say what the capture config says: the lab display, no camera, the
 * screen-only scene on stream. `library` is the parsed `videorc.scenes.v2`
 * (null before the app made one); `library: null` in the result means it is
 * left as it is. A library without a Screen only scene is a refusal: the
 * harness never streams a look it did not pick.
 */
export function buildWorkingScene({ existingWorking, library, devices }) {
  const hasLibrary = isObject(library) && Array.isArray(library.scenes)
  const scene = hasLibrary ? labSceneOf(library) : null
  if (hasLibrary && !scene) {
    throw new SeedRefused(
      'no-lab-scene',
      'The lab profile has no "Screen only" scene to put on stream.'
    )
  }
  const previous = isObject(existingWorking?.visual) ? existingWorking.visual : {}
  const layout = {
    ...(isObject(previous.layout) ? previous.layout : {}),
    ...(isObject(scene?.layouts?.horizontal) ? scene.layouts.horizontal : {}),
    layoutPreset: LAB_SCENE,
    arrangementMode: 'preset'
  }
  return {
    working: {
      version: 1,
      origin: scene ? 'saved' : 'builtin',
      sceneId: scene?.id ?? null,
      visual: {
        layout,
        // No cameraId: the camera stays off whatever the scene's layout.
        sources: {
          screenId: devices.screen.id,
          screenName: devices.screen.name,
          cameraOff: true,
          captureOff: false,
          testPattern: false
        },
        background: scene ? (scene.background ?? null) : (previous.background ?? null)
      }
    },
    library: scene ? { ...library, onStreamId: scene.id } : null
  }
}

/**
 * Checks the config the renderer saved after the reload (pure). Returns a
 * list of problems; empty means the seed took. For local-sink runs every
 * enabled destination must be the loopback sink.
 */
export function verifySeededConfig(
  saved,
  { targets, devices, scenario, working, sceneSources, onStreamId, labSceneId }
) {
  const problems = []
  if (!isObject(saved)) return ['the renderer has no saved Studio config']
  if (saved.sources?.screenId !== devices.screen.id)
    problems.push('screen source is not the lab display')
  if (saved.sources?.microphoneId !== devices.microphone.id)
    problems.push(`microphone is not the lab mic (${devices.microphone.name})`)
  if (saved.sources?.cameraId) problems.push('a camera is selected')
  if (saved.layout?.layoutPreset !== LAB_SCENE)
    problems.push(`the layout is ${saved.layout?.layoutPreset ?? 'unset'}, not ${LAB_SCENE}`)
  if (working !== undefined) {
    const visual = working?.visual
    if (!isObject(visual)) problems.push('the Studio has no working scene')
    else {
      if (visual.sources?.cameraId || visual.sources?.cameraOff !== true)
        problems.push('the working scene keeps a camera')
      if (visual.layout?.layoutPreset !== LAB_SCENE)
        problems.push(`the working scene's layout is ${visual.layout?.layoutPreset ?? 'unset'}`)
    }
  }
  if (labSceneId && onStreamId !== labSceneId)
    problems.push(`the scene on stream is ${onStreamId ?? 'none'}, not ${labSceneId}`)
  if (sceneSources !== undefined) {
    if (!Array.isArray(sceneSources)) problems.push('the backend has no scene')
    else if (sceneSources.some((source) => source?.kind === 'camera'))
      problems.push("the backend's scene shows a camera")
  }
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
  log = () => {},
  settleDeadlineMs = SEED_SETTLE_DEADLINE_MS,
  now = Date.now,
  sleep = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms))
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
  const readKey = async (key) => {
    try {
      const text = await evaluate(`window.__videorcUiSettings?.getItem(${JSON.stringify(key)})`)
      return text ? JSON.parse(text) : null
    } catch {
      return null
    }
  }
  const { working, library } = buildWorkingScene({
    existingWorking: await readKey(WORKING_SCENE_KEY),
    library: await readKey(SCENES_KEY),
    devices
  })
  const next = buildCaptureConfig({
    existing: await readKey(CAPTURE_CONFIG_KEY),
    devices,
    targets,
    stored,
    layout: working.visual.layout
  })
  const writes = [
    [CAPTURE_CONFIG_KEY, JSON.stringify(next)],
    [WORKING_SCENE_KEY, JSON.stringify(working)],
    ...(library ? [[SCENES_KEY, JSON.stringify(library)]] : []),
    [ONBOARDING_KEY, ONBOARDING_DISMISSED_VALUE]
  ]
  await evaluate(
    `(() => { for (const [key, value] of ${JSON.stringify(writes)}) window.__videorcUiSettings.setItem(key, value); return true })()`
  )
  await reloadAndWait()
  // The reloaded Studio commits its scene to the backend and saves its config
  // a moment later; wait for what it does to match, never just for the write.
  const deadline = now() + settleDeadlineMs
  let problems = []
  for (;;) {
    const scene = await rpc('scene.get').catch(() => null)
    problems = verifySeededConfig(await readKey(CAPTURE_CONFIG_KEY), {
      targets,
      devices,
      scenario,
      working: await readKey(WORKING_SCENE_KEY),
      onStreamId: (await readKey(SCENES_KEY))?.onStreamId,
      labSceneId: working.sceneId,
      // A failed scene.get is no confirmation: it retries to the deadline.
      sceneSources: scene?.sources ?? null
    })
    if (!problems.length || now() >= deadline) break
    await sleep(SEED_SETTLE_POLL_MS)
  }
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
