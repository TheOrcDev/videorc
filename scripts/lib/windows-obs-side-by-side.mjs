import { createHash } from 'node:crypto'
import { isAbsolute, join, resolve, win32 } from 'node:path'

import { buildWindowsStreamPerformanceMatrix } from './windows-stream-performance.mjs'

export const WINDOWS_OBS_SCENARIO = 'youtube-1080p60'
export const WINDOWS_OBS_TIMING = Object.freeze({
  warmupMs: 60_000,
  measurementMs: 180_000,
  sampleIntervalMs: 1_000
})
export const WINDOWS_OBS_SETTINGS = Object.freeze({
  width: 1920,
  height: 1080,
  fps: 60,
  videoCodec: 'h264',
  rateControl: 'CBR',
  bitrateKbps: 12_000,
  keyframeIntervalSeconds: 2,
  colorFormat: 'NV12',
  colorSpace: '709',
  colorRange: 'partial',
  audioSampleRateHz: 48_000,
  audioChannels: 2,
  previewOpen: false
})
export const WINDOWS_OBS_D3D11_HARDWARE_CLASSES = Object.freeze([
  'nvidia-turing-floor',
  'intel-xe-integrated'
])
export const WINDOWS_OBS_D3D11_PROFILES = Object.freeze(['1080p30', '1080p60'])
export const WINDOWS_OBS_SCHEMA_KIND = 'videorc.windows-obs-side-by-side'
export const WINDOWS_D3D11_BUDGET_KIND = 'videorc.windows-d3d11-performance-budget'

export const WINDOWS_OBS_REQUIRED_ORDER = Object.freeze([
  'obs',
  'videorc',
  'videorc',
  'obs',
  'obs',
  'videorc'
])

export function parseWindowsObsSideBySideArgs(argv = []) {
  const result = {
    mode: null,
    list: false,
    scenario: WINDOWS_OBS_SCENARIO,
    runs: 3,
    order: [...WINDOWS_OBS_REQUIRED_ORDER],
    d3d11: false,
    requireD3d11: false,
    profiles: null,
    comparison: null,
    comparisons: null,
    streamCalibrations: null,
    output: null
  }
  for (let index = 0; index < argv.length; index += 1) {
    const name = argv[index]
    if (name === '--list') {
      setMode(result, 'list', name)
      result.list = true
    } else if (name === '--calibrate') {
      setMode(result, 'calibrate', name)
    } else if (name === '--derive-budget') {
      setMode(result, 'derive-budget', name)
    } else if (name === '--derive-d3d11-budget') {
      setMode(result, 'derive-d3d11-budget', name)
    } else if (name === '--scenario') {
      result.scenario = requiredArgumentValue(argv, ++index, name)
    } else if (name === '--runs') {
      result.runs = parsePositiveInteger(requiredArgumentValue(argv, ++index, name), name)
    } else if (name === '--order') {
      result.order = parseWindowsObsOrder(requiredArgumentValue(argv, ++index, name))
    } else if (name === '--d3d11') {
      result.d3d11 = true
    } else if (name === '--require-d3d11') {
      result.requireD3d11 = true
    } else if (name === '--profiles') {
      result.profiles = parseWindowsObsProfiles(requiredArgumentValue(argv, ++index, name))
    } else if (name === '--comparison') {
      result.comparison = requiredArgumentValue(argv, ++index, name)
    } else if (name === '--comparisons') {
      result.comparisons = parseExactAbsolutePathList(
        requiredArgumentValue(argv, ++index, name),
        2,
        name
      )
    } else if (name === '--stream-calibrations') {
      result.streamCalibrations =
        result.mode === 'derive-d3d11-budget'
          ? parseExactAbsolutePathList(requiredArgumentValue(argv, ++index, name), 2, name)
          : requiredArgumentValue(argv, ++index, name)
    } else if (name === '--output') {
      result.output = requiredArgumentValue(argv, ++index, name)
    } else {
      throw new Error(`Unknown Windows OBS comparison argument: ${name}`)
    }
  }

  if (!result.mode) {
    throw new Error(
      'Choose exactly one Windows OBS operation: --list, --calibrate, --derive-budget, or --derive-d3d11-budget.'
    )
  }
  if (result.requireD3d11 && !result.d3d11) {
    throw new Error('--require-d3d11 requires the explicit --d3d11 selection.')
  }
  if (result.scenario !== WINDOWS_OBS_SCENARIO) {
    throw new Error(`Windows OBS comparison supports only ${WINDOWS_OBS_SCENARIO}.`)
  }
  if (result.mode === 'calibrate') {
    if (result.runs !== 3) {
      throw new Error('--calibrate requires exactly --runs 3 (three trials per application).')
    }
    parseWindowsObsOrder(result.order)
    if (result.profiles && result.profiles.join(',') !== '1080p60') {
      throw new Error('OBS calibration --profiles, when supplied, must be exactly 1080p60.')
    }
  }
  if (result.mode === 'derive-budget') {
    if (!result.comparison || !result.streamCalibrations || !result.output) {
      throw new Error('--derive-budget requires --comparison, --stream-calibrations, and --output.')
    }
    if (Array.isArray(result.streamCalibrations)) {
      throw new Error('--derive-budget accepts one calibration root, not a path list.')
    }
  }
  if (result.mode === 'derive-d3d11-budget') {
    if (!result.comparisons || !result.streamCalibrations || !result.output) {
      throw new Error(
        '--derive-d3d11-budget requires --comparisons, --stream-calibrations, and --output.'
      )
    }
    if (!Array.isArray(result.streamCalibrations)) {
      throw new Error('--derive-d3d11-budget requires exactly two absolute calibration roots.')
    }
    if (result.profiles && result.profiles.join(',') !== WINDOWS_OBS_D3D11_PROFILES.join(',')) {
      throw new Error(
        `D3D11 budget derivation profiles must be exactly ${WINDOWS_OBS_D3D11_PROFILES.join(',')}.`
      )
    }
  }
  return result
}

export function parseWindowsObsProfiles(value) {
  const raw = Array.isArray(value) ? value : String(value ?? '').split(',')
  const profiles = raw.map((profile) => String(profile).trim().toLocaleLowerCase('en-US'))
  if (
    profiles.length === 0 ||
    profiles.some((profile) => !profile) ||
    new Set(profiles).size !== profiles.length
  ) {
    throw new Error('Windows OBS profiles must be a non-empty list without empty/duplicate values.')
  }
  for (const profile of profiles) {
    if (!WINDOWS_OBS_D3D11_PROFILES.includes(profile)) {
      throw new Error(`Unknown Windows OBS profile: ${profile}`)
    }
  }
  return profiles
}

export function parseWindowsObsOrder(value) {
  const order = Array.isArray(value)
    ? value.map(normalizeApp)
    : String(value ?? '')
        .split(',')
        .map(normalizeApp)
  if (
    order.length !== WINDOWS_OBS_REQUIRED_ORDER.length ||
    order.some((app, index) => app !== WINDOWS_OBS_REQUIRED_ORDER[index])
  ) {
    throw new Error(
      `OBS comparison order must be ${WINDOWS_OBS_REQUIRED_ORDER.join(',')}; received ${order.join(',') || '<empty>'}.`
    )
  }
  return order
}

export function buildWindowsObsRunPlan({
  evidenceDirectory,
  candidateSha256,
  scenario = 'youtube-1080p60',
  order = WINDOWS_OBS_REQUIRED_ORDER
}) {
  const canonicalOrder = parseWindowsObsOrder(order)
  requireLowercaseSha(candidateSha256, 'candidateSha256')
  if (!portableAbsolutePath(evidenceDirectory)) {
    throw new Error('Windows OBS evidenceDirectory must be an absolute path.')
  }
  if (scenario !== WINDOWS_OBS_SCENARIO) {
    throw new Error(`Windows OBS comparison supports only ${WINDOWS_OBS_SCENARIO}.`)
  }
  const root = join(portableResolvePath(evidenceDirectory), 'windows-stream-obs', candidateSha256)
  return {
    root,
    manifestPath: join(root, 'manifest.json'),
    aggregatePath: join(root, 'aggregate.json'),
    runs: canonicalOrder.map((app, index) => ({
      index: index + 1,
      app,
      scenario,
      directory: join(root, 'runs', `${index + 1}-${app}`),
      reportPath: join(root, 'runs', `${index + 1}-${app}`, 'report.json')
    }))
  }
}

export function normalizedWindowsObsSettings({
  display,
  audio,
  obsEncoderId,
  d3d11 = false,
  requireD3d11 = false
} = {}) {
  const displayBinding = normalizeDisplayBinding(display)
  const audioBinding = normalizeAudioBinding(audio)
  const encoderId = requireNonEmptyString(obsEncoderId, 'obsEncoderId')
  return {
    scenario: WINDOWS_OBS_SCENARIO,
    video: { ...WINDOWS_OBS_SETTINGS },
    capture: {
      type: 'display',
      cursor: true,
      deviceName: displayBinding.deviceName,
      adapterLuid: displayBinding.adapterLuid,
      outputIndex: displayBinding.outputIndex,
      desktopBounds: displayBinding.desktopBounds,
      refreshHz: displayBinding.refreshHz
    },
    audio: {
      endpointId: audioBinding.endpointId,
      sampleRateHz: WINDOWS_OBS_SETTINGS.audioSampleRateHz,
      channels: WINDOWS_OBS_SETTINGS.audioChannels
    },
    output: {
      protocol: 'rtmp',
      container: 'flv',
      videoEncoder: encoderId,
      videoCodec: WINDOWS_OBS_SETTINGS.videoCodec,
      rateControl: WINDOWS_OBS_SETTINGS.rateControl,
      bitrateKbps: WINDOWS_OBS_SETTINGS.bitrateKbps,
      keyframeIntervalSeconds: WINDOWS_OBS_SETTINGS.keyframeIntervalSeconds
    },
    presentation: {
      videorc: 'capture-protected-control-window',
      obs: 'minimized-to-tray',
      previewOpen: false
    },
    d3d11: {
      selected: d3d11 === true,
      required: requireD3d11 === true
    },
    timing: { ...WINDOWS_OBS_TIMING }
  }
}

export function windowsObsSettingsIdentity(settings) {
  const normalized = stableJsonValue(settings)
  return {
    normalized,
    sha256: sha256Text(stableJson(normalized))
  }
}

export function buildWindowsObsPortableProfile({
  profileName = 'Videorc OBS Comparison',
  collectionName = 'Videorc OBS Comparison',
  sceneName = 'Videorc OBS Comparison',
  monitorId,
  audioDeviceId,
  serverUrl,
  streamKey,
  obsEncoderId
} = {}) {
  for (const [label, value] of Object.entries({
    profileName,
    collectionName,
    sceneName,
    monitorId,
    audioDeviceId,
    serverUrl,
    streamKey,
    obsEncoderId
  })) {
    requireNonEmptyString(value, label)
  }
  const displayUuid = deterministicUuid(`display:${monitorId}`)
  const audioUuid = deterministicUuid(`audio:${audioDeviceId}`)
  const sceneUuid = deterministicUuid(`scene:${sceneName}`)
  const basicIni = [
    '[General]',
    `Name=${profileName}`,
    '',
    '[Video]',
    `BaseCX=${WINDOWS_OBS_SETTINGS.width}`,
    `BaseCY=${WINDOWS_OBS_SETTINGS.height}`,
    `OutputCX=${WINDOWS_OBS_SETTINGS.width}`,
    `OutputCY=${WINDOWS_OBS_SETTINGS.height}`,
    'ScaleType=bicubic',
    'FPSCommon=60',
    `ColorFormat=${WINDOWS_OBS_SETTINGS.colorFormat}`,
    `ColorSpace=${WINDOWS_OBS_SETTINGS.colorSpace}`,
    `ColorRange=${WINDOWS_OBS_SETTINGS.colorRange}`,
    '',
    '[Audio]',
    `SampleRate=${WINDOWS_OBS_SETTINGS.audioSampleRateHz}`,
    'ChannelSetup=Stereo',
    '',
    '[Output]',
    'Mode=Advanced',
    '',
    '[AdvOut]',
    `Encoder=${obsEncoderId}`,
    'ApplyServiceSettings=false',
    'TrackIndex=1',
    'VodTrackIndex=2',
    'UseRescale=false',
    'RecType=Standard',
    ''
  ].join('\r\n')
  const streamEncoder = {
    bitrate: WINDOWS_OBS_SETTINGS.bitrateKbps,
    rate_control: WINDOWS_OBS_SETTINGS.rateControl,
    keyint_sec: WINDOWS_OBS_SETTINGS.keyframeIntervalSeconds,
    profile: 'high',
    bframes: 2
  }
  const service = {
    type: 'rtmp_custom',
    settings: {
      server: serverUrl,
      key: streamKey,
      use_auth: false
    },
    hotkeys: {}
  }
  const sceneCollection = {
    current_scene: sceneName,
    current_program_scene: sceneName,
    name: collectionName,
    scene_order: [{ name: sceneName }],
    sources: [
      {
        prev_ver: 0,
        name: 'Videorc Comparison Display',
        uuid: displayUuid,
        id: 'monitor_capture',
        versioned_id: 'monitor_capture',
        settings: {
          monitor_id: monitorId,
          capture_cursor: true
        },
        mixers: 255,
        sync: 0,
        flags: 0,
        volume: 1,
        balance: 0,
        enabled: true,
        muted: false,
        monitoring_type: 0,
        private_settings: {}
      },
      {
        prev_ver: 0,
        name: 'Videorc Comparison Audio',
        uuid: audioUuid,
        id: 'wasapi_input_capture',
        versioned_id: 'wasapi_input_capture',
        settings: { device_id: audioDeviceId },
        mixers: 1,
        sync: 0,
        flags: 0,
        volume: 1,
        balance: 0,
        enabled: true,
        muted: false,
        monitoring_type: 0,
        private_settings: {}
      },
      {
        prev_ver: 0,
        name: sceneName,
        uuid: sceneUuid,
        id: 'scene',
        versioned_id: 'scene',
        settings: {
          id_counter: 2,
          custom_size: false,
          items: [
            {
              name: 'Videorc Comparison Display',
              source_uuid: displayUuid,
              visible: true,
              locked: true,
              rot: 0,
              pos: { x: 0, y: 0 },
              scale: { x: 1, y: 1 },
              align: 5,
              bounds_type: 2,
              bounds_align: 0,
              bounds: {
                x: WINDOWS_OBS_SETTINGS.width,
                y: WINDOWS_OBS_SETTINGS.height
              },
              crop_left: 0,
              crop_top: 0,
              crop_right: 0,
              crop_bottom: 0,
              id: 1,
              group_item_backup: false,
              scale_filter: 'bicubic',
              blend_method: 'default',
              blend_type: 'normal',
              show_transition: { duration: 0 },
              hide_transition: { duration: 0 },
              private_settings: {}
            }
          ]
        },
        mixers: 0,
        sync: 0,
        flags: 0,
        volume: 1,
        balance: 0,
        enabled: true,
        muted: false,
        monitoring_type: 0,
        private_settings: {}
      }
    ],
    groups: [],
    quick_transitions: [],
    transitions: [],
    saved_projectors: [],
    modules: {}
  }
  const websocket = {
    alerts_enabled: false,
    auth_required: false,
    first_load: false,
    server_enabled: true,
    server_port: 0
  }
  const safeFiles = [
    {
      relativePath: join('config', 'obs-studio', 'basic', 'profiles', profileName, 'basic.ini'),
      contents: basicIni
    },
    {
      relativePath: join(
        'config',
        'obs-studio',
        'basic',
        'profiles',
        profileName,
        'streamEncoder.json'
      ),
      contents: `${JSON.stringify(streamEncoder, null, 2)}\n`
    },
    {
      relativePath: join('config', 'obs-studio', 'basic', 'scenes', `${collectionName}.json`),
      contents: `${JSON.stringify(sceneCollection, null, 2)}\n`
    }
  ]
  const secretFiles = [
    {
      relativePath: join('config', 'obs-studio', 'basic', 'profiles', profileName, 'service.json'),
      contents: `${JSON.stringify(service, null, 2)}\n`
    }
  ]
  return {
    profileName,
    collectionName,
    sceneName,
    displayInputName: 'Videorc Comparison Display',
    audioInputName: 'Videorc Comparison Audio',
    safeFiles,
    secretFiles,
    websocket,
    normalized: {
      profileName,
      collectionName,
      sceneName,
      monitorId,
      audioDeviceId,
      obsEncoderId,
      video: { ...WINDOWS_OBS_SETTINGS },
      streamEncoder
    },
    normalizedSha256: sha256Text(
      stableJson({
        profileName,
        collectionName,
        sceneName,
        monitorId,
        audioDeviceId,
        obsEncoderId,
        video: WINDOWS_OBS_SETTINGS,
        streamEncoder
      })
    )
  }
}

export function extractWindowsAudioEndpointId(value) {
  if (typeof value !== 'string' || !value.trim()) return null
  const decoded = decodeURIComponentSafe(value).replace(/^@/, '')
  const mmdevapi = /mmdevapi[#\\]([^`"'\s]+)/i.exec(decoded)
  const candidate = (mmdevapi?.[1] ?? decoded).replace(/[#\\]+$/, '')
  const endpoint = /(\{[0-9]+\.[0-9]+\.[0-9]+\.[0-9a-f]+\}\.[{]?[0-9a-f-]{36}[}]?)/i.exec(candidate)
  if (endpoint)
    return endpoint[1].replaceAll('{', '').replaceAll('}', '').toLocaleLowerCase('en-US')
  const guid = /[{]?([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})[}]?/i.exec(
    candidate
  )
  return guid ? guid[1].toLocaleLowerCase('en-US') : null
}

export function evaluateWindowsObsEndpointMapping({ videorc, obs } = {}) {
  const blockers = []
  const videorcDisplay = normalizeDisplayBinding(videorc?.display, blockers, 'Videorc display')
  const obsDisplay = normalizeDisplayBinding(obs?.display, blockers, 'OBS display')
  const videorcAudio = normalizeAudioBinding(videorc?.audio, blockers, 'Videorc audio')
  const obsAudio = normalizeAudioBinding(obs?.audio, blockers, 'OBS audio')
  for (const field of ['deviceName', 'adapterLuid', 'outputIndex', 'refreshHz']) {
    if (videorcDisplay[field] !== obsDisplay[field]) {
      blockers.push(`${field} differed between Videorc and OBS`)
    }
  }
  if (stableJson(videorcDisplay.desktopBounds) !== stableJson(obsDisplay.desktopBounds)) {
    blockers.push('desktopBounds differed between Videorc and OBS')
  }
  if (videorcAudio.endpointId !== obsAudio.endpointId) {
    blockers.push('Core Audio endpoint GUID differed between Videorc and OBS')
  }
  return {
    verdict: blockers.length === 0 ? 'PASS' : 'BLOCKED',
    blockers,
    display: {
      matched: blockers.every(
        (blocker) =>
          !/display|deviceName|adapterLuid|outputIndex|refreshHz|desktopBounds/i.test(blocker)
      ),
      videorc: videorcDisplay,
      obs: obsDisplay
    },
    audio: {
      matched: blockers.every((blocker) => !/audio|endpoint/i.test(blocker)),
      videorc: videorcAudio,
      obs: obsAudio
    }
  }
}

export function summarizeWindowsObsProcessTelemetry(telemetry) {
  const memorySamples = Array.isArray(telemetry?.memory?.samples) ? telemetry.memory.samples : []
  const cpuSamples = Array.isArray(telemetry?.cpu?.samples) ? telemetry.cpu.samples : []
  const totalRssMiB = memorySamples
    .map((sample) => Number(sample?.totalRssKb) / 1024)
    .filter(Number.isFinite)
  const totalCpu = cpuSamples
    .map((sample) => {
      const roles = Object.values(sample?.byRole ?? {})
        .map(Number)
        .filter(Number.isFinite)
      return roles.length > 0 ? roles.reduce((total, value) => total + value, 0) : null
    })
    .filter(Number.isFinite)
  const roleNames = new Set([
    ...memorySamples.flatMap((sample) => Object.keys(sample?.byRole ?? {})),
    ...cpuSamples.flatMap((sample) => Object.keys(sample?.byRole ?? {}))
  ])
  const roles = Object.fromEntries(
    [...roleNames].sort().map((role) => {
      const rss = memorySamples
        .map((sample) => Number(sample?.byRole?.[role]?.rssKb) / 1024)
        .filter(Number.isFinite)
      const cpu = cpuSamples.map((sample) => Number(sample?.byRole?.[role])).filter(Number.isFinite)
      return [
        role,
        {
          rssMaxMiB: maximum(rss),
          rssSlopeMiBPerMinute: linearSlopePerMinute(rss, telemetry?.timing?.intervalMs),
          cpuAveragePercent: average(cpu),
          cpuP95Percent: percentile(cpu, 0.95)
        }
      ]
    })
  )
  return {
    cpuP95Percent: percentile(totalCpu, 0.95),
    rssP95MiB: percentile(totalRssMiB, 0.95),
    rssMaxMiB: maximum(totalRssMiB),
    rssSlopeMiBPerMinute: linearSlopePerMinute(totalRssMiB, telemetry?.timing?.intervalMs),
    roles
  }
}

export function evaluateWindowsObsComparison(comparison) {
  const failures = []
  const blockers = []
  if (comparison?.schemaVersion !== 1) failures.push('schemaVersion must be 1')
  if (comparison?.kind !== 'videorc.windows-obs-side-by-side') {
    failures.push('kind must be videorc.windows-obs-side-by-side')
  }
  try {
    requireSha(comparison?.candidate?.sha256, 'candidate.sha256')
  } catch (error) {
    failures.push(error.message)
  }
  if (comparison?.candidate?.signed !== true) {
    blockers.push('the Videorc candidate was not Authenticode-signed')
  }
  try {
    requireSha(comparison?.obs?.sha256, 'obs.sha256')
  } catch (error) {
    failures.push(error.message)
  }
  if (typeof comparison?.obs?.version !== 'string' || !comparison.obs.version.trim()) {
    failures.push('obs.version was missing')
  }
  const runs = Array.isArray(comparison?.runs) ? comparison.runs : []
  let expectedOrder
  try {
    expectedOrder = parseWindowsObsOrder(runs.map((run) => run?.app))
  } catch (error) {
    failures.push(error.message)
  }

  const settingsHash = comparison?.settings?.sha256
  try {
    requireSha(settingsHash, 'settings.sha256')
  } catch (error) {
    failures.push(error.message)
  }
  if (comparison?.display?.matched !== true) {
    blockers.push('Videorc and OBS did not resolve to the same display/adapter/output')
  }
  if (comparison?.audio?.matched !== true) {
    blockers.push('Videorc and OBS did not resolve to the same Core Audio endpoint')
  }

  for (const [index, run] of runs.entries()) {
    const label = `run ${index + 1}`
    if (run?.index !== index + 1) failures.push(`${label} index did not match its order`)
    if (expectedOrder && run?.app !== expectedOrder[index]) {
      failures.push(`${label} app did not match the protected order`)
    }
    if (run?.clean !== true) blockers.push(`${label} was not a clean run`)
    if (run?.settingsSha256 !== settingsHash) {
      blockers.push(`${label} settings did not match the comparison settings`)
    }
    if (run?.app === 'videorc' && run?.candidateSha256 !== comparison?.candidate?.sha256) {
      blockers.push(`${label} used a different Videorc candidate digest`)
    }
    if (run?.media?.verdict !== 'PASS') failures.push(`${label} media verdict was not PASS`)
    if (run?.gpu?.verdict !== 'PASS') blockers.push(`${label} GPU evidence was incomplete`)
    if (run?.process?.teardownClean !== true)
      failures.push(`${label} process teardown was not clean`)
    if (
      !Array.isArray(run?.artifacts) ||
      run.artifacts.length === 0 ||
      run.artifacts.some(
        (artifact) =>
          typeof artifact?.path !== 'string' ||
          !artifact.path.trim() ||
          !/^[0-9a-f]{64}$/i.test(artifact?.sha256 ?? '')
      )
    ) {
      blockers.push(`${label} did not retain hashed artifacts`)
    }
  }

  const obsRuns = runs.filter((run) => run?.app === 'obs')
  const videorcRuns = runs.filter((run) => run?.app === 'videorc')
  if (obsRuns.length !== 3 || videorcRuns.length !== 3) {
    failures.push('comparison requires exactly three OBS and three Videorc runs')
  }
  let medians = null
  if (obsRuns.length === 3 && videorcRuns.length === 3) {
    try {
      medians = {
        obs: summarizeComparisonRuns(obsRuns),
        videorc: summarizeComparisonRuns(videorcRuns)
      }
    } catch (error) {
      blockers.push(`comparison resource metrics were incomplete: ${error.message}`)
    }
  }
  if (medians) {
    const cpuAdmission = Math.min(medians.obs.cpuP95Percent * 1.25, medians.obs.cpuP95Percent + 5)
    if (medians.videorc.cpuP95Percent > cpuAdmission) {
      failures.push(
        `Videorc median CPU p95 ${medians.videorc.cpuP95Percent} exceeded OBS admission ${cpuAdmission}`
      )
    }
    const rssAdmission = medians.obs.rssP95MiB * 1.25 + 150
    if (medians.videorc.rssP95MiB > rssAdmission) {
      failures.push(
        `Videorc median RSS p95 ${medians.videorc.rssP95MiB} exceeded OBS admission ${rssAdmission}`
      )
    }
    if (videorcRuns.some((run) => Number(run?.process?.rssSlopeMiBPerMinute) > 5)) {
      failures.push('Videorc had an unbounded total-process RSS slope')
    }
    if (
      videorcRuns.some((run) =>
        Object.values(run?.process?.roles ?? {}).some(
          (role) => Number(role?.rssSlopeMiBPerMinute) > 2
        )
      )
    ) {
      failures.push('Videorc had an unbounded per-role RSS slope')
    }
    const obsFreezeRank = Math.max(...obsRuns.map((run) => mediaRank(run?.media?.freezeVerdict)))
    const obsRepeatRank = Math.max(...obsRuns.map((run) => mediaRank(run?.media?.repeatVerdict)))
    if (
      videorcRuns.some(
        (run) =>
          mediaRank(run?.media?.freezeVerdict) > obsFreezeRank ||
          mediaRank(run?.media?.repeatVerdict) > obsRepeatRank
      )
    ) {
      failures.push('Videorc freeze/repeat verdict was worse than OBS')
    }
  }

  return {
    verdict: failures.length > 0 ? 'FAIL' : blockers.length > 0 ? 'BLOCKED' : 'PASS',
    failures,
    blockers,
    medians
  }
}

export function deriveWindowsStreamPerformanceBudget({ comparison, calibrations }) {
  const admission = evaluateWindowsObsComparison(comparison)
  if (admission.verdict !== 'PASS') {
    throw new Error(
      `Cannot derive a Windows stream budget from ${admission.verdict} comparison evidence.`
    )
  }
  if (!Array.isArray(calibrations) || calibrations.length === 0) {
    throw new Error('At least one Windows stream calibration context is required.')
  }
  const comparisonPaths = comparison.runs.map((run) => run.reportPath)
  const comparisonHashes = comparison.runs.map((run) => run.reportSha256)
  if (
    comparisonPaths.some((path) => typeof path !== 'string' || !path.trim()) ||
    comparisonHashes.some((hash) => !/^[0-9a-f]{64}$/i.test(hash ?? ''))
  ) {
    throw new Error('Comparison derivation requires six retained report paths and hashes.')
  }

  const obsRuns = comparison.runs.filter((run) => run.app === 'obs')
  const obs = summarizeComparisonRuns(obsRuns)
  const profiles = calibrations.map((calibration) => {
    const runs = calibration?.runs
    const expectedRuns =
      calibration?.scope?.scenario === '1080p60-av-endurance' &&
      calibration?.scope?.timing?.measurementMs === 600_000
        ? 1
        : 3
    if (!Array.isArray(runs) || runs.length !== expectedRuns) {
      throw new Error(
        `Calibration ${calibration?.id ?? '<unknown>'} must contain ${expectedRuns} run${expectedRuns === 1 ? '' : 's'}.`
      )
    }
    const roles = Object.keys(runs[0]?.process?.roles ?? {}).sort()
    if (roles.length === 0) {
      throw new Error(`Calibration ${calibration?.id ?? '<unknown>'} had no process roles.`)
    }
    const worstTotalRssMax = Math.max(...runs.map((run) => finite(run.process.rssMaxMiB)))
    const totalRssThreshold = ceilTo(Math.max(1, worstTotalRssMax * 1.05), 0.1)
    const rssAdmission = obs.rssMaxMiB * 1.25 + 150
    if (totalRssThreshold > rssAdmission) {
      throw new Error(
        `Calibration ${calibration.id} total RSS budget ${totalRssThreshold} exceeds OBS admission ${rssAdmission}.`
      )
    }
    const previewOpen = calibration.scope.previewOpen === true
    return {
      id: calibration.id,
      scope: calibration.scope,
      candidateSha256: comparison.candidate.sha256,
      evidence: {
        runCount: expectedRuns,
        reportPaths: runs.map((run) => run.reportPath),
        reportSha256: runs.map((run) => run.reportSha256),
        calibrationSha256: calibration.aggregateSha256,
        comparisonPaths,
        comparisonSha256: comparisonHashes
      },
      thresholds: {
        maximumTotalCpuP95Percent: Math.ceil(
          Math.min(obs.cpuP95Percent * 1.25, obs.cpuP95Percent + 5)
        ),
        maximumTotalRssMiB: totalRssThreshold,
        maximumTotalRssSlopeMiBPerMinute: 5,
        gpu: {
          maximumEngineP95Percent: Math.min(95, obs.gpuEngineP95Percent + 10),
          maximumDedicatedMiB: ceilTo(obs.gpuDedicatedMaxMiB * 1.25 + 256, 0.1),
          maximumSharedMiB: ceilTo(obs.gpuSharedMaxMiB * 1.25 + 256, 0.1)
        },
        bmp: previewOpen
          ? {
              mode: 'required',
              maximumIntervalP95Ms: Math.min(
                175,
                ceilTo(Math.max(...runs.map((run) => finite(run.bmp.intervalP95Ms))) * 1.1 + 5, 0.1)
              ),
              minimumAdvancedFrames: Math.floor(
                Math.min(...runs.map((run) => finite(run.bmp.advancedFrames))) * 0.9
              )
            }
          : {
              mode: 'disabled',
              maximumRequests: 0,
              maximumBytes: 0
            },
        roles: Object.fromEntries(
          roles.map((role) => [
            role,
            {
              maximumRssMiB: ceilTo(
                Math.max(...runs.map((run) => finite(run.process.roles[role].rssMaxMiB))) * 1.1 + 1,
                0.1
              ),
              maximumRssSlopeMiBPerMinute: 2,
              maximumAverageCpuPercent: ceilTo(
                Math.max(...runs.map((run) => finite(run.process.roles[role].cpuAveragePercent))) *
                  1.1 +
                  1,
                0.1
              ),
              maximumP95CpuPercent: ceilTo(
                Math.max(...runs.map((run) => finite(run.process.roles[role].cpuP95Percent))) *
                  1.1 +
                  1,
                0.1
              )
            }
          ])
        )
      }
    }
  })
  return {
    schemaVersion: 1,
    kind: 'videorc.windows-performance-budget-set',
    status: 'draft',
    candidateSha256: comparison.candidate.sha256,
    comparison: {
      aggregatePath: comparison.aggregatePath,
      aggregateSha256: comparison.aggregateSha256,
      reportPaths: comparisonPaths,
      reportSha256: comparisonHashes
    },
    profiles
  }
}

export function mergeWindowsObsRunEvidence({ manifest, runs }) {
  if (!manifest || typeof manifest !== 'object') {
    throw new Error('Windows OBS comparison manifest is required.')
  }
  if (!Array.isArray(runs) || runs.length !== WINDOWS_OBS_REQUIRED_ORDER.length) {
    throw new Error('Windows OBS evidence merge requires exactly six run reports.')
  }
  const mergedRuns = runs.map((run, index) => {
    if (run?.index !== index + 1 || run?.app !== WINDOWS_OBS_REQUIRED_ORDER[index]) {
      throw new Error(`Run ${index + 1} did not match the protected alternating order.`)
    }
    return stableJsonValue(run)
  })
  const comparison = {
    schemaVersion: 1,
    kind: WINDOWS_OBS_SCHEMA_KIND,
    status: 'running',
    scenario: manifest.scenario,
    timing: manifest.timing,
    candidate: manifest.candidate,
    obs: manifest.obs,
    hardware: manifest.hardware,
    mapping: manifest.mapping,
    display: manifest.mapping?.display,
    audio: manifest.mapping?.audio,
    settings: manifest.settings,
    stimulus: manifest.stimulus,
    manifestPath: manifest.manifestPath,
    manifestSha256: manifest.manifestSha256,
    runs: mergedRuns
  }
  const evaluation = evaluateWindowsObsComparison(comparison)
  return {
    ...comparison,
    status:
      evaluation.verdict === 'PASS'
        ? 'CALIBRATION'
        : evaluation.verdict === 'BLOCKED'
          ? 'BLOCKED'
          : 'FAIL',
    verdict: evaluation.verdict,
    failures: evaluation.failures,
    blockers: evaluation.blockers,
    medians: evaluation.medians,
    relative: comparisonRelativeDeltas(evaluation.medians)
  }
}

export function deriveWindowsD3d11PerformanceBudget({ comparisons, calibrations }) {
  if (!Array.isArray(comparisons) || comparisons.length !== 2) {
    throw new Error('D3D11 budget derivation requires exactly two OBS comparison aggregates.')
  }
  if (!Array.isArray(calibrations) || calibrations.length === 0) {
    throw new Error('D3D11 budget derivation requires stream calibration contexts.')
  }
  const comparisonsByClass = new Map()
  let candidateIdentity = null
  let comparisonContractIdentity = null
  const hardwareFingerprints = new Set()
  for (const comparison of comparisons) {
    const evaluation = evaluateWindowsObsComparison(comparison)
    if (evaluation.verdict !== 'PASS') {
      throw new Error(
        `Cannot derive D3D11 budget from ${evaluation.verdict} comparison evidence (${comparison?.hardware?.hardwareClass ?? 'unknown class'}).`
      )
    }
    const hardwareClass = comparison?.hardware?.hardwareClass
    if (!WINDOWS_OBS_D3D11_HARDWARE_CLASSES.includes(hardwareClass)) {
      throw new Error(`Unexpected D3D11 comparison hardware class: ${hardwareClass}`)
    }
    if (comparisonsByClass.has(hardwareClass)) {
      throw new Error(`Duplicate D3D11 comparison hardware class: ${hardwareClass}`)
    }
    requireLowercaseSha(comparison?.aggregateSha256, `${hardwareClass} aggregateSha256`)
    requireLowercaseSha(comparison?.manifestSha256, `${hardwareClass} manifestSha256`)
    requireLowercaseSha(comparison?.hardware?.fingerprint, `${hardwareClass} hardware fingerprint`)
    requireLowercaseSha(
      comparison?.stimulus?.manifestSha256,
      `${hardwareClass} stimulus manifestSha256`
    )
    if (!portableAbsolutePath(comparison?.aggregatePath)) {
      throw new Error(`${hardwareClass} aggregatePath must be absolute.`)
    }
    if (!portableAbsolutePath(comparison?.manifestPath)) {
      throw new Error(`${hardwareClass} manifestPath must be absolute.`)
    }
    const identity = windowsObsCandidateIdentity(comparison.candidate)
    if (candidateIdentity && stableJson(identity) !== stableJson(candidateIdentity)) {
      throw new Error('D3D11 comparison candidate/source/installer/payload identity differed.')
    }
    candidateIdentity = identity
    const contractIdentity = {
      obsSha256: comparison.obs.sha256,
      obsVersion: comparison.obs.version,
      settingsSha256: comparison.settings.sha256,
      normalizedSettings: comparison.settings.normalized,
      stimulusManifestSha256: comparison.stimulus.manifestSha256
    }
    if (
      comparisonContractIdentity &&
      stableJson(contractIdentity) !== stableJson(comparisonContractIdentity)
    ) {
      throw new Error('D3D11 comparisons used different OBS/settings/stimulus contract identity.')
    }
    comparisonContractIdentity = contractIdentity
    if (hardwareFingerprints.has(comparison.hardware.fingerprint)) {
      throw new Error('D3D11 comparisons reused one physical hardware fingerprint.')
    }
    hardwareFingerprints.add(comparison.hardware.fingerprint)
    comparisonsByClass.set(hardwareClass, {
      comparison,
      evaluation,
      source: {
        hardwareClass,
        aggregatePath: comparison.aggregatePath,
        aggregateSha256: comparison.aggregateSha256,
        manifestSha256: comparison.manifestSha256,
        obsSha256: comparison.obs.sha256,
        obsVersion: comparison.obs.version,
        bootId: comparison.hardware.bootId,
        fingerprint: comparison.hardware.fingerprint ?? null
      }
    })
  }
  for (const hardwareClass of WINDOWS_OBS_D3D11_HARDWARE_CLASSES) {
    if (!comparisonsByClass.has(hardwareClass)) {
      throw new Error(`Missing D3D11 OBS comparison for ${hardwareClass}.`)
    }
  }

  const profiles = []
  const protectedMatrix = buildWindowsStreamPerformanceMatrix()
  const protectedScenarios = new Map(protectedMatrix.map((scenario) => [scenario.id, scenario]))
  const qualifiedByClass = new Map(
    WINDOWS_OBS_D3D11_HARDWARE_CLASSES.map((hardwareClass) => [hardwareClass, new Set()])
  )
  const scenariosByClass = new Map(
    WINDOWS_OBS_D3D11_HARDWARE_CLASSES.map((hardwareClass) => [hardwareClass, new Set()])
  )
  const contextKeys = new Set()
  for (const calibration of calibrations) {
    const hardwareClass = calibration?.scope?.hardwareClass
    const comparisonEntry = comparisonsByClass.get(hardwareClass)
    if (!comparisonEntry) {
      throw new Error(
        `Calibration ${calibration?.id ?? '<unknown>'} used an unsupported hardware class.`
      )
    }
    const profile = calibration?.scope?.profile
    if (!WINDOWS_OBS_D3D11_PROFILES.includes(profile)) {
      throw new Error(
        `Calibration ${calibration?.id ?? '<unknown>'} used unqualified profile ${profile ?? '<missing>'}.`
      )
    }
    if (calibration?.scope?.mediaPath !== 'd3d11-native') {
      throw new Error(`Calibration ${calibration.id} did not use mediaPath d3d11-native.`)
    }
    const scenario = protectedScenarios.get(calibration?.scope?.scenario)
    if (!scenario) {
      throw new Error(
        `Calibration ${calibration.id} used an unknown protected scenario ${calibration?.scope?.scenario ?? '<missing>'}.`
      )
    }
    const expectedScope = {
      profile: scenario.fps === 60 ? '1080p60' : '1080p30',
      topology: scenario.topology,
      sourceComposition: scenario.sourceComposition,
      previewOpen: scenario.previewOpen,
      warmupMs: scenario.warmupMs,
      measurementMs: scenario.measurementMs,
      intervalMs: scenario.sampleIntervalMs
    }
    const actualScope = {
      profile,
      topology: calibration?.scope?.topology,
      sourceComposition: calibration?.scope?.sourceComposition,
      previewOpen: calibration?.scope?.previewOpen,
      warmupMs: calibration?.scope?.timing?.warmupMs,
      measurementMs: calibration?.scope?.timing?.measurementMs,
      intervalMs: calibration?.scope?.timing?.intervalMs
    }
    if (stableJson(actualScope) !== stableJson(expectedScope)) {
      throw new Error(`Calibration ${calibration.id} did not match its protected scenario scope.`)
    }
    if (
      calibration?.scope?.previewOpen === true &&
      stableJson(calibration?.scope?.preview) !==
        stableJson({
          transport: 'd3d11-shared-texture',
          backing: 'directcomposition-swapchain',
          hostKind: 'backend-d3d11-presenter'
        })
    ) {
      throw new Error(`Calibration ${calibration.id} did not use the canonical D3D11 preview.`)
    }
    const calibrationIdentity = windowsObsCandidateIdentity(calibration?.candidate)
    if (stableJson(calibrationIdentity) !== stableJson(candidateIdentity)) {
      throw new Error(`Calibration ${calibration.id} used a different final candidate identity.`)
    }
    if (!portableAbsolutePath(calibration?.aggregatePath)) {
      throw new Error(`Calibration ${calibration.id} aggregatePath must be absolute.`)
    }
    requireLowercaseSha(calibration?.aggregateSha256, `${calibration.id} aggregateSha256`)
    if (!Array.isArray(calibration?.runs) || calibration.runs.length !== scenario.repetitions) {
      throw new Error(
        `Calibration ${calibration.id} must retain exactly ${scenario.repetitions} run${scenario.repetitions === 1 ? '' : 's'}.`
      )
    }
    for (const [runIndex, run] of calibration.runs.entries()) {
      if (run?.verdict !== 'PASS') {
        throw new Error(`Calibration ${calibration.id} run ${runIndex + 1} did not pass.`)
      }
      if (run?.pipeline?.zeroCopyVerdict !== 'PASS') {
        throw new Error(
          `Calibration ${calibration.id} run ${runIndex + 1} did not prove zero-copy D3D11.`
        )
      }
      if (
        Number(run?.bmp?.requests) !== 0 ||
        Number(run?.bmp?.bytes) !== 0 ||
        run?.bmp?.mode !== 'disabled'
      ) {
        throw new Error(
          `Calibration ${calibration.id} run ${runIndex + 1} performed forbidden BMP work.`
        )
      }
      requireLowercaseSha(run?.reportSha256, `${calibration.id} run ${runIndex + 1} reportSha256`)
      if (!portableAbsolutePath(run?.reportPath)) {
        throw new Error(
          `Calibration ${calibration.id} run ${runIndex + 1} reportPath must be absolute.`
        )
      }
    }
    const contextKey = stableJson(calibration.scope)
    if (contextKeys.has(contextKey)) {
      throw new Error(`Duplicate D3D11 calibration context: ${calibration.id}`)
    }
    contextKeys.add(contextKey)
    qualifiedByClass.get(hardwareClass).add(profile)
    scenariosByClass.get(hardwareClass).add(scenario.id)
    profiles.push(
      deriveWindowsD3d11Profile({
        calibration,
        comparison: comparisonEntry.comparison,
        obs: comparisonEntry.evaluation.medians.obs,
        candidateIdentity
      })
    )
  }
  for (const [hardwareClass, profileSet] of qualifiedByClass) {
    if ([...profileSet].sort().join(',') !== [...WINDOWS_OBS_D3D11_PROFILES].sort().join(',')) {
      throw new Error(
        `${hardwareClass} calibrations must qualify exactly ${WINDOWS_OBS_D3D11_PROFILES.join(',')}.`
      )
    }
    const scenarios = scenariosByClass.get(hardwareClass)
    if (
      scenarios.size !== protectedMatrix.length ||
      protectedMatrix.some((scenario) => !scenarios.has(scenario.id))
    ) {
      throw new Error(
        `${hardwareClass} calibrations must cover the exact protected ${protectedMatrix.length}-scenario matrix.`
      )
    }
  }

  return {
    schemaVersion: 1,
    kind: WINDOWS_D3D11_BUDGET_KIND,
    status: 'draft',
    generatedBy: 'smoke-windows-obs-side-by-side --derive-d3d11-budget',
    candidate: candidateIdentity,
    qualifiedProfiles: Object.fromEntries(
      WINDOWS_OBS_D3D11_HARDWARE_CLASSES.map((hardwareClass) => [
        hardwareClass,
        [...WINDOWS_OBS_D3D11_PROFILES]
      ])
    ),
    unqualifiedLivestreamProfiles: ['1440p30', '1440p60', '4k30', '4k60'],
    comparisonEvidence: WINDOWS_OBS_D3D11_HARDWARE_CLASSES.map(
      (hardwareClass) => comparisonsByClass.get(hardwareClass).source
    ),
    profiles: profiles.sort((left, right) => left.id.localeCompare(right.id)),
    naturalFallbackPolicy: null,
    activation: {
      allowed: false,
      reason:
        'Draft requires retained natural-fallback policy evidence and independent human review.'
    }
  }
}

function deriveWindowsD3d11Profile({ calibration, comparison, obs, candidateIdentity }) {
  const runs = calibration.runs
  const roles = new Set(runs.flatMap((run) => Object.keys(run?.process?.roles ?? {})))
  if (roles.size === 0) {
    throw new Error(`Calibration ${calibration.id} had no process-role metrics.`)
  }
  const totalRssThreshold = ceilTo(
    Math.max(...runs.map((run) => finite(run.process.rssMaxMiB))) * 1.05,
    0.1
  )
  const rssAdmission = obs.rssMaxMiB * 1.25 + 150
  if (totalRssThreshold > rssAdmission) {
    throw new Error(
      `Calibration ${calibration.id} total RSS budget ${totalRssThreshold} exceeds OBS admission ${rssAdmission}.`
    )
  }
  return {
    id: calibration.id,
    scope: stableJsonValue(calibration.scope),
    candidate: candidateIdentity,
    evidence: {
      calibrationPath: calibration.aggregatePath,
      calibrationSha256: calibration.aggregateSha256,
      reportPaths: runs.map((run) => run.reportPath),
      reportSha256: runs.map((run) => run.reportSha256),
      comparisonPath: comparison.aggregatePath,
      comparisonSha256: comparison.aggregateSha256
    },
    invariants: {
      mediaPath: 'd3d11-native',
      captureReadbackFrames: 0,
      compositorCpuFallbackFrames: 0,
      rawVideoCopiedFrames: 0,
      encoderSystemMemorySamples: 0,
      previewBmpRequests: 0,
      previewBmpBytes: 0,
      cursorCorrect: true,
      inputContinuity: true,
      maximumMessageDispatchP95Ms: 50,
      maximumMessageDispatchMs: 100
    },
    thresholds: {
      maximumTotalCpuP95Percent: Math.ceil(
        Math.min(obs.cpuP95Percent * 1.25, obs.cpuP95Percent + 5)
      ),
      maximumTotalRssMiB: totalRssThreshold,
      maximumTotalRssSlopeMiBPerMinute: 5,
      gpu: {
        maximumEngineP95Percent: Math.min(95, obs.gpuEngineP95Percent + 10),
        maximumDedicatedMiB: ceilTo(obs.gpuDedicatedMaxMiB * 1.25 + 256, 0.1),
        maximumSharedMiB: ceilTo(obs.gpuSharedMaxMiB * 1.25 + 256, 0.1)
      },
      bmp: {
        mode: 'disabled',
        maximumRequests: 0,
        maximumBytes: 0
      },
      roles: Object.fromEntries(
        [...roles].sort().map((role) => [
          role,
          {
            maximumRssMiB: ceilTo(
              Math.max(...runs.map((run) => finite(run.process.roles[role]?.rssMaxMiB))) * 1.1 + 1,
              0.1
            ),
            maximumRssSlopeMiBPerMinute: 2,
            maximumAverageCpuPercent: ceilTo(
              Math.max(...runs.map((run) => finite(run.process.roles[role]?.cpuAveragePercent))) *
                1.1 +
                1,
              0.1
            ),
            maximumP95CpuPercent: ceilTo(
              Math.max(...runs.map((run) => finite(run.process.roles[role]?.cpuP95Percent))) * 1.1 +
                1,
              0.1
            )
          }
        ])
      )
    }
  }
}

function summarizeComparisonRuns(runs) {
  return {
    cpuP95Percent: median(runs.map((run) => finite(run.process.cpuP95Percent))),
    rssP95MiB: median(runs.map((run) => finite(run.process.rssP95MiB))),
    rssMaxMiB: Math.max(...runs.map((run) => finite(run.process.rssMaxMiB))),
    gpuEngineP95Percent: median(runs.map((run) => finite(run.gpu.summary.engineBusyP95Percent))),
    gpuDedicatedMaxMiB: Math.max(...runs.map((run) => finite(run.gpu.summary.dedicatedMaxMiB))),
    gpuSharedMaxMiB: Math.max(...runs.map((run) => finite(run.gpu.summary.sharedMaxMiB)))
  }
}

function setMode(result, mode, argument) {
  if (result.mode && result.mode !== mode) {
    throw new Error(`${argument} cannot be combined with ${result.mode}.`)
  }
  result.mode = mode
}

function requiredArgumentValue(argv, index, name) {
  const value = argv[index]
  if (typeof value !== 'string' || !value.trim() || value.startsWith('--')) {
    throw new Error(`${name} requires a value.`)
  }
  return value.trim()
}

function parsePositiveInteger(value, label) {
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${label} requires a positive integer.`)
  }
  return parsed
}

function parseExactAbsolutePathList(value, expectedLength, label) {
  const paths = String(value)
    .split(',')
    .map((path) => path.trim())
  if (
    paths.length !== expectedLength ||
    paths.some((path) => !path) ||
    new Set(paths.map(portableResolvePath)).size !== expectedLength
  ) {
    throw new Error(`${label} requires exactly ${expectedLength} distinct paths.`)
  }
  for (const path of paths) {
    if (!portableAbsolutePath(path)) {
      throw new Error(`${label} paths must be absolute (aliases and globs are not accepted).`)
    }
    if (/[*?\[\]{}]/.test(path)) {
      throw new Error(`${label} does not accept aliases or glob paths.`)
    }
  }
  return paths.map(portableResolvePath)
}

function portableAbsolutePath(value) {
  return (
    typeof value === 'string' &&
    Boolean(value.trim()) &&
    (isAbsolute(value) || windowsAbsolutePath(value))
  )
}

function portableResolvePath(value) {
  return windowsAbsolutePath(value) ? win32.normalize(value) : resolve(value)
}

function windowsAbsolutePath(value) {
  return typeof value === 'string' && (/^[a-z]:[\\/]/i.test(value) || /^\\\\[^\\]/.test(value))
}

function normalizeDisplayBinding(value, blockers, label = 'display') {
  const output = {
    deviceName:
      typeof value?.deviceName === 'string' && value.deviceName.trim()
        ? value.deviceName.trim().toLocaleUpperCase('en-US')
        : null,
    adapterLuid: normalizeAdapterLuid(value?.adapterLuid),
    outputIndex: Number(value?.outputIndex),
    desktopBounds: {
      x: Number(value?.desktopBounds?.x),
      y: Number(value?.desktopBounds?.y),
      width: Number(value?.desktopBounds?.width),
      height: Number(value?.desktopBounds?.height)
    },
    refreshHz: Number(value?.refreshHz)
  }
  const missing = []
  if (!output.deviceName) missing.push('deviceName')
  if (!output.adapterLuid) missing.push('adapterLuid')
  if (!Number.isInteger(output.outputIndex) || output.outputIndex < 0) missing.push('outputIndex')
  if (
    !Number.isFinite(output.desktopBounds.x) ||
    !Number.isFinite(output.desktopBounds.y) ||
    !Number.isFinite(output.desktopBounds.width) ||
    output.desktopBounds.width <= 0 ||
    !Number.isFinite(output.desktopBounds.height) ||
    output.desktopBounds.height <= 0
  ) {
    missing.push('desktopBounds')
  }
  if (!Number.isFinite(output.refreshHz) || output.refreshHz <= 0) missing.push('refreshHz')
  if (missing.length > 0) {
    const message = `${label} mapping omitted ${missing.join(', ')}`
    if (Array.isArray(blockers)) blockers.push(message)
    else throw new Error(message)
  }
  return output
}

function normalizeAudioBinding(value, blockers, label = 'audio') {
  const endpointId =
    extractWindowsAudioEndpointId(value?.endpointId) ??
    extractWindowsAudioEndpointId(value?.symbolicLink) ??
    null
  const output = {
    endpointId,
    friendlyName:
      typeof value?.friendlyName === 'string' && value.friendlyName.trim()
        ? value.friendlyName.trim()
        : null
  }
  if (!endpointId) {
    const message = `${label} mapping omitted an authoritative Core Audio endpoint GUID`
    if (Array.isArray(blockers)) blockers.push(message)
    else throw new Error(message)
  }
  return output
}

function normalizeAdapterLuid(value) {
  if (typeof value !== 'string') return null
  const compact = value.trim().replace(/^0x/i, '').replace(':0x', '').replaceAll(':', '')
  return /^[0-9a-f]{16}$/i.test(compact) ? compact.toLocaleLowerCase('en-US') : null
}

function requireNonEmptyString(value, label) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${label} is required.`)
  }
  return value.trim()
}

function stableJson(value) {
  return JSON.stringify(stableJsonValue(value))
}

function stableJsonValue(value) {
  if (Array.isArray(value)) return value.map(stableJsonValue)
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, child]) => child !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, stableJsonValue(child)])
    )
  }
  return value
}

function sha256Text(value) {
  return createHash('sha256').update(value).digest('hex')
}

function deterministicUuid(seed) {
  const digest = createHash('sha256').update(seed).digest('hex')
  return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-4${digest.slice(13, 16)}-a${digest.slice(
    17,
    20
  )}-${digest.slice(20, 32)}`
}

function decodeURIComponentSafe(value) {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

function comparisonRelativeDeltas(medians) {
  if (!medians) return null
  const delta = (videorc, obs) => ({
    absolute: videorc - obs,
    ratio: obs === 0 ? null : videorc / obs
  })
  return {
    cpuP95Percent: delta(medians.videorc.cpuP95Percent, medians.obs.cpuP95Percent),
    rssP95MiB: delta(medians.videorc.rssP95MiB, medians.obs.rssP95MiB),
    gpuEngineP95Percent: delta(
      medians.videorc.gpuEngineP95Percent,
      medians.obs.gpuEngineP95Percent
    ),
    gpuDedicatedMaxMiB: delta(medians.videorc.gpuDedicatedMaxMiB, medians.obs.gpuDedicatedMaxMiB),
    gpuSharedMaxMiB: delta(medians.videorc.gpuSharedMaxMiB, medians.obs.gpuSharedMaxMiB)
  }
}

function windowsObsCandidateIdentity(candidate) {
  requireLowercaseSha(candidate?.sha256, 'candidate.sha256')
  requireLowercaseSha(candidate?.packagePayload?.sha256, 'candidate.packagePayload.sha256')
  requireLowercaseSha(candidate?.installerSha256, 'candidate.installerSha256')
  if (!/^[0-9a-f]{40}$/.test(candidate?.sourceCommit ?? '')) {
    throw new Error('candidate.sourceCommit must be a lowercase 40-character commit.')
  }
  return {
    sourceCommit: candidate.sourceCommit,
    installerSha256: candidate.installerSha256,
    executableSha256: candidate.sha256,
    packagePayloadSha256: candidate.packagePayload.sha256
  }
}

function percentile(values, ratio) {
  const finiteValues = values
    .map(Number)
    .filter(Number.isFinite)
    .sort((left, right) => left - right)
  if (finiteValues.length === 0) return Number.NaN
  return finiteValues[Math.max(0, Math.ceil(finiteValues.length * ratio) - 1)]
}

function maximum(values) {
  const finiteValues = values.map(Number).filter(Number.isFinite)
  return finiteValues.length > 0 ? Math.max(...finiteValues) : Number.NaN
}

function average(values) {
  const finiteValues = values.map(Number).filter(Number.isFinite)
  return finiteValues.length > 0
    ? finiteValues.reduce((total, value) => total + value, 0) / finiteValues.length
    : Number.NaN
}

function linearSlopePerMinute(values, intervalMs) {
  const finiteValues = values.map(Number).filter(Number.isFinite)
  const intervalMinutes = Number(intervalMs) / 60_000
  if (finiteValues.length < 2 || !Number.isFinite(intervalMinutes) || intervalMinutes <= 0) {
    return Number.NaN
  }
  const count = finiteValues.length
  const meanX = (count - 1) / 2
  const meanY = average(finiteValues)
  let numerator = 0
  let denominator = 0
  for (let index = 0; index < count; index += 1) {
    const x = index - meanX
    numerator += x * (finiteValues[index] - meanY)
    denominator += x * x
  }
  return denominator > 0 ? numerator / denominator / intervalMinutes : 0
}

function normalizeApp(value) {
  return String(value ?? '')
    .trim()
    .toLocaleLowerCase('en-US')
}

function requireSha(value, label) {
  if (!sha256(value)) {
    throw new Error(`${label} must be a SHA-256 digest`)
  }
}

function requireLowercaseSha(value, label) {
  if (!lowercaseSha256(value)) {
    throw new Error(`${label} must be a lowercase SHA-256 digest`)
  }
}

function sha256(value) {
  return typeof value === 'string' && /^[0-9a-f]{64}$/i.test(value)
}

function lowercaseSha256(value) {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value)
}

function normalizeSha256(value) {
  return value.toLocaleLowerCase('en-US')
}

function mediaRank(value) {
  return value === 'PASS' ? 0 : value === 'WARN' ? 1 : 2
}

function finite(value) {
  const number = Number(value)
  if (!Number.isFinite(number)) throw new Error('Comparison/calibration metric was non-finite.')
  return number
}

function median(values) {
  const ordered = [...values].sort((left, right) => left - right)
  const middle = Math.floor(ordered.length / 2)
  return ordered.length % 2 === 1 ? ordered[middle] : (ordered[middle - 1] + ordered[middle]) / 2
}

function ceilTo(value, precision) {
  return Math.ceil(value / precision) * precision
}
