import { WINDOWS_D3D11_FAIRNESS_LIMITS } from './windows-d3d11-media.mjs'

const REQUIRED_TOP_LEVEL_SECTIONS = [
  'schemaVersion',
  'generatedAt',
  'app',
  'health',
  'devices',
  'lastAudioMeter',
  'entitlements',
  'recording',
  'diagnostics',
  'logs',
  'sessions',
  'redactionSummary'
]

const REDACTION_SUMMARY_FIELDS = [
  'secretValues',
  'databasePaths',
  'mediaPaths',
  'homePaths',
  'urlCredentials',
  'aiArtifactBodies'
]

const SUPPORTED_SCHEMA_VERSION = 2
const WINDOWS_ACCEPTANCE_REQUIRED_DEVICE_KINDS = ['screen', 'camera', 'microphone']

const AI_ARTIFACT_BODY_KEYS = new Set([
  'body',
  'chapters',
  'content',
  'description',
  'summary',
  'text',
  'title',
  'transcript'
])

export function validateSupportBundle(bundle, options = {}) {
  const failures = []
  const warnings = []

  if (!isPlainObject(bundle)) {
    return {
      ok: false,
      failures: ['Support bundle root must be a JSON object.'],
      warnings
    }
  }

  for (const section of REQUIRED_TOP_LEVEL_SECTIONS) {
    if (!Object.prototype.hasOwnProperty.call(bundle, section)) {
      failures.push(`Missing required top-level section: ${section}`)
    }
  }

  if (bundle.schemaVersion !== SUPPORTED_SCHEMA_VERSION) {
    failures.push(`Unsupported support bundle schemaVersion: ${String(bundle.schemaVersion)}`)
  }
  if (!isPlainObject(bundle.app)) {
    failures.push('app section must be an object.')
  } else {
    for (const field of ['version', 'platform', 'runMode']) {
      if (typeof bundle.app[field] !== 'string' || bundle.app[field].trim() === '') {
        failures.push(`app.${field} must be a non-empty string.`)
      }
    }
  }
  if (!isPlainObject(bundle.health)) {
    failures.push('health section must be an object.')
  } else {
    for (const field of ['status', 'version', 'platform']) {
      if (typeof bundle.health[field] !== 'string' || bundle.health[field].trim() === '') {
        failures.push(`health.${field} must be a non-empty string.`)
      }
    }
    if (!isPlainObject(bundle.health.ffmpeg)) {
      failures.push('health.ffmpeg must be an object.')
    } else if (typeof bundle.health.ffmpeg.available !== 'boolean') {
      failures.push('health.ffmpeg.available must be a boolean.')
    }
  }
  if (!isPlainObject(bundle.devices)) {
    failures.push('devices section must be an object.')
  } else if (!Array.isArray(bundle.devices.devices)) {
    failures.push('devices.devices must be an array.')
  }
  if (!isPlainObject(bundle.diagnostics)) {
    failures.push('diagnostics section must be an object.')
  }
  if (!Array.isArray(bundle.logs)) {
    failures.push('logs section must be an array.')
  }
  if (!Array.isArray(bundle.sessions)) {
    failures.push('sessions section must be an array.')
  }
  if (!isPlainObject(bundle.redactionSummary)) {
    failures.push('redactionSummary section must be an object.')
  } else {
    for (const field of REDACTION_SUMMARY_FIELDS) {
      const value = bundle.redactionSummary[field]
      if (!Number.isInteger(value) || value < 0) {
        failures.push(`redactionSummary.${field} must be a non-negative integer.`)
      }
    }
  }

  inspectBackendCrashRecords(bundle, failures)

  inspectValue(bundle, [], failures, warnings)
  if (options.windowsAcceptance === true) {
    inspectWindowsAcceptance(bundle, failures, warnings)
  }

  return {
    ok: failures.length === 0,
    failures,
    warnings
  }
}

// Live-feedback batch 3 (B1): rendererDiagnostics.runtimeInfo.backendCrashes
// carries the supervisor's persisted crash records (most recent first). The
// field is optional (older apps omit it), but when present every record must
// keep the shape the crash-capture flow promises, or the bundle is lying.
const BACKEND_CRASH_RECORD_LIMIT = 5
const BACKEND_CRASH_STDERR_TAIL_LIMIT = 50

function inspectBackendCrashRecords(bundle, failures) {
  const runtimeInfo = bundle.rendererDiagnostics?.runtimeInfo
  if (!isPlainObject(runtimeInfo) || runtimeInfo.backendCrashes === undefined) {
    return
  }
  const prefix = 'rendererDiagnostics.runtimeInfo.backendCrashes'
  const records = runtimeInfo.backendCrashes
  if (!Array.isArray(records)) {
    failures.push(`${prefix} must be an array of crash records.`)
    return
  }
  if (records.length > BACKEND_CRASH_RECORD_LIMIT) {
    failures.push(`${prefix} must keep at most ${BACKEND_CRASH_RECORD_LIMIT} records.`)
  }
  let previousAt = null
  records.forEach((record, index) => {
    const label = `${prefix}.${index}`
    if (!isPlainObject(record)) {
      failures.push(`${label} must be an object.`)
      return
    }
    if (typeof record.at !== 'string' || Number.isNaN(Date.parse(record.at))) {
      failures.push(`${label}.at must be an ISO timestamp.`)
    } else {
      const at = Date.parse(record.at)
      if (previousAt !== null && at > previousAt) {
        failures.push(`${prefix} must be ordered most recent first (record ${index}).`)
      }
      previousAt = at
    }
    if (!Number.isInteger(record.generation) || record.generation < 0) {
      failures.push(`${label}.generation must be a non-negative integer.`)
    }
    if (record.code !== null && !Number.isInteger(record.code)) {
      failures.push(`${label}.code must be an integer or null.`)
    }
    if (record.signal !== null && (typeof record.signal !== 'string' || !record.signal)) {
      failures.push(`${label}.signal must be a signal name or null.`)
    }
    if (record.code === null && record.signal === null && record.intentional !== true) {
      failures.push(`${label} must name an exit code or a signal for a crash.`)
    }
    if (record.attempt !== null && (!Number.isInteger(record.attempt) || record.attempt < 1)) {
      failures.push(`${label}.attempt must be a positive integer or null.`)
    }
    if (!Number.isInteger(record.uptimeMs) || record.uptimeMs < 0) {
      failures.push(`${label}.uptimeMs must be a non-negative integer.`)
    }
    if (typeof record.intentional !== 'boolean') {
      failures.push(`${label}.intentional must be a boolean.`)
    }
    if (!Array.isArray(record.stderrTail)) {
      failures.push(`${label}.stderrTail must be an array of strings.`)
    } else {
      if (record.stderrTail.length > BACKEND_CRASH_STDERR_TAIL_LIMIT) {
        failures.push(
          `${label}.stderrTail must keep at most ${BACKEND_CRASH_STDERR_TAIL_LIMIT} lines.`
        )
      }
      if (record.stderrTail.some((line) => typeof line !== 'string')) {
        failures.push(`${label}.stderrTail must contain only strings.`)
      }
    }
  })
}

function inspectWindowsAcceptance(bundle, failures, warnings) {
  if (!isPlainObject(bundle)) {
    return
  }

  if (bundle.schemaVersion !== SUPPORTED_SCHEMA_VERSION) {
    failures.push(
      `windows acceptance requires support bundle schemaVersion ${SUPPORTED_SCHEMA_VERSION}.`
    )
  }
  requireString(bundle, ['app', 'platform'], 'windows', failures)
  requireString(bundle, ['health', 'platform'], 'windows', failures)
  requireString(bundle, ['app', 'runMode'], 'packaged', failures)

  if (bundle.health?.ffmpeg?.available !== true) {
    failures.push('windows acceptance requires health.ffmpeg.available to be true.')
  }
  if (typeof bundle.health?.ffmpeg?.version !== 'string' || !bundle.health.ffmpeg.version.trim()) {
    failures.push('windows acceptance requires health.ffmpeg.version to be present.')
  }

  const runtimeInfo = bundle.rendererDiagnostics?.runtimeInfo
  if (!isPlainObject(runtimeInfo)) {
    failures.push('windows acceptance requires rendererDiagnostics.runtimeInfo.')
  } else {
    requireString(runtimeInfo, ['platform'], 'win32', failures, 'rendererDiagnostics.runtimeInfo')
    requireString(runtimeInfo, ['arch'], 'x64', failures, 'rendererDiagnostics.runtimeInfo')
    if (runtimeInfo.isPackaged !== true) {
      failures.push('windows acceptance requires rendererDiagnostics.runtimeInfo.isPackaged=true.')
    }
    if (typeof runtimeInfo.osRelease !== 'string' || !runtimeInfo.osRelease.trim()) {
      failures.push('windows acceptance requires rendererDiagnostics.runtimeInfo.osRelease.')
    } else {
      const build = windowsBuildNumber(runtimeInfo.osRelease)
      if (build === null) {
        failures.push(
          `rendererDiagnostics.runtimeInfo.osRelease must include a Windows build number: ${runtimeInfo.osRelease}`
        )
      } else if (build < 22000) {
        failures.push(`windows acceptance requires Windows 11 build 22000+; found ${build}.`)
      }
    }
    if (!Array.isArray(runtimeInfo.gpuDevices) || runtimeInfo.gpuDevices.length === 0) {
      failures.push('windows acceptance requires rendererDiagnostics.runtimeInfo.gpuDevices.')
    } else {
      runtimeInfo.gpuDevices.forEach((device, index) => {
        if (!isPlainObject(device)) {
          failures.push(`rendererDiagnostics.runtimeInfo.gpuDevices.${index} must be an object.`)
          return
        }
        if (
          stringOrNumber(device.vendorId) === undefined &&
          stringOrNumber(device.deviceId) === undefined &&
          typeof device.description !== 'string'
        ) {
          failures.push(
            `rendererDiagnostics.runtimeInfo.gpuDevices.${index} must include a vendorId, deviceId, or description.`
          )
        }
      })
    }
    if (typeof runtimeInfo.hardwareAccelerationDisabled !== 'boolean') {
      failures.push(
        'windows acceptance requires rendererDiagnostics.runtimeInfo.hardwareAccelerationDisabled.'
      )
    }
    if (!isPlainObject(runtimeInfo.gpuFallback)) {
      failures.push('windows acceptance requires rendererDiagnostics.runtimeInfo.gpuFallback.')
    } else {
      const validSources = new Set(['env', 'persisted', 'retry', 'none'])
      if (!validSources.has(runtimeInfo.gpuFallback.source)) {
        failures.push(
          'rendererDiagnostics.runtimeInfo.gpuFallback.source must identify env, persisted, retry, or none.'
        )
      }
      if (typeof runtimeInfo.gpuFallback.retryScheduled !== 'boolean') {
        failures.push(
          'rendererDiagnostics.runtimeInfo.gpuFallback.retryScheduled must be a boolean.'
        )
      }
      if (
        !Number.isInteger(runtimeInfo.gpuFallback.retryAttempts) ||
        runtimeInfo.gpuFallback.retryAttempts < 0
      ) {
        failures.push(
          'rendererDiagnostics.runtimeInfo.gpuFallback.retryAttempts must be a non-negative integer.'
        )
      }
      if (
        runtimeInfo.hardwareAccelerationDisabled === true &&
        (typeof runtimeInfo.gpuFallback.reason !== 'string' ||
          !runtimeInfo.gpuFallback.reason.trim())
      ) {
        failures.push(
          'windows acceptance requires a GPU fallback reason while software rendering is active.'
        )
      }
    }
  }

  const devices = Array.isArray(bundle.devices?.devices) ? bundle.devices.devices : []
  for (const kind of WINDOWS_ACCEPTANCE_REQUIRED_DEVICE_KINDS) {
    if (!devices.some((device) => device?.kind === kind && device?.status === 'available')) {
      failures.push(`windows acceptance requires an available ${kind} device.`)
    }
  }
  if (!hasWindowsCaptureBackendProof(devices)) {
    failures.push(
      'windows acceptance requires Windows capture backend proof in devices (DXGI/gdigrab/dshow/MediaFoundation).'
    )
  }

  const diagnostics = diagnosticSnapshots(bundle)
  if (!diagnostics.some((snapshot) => typeof snapshot.encodeBackend === 'string')) {
    failures.push(
      'windows acceptance requires encodeBackend in diagnostics or session finalDiagnostics.'
    )
  }
  if (
    !diagnostics.some(
      (snapshot) =>
        typeof snapshot.compositorBackend === 'string' ||
        typeof snapshot.compositorFallbackReason === 'string'
    )
  ) {
    warnings.push(
      'windows acceptance bundle does not include compositor backend/fallback diagnostics; device backend proof is still required.'
    )
  }
  inspectWindowsStreamDiagnostics(diagnostics, failures, bundle)
}

function inspectWindowsStreamDiagnostics(diagnostics, failures, bundle) {
  const streamSnapshots = diagnostics.filter(
    (snapshot) =>
      typeof snapshot?.activeOutputMode === 'string' && snapshot.activeOutputMode.includes('stream')
  )
  if (streamSnapshots.length === 0) {
    return
  }

  for (const [index, snapshot] of streamSnapshots.entries()) {
    const label = `windows stream diagnostics ${index + 1}`
    for (const field of [
      'streamMeasuredBitrateKbps',
      'streamMeasuredBitrateMinKbps',
      'streamMeasuredBitrateMaxKbps'
    ]) {
      if (!Number.isFinite(snapshot[field]) || snapshot[field] <= 0) {
        failures.push(`${label} requires positive ${field}.`)
      }
    }
    for (const field of ['streamOutputTotalBytes', 'streamDuplicatedFrames']) {
      if (!Number.isInteger(snapshot[field]) || snapshot[field] < 0) {
        failures.push(`${label} requires non-negative integer ${field}.`)
      }
    }
    for (const field of [
      'encoderBridgeRequestedVideoOutput',
      'encoderBridgeEffectiveVideoOutput',
      'encoderBridgeEncodedOutputBackend'
    ]) {
      if (typeof snapshot[field] !== 'string' || !snapshot[field].trim()) {
        failures.push(`${label} requires ${field}.`)
      }
    }
    if (
      snapshot.encoderBridgeRequestedVideoOutput !== snapshot.encoderBridgeEffectiveVideoOutput &&
      (typeof snapshot.encoderBridgeEncodedOutputFallbackReason !== 'string' ||
        !snapshot.encoderBridgeEncodedOutputFallbackReason.trim())
    ) {
      failures.push(`${label} requires a fallback reason for a requested/effective mismatch.`)
    }
  }

  const mediaSnapshots = streamSnapshots.filter((snapshot) =>
    isPlainObject(snapshot?.windowsD3d11Media)
  )
  if (mediaSnapshots.length !== streamSnapshots.length) {
    failures.push(
      'windows stream diagnostics require either live D3D11 media or one named natural fallback in every snapshot.'
    )
    return
  }
  const d3d11Snapshots = mediaSnapshots.filter(
    (snapshot) => snapshot.windowsD3d11Media.state === 'live'
  )
  const fallbackSnapshots = mediaSnapshots.filter(
    (snapshot) => snapshot.windowsD3d11Media.state === 'fallback'
  )
  if (d3d11Snapshots.length === 0) {
    inspectWindowsNaturalD3d11FallbackSnapshots(fallbackSnapshots, streamSnapshots, failures)
    return
  }
  if (d3d11Snapshots.length !== streamSnapshots.length || fallbackSnapshots.length > 0) {
    failures.push('windows D3D11 stream diagnostics changed between live and fallback states.')
  }
  const adapterLuids = new Set()
  const generations = new Set()
  for (const [index, snapshot] of d3d11Snapshots.entries()) {
    const label = `windows D3D11 stream diagnostics ${index + 1}`
    const media = snapshot.windowsD3d11Media
    if (media.state !== 'live') failures.push(`${label} requires state=live.`)
    if (media.requested !== true) failures.push(`${label} requires requested=true.`)
    if (!/^[0-9a-f]{16}$/.test(media.adapterLuid ?? '')) {
      failures.push(`${label} requires a canonical adapterLuid.`)
    } else {
      adapterLuids.add(media.adapterLuid)
    }
    for (const field of [
      'captureAdapterLuid',
      'compositorAdapterLuid',
      'primaryEncoderAdapterLuid'
    ]) {
      if (!/^[0-9a-f]{16}$/.test(media[field] ?? '')) {
        failures.push(`${label} requires a canonical ${field}.`)
      } else if (media[field] !== media.adapterLuid) {
        failures.push(`${label} requires ${field} to equal adapterLuid.`)
      }
    }
    if (
      media.auxiliaryEncoderAdapterLuid !== null &&
      media.auxiliaryEncoderAdapterLuid !== undefined
    ) {
      if (!/^[0-9a-f]{16}$/.test(media.auxiliaryEncoderAdapterLuid)) {
        failures.push(`${label} requires a canonical auxiliaryEncoderAdapterLuid when present.`)
      } else if (media.auxiliaryEncoderAdapterLuid !== media.adapterLuid) {
        failures.push(`${label} requires auxiliaryEncoderAdapterLuid to equal adapterLuid.`)
      }
    }
    if (
      snapshot.encoderBridgeSeparateOutputEncodersActive === true &&
      !/^[0-9a-f]{16}$/.test(media.auxiliaryEncoderAdapterLuid ?? '')
    ) {
      failures.push(`${label} requires auxiliaryEncoderAdapterLuid for split output encoders.`)
    }
    if (!Number.isSafeInteger(media.generation) || media.generation <= 0) {
      failures.push(`${label} requires a positive generation.`)
    } else {
      generations.add(media.generation)
    }
    if (
      !['desktop-duplication', 'windows-graphics-capture-monitor'].includes(media.captureBackend)
    ) {
      failures.push(`${label} requires a native captureBackend.`)
    }
    for (const field of [
      'captureReadbackFrames',
      'compositorCpuFallbackFrames',
      'encoderSystemMemorySamples',
      'rawVideoCopiedFrames',
      'previewBmpRequests',
      'previewBmpBytes',
      'texturePoolPressureEvents',
      'adapterMismatches',
      'deviceResets',
      'staleGenerationCallbacks',
      'synchronizationTimeouts'
    ]) {
      if (media[field] !== 0) failures.push(`${label} requires ${field}=0.`)
    }
    if (!Number.isInteger(media.cameraUploadFrames) || media.cameraUploadFrames < 0) {
      failures.push(`${label} requires non-negative integer cameraUploadFrames.`)
    }
    if (!Number.isInteger(media.texturePoolCapacity) || media.texturePoolCapacity <= 0) {
      failures.push(`${label} requires positive texturePoolCapacity.`)
    }
    if (
      !Number.isInteger(media.texturePoolInUse) ||
      media.texturePoolInUse < 0 ||
      media.texturePoolInUse > media.texturePoolCapacity
    ) {
      failures.push(`${label} requires texturePoolInUse within the fixed pool capacity.`)
    }
    inspectWindowsD3d11SchedulerDiagnostics(media, label, failures)
    inspectWindowsD3d11CursorDiagnostics(media, label, failures)
    if (typeof media.fallbackReason === 'string' && media.fallbackReason.trim()) {
      failures.push(`${label} must not contain a fallbackReason.`)
    }
  }
  if (adapterLuids.size !== 1) {
    failures.push('windows D3D11 stream diagnostics did not preserve one adapter LUID.')
  }
  if (generations.size !== 1) {
    failures.push('windows D3D11 stream diagnostics did not preserve one generation.')
  }
  const terminal = d3d11Snapshots.at(-1)?.windowsD3d11Media
  if (!(terminal?.textureImportFrames > 0)) {
    failures.push('windows D3D11 stream diagnostics require positive textureImportFrames.')
  }
  if (!(terminal?.encoderGpuSamples > 0)) {
    failures.push('windows D3D11 stream diagnostics require positive encoderGpuSamples.')
  }
  if (
    terminal?.cursorRequested === true &&
    terminal?.cursorMode === 'separate' &&
    !(terminal?.cursorCompositedFrames > 0)
  ) {
    failures.push(
      'windows D3D11 stream diagnostics require positive cursorCompositedFrames for separate cursor composition.'
    )
  }

  const previewWasD3d11 = d3d11Snapshots.some(
    (snapshot) =>
      snapshot.previewTransport === 'd3d11-shared-texture' ||
      snapshot.previewSurfaceBacking === 'directcomposition-swapchain'
  )
  if (previewWasD3d11) {
    inspectWindowsD3d11PresenterDiagnostics(
      bundle?.rendererDiagnostics?.nativePreviewSurfaceStatus,
      failures
    )
  }
}

function inspectWindowsNaturalD3d11FallbackSnapshots(fallbackSnapshots, streamSnapshots, failures) {
  if (fallbackSnapshots.length !== streamSnapshots.length || fallbackSnapshots.length === 0) {
    failures.push(
      'windows stream diagnostics did not prove a stable live D3D11 path or named natural fallback.'
    )
    return
  }
  const fallbackReasons = new Set()
  for (const [index, snapshot] of fallbackSnapshots.entries()) {
    const label = `windows natural D3D11 fallback diagnostics ${index + 1}`
    const media = snapshot.windowsD3d11Media
    if (media.state !== 'fallback') failures.push(`${label} requires state=fallback.`)
    if (media.requested !== false) failures.push(`${label} requires requested=false.`)
    if (media.required !== false) failures.push(`${label} requires required=false.`)
    if (media.captureBackend !== 'legacy-ffmpeg') {
      failures.push(`${label} requires captureBackend=legacy-ffmpeg.`)
    }
    if (typeof media.fallbackReason !== 'string' || !media.fallbackReason.trim()) {
      failures.push(`${label} requires one named fallbackReason.`)
    } else {
      fallbackReasons.add(media.fallbackReason)
    }
    for (const field of [
      'adapterLuid',
      'captureAdapterLuid',
      'compositorAdapterLuid',
      'primaryEncoderAdapterLuid',
      'auxiliaryEncoderAdapterLuid'
    ]) {
      if (media[field] !== null && media[field] !== undefined) {
        failures.push(`${label} must not claim ${field}.`)
      }
    }
    inspectWindowsD3d11SchedulerDiagnostics(media, label, failures)
  }
  if (fallbackReasons.size !== 1) {
    failures.push('windows natural D3D11 fallback reason changed across stream diagnostics.')
  }
}

function inspectWindowsD3d11SchedulerDiagnostics(media, label, failures) {
  for (const [field, maximum] of [
    ['messagePumpLagP95Ms', WINDOWS_D3D11_FAIRNESS_LIMITS.messagePumpLagP95Ms],
    ['messagePumpLagMaxMs', WINDOWS_D3D11_FAIRNESS_LIMITS.messagePumpLagMaxMs],
    ['mediaCommandLagP95Ms', WINDOWS_D3D11_FAIRNESS_LIMITS.mediaCommandLagP95Ms],
    ['mediaCommandLagMaxMs', WINDOWS_D3D11_FAIRNESS_LIMITS.mediaCommandLagMaxMs]
  ]) {
    if (!Number.isFinite(media[field]) || media[field] < 0 || media[field] > maximum) {
      failures.push(`${label} requires ${field} within ${maximum} ms.`)
    }
  }
  for (const field of ['maximumConsecutiveMessageBatch', 'maximumConsecutiveMediaBatch']) {
    if (
      !Number.isInteger(media[field]) ||
      media[field] < 0 ||
      media[field] > WINDOWS_D3D11_FAIRNESS_LIMITS[field]
    ) {
      failures.push(`${label} requires ${field} within ${WINDOWS_D3D11_FAIRNESS_LIMITS[field]}.`)
    }
  }
  if (media.synchronizationTimeouts !== 0) {
    failures.push(`${label} requires synchronizationTimeouts=0.`)
  }
}

function inspectWindowsD3d11CursorDiagnostics(media, label, failures) {
  if (typeof media.cursorRequested !== 'boolean') {
    failures.push(`${label} requires cursorRequested.`)
    return
  }
  if (typeof media.cursorPixelsSource !== 'string' || !media.cursorPixelsSource.trim()) {
    failures.push(`${label} requires cursorPixelsSource.`)
  }
  if (media.captureBackend === 'desktop-duplication') {
    if (media.cursorRequested !== true) {
      failures.push(`${label} requires cursorRequested=true for Desktop Duplication.`)
    }
    if (!['embedded', 'separate'].includes(media.cursorMode)) {
      failures.push(`${label} requires embedded or separate Desktop Duplication cursorMode.`)
    }
    if (media.cursorExclusionGuaranteed !== false) {
      failures.push(`${label} requires cursorExclusionGuaranteed=false for Desktop Duplication.`)
    }
    if (media.cursorMode === 'embedded' && media.cursorCompositedFrames !== 0) {
      failures.push(`${label} requires cursorCompositedFrames=0 for embedded cursor ownership.`)
    }
    return
  }
  if (media.captureBackend === 'windows-graphics-capture-monitor') {
    if (media.cursorRequested !== false) {
      failures.push(`${label} requires cursorRequested=false for cursor-excluded WGC.`)
    }
    if (media.cursorMode !== 'excluded-wgc') {
      failures.push(`${label} requires cursorMode=excluded-wgc for cursor-excluded WGC.`)
    }
    if (media.cursorExclusionGuaranteed !== true) {
      failures.push(`${label} requires cursorExclusionGuaranteed=true for cursor-excluded WGC.`)
    }
    if (media.cursorCompositedFrames !== 0) {
      failures.push(`${label} requires cursorCompositedFrames=0 for cursor-excluded WGC.`)
    }
  }
}

function inspectWindowsD3d11PresenterDiagnostics(status, failures) {
  const label = 'rendererDiagnostics.nativePreviewSurfaceStatus'
  if (!isPlainObject(status)) {
    failures.push(`${label} is required for an active D3D11 presenter.`)
    return
  }
  if (status.state !== 'live') failures.push(`${label} requires state=live.`)
  if (status.transport !== 'd3d11-shared-texture') {
    failures.push(`${label} requires transport=d3d11-shared-texture.`)
  }
  if (status.backing !== 'directcomposition-swapchain') {
    failures.push(`${label} requires backing=directcomposition-swapchain.`)
  }
  if (status.sourcePixelsPresent !== true) {
    failures.push(`${label} requires sourcePixelsPresent=true.`)
  }
  if (status.framePollingSuppressed !== true) {
    failures.push(`${label} requires framePollingSuppressed=true.`)
  }

  const presenter = status.windowsD3d11Presenter
  if (!isPlainObject(presenter)) {
    failures.push(`${label}.windowsD3d11Presenter is required.`)
    return
  }
  for (const field of [
    'layered',
    'transparent',
    'noActivate',
    'excludedFromCapture',
    'generationMatches',
    'ownerProcessMatches',
    'sameAdapter',
    'sourceLive',
    'firstPresentSucceeded'
  ]) {
    if (presenter[field] !== true) {
      failures.push(`${label}.windowsD3d11Presenter requires ${field}=true.`)
    }
  }
  for (const field of ['windowActive', 'windowFocused']) {
    if (presenter[field] !== false) {
      failures.push(`${label}.windowsD3d11Presenter requires ${field}=false.`)
    }
  }
  if (!Number.isSafeInteger(presenter.successfulPresents) || presenter.successfulPresents <= 0) {
    failures.push(`${label}.windowsD3d11Presenter requires positive successfulPresents.`)
  }
  if (
    !Number.isSafeInteger(presenter.lastPresentedSequence) ||
    presenter.lastPresentedSequence <= 0
  ) {
    failures.push(`${label}.windowsD3d11Presenter requires a positive lastPresentedSequence.`)
  }
  for (const field of ['latestWinsDrops', 'hiddenDrops', 'busyDrops', 'staleFrameDrops']) {
    if (!Number.isSafeInteger(presenter[field]) || presenter[field] < 0) {
      failures.push(`${label}.windowsD3d11Presenter requires non-negative integer ${field}.`)
    }
  }
  const bounds = presenter.actualBounds
  if (
    !isPlainObject(bounds) ||
    !Number.isSafeInteger(bounds.x) ||
    !Number.isSafeInteger(bounds.y) ||
    !Number.isSafeInteger(bounds.width) ||
    bounds.width <= 0 ||
    !Number.isSafeInteger(bounds.height) ||
    bounds.height <= 0
  ) {
    failures.push(`${label}.windowsD3d11Presenter requires positive integral actualBounds.`)
  }
  if (typeof presenter.fallbackReason === 'string' && presenter.fallbackReason.trim()) {
    failures.push(`${label}.windowsD3d11Presenter must not contain a fallbackReason.`)
  }
}

function inspectValue(value, path, failures, warnings) {
  if (Array.isArray(value)) {
    value.forEach((item, index) => inspectValue(item, [...path, String(index)], failures, warnings))
    return
  }
  if (!isPlainObject(value)) {
    inspectScalar(value, path, failures, warnings)
    return
  }

  for (const [key, child] of Object.entries(value)) {
    inspectValue(child, [...path, key], failures, warnings)
  }
}

function inspectScalar(value, path, failures, warnings) {
  if (typeof value !== 'string' || value.trim() === '') {
    return
  }

  const key = path[path.length - 1] ?? ''
  const normalizedKey = normalizeKey(key)
  const location = path.join('.')

  if (normalizedKey === 'orderabovewindowhandle') {
    failures.push(`${location} leaked a privileged native window handle.`)
  }

  if (isAiArtifactBody(path, normalizedKey) && !isRedacted(value)) {
    failures.push(
      `${location} contains an AI artifact body; support bundles must keep only artifact metadata.`
    )
  }

  if (isSecretKey(normalizedKey) && !isRedactedSecret(value)) {
    failures.push(`${location} contains an unredacted secret-shaped value.`)
  }

  if (normalizedKey === 'databasepath' && value !== '<redacted:database-path>') {
    failures.push(`${location} contains an unredacted database path.`)
  }

  if (isMediaPathKey(normalizedKey) && !isRedactedPath(value)) {
    failures.push(`${location} contains an unredacted media path.`)
  }

  if (normalizedKey.includes('url') && hasUnredactedUrlSecret(value)) {
    failures.push(`${location} contains an unredacted URL credential or RTMP URL.`)
  }

  if (!isRedacted(value) && looksLikeInlineSecret(value)) {
    failures.push(`${location} contains inline secret-shaped text.`)
  }

  if (!isRedacted(value) && looksLikeHomePath(value)) {
    failures.push(`${location} contains an unredacted home-directory path.`)
  }

  if (isRedacted(value) && value.includes('\n')) {
    warnings.push(`${location} redaction marker contains a newline.`)
  }
}

function requireString(root, path, expected, failures, prefix) {
  const value = valueAt(root, path)
  const location = prefix ? `${prefix}.${path.join('.')}` : path.join('.')
  if (value !== expected) {
    failures.push(
      `${location} must be ${JSON.stringify(expected)}; found ${JSON.stringify(value)}.`
    )
  }
}

function valueAt(root, path) {
  let current = root
  for (const part of path) {
    if (!isPlainObject(current)) {
      return undefined
    }
    current = current[part]
  }
  return current
}

function diagnosticSnapshots(bundle) {
  const snapshots = []
  if (isPlainObject(bundle.diagnostics)) {
    snapshots.push(bundle.diagnostics)
  }
  if (Array.isArray(bundle.sessions)) {
    for (const session of bundle.sessions) {
      if (isPlainObject(session?.finalDiagnostics)) {
        snapshots.push(session.finalDiagnostics)
      }
    }
  }
  return snapshots
}

function hasWindowsCaptureBackendProof(devices) {
  const availableDevices = devices.filter((device) => device?.status === 'available')
  return (
    availableDevices.some(
      (device) =>
        (device.kind === 'screen' || device.kind === 'window') &&
        windowsBackendText(device).match(/\b(dxgi|gdigrab|desktop duplication)\b/i)
    ) &&
    availableDevices.some(
      (device) =>
        device.kind === 'camera' &&
        windowsBackendText(device).match(/\b(dshow|directshow|mediafoundation)\b/i)
    ) &&
    availableDevices.some(
      (device) => device.kind === 'microphone' && windowsBackendText(device).match(/\bdshow\b/i)
    )
  )
}

function windowsBackendText(device) {
  return [device.id, device.name, device.detail].filter(Boolean).join(' ')
}

function windowsBuildNumber(release) {
  if (typeof release !== 'string' || !release.trim()) {
    return null
  }
  const parts = release.split('.')
  const build = Number(parts[2])
  return Number.isFinite(build) ? build : null
}

function stringOrNumber(value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value
  }
  if (typeof value === 'string' && value.trim()) {
    return value
  }
  return undefined
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function normalizeKey(key) {
  return String(key).replace(/[_-]/g, '').toLowerCase()
}

function isSecretKey(key) {
  if (key === 'secretstorebackend') {
    return false
  }
  return (
    key.includes('token') ||
    key.includes('secret') ||
    key.includes('streamkey') ||
    key.includes('apikey') ||
    key.includes('authorization') ||
    key.includes('password')
  )
}

function isMediaPathKey(key) {
  return new Set([
    'outputpath',
    'outputfile',
    'mp4path',
    'mp4file',
    'filepath',
    'file',
    'audiopath',
    'markdownpath',
    'recordingpath'
  ]).has(key)
}

function isAiArtifactBody(path, normalizedKey) {
  return path.includes('aiArtifacts') && AI_ARTIFACT_BODY_KEYS.has(normalizedKey)
}

function isRedacted(value) {
  return /^<redacted:[^>]+>$/.test(value)
}

function isRedactedSecret(value) {
  return value === '<redacted:secret>' || value.includes('<redacted:')
}

function isRedactedPath(value) {
  return /^<redacted:path:[^/\\>]+>$/.test(value)
}

function hasUnredactedUrlSecret(value) {
  if (value.includes('<redacted:')) {
    return false
  }
  if (/^[a-z][a-z0-9+.-]*:\/\/[^/\s]+@/i.test(value)) {
    return true
  }
  return value.startsWith('rtmp://') || value.startsWith('rtmps://')
}

function looksLikeInlineSecret(value) {
  return (
    /\bsk-[A-Za-z0-9_-]{8,}/.test(value) ||
    /\bghp_[A-Za-z0-9_]{8,}/.test(value) ||
    /\bxox[baprs]-[A-Za-z0-9-]{8,}/.test(value) ||
    /(?:access_token|refresh_token|stream_key|api_key|client_secret)=([^&\s]+)/i.test(value)
  )
}

function looksLikeHomePath(value) {
  return /(^|\s)(\/Users\/[^/\s]+|\/home\/[^/\s]+|[A-Za-z]:\\Users\\[^\\\s]+)/.test(value)
}
