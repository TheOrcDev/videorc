import type {
  CloudIsoAnswer,
  CloudIsoAvailability,
  CloudIsoEnableParams,
  CloudIsoImportEvent,
  CloudIsoImportJournal,
  CloudIsoImportState,
  CloudIsoStatus,
  CloudRoomGuest
} from '@/lib/backend'
import { plural } from '@/lib/format'
import { OFFLINE_LOCK_REASON } from '@/lib/lock-reason'
import type { StatusTone } from '@/lib/status-word'

import {
  ISO_ROLES,
  isIsoRole,
  parseIsoManifest,
  planIsoImport,
  type IsoEndReason,
  type IsoEntry,
  type IsoFailure,
  type IsoManifestV1,
  type IsoRole
} from '../../../shared/cloud-source-iso'

// Plan 249 S22: the words and states of "Separate files", the opt-in cloud
// ISO: each person and each source of a talk show as its own file in the
// cloud, beside the mixed recording. Pure, so the Guests tab's control and the
// Library's take rows read the same answers, and the tests pin every line.
// docs/cloud/249-s22-contract.md is the contract.

// --- Availability, limits and cost -------------------------------------------

/** The published per-minute price of one separate file (raw track export). */
export const ISO_MICROS_PER_FILE_MINUTE = 1_000
/** What Turn on asks for: the web's cap on files at once, and two hours. */
export const ISO_DEFAULT_LIMITS: IsoLimits = { maxActiveEntries: 12, maxMinutes: 120 }
export type IsoLimits = { maxActiveEntries: number; maxMinutes: number }

export const ISO_NOT_AVAILABLE = "Separate cloud files aren't available yet."
export const ISO_NOT_ON_PLAN = "Separate cloud files aren't part of your plan."
export const ISO_OPEN_ROOM_FIRST = 'Open the room first.'
export const ISO_CHECKING = 'Checking separate files…'
export const ISO_FOLDER_UNAVAILABLE =
  'The recordings folder you chose isn’t available. Choose it again in Output → Where recordings go.'
export const ISO_LAYOUT_UNKNOWN_NOTE =
  'Layout unknown: this camera file may hold a hidden transparency layer, so Videorc never shows it as a picture. Check it in an editor before you use it.'
export const ISO_OVERLAP_NOTE =
  'Overlaps: another part of the same source was recording at the same time.'

/** The price the web published, when it sent one; else the known one. */
export function isoMicrosPerFileMinute(availability?: CloudIsoAvailability | null): number {
  const value = availability?.provider?.facts.microsPerTrackEgressMinute
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? value
    : ISO_MICROS_PER_FILE_MINUTE
}

/** The worst case: every file recording for the whole limit. */
export function isoEstimateMicros(
  limits: IsoLimits,
  microsPerMinute = ISO_MICROS_PER_FILE_MINUTE
): number {
  return limits.maxActiveEntries * limits.maxMinutes * microsPerMinute
}

/** "$1.44"; a per-minute price keeps its third decimal: "$0.001". */
export function formatUsdMicros(micros: number): string {
  const dollars = micros / 1_000_000
  const digits = dollars > 0 && dollars < 0.01 ? 3 : 2
  return `$${dollars.toFixed(digits)}`
}

function minutesLabel(minutes: number): string {
  return minutes % 60 === 0 ? plural(minutes / 60, 'hour') : plural(minutes, 'minute')
}

export function isoLimitsLine(limits: IsoLimits): string {
  return `Up to ${plural(limits.maxActiveEntries, 'file')} at once, for up to ${minutesLabel(limits.maxMinutes)}.`
}

export function isoCostLine(
  limits: IsoLimits,
  microsPerMinute = ISO_MICROS_PER_FILE_MINUTE
): string {
  const total = formatUsdMicros(isoEstimateMicros(limits, microsPerMinute))
  const price = formatUsdMicros(microsPerMinute)
  return `Estimated cost: up to ${total} (${plural(limits.maxActiveEntries, 'file')} × ${plural(limits.maxMinutes, 'minute')} at ${price} a minute, the published price). An estimate, not a bill.`
}

/** The one request Turn on sends: consent from the checked confirmation only. */
export function isoEnableParams(
  showId: string,
  limits: IsoLimits,
  microsPerMinute = ISO_MICROS_PER_FILE_MINUTE
): CloudIsoEnableParams {
  return {
    showId,
    consent: true,
    maxActiveEntries: limits.maxActiveEntries,
    maxMinutes: limits.maxMinutes,
    costCeilingMicros: isoEstimateMicros(limits, microsPerMinute)
  }
}

/** A refusal's words, by the backend's error code (§5). */
export function isoErrorText(code: string | undefined): string | null {
  switch (code) {
    case 'cloud-iso-not-qualified':
      return ISO_NOT_AVAILABLE
    case 'cloud-iso-plan':
      return ISO_NOT_ON_PLAN
    case 'cloud-iso-refused':
      return "Videorc Cloud can't record separate files for this show right now."
    case 'cloud-iso-controller':
      return 'Another device controls this show now. Continue here first.'
    case 'cloud-iso-failed':
      return "Videorc Cloud didn't answer about separate files. Try again."
    case 'cloud-iso-import-failed':
      return "The separate files couldn't be downloaded. Try again."
    case 'resource-capability-rejected':
      return ISO_FOLDER_UNAVAILABLE
    default:
      return null
  }
}

export type IsoRoomGateInput = {
  offline: boolean
  roomOpen: boolean
  /** The last `cloud.iso.status` answer; null until one arrives. */
  answer: CloudIsoAnswer | null
  /** The error code of the last status check that failed. */
  errorCode: string | null
}

/** Why Turn on is disabled, or null when it can be asked for. */
export function isoEnableBlockedReason(input: IsoRoomGateInput): string | null {
  if (input.offline) return OFFLINE_LOCK_REASON
  if (!input.roomOpen) return ISO_OPEN_ROOM_FIRST
  if (input.errorCode === 'cloud-iso-plan') return ISO_NOT_ON_PLAN
  if (input.errorCode === 'cloud-iso-not-qualified') return ISO_NOT_AVAILABLE
  if (!input.answer) return input.errorCode ? ISO_NOT_AVAILABLE : ISO_CHECKING
  const { availability } = input.answer
  if (!availability.productionQualified || !availability.enabled) return ISO_NOT_AVAILABLE
  return null
}

// --- Takes ---------------------------------------------------------------------

export type IsoParsedTake =
  | { ok: true; manifest: IsoManifestV1; programRecordingId: string }
  | { ok: false; programRecordingId: string }

/** Every take, read through the strict parser: an unreadable one stays listed as unreadable. */
export function isoParsedTakes(status: CloudIsoStatus | null | undefined): IsoParsedTake[] {
  return (status?.takes ?? []).map((take) => {
    try {
      return {
        ok: true,
        manifest: parseIsoManifest(take.manifest),
        programRecordingId: take.programRecordingId
      }
    } catch {
      return { ok: false, programRecordingId: take.programRecordingId }
    }
  })
}

/** The take the room records now, or the last one: the newest manifest. */
export function isoCurrentTake(takes: readonly IsoParsedTake[]): IsoManifestV1 | null {
  let current: IsoManifestV1 | null = null
  for (const take of takes) {
    if (!take.ok) continue
    if (!current || take.manifest.createdAtMs > current.createdAtMs) current = take.manifest
  }
  return current
}

// --- Rows ----------------------------------------------------------------------

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

const ROLE_WORDS: Record<IsoRole, string> = {
  'host-camera': 'camera',
  'host-microphone': 'microphone',
  'host-aux': 'show sounds',
  'host-screen': 'screen',
  'guest-camera': 'camera',
  'guest-microphone': 'microphone',
  'guest-screen': 'screen',
  'guest-screen-audio': 'screen audio'
}

const FAILURE_TEXT: Record<IsoFailure, string> = {
  'start-failed': "Couldn't start",
  'provider-failed': 'Stopped by a cloud error',
  'provider-aborted': 'Stopped by the cloud',
  'limit-reached': "Reached the cloud's time limit",
  'missing-output': 'No file was saved',
  'stop-failed': "Couldn't stop cleanly",
  'start-unknown': "Didn't start"
}

const STOP_TEXT: Partial<Record<IsoEndReason, string>> = {
  'budget-exhausted': 'Separate files stopped: the cost limit was reached.',
  'time-limit': 'Separate files stopped: the time limit was reached.'
}

export function isoFailureText(failure: IsoFailure | null): string | null {
  return failure ? FAILURE_TEXT[failure] : null
}

function partSuffix(generation: number): string {
  return generation > 1 ? ` (part ${generation})` : ''
}

export type IsoStatusWord = { label: string; tone: StatusTone }

/** A file's state in the cloud, as one status word and an optional reason. */
export function isoEntryStatus(entry: IsoEntry): IsoStatusWord & { detail: string | null } {
  const detail = isoFailureText(entry.failure)
  switch (entry.state) {
    case 'starting':
      return { label: 'Starting', tone: 'neutral', detail: null }
    case 'recording':
      return { label: 'Recording', tone: 'live', detail: null }
    case 'complete':
      return { label: 'Saved', tone: 'good', detail: null }
    case 'partial':
      return { label: 'Partial', tone: 'warn', detail }
    case 'failed':
      return { label: 'Failed', tone: 'error', detail }
    case 'expired':
      return { label: 'Expired', tone: 'neutral', detail: null }
  }
}

function roleOrder(role: IsoRole): number {
  return ISO_ROLES.indexOf(role)
}

function sortedEntries(manifest: IsoManifestV1): IsoEntry[] {
  const subjects = new Map<string, number>()
  for (const entry of manifest.entries) {
    if (!subjects.has(entry.subject)) subjects.set(entry.subject, subjects.size)
  }
  const subjectOrder = (subject: string): number =>
    subject === 'host' ? -1 : (subjects.get(subject) ?? 0)
  return [...manifest.entries].sort(
    (a, b) =>
      subjectOrder(a.subject) - subjectOrder(b.subject) ||
      roleOrder(a.role) - roleOrder(b.role) ||
      a.generation - b.generation
  )
}

export type IsoRoomRow = {
  id: string
  title: string
  status: IsoStatusWord
  detail: string | null
}

/** The room's live list: who and what records, by name, the host first. */
export function isoRoomRows(
  manifest: IsoManifestV1,
  guests: readonly CloudRoomGuest[] = []
): IsoRoomRow[] {
  const names = new Map(guests.map((guest) => [guest.guestId, guest.name]))
  return sortedEntries(manifest).map((entry) => {
    const owner =
      entry.subject === 'host'
        ? 'Your'
        : names.get(entry.subject)
          ? `${names.get(entry.subject)}'s`
          : "A guest's"
    const status = isoEntryStatus(entry)
    return {
      id: entry.id,
      title: `${owner} ${ROLE_WORDS[entry.role]}${partSuffix(entry.generation)}`,
      status: { label: status.label, tone: status.tone },
      detail: status.detail
    }
  })
}

export type IsoGuestConsentRow = {
  guestId: string
  name: string
  agreed: boolean
  status: IsoStatusWord
}

/** Each guest in the room and whether they agreed to their own files. */
export function isoGuestConsentRows(
  guests: readonly CloudRoomGuest[] | undefined,
  consent: CloudIsoStatus['guestConsent'] | undefined
): IsoGuestConsentRow[] {
  const agreed = new Set((consent ?? []).map((entry) => entry.identity))
  return (guests ?? []).map((guest) => {
    const yes = agreed.has(guest.guestId)
    return {
      guestId: guest.guestId,
      name: guest.name,
      agreed: yes,
      status: yes ? { label: 'Agreed', tone: 'good' } : { label: "Hasn't agreed", tone: 'neutral' }
    }
  })
}

/** Lines for a take that stopped early or left sources out: never hidden. */
export function isoTakeNotes(manifest: IsoManifestV1): string[] {
  const notes: string[] = []
  const stopped = manifest.stopReason ? STOP_TEXT[manifest.stopReason] : undefined
  if (stopped) notes.push(stopped)
  if (manifest.refused.length > 0) {
    const count = manifest.refused.length
    notes.push(
      `${plural(count, 'source')} ${count === 1 ? "wasn't" : "weren't"} recorded separately: a guest who hasn't agreed, or audio Videorc can't tell apart.`
    )
  }
  return notes
}

const REFUSAL_TEXT: Record<string, string> = {
  'not-qualified': "Separate cloud files aren't available yet.",
  'no-program-take': 'Separate files start once the show is recording.',
  'host-consent-missing': 'Turn separate files on again to confirm.',
  'cost-ceiling-too-low': 'The cost limit is too low for these limits.',
  'cost-ceiling-over-cap': 'The cost limit is higher than your plan allows.',
  'limits-exceeded': 'These limits are higher than your plan allows.',
  'concurrency-unavailable': 'Videorc Cloud is busy right now. Separate files will try again.',
  'show-expired': 'This show has ended.',
  'take-expired': 'This recording has already expired.',
  'take-limit': 'This show has reached its number of separate recordings.'
}

/** Why the current recording has no separate files, from the last refusal. */
export function isoRefusalText(status: CloudIsoStatus | null | undefined): string | null {
  const refusal = status?.lastRefusal
  if (!refusal) return null
  return (
    REFUSAL_TEXT[refusal.reason] ??
    `Separate files couldn't start for this recording (${refusal.reason}).`
  )
}

// --- Library -------------------------------------------------------------------

/** The Library recording a complete file is registered as (§5). */
export function isoLocalSessionId(
  takeId: string,
  entry: { subject: string; role: IsoRole; generation: number }
): string {
  return `cloud-iso-${takeId}-${entry.subject}-${entry.role}-g${entry.generation}`
}

export type IsoLibraryRow = {
  entryId: string
  title: string
  /** "Guest 2" when a take has more than one guest. */
  context: string | null
  role: IsoRole
  /** Planned by `planIsoImport`: complete or partial, inside retention. */
  importable: boolean
  partial: boolean
  overlap: boolean
  /** A host camera file in v1: possibly packed alpha, never a picture. */
  layoutUnknown: boolean
  bytes: number | null
  durationMs: number | null
  /** Why a file can't be imported, when it can't. */
  unavailable: string | null
  localSessionId: string
}

function entryParts(
  entryId: string
): { subject: string; role: IsoRole; generation: number } | null {
  const match = /^([^/]+)\/([a-z-]+)\/g(\d+)$/.exec(entryId)
  if (!match || !isIsoRole(match[2])) return null
  return { subject: match[1] as string, role: match[2], generation: Number(match[3]) }
}

function guestOrdinals(subjects: readonly string[]): Map<string, string> {
  const guests = [...new Set(subjects.filter((subject) => subject !== 'host'))]
  return new Map(
    guests.length > 1 ? guests.map((subject, index) => [subject, `Guest ${index + 1}`]) : []
  )
}

/** Every file of a take, importable or not, in the room's order. */
export function isoLibraryRows(manifest: IsoManifestV1, now: number): IsoLibraryRow[] {
  const planned = new Map(planIsoImport(manifest, now).map((item) => [item.entryId, item]))
  const entries = sortedEntries(manifest)
  const ordinals = guestOrdinals(entries.map((entry) => entry.subject))
  const expired = now >= manifest.expiresAtMs
  return entries.map((entry) => {
    const item = planned.get(entry.id)
    let unavailable: string | null = null
    if (!item) {
      if (entry.state === 'starting' || entry.state === 'recording') unavailable = 'Still recording'
      else if (entry.state === 'expired' || expired) unavailable = 'Expired in the cloud'
      else if (entry.state === 'failed')
        unavailable = `Not recorded: ${isoFailureText(entry.failure) ?? 'Failed'}`
      else unavailable = "Can't be imported"
    }
    return {
      entryId: entry.id,
      title: `${ROLE_TITLES[entry.role]}${partSuffix(entry.generation)}`,
      context: ordinals.get(entry.subject) ?? null,
      role: entry.role,
      importable: item !== undefined,
      partial: entry.state === 'partial',
      overlap: entry.overlap,
      layoutUnknown: entry.frameLayout?.layout === 'unknown',
      bytes: entry.bytes,
      durationMs: entry.durationMs,
      unavailable,
      localSessionId: isoLocalSessionId(manifest.takeId, entry)
    }
  })
}

/**
 * A take whose manifest the cloud no longer serves (the show expired) but
 * this computer imported from: its rows from the import journal alone.
 */
export function isoJournalRows(journal: CloudIsoImportJournal): IsoLibraryRow[] {
  const rows: IsoLibraryRow[] = []
  const parts = journal.records.flatMap((record) => {
    const entry = entryParts(record.entryId)
    return entry ? [{ record, entry }] : []
  })
  const ordinals = guestOrdinals(parts.map(({ entry }) => entry.subject))
  for (const { record, entry } of parts) {
    rows.push({
      entryId: record.entryId,
      title: `${ROLE_TITLES[entry.role]}${partSuffix(entry.generation)}`,
      context: ordinals.get(entry.subject) ?? null,
      role: entry.role,
      importable: false,
      partial: false,
      overlap: false,
      // v1 never trusts a host camera layout (contract §1).
      layoutUnknown: entry.role === 'host-camera',
      bytes: record.expectedBytes,
      durationMs: null,
      unavailable: record.state === 'complete' ? null : 'Expired in the cloud',
      localSessionId: isoLocalSessionId(journal.takeId, entry)
    })
  }
  return rows
}

// --- Imports -------------------------------------------------------------------

export type IsoFileImport = {
  state: CloudIsoImportState
  bytes: number | null
  expectedBytes: number | null
  /** Raw text: the console's, never a row's. */
  error: string | null
  localSessionId: string | null
}

export type IsoTakeImport = {
  /** The running job, when this window started it or saw its events. */
  jobId: string | null
  /** Asked for, no answer yet. */
  starting: boolean
  /** The job failed as a whole (no file named), or could not start. */
  failed: boolean
  files: ReadonlyMap<string, IsoFileImport>
}

/** Keyed by take id. */
export type IsoImports = ReadonlyMap<string, IsoTakeImport>

const EMPTY_TAKE: IsoTakeImport = { jobId: null, starting: false, failed: false, files: new Map() }

export function isoTakeImport(imports: IsoImports, takeId: string): IsoTakeImport {
  return imports.get(takeId) ?? EMPTY_TAKE
}

/** The journal is the truth for each file; a job id this window knows is kept. */
export function isoImportsFromJournal(
  previous: IsoImports,
  journals: readonly CloudIsoImportJournal[]
): IsoImports {
  const next = new Map(previous)
  for (const journal of journals) {
    const before = isoTakeImport(previous, journal.takeId)
    const files = new Map(before.files)
    for (const record of journal.records) {
      files.set(record.entryId, {
        state: record.state,
        bytes: record.bytes,
        expectedBytes: record.expectedBytes,
        error: record.error,
        localSessionId: files.get(record.entryId)?.localSessionId ?? null
      })
    }
    const running = [...files.values()].some(isFileRunning)
    next.set(journal.takeId, {
      jobId: running ? before.jobId : null,
      starting: false,
      failed: before.failed && !running,
      files
    })
  }
  return next
}

export function reduceIsoImportEvent(imports: IsoImports, event: CloudIsoImportEvent): IsoImports {
  const before = isoTakeImport(imports, event.takeId)
  const next = new Map(imports)
  if (event.entryId === null) {
    next.set(event.takeId, {
      ...before,
      jobId: event.state === 'failed' ? null : event.jobId,
      starting: false,
      failed: event.state === 'failed'
    })
    return next
  }
  const files = new Map(before.files)
  const file = files.get(event.entryId)
  files.set(event.entryId, {
    state: event.state,
    bytes: event.bytes ?? file?.bytes ?? null,
    expectedBytes: file?.expectedBytes ?? null,
    error: event.error ?? null,
    localSessionId: event.localSessionId ?? file?.localSessionId ?? null
  })
  const running = [...files.values()].some(isFileRunning)
  next.set(event.takeId, {
    jobId: running ? event.jobId : null,
    starting: false,
    failed: false,
    files
  })
  return next
}

export function isoImportStarting(imports: IsoImports, takeId: string): IsoImports {
  return new Map(imports).set(takeId, {
    ...isoTakeImport(imports, takeId),
    starting: true,
    failed: false
  })
}

export function isoImportAnswered(
  imports: IsoImports,
  takeId: string,
  jobId: string | null
): IsoImports {
  const before = isoTakeImport(imports, takeId)
  return new Map(imports).set(takeId, {
    ...before,
    jobId: jobId ?? before.jobId,
    starting: false,
    failed: jobId === null
  })
}

function isFileRunning(file: IsoFileImport): boolean {
  return file.state === 'pending' || file.state === 'downloading'
}

/** A file's progress, 0–100, while its size is known. */
export function isoFilePercent(file: IsoFileImport, expected: number | null): number | null {
  const total = file.expectedBytes ?? expected
  if (file.state === 'complete') return 100
  if (!total || total <= 0 || file.bytes === null) return null
  return Math.max(0, Math.min(99, Math.floor((file.bytes / total) * 100)))
}

export type IsoFileWord = IsoStatusWord & { percent: number | null }

/** One file's local state for its row, or null before it was asked for. */
export function isoFileWord(
  file: IsoFileImport | undefined,
  expected: number | null
): IsoFileWord | null {
  if (!file) return null
  switch (file.state) {
    case 'pending':
      return { label: 'Waiting', tone: 'neutral', percent: null }
    case 'downloading': {
      const percent = isoFilePercent(file, expected)
      return {
        label: percent === null ? 'Downloading' : `Downloading ${percent}%`,
        tone: 'neutral',
        percent
      }
    }
    case 'complete':
      return { label: 'Imported', tone: 'good', percent: 100 }
    case 'failed':
      return { label: "Couldn't import", tone: 'error', percent: null }
    case 'expired':
      return { label: 'Expired in the cloud', tone: 'neutral', percent: null }
  }
}

export type IsoTakeImportSummary = {
  running: boolean
  importable: number
  imported: number
  failed: number
  /** The take's Import button: null once every file is here. */
  action: string | null
}

export function isoTakeImportSummary(
  rows: readonly IsoLibraryRow[],
  take: IsoTakeImport
): IsoTakeImportSummary {
  const importable = rows.filter((row) => row.importable)
  let imported = 0
  let failed = 0
  let running = take.starting
  for (const row of importable) {
    const file = take.files.get(row.entryId)
    if (file?.state === 'complete') imported += 1
    else if (file?.state === 'failed') failed += 1
    else if (file && isFileRunning(file)) running = true
    // A job this window started whose first event for the file hasn't come.
    else if (!file && take.jobId) running = true
  }
  let action: string | null = null
  if (running) action = take.starting ? 'Starting…' : 'Importing…'
  else if (importable.length > 0 && imported < importable.length)
    action = failed > 0 || take.failed || imported > 0 ? 'Import again' : 'Import separate files'
  return { running, importable: importable.length, imported, failed, action }
}
