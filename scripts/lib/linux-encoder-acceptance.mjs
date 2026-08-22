export const LINUX_ENCODER_ACCEPTANCE_BACKENDS = Object.freeze(['openh264', 'vaapi'])

const EXPECTED_DIAGNOSTIC_BACKEND = Object.freeze({
  openh264: 'software-open-h264',
  vaapi: 'hardware-vaapi'
})

export function parseLinuxEncoderAcceptanceArgs(args) {
  let requested = 'all'
  let sawBackend = false

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]
    let value
    if (argument === '--backend') {
      value = args[index + 1]
      index += 1
      if (!value) throw new Error('--backend requires all, openh264, or vaapi')
    } else if (argument.startsWith('--backend=')) {
      value = argument.slice('--backend='.length)
    } else {
      throw new Error(`Unknown Linux encoder acceptance argument: ${argument}`)
    }

    if (sawBackend) throw new Error('--backend may be provided only once')
    sawBackend = true
    requested = value
  }

  if (requested === 'all') {
    return { requested, backends: [...LINUX_ENCODER_ACCEPTANCE_BACKENDS] }
  }
  if (!LINUX_ENCODER_ACCEPTANCE_BACKENDS.includes(requested)) {
    throw new Error(`--backend must be all, openh264, or vaapi; got ${requested}`)
  }
  return { requested, backends: [requested] }
}

export function parseOsRelease(text) {
  return Object.fromEntries(
    String(text ?? '')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('#') && line.includes('='))
      .map((line) => {
        const separator = line.indexOf('=')
        const key = line.slice(0, separator)
        const rawValue = line.slice(separator + 1)
        const quoted =
          (rawValue.startsWith('"') && rawValue.endsWith('"')) ||
          (rawValue.startsWith("'") && rawValue.endsWith("'"))
        return [key, quoted ? rawValue.slice(1, -1) : rawValue]
      })
  )
}

export function assessLinuxEncoderAcceptanceHost({
  platform,
  arch,
  osRelease,
  testerName,
  machineName,
  physicalHardware,
  videoDevices,
  renderDevices,
  backends
}) {
  const problems = []
  if (platform !== 'linux' || arch !== 'x64') {
    problems.push(`requires Linux x64, got ${platform}/${arch}`)
  }
  if (osRelease?.ID !== 'ubuntu' || osRelease?.VERSION_ID !== '24.04') {
    problems.push(
      `requires Ubuntu 24.04, got ${osRelease?.PRETTY_NAME ?? `${osRelease?.ID ?? 'unknown'} ${osRelease?.VERSION_ID ?? 'unknown'}`}`
    )
  }
  if (!String(testerName ?? '').trim()) {
    problems.push('VIDEORC_LINUX_TESTER_NAME must name the person running acceptance')
  }
  if (!String(machineName ?? '').trim()) {
    problems.push('VIDEORC_LINUX_TESTER_MACHINE must name the specific hardware box')
  }
  if (physicalHardware !== '1') {
    problems.push('VIDEORC_LINUX_PHYSICAL_HARDWARE=1 must attest this is a real, non-VM box')
  }
  if (!Array.isArray(videoDevices) || videoDevices.length === 0) {
    problems.push('the named tester box must expose a webcam as /dev/video*')
  }
  if (
    backends.includes('vaapi') &&
    (!Array.isArray(renderDevices) || renderDevices.length === 0)
  ) {
    problems.push('VAAPI acceptance requires at least one /dev/dri/renderD* device')
  }
  return { ok: problems.length === 0, problems }
}

export function assessLinuxEncoderMatrixResults({ backend, results }) {
  const problems = []
  const expectedDiagnosticBackend = EXPECTED_DIAGNOSTIC_BACKEND[backend]
  if (!expectedDiagnosticBackend) {
    return { ok: false, problems: [`unknown Linux encoder backend ${backend}`], result: null }
  }
  if (!Array.isArray(results) || results.length !== 1) {
    return {
      ok: false,
      problems: [`expected exactly one 1080p30 matrix result, got ${results?.length ?? 'none'}`],
      result: null
    }
  }

  const result = results[0]
  if (result.combo !== '1080p30') problems.push(`expected combo 1080p30, got ${result.combo}`)
  if (!Array.isArray(result.failures)) {
    problems.push('matrix result omitted its failures array')
  } else if (result.failures.length > 0) {
    problems.push(...result.failures.map((failure) => `matrix failure: ${failure}`))
  }
  if (!String(result.outputPath ?? '').trim() || !(result.sizeBytes > 0)) {
    problems.push('matrix result did not prove a non-empty recording artifact')
  }
  if (result.metrics?.width !== 1920 || result.metrics?.height !== 1080) {
    problems.push(
      `expected a 1920x1080 artifact, got ${result.metrics?.width ?? '?'}x${result.metrics?.height ?? '?'}`
    )
  }
  if (
    typeof result.metrics?.observedFps !== 'number' ||
    Math.abs(result.metrics.observedFps - 30) > 0.6
  ) {
    problems.push(`expected artifact cadence near 30fps, got ${result.metrics?.observedFps ?? '?'}`)
  }
  if (result.bridgeDiagnostics?.encodeBackend !== expectedDiagnosticBackend) {
    problems.push(
      `expected diagnostics backend ${expectedDiagnosticBackend}, got ${result.bridgeDiagnostics?.encodeBackend ?? 'missing'}`
    )
  }

  return { ok: problems.length === 0, problems, result }
}
