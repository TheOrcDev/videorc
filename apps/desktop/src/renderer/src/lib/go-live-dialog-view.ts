import type {
  GoLiveDestinationPreflight,
  GoLivePreflight,
  StreamMetadataDraft,
  StreamPlatform,
  StreamTargetSettings,
  StreamingSettings
} from './backend'
import { broadcastInfoIssues, type BroadcastInfoIssues } from './broadcast-info'
import type { GoLiveCaptionsReadiness } from './captions-preflight'
import type { EntitlementUiGate } from './entitlement-ui'
import { platformLabel } from './platform-copy'

// What the Go Live dialog shows, derived once (plan 174 S3.4): each
// destination's readiness, the problems that belong to a row versus the whole
// livestream, the summary words and the pending label by phase. Pure, so the
// dialog stays markup.

/** Where a confirmed Go Live is, for the primary's pending label (B-14). */
export type GoLivePhase =
  | { kind: 'checking' }
  | { kind: 'preparing'; platform: StreamPlatform }
  | { kind: 'starting' }

/** "Checking…", "Preparing YouTube…", "Starting…". */
export function goLivePendingLabel(phase: GoLivePhase | null): string {
  switch (phase?.kind) {
    case 'preparing':
      return `Preparing ${platformLabel(phase.platform)}…`
    case 'starting':
      return 'Starting…'
    default:
      return 'Checking…'
  }
}

/**
 * A preflight problem about the title (crates/videorc-backend/src/preflight.rs
 * words). The dialog's own Title field checks the title as it is typed, so
 * these never block on their own and never repeat as an Alert.
 */
export function isTitleIssue(issue: { message: string }): boolean {
  return /\btitle is required\b/i.test(issue.message)
}

export type GoLiveDestinationView = {
  destination: GoLiveDestinationPreflight
  /** Ready to go live as the dialog stands now. */
  ready: boolean
  /** Why not, in one line; null when ready. */
  problem: string | null
}

export type GoLiveDialogView = {
  destinations: GoLiveDestinationView[]
  /** Errors about the whole livestream: one destructive Alert. */
  generalErrors: string[]
  /** Limits (what chat can't do): one warning Alert. */
  warnings: string[]
  /** "3 of 3 ready", or null with no destination. */
  summary: string | null
  /** Every destination is ready and nothing general blocks. */
  destinationsReady: boolean
}

function withPlatform(issue: { platform?: StreamPlatform; message: string }): string {
  return issue.platform ? `${platformLabel(issue.platform)}: ${issue.message}` : issue.message
}

/**
 * The preflight as the dialog shows it. `titleField` is true when the dialog
 * carries the Title field (a destination streams the instant draft);
 * `titleMissing` when that field is still empty, so a destination held only
 * by the title says "Needs a title." instead of the backend's words.
 */
export function goLiveDialogView(
  preflight: GoLivePreflight | null,
  { titleField, titleMissing }: { titleField: boolean; titleMissing: boolean }
): GoLiveDialogView {
  const destinations = preflight?.destinations ?? []
  const rowIds = new Set(destinations.map((destination) => destination.targetId))
  const errors = preflight?.issues.filter((issue) => issue.severity === 'error') ?? []
  const titleHandled = (issue: { message: string }): boolean => titleField && isTitleIssue(issue)

  const views = destinations.map((destination): GoLiveDestinationView => {
    const own = errors.filter((issue) => issue.targetId === destination.targetId)
    const onlyTitle = own.length > 0 && own.every(titleHandled)
    if (destination.ready || (onlyTitle && !titleMissing)) {
      return { destination, ready: true, problem: null }
    }
    return {
      destination,
      ready: false,
      problem: onlyTitle ? 'Needs a title.' : destination.message
    }
  })
  const generalErrors = errors
    .filter((issue) => !(issue.targetId && rowIds.has(issue.targetId)) && !titleHandled(issue))
    .map(withPlatform)
  const warnings = (preflight?.issues ?? [])
    .filter((issue) => issue.severity === 'warning')
    .map(withPlatform)
  const readyCount = views.filter((view) => view.ready).length

  return {
    destinations: views,
    generalErrors,
    warnings,
    summary: views.length ? `${readyCount} of ${views.length} ready` : null,
    destinationsReady: views.length > 0 && readyCount === views.length && generalErrors.length === 0
  }
}

/** The entitlement gate when it blocks (the dialog's LockAlert). */
export type GoLiveEntitlementBlocker = Extract<EntitlementUiGate, { allowed: false }>

/**
 * Everything the Go Live dialog's primary waits on, derived once (plan 209
 * S10, D13): the dialog draws it and disables "Go live" while `blocked`, and
 * an agent's `go_live` refuses on the same answer, so a call without the
 * dialog can never start what the dialog would hold back.
 *
 * `sentStreaming` is what this Go Live sends (the saved destinations minus
 * the ones left out of it); `entitlementGate` is `goLiveEntitlementGate` for
 * the saved destinations, as the host computes it.
 */
export interface GoLiveConfirmGate {
  /** The destinations this Go Live sends. */
  sentTargets: StreamTargetSettings[]
  /** One of them starts a scheduled event. */
  hasScheduledTargets: boolean
  /** One of them streams the instant draft (so the dialog carries a Title). */
  hasInstantTargets: boolean
  /** An instant destination is YouTube (privacy reaches it). */
  instantYouTube: boolean
  /** The draft's title and description problems, when the dialog has the fields. */
  titleIssues: BroadcastInfoIssues | null
  view: GoLiveDialogView
  entitlementBlocker: GoLiveEntitlementBlocker | null
  /** Something above the primary blocks it. */
  blocked: boolean
}

export function goLiveConfirmGate({
  preflight,
  draft,
  sentStreaming,
  captionsReadiness,
  entitlementGate
}: {
  preflight: GoLivePreflight | null
  draft: StreamMetadataDraft | null
  sentStreaming: StreamingSettings
  captionsReadiness: Pick<GoLiveCaptionsReadiness, 'blocksStart'>
  entitlementGate: EntitlementUiGate
}): GoLiveConfirmGate {
  const sentTargets = sentStreaming.targets.filter((target) => target.enabled)
  const hasScheduledTargets = sentTargets.some((target) => target.scheduledEventId)
  // The instant draft's details apply to every destination not tied to a
  // saved event; privacy reaches YouTube only.
  const hasInstantTargets = sentTargets.some((target) => !target.scheduledEventId)
  const instantYouTube = sentTargets.some(
    (target) => !target.scheduledEventId && target.platform === 'youtube'
  )
  const titleIssues =
    hasInstantTargets && draft ? broadcastInfoIssues(draft, { titleRequired: true }) : null
  const view = goLiveDialogView(preflight, {
    titleField: hasInstantTargets,
    titleMissing: hasInstantTargets && (!draft || draft.title.trim() === '')
  })
  const entitlementBlocker = entitlementGate.allowed ? null : entitlementGate
  const blocked =
    Boolean(entitlementBlocker) ||
    captionsReadiness.blocksStart ||
    Boolean(titleIssues?.title || titleIssues?.description) ||
    (hasInstantTargets && !draft) ||
    !view.destinationsReady
  return {
    sentTargets,
    hasScheduledTargets,
    hasInstantTargets,
    instantYouTube,
    titleIssues,
    view,
    entitlementBlocker,
    blocked
  }
}
