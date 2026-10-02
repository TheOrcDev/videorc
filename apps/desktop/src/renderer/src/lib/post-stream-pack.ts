// Plan 068 D10: the post-stream pack runs itself. When a streamed session
// that Orcle listened to and that also recorded locally finishes its MP4, and
// its transcript sidecar (<recording>.srt) was written, the renderer runs the
// existing post-recording workflow once (publish_pack + social_posts) and
// says so with a toast that opens Publish. A captions-only stream never runs
// it by itself.
// Cloud consent lives only in the renderer (`videorc.aiConsent`), which is why
// the renderer, not the backend, starts the run.
//
// Loaded lazily from use-studio and from the Publish tab: nothing here is on
// the eager renderer path (the eager bundle budget is tight).

import { toast } from '@/lib/toast'

import {
  cloudAiReadiness,
  type CloudAiReadiness,
  type CloudAiReadinessState
} from '@/lib/ai-readiness'
import type {
  AiArtifact,
  AiCapabilities,
  AiQuotaStatus,
  AiWorkflowResult,
  RecordingFinalizationEvent,
  SessionSummary,
  VideorcAccountSnapshot
} from '@/lib/backend'

/** The "Make my post-stream pack automatically" preference ('1' / '0'). */
export const POST_STREAM_PACK_AUTO_STORAGE_KEY = 'videorc.postStreamPackAuto'
/** Session ids the auto-run already started (or reported blocked) for. */
export const POST_STREAM_PACK_ATTEMPTED_STORAGE_KEY = 'videorc.postStreamPackAttempted'
/**
 * The backend health code `write_caption_artifacts` emits once the SRT is on
 * disk. use-studio matches it inline (eager path); a test keeps them equal.
 */
export const TRANSCRIPT_WRITTEN_HEALTH_CODE = 'captions-srt-written'
/** app-shell's listener; `detail.sessionId` selects that session in Publish. */
export const OPEN_PUBLISH_EVENT = 'videorc:open-publish'

const ATTEMPTED_SESSION_IDS_MAX = 50

/**
 * What the auto-run asks the server for: the pack, plus the social posts when
 * the server offers them (the same gate as Publish's Social posts card).
 */
export function postStreamPackOutputs(supportsSocialPosts: boolean | undefined): string[] {
  return supportsSocialPosts ? ['publish_pack', 'social_posts'] : ['publish_pack']
}

/**
 * An explicit choice in Publish wins ('1' / '0'); without one the pack makes
 * itself exactly when Orcle listening is on (`listenOn`).
 */
export function postStreamPackAutoFromStorage(
  raw: string | null | undefined,
  listenOn: boolean
): boolean {
  return raw === '1' || (raw !== '0' && listenOn)
}

export function postStreamPackAutoToStorage(enabled: boolean): string {
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

/** Appends `sessionId` (newest last), keeping the list bounded. */
export function withAttemptedSessionId(ids: readonly string[], sessionId: string): string[] {
  return [...ids.filter((id) => id !== sessionId), sessionId].slice(-ATTEMPTED_SESSION_IDS_MAX)
}

/** The row fields the decision reads (a `SessionSummary` satisfies it). */
export interface PostStreamPackSession {
  mode: string
  mp4Path?: string
  outputPath?: string
  aiArtifactCount: number
}

export interface PostStreamPackInput {
  event: Pick<RecordingFinalizationEvent, 'sessionId' | 'state' | 'mp4Path' | 'outputPath'>
  /** The Library row, or null when it could not be found. */
  session: PostStreamPackSession | null
  /** `captions-srt-written` arrived for this session before it finalized. */
  transcriptWritten: boolean
  /** Orcle's listening reached `on` in this session (seen in `cohost.state`). */
  orcleListened: boolean
  /** `videorc.aiConsent`: cloud upload allowed. */
  consent: boolean
  /** The "Make my post-stream pack automatically" preference. */
  autoEnabled: boolean
  /** The session id is already in the attempted list. */
  attempted: boolean
  /** A Publish run for this session is already in flight. */
  running: boolean
  readiness: Pick<CloudAiReadiness, 'state' | 'description'>
}

export type PostStreamPackSkipReason =
  | 'not-finalized'
  | 'setting-off'
  | 'no-consent'
  | 'already-attempted'
  | 'unknown-session'
  | 'not-streamed'
  | 'no-recording'
  | 'orcle-not-listening'
  | 'no-transcript'
  | 'already-has-artifacts'
  | 'cloud-unavailable'

export type PostStreamPackDecision =
  | { kind: 'run' }
  | { kind: 'skip'; reason: PostStreamPackSkipReason }
  /** It would run, but cloud AI says no (quota, server): tell the user once. */
  | { kind: 'blocked'; reason: string }

// No account or no Premium: cloud AI was never available here, so there is
// nothing to explain after every stream (the consent switch already reads off).
const SILENT_READINESS_STATES: ReadonlySet<CloudAiReadinessState> = new Set([
  'signed-out',
  'premium-required'
])

/** Whether a finished session gets its pack made automatically. Pure. */
export function decidePostStreamPackAutoRun(input: PostStreamPackInput): PostStreamPackDecision {
  const skip = (reason: PostStreamPackSkipReason): PostStreamPackDecision => ({
    kind: 'skip',
    reason
  })
  const { event, session } = input
  if (event.state !== 'finalized') return skip('not-finalized')
  if (!input.autoEnabled) return skip('setting-off')
  if (!input.consent) return skip('no-consent')
  if (input.attempted) return skip('already-attempted')
  if (!session) return skip('unknown-session')
  // Stored modes are 'record', 'stream', 'record+stream' (older rows may
  // spell 'streaming'): anything that went out live counts.
  if (!session.mode.includes('stream')) return skip('not-streamed')
  if (!(event.mp4Path || event.outputPath || session.mp4Path || session.outputPath)) {
    return skip('no-recording')
  }
  // Captions alone never make the pack by itself: Orcle must have listened.
  if (!input.orcleListened) return skip('orcle-not-listening')
  if (!input.transcriptWritten) return skip('no-transcript')
  // Any AI artifact means a Publish run already happened for this session.
  if (input.running || session.aiArtifactCount > 0) return skip('already-has-artifacts')
  const readiness = input.readiness.state
  if (SILENT_READINESS_STATES.has(readiness)) return skip('cloud-unavailable')
  // 'checking' still runs: the backend validates capabilities itself.
  if (readiness !== 'ready' && readiness !== 'checking') {
    return { kind: 'blocked', reason: input.readiness.description }
  }
  return { kind: 'run' }
}

export type PostStreamPackOutcome = { ok: true } | { ok: false; reason: string }

const PACK_KINDS: ReadonlySet<AiArtifact['kind']> = new Set([
  'title-description',
  'summary',
  'chapters',
  'social-posts'
])

/**
 * `ai.run_post_recording` resolves even when the cloud job failed: the
 * failure is a Failed artifact carrying the reason. Pure.
 */
export function postStreamPackOutcome(result: AiWorkflowResult): PostStreamPackOutcome {
  const failed = result.artifacts.find((artifact) => artifact.status === 'failed')
  if (failed) {
    return { ok: false, reason: artifactMessage(failed) ?? 'Cloud AI failed.' }
  }
  const produced = result.artifacts.some(
    (artifact) => artifact.status === 'ready' && PACK_KINDS.has(artifact.kind)
  )
  return produced
    ? { ok: true }
    : { ok: false, reason: 'Cloud AI returned nothing for this recording.' }
}

function artifactMessage(artifact: AiArtifact): string | null {
  const content = artifact.content
  if (typeof content !== 'object' || content === null) return null
  const message = (content as { message?: unknown }).message
  return typeof message === 'string' && message.trim() ? message.trim() : null
}

export interface PostStreamPackStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

export interface PostStreamPackRunDeps {
  /** localStorage, or null when unavailable. Every access is guarded. */
  storage: PostStreamPackStorage | null
  /** One `ai.run_post_recording` call for the pack. */
  runWorkflow: (sessionId: string) => Promise<AiWorkflowResult>
  onStart: (sessionId: string) => void
  onSettled: (sessionId: string) => void
  onReady: (sessionId: string) => void
  onFailed: (sessionId: string, reason: string) => void
}

export type PostStreamPackRunInput = Omit<PostStreamPackInput, 'attempted' | 'autoEnabled'> & {
  /** `cohost.settings.listen`: the preference's default. */
  listenOn: boolean
}

// Backstop for the storage list: a second finalized event in this window
// never starts a second run, even when localStorage throws.
const claimedSessionIds = new Set<string>()

/**
 * Decide, remember the attempt, run once, report. The attempted list is
 * written BEFORE the run starts, so a crash, reload or failure never leads
 * to an automatic retry.
 */
export async function runPostStreamPackOnce(
  input: PostStreamPackRunInput,
  deps: PostStreamPackRunDeps
): Promise<PostStreamPackDecision> {
  const { listenOn, ...decisionInput } = input
  const sessionId = input.event.sessionId
  const attemptedIds = parseAttemptedSessionIds(
    readStorage(deps.storage, POST_STREAM_PACK_ATTEMPTED_STORAGE_KEY)
  )
  const decision = decidePostStreamPackAutoRun({
    ...decisionInput,
    autoEnabled: postStreamPackAutoFromStorage(
      readStorage(deps.storage, POST_STREAM_PACK_AUTO_STORAGE_KEY),
      listenOn
    ),
    attempted: claimedSessionIds.has(sessionId) || attemptedIds.includes(sessionId)
  })
  if (decision.kind === 'skip') return decision

  claimedSessionIds.add(sessionId)
  writeStorage(
    deps.storage,
    POST_STREAM_PACK_ATTEMPTED_STORAGE_KEY,
    JSON.stringify(withAttemptedSessionId(attemptedIds, sessionId))
  )
  if (decision.kind === 'blocked') {
    deps.onFailed(sessionId, decision.reason)
    return decision
  }

  deps.onStart(sessionId)
  try {
    const outcome = postStreamPackOutcome(await deps.runWorkflow(sessionId))
    if (outcome.ok) {
      deps.onReady(sessionId)
    } else {
      deps.onFailed(sessionId, outcome.reason)
    }
  } catch (error) {
    deps.onFailed(sessionId, error instanceof Error ? error.message : String(error))
  } finally {
    deps.onSettled(sessionId)
  }
  return decision
}

function readStorage(storage: PostStreamPackStorage | null, key: string): string | null {
  try {
    return storage?.getItem(key) ?? null
  } catch {
    return null
  }
}

function writeStorage(storage: PostStreamPackStorage | null, key: string, value: string): void {
  try {
    storage?.setItem(key, value)
  } catch {
    // Storage unavailable: the in-memory claim still holds for this window.
  }
}

/** Opens Publish on `sessionId` (app-shell's `videorc:open-publish` listener). */
export function openPublish(sessionId: string): void {
  window.dispatchEvent(new CustomEvent(OPEN_PUBLISH_EVENT, { detail: { sessionId } }))
}

function toastId(sessionId: string): string {
  return `post-stream-pack-${sessionId}`
}

export function showPostStreamPackReady(sessionId: string): void {
  toast.success('Your post-stream pack is ready', {
    id: toastId(sessionId),
    description: 'Title, description and chapters, written from what you said.',
    action: { label: 'Open Publish', onClick: () => openPublish(sessionId) }
  })
}

/** Quiet on purpose: no retry happens, and Publish can run it by hand. */
export function showPostStreamPackFailed(sessionId: string, reason: string): void {
  toast("Your post-stream pack didn't run", {
    id: toastId(sessionId),
    description: reason,
    action: { label: 'Open Publish', onClick: () => openPublish(sessionId) }
  })
}

/** What use-studio hands over when a session finalizes. */
export interface StudioPostStreamPackContext {
  request: <T>(method: string, params?: unknown) => Promise<T>
  sessions: readonly SessionSummary[]
  transcriptWritten: boolean
  orcleListened: boolean
  listenOn: boolean
  consent: boolean
  runningSessionId: string | null
  readiness: {
    account: VideorcAccountSnapshot | null
    capabilities: AiCapabilities | null
    error: string | null
    loading: boolean
    quota: AiQuotaStatus | null
  }
  setRunningSessionId: (update: (current: string | null) => string | null) => void
  refreshSessions: () => Promise<void>
}

/** The studio wiring for `runPostStreamPackOnce` (real storage, RPC, toasts). */
export async function autoRunPostStreamPack(
  event: RecordingFinalizationEvent,
  studio: StudioPostStreamPackContext
): Promise<PostStreamPackDecision> {
  if (event.state !== 'finalized') return { kind: 'skip', reason: 'not-finalized' }
  const session =
    studio.sessions.find((row) => row.id === event.sessionId) ??
    (await findSessionRow(studio, event.sessionId))
  return runPostStreamPackOnce(
    {
      event,
      session,
      transcriptWritten: studio.transcriptWritten,
      orcleListened: studio.orcleListened,
      listenOn: studio.listenOn,
      consent: studio.consent,
      running: studio.runningSessionId === event.sessionId,
      readiness: cloudAiReadiness(studio.readiness)
    },
    {
      storage: browserStorage(),
      runWorkflow: (sessionId) =>
        studio.request<AiWorkflowResult>('ai.run_post_recording', {
          sessionId,
          consentToUploadAudio: true,
          outputs: postStreamPackOutputs(
            studio.readiness.capabilities?.workflow.supportsSocialPosts
          )
        }),
      onStart: (sessionId) => studio.setRunningSessionId(() => sessionId),
      onSettled: (sessionId) => {
        studio.setRunningSessionId((current) => (current === sessionId ? null : current))
        void studio.refreshSessions().catch(() => undefined)
      },
      onReady: showPostStreamPackReady,
      onFailed: showPostStreamPackFailed
    }
  )
}

async function findSessionRow(
  studio: StudioPostStreamPackContext,
  sessionId: string
): Promise<SessionSummary | null> {
  try {
    const page = await studio.request<{ items: SessionSummary[] }>('sessions.list', { limit: 20 })
    return page.items.find((row) => row.id === sessionId) ?? null
  } catch {
    return null
  }
}

function browserStorage(): PostStreamPackStorage | null {
  try {
    return window.localStorage
  } catch {
    return null
  }
}
