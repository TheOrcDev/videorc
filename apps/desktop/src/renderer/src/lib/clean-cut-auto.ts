import type {
  AiCapabilities,
  CleanCutJob,
  EntitlementsSnapshot,
  RecordingFinalizationEvent,
  SessionSummary
} from './backend'
import { openCleanCut } from './clean-cut-events'
import {
  CLEAN_CUT_CONSENT_OFF_REASON,
  cleanCutCapabilities,
  cleanCutEligibility,
  cleanCutErrorReason,
  cleanCutUnavailableReason,
  type CleanCutSession
} from './clean-cut-view'
import { cloudAiUploadGate } from './entitlement-ui'
import { applyFinalizationEvent } from './session-finalization'
import { toast } from './toast'

// Plan 119 S15: with "Make a clean cut of every recording" on, a recording
// that finishes its MP4 gets its clean cut without a click. Cloud consent
// lives only in the renderer (`videorc.aiConsent`), which is why the renderer,
// not the backend, starts the job. Loaded lazily from use-studio when a
// session finalizes: nothing here is on the eager renderer path.

/** "Make a clean cut of every recording" ('1' / '0'); off unless chosen. */
export const CLEAN_CUT_AUTO_STORAGE_KEY = 'videorc.cleanCutAuto'
/** Sessions the auto-run already started (or tried to), newest last. */
export const CLEAN_CUT_ATTEMPTED_STORAGE_KEY = 'videorc.cleanCutAttempted'
export const CLEAN_CUT_ATTEMPTED_MAX = 50

export function cleanCutAutoFromStorage(raw: string | null | undefined): boolean {
  return raw === '1'
}

export function cleanCutAutoToStorage(enabled: boolean): string {
  return enabled ? '1' : '0'
}

export function parseAttemptedSessionIds(raw: string | null | undefined): string[] {
  if (!raw) return []
  try {
    const parsed: unknown = JSON.parse(raw)
    return Array.isArray(parsed)
      ? parsed.filter((id): id is string => typeof id === 'string' && id.length > 0)
      : []
  } catch {
    return []
  }
}

/** Appends `id` (newest last) and keeps the ledger bounded. */
export function withAttemptedSessionId(
  ids: readonly string[],
  id: string,
  max: number = CLEAN_CUT_ATTEMPTED_MAX
): string[] {
  return [...ids.filter((entry) => entry !== id), id].slice(-max)
}

export type CleanCutAutoSkipReason =
  | 'not-finalized'
  | 'setting-off'
  | 'already-attempted'
  | 'unknown-session'
  | 'not-eligible'
  | 'no-consent'
  | 'not-premium'
  | 'unavailable'

export type CleanCutAutoDecision =
  | { kind: 'run' }
  | { kind: 'skip'; reason: CleanCutAutoSkipReason }

export interface CleanCutAutoInput {
  event: Pick<RecordingFinalizationEvent, 'sessionId' | 'state'>
  /** The Library row with this finalization applied, or null when unknown. */
  session: CleanCutSession | null
  autoEnabled: boolean
  /** The session id is already in the ledger (or claimed in this window). */
  attempted: boolean
  /** `videorc.aiConsent`. */
  consent: boolean
  /** The cloud-AI Premium gate. */
  premium: boolean
  /** `cleanCut.available` from the capability block. */
  available: boolean
}

/**
 * Whether a finished recording gets its clean cut by itself. Pure. The
 * session must be an eligible recording (decision 11: finished, an MP4,
 * `record` or `record+stream`, not imported, not derived, 10 s or more),
 * and the switch, consent, Premium and the server must all say yes.
 */
export function decideCleanCutAutoRun(input: CleanCutAutoInput): CleanCutAutoDecision {
  const skip = (reason: CleanCutAutoSkipReason): CleanCutAutoDecision => ({ kind: 'skip', reason })
  if (input.event.state !== 'finalized') return skip('not-finalized')
  if (!input.autoEnabled) return skip('setting-off')
  if (input.attempted) return skip('already-attempted')
  if (!input.session) return skip('unknown-session')
  if (!cleanCutEligibility(input.session).eligible) return skip('not-eligible')
  if (!input.consent) return skip('no-consent')
  if (!input.premium) return skip('not-premium')
  if (!input.available) return skip('unavailable')
  return { kind: 'run' }
}

/** Skips the streamer would expect to be cut: each warns once (E-25). */
const NOTICED_SKIPS: ReadonlySet<CleanCutAutoSkipReason> = new Set([
  'no-consent',
  'not-premium',
  'unavailable'
])

/**
 * Why a finished recording got no clean cut with the switch on, in plain
 * words (plan 174 E-25), or null when the skip is expected (the switch off,
 * already tried, a stream without a recording, a short take). Pure.
 */
export function cleanCutAutoSkipReason(
  reason: CleanCutAutoSkipReason,
  context: { premiumReason: string; reasonCode: string | null }
): string | null {
  if (!NOTICED_SKIPS.has(reason)) return null
  if (reason === 'no-consent') return CLEAN_CUT_CONSENT_OFF_REASON
  if (reason === 'not-premium') return context.premiumReason
  return cleanCutUnavailableReason(context.reasonCode)
}

export interface CleanCutStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

/** What use-studio hands over when a session finalizes. */
export interface CleanCutAutoContext {
  request: <T>(method: string, params?: unknown) => Promise<T>
  sessions: readonly SessionSummary[]
  consent: boolean
  entitlements: EntitlementsSnapshot | null
  capabilities: AiCapabilities | null
  /** localStorage by default; null when unavailable. Every access is guarded. */
  storage?: CleanCutStorage | null
}

// Backstop for the storage ledger: a second finalized event in this window
// never starts a second job, even when localStorage throws.
const claimedSessionIds = new Set<string>()

/** Tests only. */
export function resetCleanCutAutoClaims(): void {
  claimedSessionIds.clear()
}

/**
 * Decide, remember the attempt, start once. The ledger is written BEFORE the
 * job starts, so a crash, a reload or a refusal never leads to an automatic
 * retry: the card's Retry is the way back.
 */
export async function autoRunCleanCut(
  event: RecordingFinalizationEvent,
  context: CleanCutAutoContext
): Promise<CleanCutAutoDecision> {
  if (event.state !== 'finalized') return { kind: 'skip', reason: 'not-finalized' }
  const storage = context.storage === undefined ? browserStorage() : context.storage
  // Cheap exit first: with the switch off nothing else is read.
  if (!cleanCutAutoFromStorage(readStorage(storage, CLEAN_CUT_AUTO_STORAGE_KEY))) {
    return { kind: 'skip', reason: 'setting-off' }
  }
  const sessionId = event.sessionId
  const attemptedIds = parseAttemptedSessionIds(
    readStorage(storage, CLEAN_CUT_ATTEMPTED_STORAGE_KEY)
  )
  const attempted = claimedSessionIds.has(sessionId) || attemptedIds.includes(sessionId)
  const session = attempted ? null : await findSessionRow(context, event)
  const gate = cloudAiUploadGate(context.entitlements)
  const capabilities = cleanCutCapabilities(context.capabilities)
  const decision = decideCleanCutAutoRun({
    event,
    session,
    autoEnabled: true,
    attempted,
    consent: context.consent,
    premium: gate.allowed,
    available: capabilities?.available === true
  })
  const claim = (): void => {
    claimedSessionIds.add(sessionId)
    writeStorage(
      storage,
      CLEAN_CUT_ATTEMPTED_STORAGE_KEY,
      JSON.stringify(withAttemptedSessionId(attemptedIds, sessionId))
    )
  }
  if (decision.kind !== 'run') {
    // A skip the streamer didn't expect warns once per recording (E-25): the
    // ledger keeps it from warning again, and the toast leads to Clean cut.
    const why = cleanCutAutoSkipReason(decision.reason, {
      premiumReason: gate.allowed ? '' : gate.reason,
      reasonCode: capabilities?.reasonCode ?? null
    })
    if (why) {
      claim()
      showCleanCutAutoFailed(sessionId, why)
    }
    return decision
  }

  claim()
  try {
    await context.request<CleanCutJob>('cleanCut.start', {
      sessionId,
      mode: 'clean',
      consentToUploadAudio: true
    })
  } catch (error) {
    if (errorCode(error) !== 'already-running') {
      showCleanCutAutoFailed(sessionId, cleanCutErrorReason(error))
    }
  }
  return decision
}

/**
 * Quiet on purpose: nothing retries by itself, and Clean cut has Make and
 * Retry. One toast per recording; its action opens Clean cut on it.
 */
export function showCleanCutAutoFailed(sessionId: string, reason: string): void {
  toast.warning("Your clean cut didn't start", {
    id: `clean-cut-auto-${sessionId}`,
    description: reason,
    action: { label: 'Open Clean cut', onClick: () => openCleanCut({ sessionId }) }
  })
}

function errorCode(error: unknown): string | null {
  if (!error || typeof error !== 'object' || !('code' in error)) return null
  const code = (error as { code?: unknown }).code
  return typeof code === 'string' ? code : null
}

/**
 * The row with this finalization applied. The loaded Library page usually
 * has it; a row that is missing or still says running is read again.
 */
async function findSessionRow(
  context: CleanCutAutoContext,
  event: RecordingFinalizationEvent
): Promise<CleanCutSession | null> {
  let row: SessionSummary | null =
    context.sessions.find((entry) => entry.id === event.sessionId) ?? null
  if (!row || row.status !== 'completed') {
    try {
      const page = await context.request<{ items: SessionSummary[] }>('sessions.list', {
        limit: 20
      })
      row = page.items.find((entry) => entry.id === event.sessionId) ?? row
    } catch {
      // Keep what the loaded page had.
    }
  }
  return row ? (applyFinalizationEvent([row], event)[0] as CleanCutSession) : null
}

function browserStorage(): CleanCutStorage | null {
  try {
    return globalThis.localStorage ?? null
  } catch {
    return null
  }
}

function readStorage(storage: CleanCutStorage | null, key: string): string | null {
  try {
    return storage?.getItem(key) ?? null
  } catch {
    return null
  }
}

function writeStorage(storage: CleanCutStorage | null, key: string, value: string): void {
  try {
    storage?.setItem(key, value)
  } catch {
    // Storage unavailable: the in-memory claim still holds for this window.
  }
}
