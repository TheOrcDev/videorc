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
  if (argv.length === 0) {
    return [...WINDOWS_ENCODED_BRIDGE_PROFILES]
  }
  if (argv[0] !== '--profiles') {
    throw new Error(`Unknown Windows encoded-bridge argument: ${argv[0]}`)
  }

  const value = argv[1]
  if (value === undefined || value.startsWith('--')) {
    throw new Error('--profiles requires a comma-separated value.')
  }
  const trailing = argv.slice(2)
  if (trailing.length > 0) {
    if (trailing[0] === '--profiles') {
      throw new Error('--profiles may be supplied only once.')
    }
    throw new Error(`Unknown Windows encoded-bridge argument: ${trailing[0]}`)
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
  return WINDOWS_ENCODED_BRIDGE_PROFILES.filter((profile) => requestedIds.has(profile.id))
}
