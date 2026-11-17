/**
 * Plan 249 S17. What a cloud talk show's outputs are, said truthfully.
 * Mirrored in the web (`lib/cloud/media/output-profile.ts`); the two copies
 * differ only in formatting and are pinned by the same vectors
 * (`protocol-fixtures/cloud-parity-outputs.json`).
 *
 * - Managed egress encodes every program output the same way
 *   (`MANAGED_ENCODING`): 1080p (1920x1080, or 1080x1920 upright), H.264 High,
 *   6 Mbps, 60 fps, 2 s keyframes, AAC 160 kbps at 48 kHz.
 * - Plan 234 Phase 0 (docs/cloud/spike-livekit-managed-2026-11.md) passed
 *   1080p at 6 Mbps with a 30 fps picture; 60 fps motion failed its frame
 *   test. So a 60 fps request is sent as the qualified 30 fps picture inside
 *   the 60 fps stream, and the room says so before it opens.
 * - Above 1080p (1440p, 4K) nothing is measured: such a request is refused
 *   with its reason, never sent as 1080p under a higher claim. A profile is
 *   qualified only by a measured record in `MANAGED_HIGHER_PROFILES`; none
 *   has one, and nothing here can turn one on.
 * - Each orientation is its own egress, and a recording is its own egress
 *   beside a stream (the `rec=1` page), so record-only layers stay
 *   independent. No price is stated: none is published for a show.
 */
export type ManagedOrientationName = 'horizontal' | 'vertical'
export type ManagedOutput = {
  orientation: ManagedOrientationName
  width: number
  height: number
  fps: number
  videoKbps: number
  audioKbps?: number
}
export const MANAGED_ENCODING = {
  framerate: 60,
  videoBitrateKbps: 6000,
  audioBitrateKbps: 160,
  audioFrequency: 48000,
  keyFrameIntervalSeconds: 2
} as const
/** The measured profile: 1080p with a 30 fps picture (Plan 234 Phase 0). */
export const MANAGED_QUALIFIED = {
  longSide: 1920,
  shortSide: 1080,
  pictureFps: 30,
  evidence: 'Plan 234 Phase 0, 2026-11-13: 1080p 6 Mbps passed; 60 fps motion failed'
} as const
/** Higher profiles and their qualification: measured records only, none yet. */
export const MANAGED_HIGHER_PROFILES = [
  { label: '1440p', longSide: 2560, shortSide: 1440, qualification: 'not-run' },
  { label: '4K', longSide: 3840, shortSide: 2160, qualification: 'not-run' }
] as const
export type ManagedOutputDifference = 'resolution' | 'fps' | 'bitrate'
export type ManagedEffectiveOutput = ManagedOutput & {
  audioKbps: number
  /** The picture's qualified cadence inside the encoded stream. */
  pictureFps: number
  differences: ManagedOutputDifference[]
}
export type ManagedOutputProfile = {
  version: 1
  requested: ManagedOutput[]
  effective: ManagedEffectiveOutput[]
  qualification: 'phase0-1080p30-picture'
  higherProfilesQualified: false
  pricePerHour: null
  /** One stream egress and one recording egress per orientation, at most. */
  maxProgramEgresses: number
}

const sides = (orientation: ManagedOrientationName): { width: number; height: number } =>
  orientation === 'vertical'
    ? { width: MANAGED_QUALIFIED.shortSide, height: MANAGED_QUALIFIED.longSide }
    : { width: MANAGED_QUALIFIED.longSide, height: MANAGED_QUALIFIED.shortSide }

/** Why these outputs can't open a room, or null. Bitrate and 60 fps are disclosed, not refused. */
export function managedOutputProblem(outputs: readonly ManagedOutput[]): string | null {
  if (
    outputs.length < 1 ||
    outputs.length > 2 ||
    new Set(outputs.map((o) => o.orientation)).size !== outputs.length
  )
    return 'Choose one output per orientation before opening the room.'
  for (const o of outputs) {
    if (
      (o.orientation !== 'horizontal' && o.orientation !== 'vertical') ||
      ![o.width, o.height, o.fps, o.videoKbps].every((n) => Number.isSafeInteger(n) && n > 0)
    )
      return 'Cloud room outputs need a size, a frame rate and a bitrate.'
    const { width, height } = sides(o.orientation)
    if (o.width * height !== o.height * width)
      return o.orientation === 'vertical'
        ? 'A vertical cloud output must be 9:16.'
        : 'A horizontal cloud output must be 16:9.'
    if (o.width > width || o.height > height) {
      const higher = MANAGED_HIGHER_PROFILES.find((p) => Math.max(o.width, o.height) <= p.longSide)
      return `Cloud talk shows send 1080p. ${higher?.label ?? 'This size'} hasn't been measured on cloud outputs yet, so it can't be used. Choose 1080p or lower for the room, or stream directly.`
    }
    if (o.fps > MANAGED_ENCODING.framerate)
      return `Cloud talk shows send at most ${MANAGED_ENCODING.framerate} fps.`
  }
  return null
}

/** What each requested output becomes, and how it differs from the request. */
export function managedOutputProfile(requested: readonly ManagedOutput[]): ManagedOutputProfile {
  return {
    version: 1,
    requested: requested.map((o) => ({ ...o })),
    effective: requested.map((o) => {
      const { width, height } = sides(o.orientation)
      const differences: ManagedOutputDifference[] = []
      if (o.width !== width || o.height !== height) differences.push('resolution')
      if (o.fps > MANAGED_QUALIFIED.pictureFps) differences.push('fps')
      if (o.videoKbps !== MANAGED_ENCODING.videoBitrateKbps) differences.push('bitrate')
      return {
        orientation: o.orientation,
        width,
        height,
        fps: MANAGED_ENCODING.framerate,
        pictureFps: MANAGED_QUALIFIED.pictureFps,
        videoKbps: MANAGED_ENCODING.videoBitrateKbps,
        audioKbps: MANAGED_ENCODING.audioBitrateKbps,
        differences
      }
    }),
    qualification: 'phase0-1080p30-picture',
    higherProfilesQualified: false,
    pricePerHour: null,
    maxProgramEgresses: requested.length * 2
  }
}

/**
 * Whether a destination can go to this room, before anything is prepared on
 * its platform: its orientation must be one the room opened with, and its
 * address an RTMP or RTMPS one (the web's own guard). Any platform may take
 * either orientation; the platform decides what it accepts.
 */
export function managedDestinationProblem(
  destination: { label: string; orientation: ManagedOrientationName; url?: string },
  outputs: readonly Pick<ManagedOutput, 'orientation'>[]
): string | null {
  if (destination.orientation !== 'horizontal' && destination.orientation !== 'vertical')
    return `${destination.label} needs a horizontal or vertical output.`
  if (!outputs.some((o) => o.orientation === destination.orientation))
    return `${destination.label} is ${destination.orientation}, and this room opened without a ${destination.orientation} output. Close the room and open it again with ${destination.label} on.`
  if (
    destination.url !== undefined &&
    destination.url !== '' &&
    !/^rtmps?:\/\//i.test(destination.url)
  )
    return `${destination.label} needs an rtmp:// or rtmps:// address for cloud output.`
  return null
}

const ORIENTATION_WORD = { horizontal: 'Horizontal', vertical: 'Vertical' } as const

/** One sentence per output: what viewers get, and what differs from the request. */
export function managedProfileDescription(profile: ManagedOutputProfile | undefined): string {
  if (!profile || profile.version !== 1)
    return "This room didn't report its output profile. Reopen the room to see it."
  const lines = profile.effective.map((o) => {
    const notes: string[] = []
    if (o.differences.includes('resolution')) notes.push('scaled to 1080p')
    if (o.differences.includes('fps')) notes.push(`${o.pictureFps} fps picture`)
    if (o.differences.includes('bitrate')) notes.push(`${o.videoKbps / 1000} Mbps`)
    return `${ORIENTATION_WORD[o.orientation]} ${o.width}×${o.height}, ${o.pictureFps} fps picture in a ${o.fps} fps stream, ${o.videoKbps / 1000} Mbps H.264, AAC ${o.audioKbps} kbps${notes.length ? ` (differs from your settings: ${notes.join(', ')})` : ''}`
  })
  return `${lines.join('. ')}. ${profile.effective.length === 2 ? 'Each orientation is its own cloud output' : 'One cloud output'}; recording adds one per orientation. 1440p and 4K aren't available yet.`
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v)
const count = (v: unknown, max: number): v is number =>
  typeof v === 'number' && Number.isSafeInteger(v) && v > 0 && v <= max
function parseOutput(value: unknown): ManagedOutput | null {
  if (
    !isRecord(value) ||
    (value.orientation !== 'horizontal' && value.orientation !== 'vertical') ||
    !count(value.width, 8192) ||
    !count(value.height, 8192) ||
    !count(value.fps, 240) ||
    !count(value.videoKbps, 100_000) ||
    (value.audioKbps !== undefined && !count(value.audioKbps, 1024))
  )
    return null
  return {
    orientation: value.orientation,
    width: value.width,
    height: value.height,
    fps: value.fps,
    videoKbps: value.videoKbps,
    ...(value.audioKbps !== undefined ? { audioKbps: value.audioKbps as number } : {})
  }
}
const DIFFERENCES: readonly ManagedOutputDifference[] = ['resolution', 'fps', 'bitrate']

/** The status's `show.outputProfile`, bounded; anything else is no profile. */
export function parseManagedOutputProfile(value: unknown): ManagedOutputProfile | null {
  if (
    !isRecord(value) ||
    value.version !== 1 ||
    value.qualification !== 'phase0-1080p30-picture' ||
    value.higherProfilesQualified !== false ||
    value.pricePerHour !== null ||
    !count(value.maxProgramEgresses, 4) ||
    !Array.isArray(value.requested) ||
    !Array.isArray(value.effective) ||
    value.requested.length < 1 ||
    value.requested.length > 2 ||
    value.effective.length !== value.requested.length
  )
    return null
  const requested = value.requested.map(parseOutput)
  if (requested.some((o) => o === null)) return null
  const effective: ManagedEffectiveOutput[] = []
  for (const entry of value.effective) {
    const output = parseOutput(entry)
    if (
      !output ||
      !isRecord(entry) ||
      !count(entry.pictureFps, 240) ||
      !count(entry.audioKbps, 1024) ||
      !Array.isArray(entry.differences) ||
      entry.differences.length > DIFFERENCES.length ||
      !entry.differences.every((d) => DIFFERENCES.includes(d as ManagedOutputDifference))
    )
      return null
    effective.push({
      ...output,
      audioKbps: entry.audioKbps,
      pictureFps: entry.pictureFps,
      differences: [...(entry.differences as ManagedOutputDifference[])]
    })
  }
  return {
    version: 1,
    requested: requested as ManagedOutput[],
    effective,
    qualification: 'phase0-1080p30-picture',
    higherProfilesQualified: false,
    pricePerHour: null,
    maxProgramEgresses: value.maxProgramEgresses
  }
}
