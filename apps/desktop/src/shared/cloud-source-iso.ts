// Plan 249 S22: desktop mirror of the web cloud ISO manifest parser
// (videorc-web `lib/cloud/iso/manifest.ts`) and of the backend import plan
// (`crates/videorc-backend/src/cloud_source_iso.rs`). All three must accept
// `protocol-fixtures/cloud-source-iso.json` `valid` and refuse every
// `invalid` case. A mixed take alone never produces ISO, and nothing here is
// production-qualified: there is no UI or RPC that enables cloud ISO yet.

export const ISO_ROLES = [
  'host-camera',
  'host-microphone',
  'host-aux',
  'host-screen',
  'guest-camera',
  'guest-microphone',
  'guest-screen',
  'guest-screen-audio'
] as const
export type IsoRole = (typeof ISO_ROLES)[number]
export type IsoTrackKind = 'audio' | 'video'
export const GUEST_IDENTITY = /^g_[A-Za-z0-9_-]{1,128}$/
export const TRACK_SID = /^TR_[A-Za-z0-9]{1,64}$/
export const TAKE_ID_PATTERN = /^tk_[0-9A-Za-z]{12}$/
export const DECLARED_LAYOUTS = ['opaque', 'rgb-left-alpha-right:g8'] as const
export type IsoDeclaredLayout = (typeof DECLARED_LAYOUTS)[number]
/** v1: host camera layout is `unknown` until a verified descriptor exists; a track name is never authority. */
export type IsoFrameLayout = {
  basis: 'role-opaque' | 'unavailable'
  layout: 'opaque' | 'unknown'
  declared: IsoDeclaredLayout | null
} | null
export const HOST_SUBJECT = 'host'
export function roleKind(role: IsoRole): IsoTrackKind {
  return role.endsWith('camera') || role.endsWith('screen') ? 'video' : 'audio'
}
export function isIsoRole(value: unknown): value is IsoRole {
  return typeof value === 'string' && (ISO_ROLES as readonly string[]).includes(value)
}

export const ISO_MANIFEST_VERSION = 1 as const
export const ISO_MANIFEST_KIND = 'videorc.cloud-iso' as const

/** Structural bounds every parser enforces before trusting a manifest. */
export const ISO_MANIFEST_BOUNDS = {
  maxEntries: 48,
  maxRefused: 64,
  maxGuests: 16,
  maxLiveIntervals: 32,
  maxGenerationsPerSlot: 6
} as const

export const ISO_ENTRY_STATES = [
  'starting',
  'recording',
  'complete',
  'partial',
  'failed',
  'expired'
] as const
export type IsoEntryState = (typeof ISO_ENTRY_STATES)[number]

export const ISO_FAILURES = [
  'start-failed',
  'provider-failed',
  'provider-aborted',
  'limit-reached',
  'missing-output',
  'stop-failed',
  /** The start call's outcome is unknown and no egress was found for it. */
  'start-unknown'
] as const
export type IsoFailure = (typeof ISO_FAILURES)[number]

export const ISO_END_REASONS = [
  'unpublished',
  'stopped',
  'take-ended',
  'budget-exhausted',
  'time-limit',
  'consent-withdrawn'
] as const
export type IsoEndReason = (typeof ISO_END_REASONS)[number]

export type IsoEntry = {
  /** `<subject>/<role>/g<generation>`: unique within a manifest. */
  id: string
  role: IsoRole
  subject: string
  generation: number
  trackSid: string
  kind: IsoTrackKind
  mimeType: string
  state: IsoEntryState
  egressId: string | null
  /** Relative to the take folder: `iso/<role>/<subject>-g<generation>`. */
  objectPrefix: string
  /** Provider-reported object key once complete; never assumed. */
  objectKey: string | null
  requestedAtMs: number
  startedAtMs: number | null
  endedAtMs: number | null
  /** `startedAtMs - clock.originAtMs`; null until the provider reports a start. */
  offsetMs: number | null
  durationMs: number | null
  bytes: number | null
  /** Another generation of the same slot was live at the same time. */
  overlap: boolean
  /** Video only. v1 never trusts a declared layout (see `frameLayoutFor`). */
  frameLayout: IsoFrameLayout
  endReason: IsoEndReason | null
  failure: IsoFailure | null
}

export type IsoReservation = {
  maxActiveEntries: number
  maxMinutes: number
  ceilingMicros: number
  estimateMicros: number
  deadlineAtMs: number
}

export type IsoManifestV1 = {
  v: typeof ISO_MANIFEST_VERSION
  kind: typeof ISO_MANIFEST_KIND
  showId: string
  takeId: string
  orientation: 'h' | 'v'
  liveIntervalIds: string[]
  clock: {
    origin: 'program-take-start'
    originAtMs: number
    basis: 'provider-egress-start'
    uncertainty: 'unmeasured'
  }
  consent: { hostAtMs: number; guests: Record<string, number> }
  reservation: IsoReservation
  meter: { egressMs: number; costMicros: number }
  createdAtMs: number
  expiresAtMs: number
  stoppedAtMs: number | null
  stopReason: IsoEndReason | null
  entries: IsoEntry[]
  refused: Array<{ trackSid: string; reason: string }>
  productionQualified: false
}

export function entryId(subject: string, role: IsoRole, generation: number) {
  return `${subject}/${role}/g${generation}`
}

export function entryObjectPrefix(subject: string, role: IsoRole, generation: number) {
  return `iso/${role}/${subject}-g${generation}`
}

export function isTerminal(state: IsoEntryState): boolean {
  return state !== 'starting' && state !== 'recording'
}

export class IsoManifestError extends Error {
  constructor(readonly field: string) {
    super(`Invalid ISO manifest: ${field}`)
    this.name = 'IsoManifestError'
  }
}

const SHOW_ID = /^sh_[A-Za-z0-9_-]{8,64}$/
const EGRESS_ID = /^EG_[A-Za-z0-9]{1,64}$/
const INTERVAL_ID = /^[A-Za-z0-9_-]{1,64}$/
const MIME = /^(audio|video)\/[A-Za-z0-9.+-]{1,32}$/
const REFUSAL = /^[a-z-]{1,40}$/

type Obj = Record<string, unknown>
const obj = (v: unknown, f: string): Obj => {
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new IsoManifestError(f)
  return v as Obj
}
const int = (v: unknown, f: string, min = 0): number => {
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < min) throw new IsoManifestError(f)
  return v
}
const intOrNull = (v: unknown, f: string, min = 0) => (v === null ? null : int(v, f, min))
const str = (v: unknown, f: string, re: RegExp): string => {
  if (typeof v !== 'string' || !re.test(v)) throw new IsoManifestError(f)
  return v
}
const oneOf = <T extends string>(v: unknown, f: string, list: readonly T[]): T => {
  if (typeof v !== 'string' || !(list as readonly string[]).includes(v))
    throw new IsoManifestError(f)
  return v as T
}
const exactKeys = (o: Obj, keys: readonly string[], f: string) => {
  const actual = Object.keys(o).sort()
  const want = [...keys].sort()
  if (actual.length !== want.length || actual.some((k, i) => k !== want[i]))
    throw new IsoManifestError(`${f}.keys`)
}

const ENTRY_KEYS = [
  'id',
  'role',
  'subject',
  'generation',
  'trackSid',
  'kind',
  'mimeType',
  'state',
  'egressId',
  'objectPrefix',
  'objectKey',
  'requestedAtMs',
  'startedAtMs',
  'endedAtMs',
  'offsetMs',
  'durationMs',
  'bytes',
  'overlap',
  'frameLayout',
  'endReason',
  'failure'
] as const

function parseEntry(
  value: unknown,
  index: number,
  m: { takeId: string; originAtMs: number }
): IsoEntry {
  const f = `entries[${index}]`
  const e = obj(value, f)
  exactKeys(e, ENTRY_KEYS, f)
  if (!isIsoRole(e.role)) throw new IsoManifestError(`${f}.role`)
  const role = e.role
  const host = role.startsWith('host-')
  const subject = host
    ? str(e.subject, `${f}.subject`, /^host$/)
    : str(e.subject, `${f}.subject`, GUEST_IDENTITY)
  if (host !== (subject === HOST_SUBJECT)) throw new IsoManifestError(`${f}.subject`)
  const generation = int(e.generation, `${f}.generation`, 1)
  if (generation > ISO_MANIFEST_BOUNDS.maxGenerationsPerSlot)
    throw new IsoManifestError(`${f}.generation`)
  if (e.id !== entryId(subject, role, generation)) throw new IsoManifestError(`${f}.id`)
  if (e.kind !== roleKind(role)) throw new IsoManifestError(`${f}.kind`)
  const mimeType = str(e.mimeType, `${f}.mimeType`, MIME)
  if (!mimeType.startsWith(`${roleKind(role)}/`)) throw new IsoManifestError(`${f}.mimeType`)
  if (e.objectPrefix !== entryObjectPrefix(subject, role, generation))
    throw new IsoManifestError(`${f}.objectPrefix`)
  const state = oneOf(e.state, `${f}.state`, ISO_ENTRY_STATES)
  const egressId = e.egressId === null ? null : str(e.egressId, `${f}.egressId`, EGRESS_ID)
  let objectKey: string | null = null
  if (e.objectKey !== null) {
    objectKey = str(e.objectKey, `${f}.objectKey`, /^[A-Za-z0-9_./-]{1,512}$/)
    if (
      objectKey.includes('..') ||
      objectKey.startsWith('/') ||
      !objectKey.includes(`/${m.takeId}/${e.objectPrefix}`)
    )
      throw new IsoManifestError(`${f}.objectKey`)
  }
  const requestedAtMs = int(e.requestedAtMs, `${f}.requestedAtMs`)
  const startedAtMs = intOrNull(e.startedAtMs, `${f}.startedAtMs`)
  const endedAtMs = intOrNull(e.endedAtMs, `${f}.endedAtMs`)
  if (startedAtMs !== null && endedAtMs !== null && endedAtMs < startedAtMs)
    throw new IsoManifestError(`${f}.endedAtMs`)
  let offsetMs: number | null = null
  if (e.offsetMs !== null) {
    offsetMs = int(e.offsetMs, `${f}.offsetMs`, Number.MIN_SAFE_INTEGER)
    if (startedAtMs === null || offsetMs !== startedAtMs - m.originAtMs)
      throw new IsoManifestError(`${f}.offsetMs`)
  } else if (startedAtMs !== null) throw new IsoManifestError(`${f}.offsetMs`)
  const durationMs = intOrNull(e.durationMs, `${f}.durationMs`)
  const bytes = intOrNull(e.bytes, `${f}.bytes`)
  if (typeof e.overlap !== 'boolean') throw new IsoManifestError(`${f}.overlap`)
  let frameLayout: IsoFrameLayout = null
  if (roleKind(role) === 'video') {
    const l = obj(e.frameLayout, `${f}.frameLayout`)
    exactKeys(l, ['basis', 'layout', 'declared'], `${f}.frameLayout`)
    const declared =
      l.declared === null ? null : oneOf(l.declared, `${f}.frameLayout.declared`, DECLARED_LAYOUTS)
    if (role === 'host-camera') {
      // v1: a host camera layout is never trusted (no verified descriptor).
      if (l.basis !== 'unavailable' || l.layout !== 'unknown')
        throw new IsoManifestError(`${f}.frameLayout`)
      frameLayout = { basis: 'unavailable', layout: 'unknown', declared }
    } else {
      if (l.basis !== 'role-opaque' || l.layout !== 'opaque' || declared)
        throw new IsoManifestError(`${f}.frameLayout`)
      frameLayout = { basis: 'role-opaque', layout: 'opaque', declared: null }
    }
  } else if (e.frameLayout !== null) throw new IsoManifestError(`${f}.frameLayout`)
  const endReason =
    e.endReason === null ? null : oneOf(e.endReason, `${f}.endReason`, ISO_END_REASONS)
  const failure = e.failure === null ? null : oneOf(e.failure, `${f}.failure`, ISO_FAILURES)
  // State coherence: complete needs provider output; failed needs a cause.
  if (state === 'complete' && (objectKey === null || startedAtMs === null))
    throw new IsoManifestError(`${f}.state`)
  if (state === 'failed' && failure === null) throw new IsoManifestError(`${f}.failure`)
  if (!isTerminal(state) && (failure !== null || endedAtMs !== null))
    throw new IsoManifestError(`${f}.state`)
  return {
    id: e.id as string,
    role,
    subject,
    generation,
    trackSid: str(e.trackSid, `${f}.trackSid`, TRACK_SID),
    kind: roleKind(role),
    mimeType,
    state,
    egressId,
    objectPrefix: e.objectPrefix as string,
    objectKey,
    requestedAtMs,
    startedAtMs,
    endedAtMs,
    offsetMs,
    durationMs,
    bytes,
    overlap: e.overlap,
    frameLayout,
    endReason,
    failure
  }
}

const MANIFEST_KEYS = [
  'v',
  'kind',
  'showId',
  'takeId',
  'orientation',
  'liveIntervalIds',
  'clock',
  'consent',
  'reservation',
  'meter',
  'createdAtMs',
  'expiresAtMs',
  'stoppedAtMs',
  'stopReason',
  'entries',
  'refused',
  'productionQualified'
] as const

/** Strict parser: unknown keys, unbounded lists and incoherent states fail closed. */
export function parseIsoManifest(value: unknown): IsoManifestV1 {
  const m = obj(value, 'manifest')
  exactKeys(m, MANIFEST_KEYS, 'manifest')
  if (m.v !== ISO_MANIFEST_VERSION) throw new IsoManifestError('v')
  if (m.kind !== ISO_MANIFEST_KIND) throw new IsoManifestError('kind')
  if (m.productionQualified !== false) throw new IsoManifestError('productionQualified')
  const showId = str(m.showId, 'showId', SHOW_ID)
  const takeId = str(m.takeId, 'takeId', TAKE_ID_PATTERN)
  const orientation = oneOf(m.orientation, 'orientation', ['h', 'v'] as const)
  if (
    !Array.isArray(m.liveIntervalIds) ||
    m.liveIntervalIds.length > ISO_MANIFEST_BOUNDS.maxLiveIntervals
  )
    throw new IsoManifestError('liveIntervalIds')
  const liveIntervalIds = m.liveIntervalIds.map((id, i) =>
    str(id, `liveIntervalIds[${i}]`, INTERVAL_ID)
  )
  const clock = obj(m.clock, 'clock')
  exactKeys(clock, ['origin', 'originAtMs', 'basis', 'uncertainty'], 'clock')
  if (
    clock.origin !== 'program-take-start' ||
    clock.basis !== 'provider-egress-start' ||
    clock.uncertainty !== 'unmeasured'
  )
    throw new IsoManifestError('clock')
  const originAtMs = int(clock.originAtMs, 'clock.originAtMs', 1)
  const consent = obj(m.consent, 'consent')
  exactKeys(consent, ['hostAtMs', 'guests'], 'consent')
  const guestsIn = obj(consent.guests, 'consent.guests')
  const guestIds = Object.keys(guestsIn)
  if (guestIds.length > ISO_MANIFEST_BOUNDS.maxGuests) throw new IsoManifestError('consent.guests')
  const guests: Record<string, number> = {}
  for (const id of guestIds) {
    str(id, 'consent.guests.key', GUEST_IDENTITY)
    guests[id] = int(guestsIn[id], `consent.guests.${id}`, 1)
  }
  const r = obj(m.reservation, 'reservation')
  exactKeys(
    r,
    ['maxActiveEntries', 'maxMinutes', 'ceilingMicros', 'estimateMicros', 'deadlineAtMs'],
    'reservation'
  )
  const reservation: IsoReservation = {
    maxActiveEntries: int(r.maxActiveEntries, 'reservation.maxActiveEntries', 1),
    maxMinutes: int(r.maxMinutes, 'reservation.maxMinutes', 1),
    ceilingMicros: int(r.ceilingMicros, 'reservation.ceilingMicros'),
    estimateMicros: int(r.estimateMicros, 'reservation.estimateMicros'),
    deadlineAtMs: int(r.deadlineAtMs, 'reservation.deadlineAtMs', 1)
  }
  if (reservation.estimateMicros > reservation.ceilingMicros)
    throw new IsoManifestError('reservation.estimateMicros')
  const meter = obj(m.meter, 'meter')
  exactKeys(meter, ['egressMs', 'costMicros'], 'meter')
  if (!Array.isArray(m.entries) || m.entries.length > ISO_MANIFEST_BOUNDS.maxEntries)
    throw new IsoManifestError('entries')
  const entries = m.entries.map((e, i) => parseEntry(e, i, { takeId, originAtMs }))
  const ids = new Set<string>()
  const sids = new Set<string>()
  for (const entry of entries) {
    if (ids.has(entry.id)) throw new IsoManifestError('entries.id')
    // One publication is one generation: a SID never appears twice.
    if (sids.has(entry.trackSid)) throw new IsoManifestError('entries.trackSid')
    ids.add(entry.id)
    sids.add(entry.trackSid)
    if (!entry.role.startsWith('host-') && guests[entry.subject] === undefined)
      throw new IsoManifestError('entries.consent')
  }
  if (!Array.isArray(m.refused) || m.refused.length > ISO_MANIFEST_BOUNDS.maxRefused)
    throw new IsoManifestError('refused')
  const refused = m.refused.map((value, i) => {
    const r = obj(value, `refused[${i}]`)
    exactKeys(r, ['trackSid', 'reason'], `refused[${i}]`)
    return {
      trackSid: str(r.trackSid, `refused[${i}].trackSid`, TRACK_SID),
      reason: str(r.reason, `refused[${i}].reason`, REFUSAL)
    }
  })
  return {
    v: ISO_MANIFEST_VERSION,
    kind: ISO_MANIFEST_KIND,
    showId,
    takeId,
    orientation,
    liveIntervalIds,
    clock: {
      origin: 'program-take-start',
      originAtMs,
      basis: 'provider-egress-start',
      uncertainty: 'unmeasured'
    },
    consent: { hostAtMs: int(consent.hostAtMs, 'consent.hostAtMs', 1), guests },
    reservation,
    meter: {
      egressMs: int(meter.egressMs, 'meter.egressMs'),
      costMicros: int(meter.costMicros, 'meter.costMicros')
    },
    createdAtMs: int(m.createdAtMs, 'createdAtMs', 1),
    expiresAtMs: int(m.expiresAtMs, 'expiresAtMs', 1),
    stoppedAtMs: intOrNull(m.stoppedAtMs, 'stoppedAtMs'),
    stopReason: m.stopReason === null ? null : oneOf(m.stopReason, 'stopReason', ISO_END_REASONS),
    entries,
    refused,
    productionQualified: false
  }
}

const ROLE_TITLES: Record<IsoRole, string> = {
  'host-camera': 'Host camera',
  'host-microphone': 'Host microphone',
  'host-aux': 'Host sounds',
  'host-screen': 'Host screen',
  'guest-camera': 'Guest camera',
  'guest-microphone': 'Guest microphone',
  'guest-screen': 'Guest screen',
  'guest-screen-audio': 'Guest screen audio'
}

export type IsoImportItem = {
  takeId: string
  entryId: string
  role: IsoRole
  subject: string
  generation: number
  objectKey: string
  /** Milliseconds from the program take's start (basis: provider egress start). */
  offsetMs: number
  durationMs: number | null
  bytes: number | null
  partial: boolean
  overlap: boolean
  /** Video layout: `unknown` is never shown as a normal picture. Null for audio. */
  frameLayout: 'opaque' | 'unknown' | null
  fileName: string
  title: string
}

/** Mirrors `plan_iso_import`: past retention, or with no recorded ISO file, nothing. */
export function planIsoImport(manifest: IsoManifestV1, now: number): IsoImportItem[] {
  if (now >= manifest.expiresAtMs) return []
  const items: IsoImportItem[] = []
  for (const e of manifest.entries) {
    if (e.state !== 'complete' && e.state !== 'partial') continue
    if (e.objectKey === null || e.offsetMs === null) continue
    if (e.bytes !== null && e.bytes > 8 * 1024 ** 3) continue
    const ext = /\.(webm|ogg|mp4|mkv|m4a)$/.exec(e.objectKey)?.[1] ?? 'bin'
    const partial = e.state === 'partial'
    items.push({
      takeId: manifest.takeId,
      entryId: e.id,
      role: e.role,
      subject: e.subject,
      generation: e.generation,
      objectKey: e.objectKey,
      offsetMs: e.offsetMs,
      durationMs: e.durationMs,
      bytes: e.bytes,
      partial,
      overlap: e.overlap,
      frameLayout: e.frameLayout?.layout ?? null,
      fileName: `${manifest.takeId}-iso-${e.role}-${e.subject}-g${e.generation}.${ext}`,
      title: `${ROLE_TITLES[e.role]}${e.generation > 1 ? ` (part ${e.generation})` : ''}${e.frameLayout?.layout === 'unknown' ? ' (layout unknown)' : ''}${partial ? ' (partial)' : ''}`
    })
  }
  return items
}
