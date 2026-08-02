export const WINDOWS_ENCODED_BRIDGE_PROFILES = Object.freeze([
  Object.freeze({ id: '1080p30', width: 1920, height: 1080, fps: 30, bitrateKbps: 6000 }),
  Object.freeze({ id: '1080p60', width: 1920, height: 1080, fps: 60, bitrateKbps: 9000 }),
  Object.freeze({ id: '1440p30', width: 2560, height: 1440, fps: 30, bitrateKbps: 12000 }),
  Object.freeze({ id: '1440p60', width: 2560, height: 1440, fps: 60, bitrateKbps: 18000 }),
  Object.freeze({ id: '4k30', width: 3840, height: 2160, fps: 30, bitrateKbps: 30000 }),
  Object.freeze({
    id: 'vertical-1080p30',
    width: 1080,
    height: 1920,
    fps: 30,
    bitrateKbps: 6000
  }),
  Object.freeze({
    id: 'vertical-1080p60',
    width: 1080,
    height: 1920,
    fps: 60,
    bitrateKbps: 9000
  }),
  Object.freeze({
    id: 'vertical-1440p30',
    width: 1440,
    height: 2560,
    fps: 30,
    bitrateKbps: 12000
  }),
  Object.freeze({
    id: 'vertical-1440p60',
    width: 1440,
    height: 2560,
    fps: 60,
    bitrateKbps: 18000
  }),
  Object.freeze({
    id: 'vertical-4k30',
    width: 2160,
    height: 3840,
    fps: 30,
    bitrateKbps: 30000
  })
])

export function selectWindowsEncodedBridgeProfiles(argv = []) {
  return parseWindowsEncodedBridgeArgs(argv).profiles
}

export function parseWindowsEncodedBridgeArgs(argv = []) {
  const values = [...argv]
  const d3d11 = takeFlag(values, '--d3d11')
  const requireD3d11 = takeFlag(values, '--require-d3d11')
  const expectFallback = takeOption(values, '--expect-fallback')
  const value = takeOption(values, '--profiles')
  if (values.length > 0) {
    throw new Error(`Unknown Windows encoded-bridge argument: ${values[0]}`)
  }
  if (requireD3d11 && !d3d11) {
    throw new Error('--require-d3d11 requires --d3d11.')
  }
  if (expectFallback !== undefined && expectFallback !== 'natural') {
    throw new Error(`--expect-fallback must be natural; received ${expectFallback}.`)
  }
  if (expectFallback === 'natural' && (d3d11 || requireD3d11)) {
    throw new Error('--expect-fallback natural cannot be combined with an explicit D3D11 path.')
  }
  if (value === undefined) {
    return {
      profiles: [...WINDOWS_ENCODED_BRIDGE_PROFILES],
      d3d11,
      requireD3d11,
      expectFallback: expectFallback ?? null
    }
  }

  const requested = value.split(',').map((id) => id.trim())
  if (requested.length === 0 || requested.some((id) => id.length === 0)) {
    throw new Error('--profiles must contain at least one non-empty profile ID.')
  }
  const duplicates = requested.filter((id, index) => requested.indexOf(id) !== index)
  if (duplicates.length > 0) {
    throw new Error(`Duplicate Windows encoded-bridge profile: ${duplicates[0]}`)
  }

  const knownIds = new Set(WINDOWS_ENCODED_BRIDGE_PROFILES.map((profile) => profile.id))
  const unknown = requested.find((id) => !knownIds.has(id))
  if (unknown) {
    throw new Error(`Unknown Windows encoded-bridge profile: ${unknown}`)
  }

  const requestedIds = new Set(requested)
  return {
    profiles: WINDOWS_ENCODED_BRIDGE_PROFILES.filter((profile) => requestedIds.has(profile.id)),
    d3d11,
    requireD3d11,
    expectFallback: expectFallback ?? null
  }
}

function takeFlag(values, name) {
  const matches = values.reduce((count, value) => count + (value === name ? 1 : 0), 0)
  if (matches > 1) throw new Error(`${name} may be supplied only once.`)
  if (matches === 0) return false
  values.splice(values.indexOf(name), 1)
  return true
}

function takeOption(values, name) {
  const indexes = values
    .map((value, index) => (value === name ? index : -1))
    .filter((index) => index >= 0)
  if (indexes.length > 1) throw new Error(`${name} may be supplied only once.`)
  if (indexes.length === 0) return undefined
  const index = indexes[0]
  const value = values[index + 1]
  if (value === undefined || value.startsWith('--')) {
    throw new Error(`${name} requires a comma-separated value.`)
  }
  values.splice(index, 2)
  return value
}
