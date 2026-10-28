import { sessionOwnsTransport } from '../../../shared/capture-state'
import type {
  AiCapabilities,
  EntitlementsSnapshot,
  GoLivePreflight,
  RecordingStatus,
  StreamMetadataDraft,
  StreamPlatform,
  StreamingSettings
} from './backend'
import type { CaptureConfig, WsStatus } from './capture'
import {
  decideGoLiveCaptionsReadiness,
  type CaptionSessionOutputReadiness,
  type GoLiveCaptionsReadiness
} from './captions-preflight'
import { goLiveEntitlementGate, type EntitlementUiGate } from './entitlement-ui'
import { goLiveConfirmGate } from './go-live-dialog-view'
import { streamingWithoutTargets } from './go-live-exclusions'
import {
  LIVESTREAM_STILL_SETTLING,
  shouldIgnoreGoLiveAction,
  type GoLivePartialSetup
} from './go-live-flow'
import { destinationLabel, platformLabel } from './platform-copy'
import { sessionStartFailureMessage } from './session-start-failure'
import { livestreamIntent, type SessionStartIntent } from './session-start-intent'
import { connectionBlockedReason, START_BLOCKED_COPY } from './start-blocked-copy'

// Going live without the dialog (plan 209 S10, D13). An agent's `go_live`
// runs the Go Live dialog's own preflight and confirm in the Studio
// (hooks/use-studio.tsx) and decides here what the dialog would have
// shown: the same gate the dialog disables its primary on
// (`goLiveConfirmGate`), the same blockers in the dialog's words, and the
// two ways out the dialog offers, "Go live without {destination}" for every
// destination that isn't ready (`allowPartial`) and "Go live without
// captions" (`withoutCaptions`). A blocker only the streamer can fix (sign
// in, a missing key, Premium) is always a refusal: agents never connect
// accounts. Loaded with the first agent Go Live, never in the eager bundle:
// the Studio hands `goLiveWithoutDialog` its handlers and latest state.

/** What an agent's `go_live` asks for, beside the saved setup. */
export interface HeadlessGoLiveRequest {
  /** Destination ids (or platform names) to go live on; every other one that
   * is on sits this livestream out, as "Go live without" does. */
  destinations?: readonly string[]
  /** The stream title for this livestream (the dialog's Title field). */
  title?: string
  /** Go live on the ready destinations when some aren't. */
  allowPartial?: boolean
  /** Go live without captions when they can't start. */
  withoutCaptions?: boolean
}

/** Where a Go Live without the dialog ended: live on these, or why not. */
export type HeadlessGoLiveOutcome =
  | {
      ok: true
      destinations: { id: string; platform: StreamPlatform; label: string }[]
      /** Output's recording is on, so this livestream records too (D19). */
      recording: boolean
    }
  | { ok: false; message: string }

/** What the agent reads when a Go Live without the dialog can't start. */
export const HEADLESS_GO_LIVE_COPY = {
  dialogOpen: 'The Go Live dialog is open in Videorc. Finish or cancel it there.',
  inFlight: 'Videorc is already going live.',
  noDestination: 'No destination is on. Turn one on in Livestream → Setup.',
  draftLoading: 'Videorc is still loading your stream details. Try again in a moment.',
  captionsTitle: "Captions can't start",
  allowPartialHint: 'Pass allowPartial: true to go live on the ready ones.',
  withoutCaptionsHint: 'Pass withoutCaptions: true to go live without them.',
  scheduledChanged:
    'The scheduled event changed. Review its updated visibility and details in Videorc, then go live again.',
  setupFailed: "Some destinations couldn't be set up",
  didNotStart: "The livestream didn't start. Check Studio on your computer."
} as const

export type HeadlessExclusions =
  | { ok: true; excludedTargetIds: string[] }
  | { ok: false; message: string }

/**
 * The saved destinations a `destinations` list leaves out of this livestream:
 * every destination that is on and wasn't named. A name is a destination id
 * or a platform ("twitch" names every Twitch destination that is on). A name
 * that matches nothing, or a destination that is off, is refused: going live
 * never turns a destination on (that is a saved change in Livestream).
 */
export function headlessExclusions(
  streaming: StreamingSettings,
  destinations: readonly string[] | undefined
): HeadlessExclusions {
  if (!destinations || destinations.length === 0) return { ok: true, excludedTargetIds: [] }
  const on = streaming.targets.filter((target) => target.enabled)
  const named = new Set<string>()
  for (const raw of destinations) {
    const name = raw.trim()
    const byId = streaming.targets.find((target) => target.id === name)
    if (byId) {
      if (!on.includes(byId)) {
        return {
          ok: false,
          message: `${destinationLabel(byId.label)} is off. Turn it on in Livestream → Setup first.`
        }
      }
      named.add(byId.id)
      continue
    }
    const byPlatform = on.filter((target) => target.platform === name.toLowerCase())
    if (byPlatform.length === 0) {
      return {
        ok: false,
        message: `No destination that is on matches "${name}". Use an id from list_destinations.`
      }
    }
    for (const target of byPlatform) named.add(target.id)
  }
  return {
    ok: true,
    excludedTargetIds: on.filter((target) => !named.has(target.id)).map((target) => target.id)
  }
}

/** The draft this livestream goes out with: the saved one, with the call's title. */
export function headlessDraft(
  draft: StreamMetadataDraft | null,
  title: string | undefined
): StreamMetadataDraft | null {
  if (!draft || title === undefined) return draft
  return { ...draft, title }
}

export type HeadlessGoLiveDecision =
  | { kind: 'confirm' }
  | { kind: 'refuse'; message: string }
  /** Leave these out of this livestream and check again ("Go live without"). */
  | { kind: 'exclude'; targetIds: string[] }

/**
 * The dialog's answer for a preflight, without the dialog: confirm when its
 * primary would be enabled, else its blockers in its own words, or, with
 * `allowPartial`, the destinations to leave out first. Captions arrive with
 * the call's `withoutCaptions` already folded into their readiness, as the
 * dialog's "Go live without captions" folds it in.
 */
export function decideHeadlessGoLive(input: {
  preflight: GoLivePreflight
  draft: StreamMetadataDraft | null
  sentStreaming: StreamingSettings
  captionsReadiness: GoLiveCaptionsReadiness
  entitlementGate: EntitlementUiGate
  allowPartial: boolean
}): HeadlessGoLiveDecision {
  const gate = goLiveConfirmGate(input)
  if (!gate.blocked) return { kind: 'confirm' }
  // What only the streamer can fix comes first, each in the dialog's words.
  if (gate.entitlementBlocker) return { kind: 'refuse', message: gate.entitlementBlocker.reason }
  if (input.captionsReadiness.blocksStart) {
    return {
      kind: 'refuse',
      message: sentences(
        `${HEADLESS_GO_LIVE_COPY.captionsTitle}: ${input.captionsReadiness.description}`,
        HEADLESS_GO_LIVE_COPY.withoutCaptionsHint
      )
    }
  }
  if (gate.hasInstantTargets && !input.draft) {
    return { kind: 'refuse', message: HEADLESS_GO_LIVE_COPY.draftLoading }
  }
  const titleProblem = gate.titleIssues?.title ?? gate.titleIssues?.description
  if (titleProblem) return { kind: 'refuse', message: titleProblem }
  const { view } = gate
  if (view.destinations.length === 0) {
    return {
      kind: 'refuse',
      message: sentences(HEADLESS_GO_LIVE_COPY.noDestination, ...view.generalErrors)
    }
  }
  const notReady = view.destinations.filter((row) => !row.ready)
  const readyCount = view.destinations.length - notReady.length
  if (
    input.allowPartial &&
    view.generalErrors.length === 0 &&
    notReady.length > 0 &&
    readyCount > 0
  ) {
    return { kind: 'exclude', targetIds: notReady.map((row) => row.destination.targetId) }
  }
  const rows = notReady.map(
    (row) => `${destinationLabel(row.destination.label)}: ${row.problem ?? row.destination.message}`
  )
  return {
    kind: 'refuse',
    message: sentences(
      ...rows,
      ...view.generalErrors,
      !input.allowPartial && readyCount > 0 && notReady.length > 0 && !view.generalErrors.length
        ? HEADLESS_GO_LIVE_COPY.allowPartialHint
        : ''
    )
  }
}

/**
 * Platform setup left some destinations behind (the dialog's "Some
 * destinations couldn't be set up"). With `allowPartial` the ready ones go
 * live, as "Go live on {ready}" does; without it, the failures in the
 * dialog's words, and the prepared broadcasts are cleaned up as Cancel does.
 */
export function decideHeadlessPartialSetup(
  setup: GoLivePartialSetup,
  allowPartial: boolean
): { kind: 'continue' } | { kind: 'refuse'; message: string } {
  if (allowPartial && setup.readyLabels.length > 0) return { kind: 'continue' }
  const failures = setup.failures.map(
    (failure) => `${platformLabel(failure.platform)}: ${failure.label}. ${failure.message}`
  )
  return {
    kind: 'refuse',
    message: sentences(
      `${HEADLESS_GO_LIVE_COPY.setupFailed}.`,
      ...failures,
      setup.readyLabels.length
        ? `Ready: ${setup.readyLabels.join(', ')}. ${HEADLESS_GO_LIVE_COPY.allowPartialHint}`
        : ''
    )
  }
}

/** Joins sentences with one space, each ending in its own stop. */
function sentences(...parts: string[]): string {
  return parts
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => (/[.!?…]$/.test(part) ? part : `${part}.`))
    .join(' ')
}

/** The Go Live dialog's preflight answer (plan 209 S10: shared with `go_live`). */
export type GoLivePreflightRun =
  | {
      kind: 'ready'
      preflight: GoLivePreflight
      draft: StreamMetadataDraft | null
      capabilities: AiCapabilities | null
    }
  | { kind: 'refused'; reason: string }
  /** The previous livestream is still settling (said in the Studio already). */
  | { kind: 'settling' }
  | { kind: 'offline' }

/**
 * What a Go Live without the dialog decided before it confirms (plan 209
 * S10): the destinations it left out, the draft it goes out with, the
 * preflight it decided on (its scheduled events), and the captions' answer
 * with "Go live without captions" folded in. Passed explicitly, so the
 * confirm never waits for a render to see them.
 */
export type HeadlessGoLiveConfirmation = {
  excludedTargetIds: readonly string[]
  draft: StreamMetadataDraft | null
  preflight: GoLivePreflight
  captionsReadiness: GoLiveCaptionsReadiness
  suppressCaptions: boolean
}

/** Where the Go Live dialog's confirm ended (plan 209 S10). */
export type GoLiveConfirmOutcome =
  /** Another confirm or start owns the transport. */
  | { kind: 'ignored' }
  | { kind: 'captions'; description: string }
  | { kind: 'scheduled-changed'; preflight: GoLivePreflight }
  /** The fresh preflight still blocks; the dialog shows it. */
  | { kind: 'blocked'; preflight: GoLivePreflight }
  | { kind: 'partial'; setup: GoLivePartialSetup }
  | { kind: 'started'; started: boolean; streaming: StreamingSettings }
  | { kind: 'failed'; error: unknown }

/**
 * What a Go Live without the dialog reads and drives in the Studio
 * (hooks/use-studio.tsx): the latest render's state and the dialog's own
 * handlers. The in-flight refs are the Studio's own, so a Go Live here owns
 * the transport exactly as the dialog's does (B-7, B-14).
 */
export interface HeadlessGoLiveStudio {
  /** The Studio has a backend client. */
  connected: boolean
  wsStatus: WsStatus
  recording: RecordingStatus
  /** The Go Live dialog is open. */
  dialogOpen: boolean
  goLiveConfirmationPending: boolean
  startRequestPending: boolean
  openGoLiveConfirmationInFlightRef: { current: Promise<void> | null }
  confirmGoLiveInFlightPromiseRef: { readonly current: unknown }
  sessionStartInFlightRef: { readonly current: unknown }
  config: CaptureConfig
  streamMetadataDraft: StreamMetadataDraft | null
  captionsPlatformUnavailable: string | null
  goLiveCaptionOutputReadiness: CaptionSessionOutputReadiness | undefined
  entitlements: EntitlementsSnapshot | null
  setGoLiveConfirmationPending: (pending: boolean) => void
  setSuppressCaptionsForSession: (suppress: boolean) => void
  runGoLivePreflight: (
    intent: SessionStartIntent,
    streaming: StreamingSettings,
    draft: StreamMetadataDraft | null
  ) => Promise<GoLivePreflightRun>
  revalidateGoLive: (
    streaming: StreamingSettings,
    excludedTargetIds: readonly string[]
  ) => Promise<GoLivePreflight | null>
  runGoLiveConfirmation: (headless: HeadlessGoLiveConfirmation) => Promise<GoLiveConfirmOutcome>
  settlePreparedPlatformLifecycle: (streaming: StreamingSettings) => Promise<unknown>
  startOnReadyDestinations: (headless: {
    setup: GoLivePartialSetup
    suppressCaptions: boolean
  }) => Promise<boolean>
}

/**
 * An agent's `go_live`, without the dialog (plan 209 S10, D13). It runs the
 * dialog's own preflight (`runGoLivePreflight`), decides on the dialog's own
 * gate (`decideHeadlessGoLive`), presses its two ways out when the call asks
 * ("Go live without {destination}" for `allowPartial`, "Go live without
 * captions" for `withoutCaptions`) and confirms through the dialog's own
 * confirm and "Go live on {ready}". Anything only the streamer can fix (sign
 * in, a key, Premium) is refused in the dialog's words. Go Live records too
 * only when Output's recording is on, as the dialog does. Stream Deck and the
 * phone keep opening the dialog (D2, D19).
 */
export async function goLiveWithoutDialog(
  request: HeadlessGoLiveRequest,
  studio: HeadlessGoLiveStudio
): Promise<HeadlessGoLiveOutcome> {
  const copy = HEADLESS_GO_LIVE_COPY
  if (!studio.connected) {
    return { ok: false, message: connectionBlockedReason(studio.wsStatus) ?? copy.inFlight }
  }
  if (sessionOwnsTransport(studio.recording)) {
    return { ok: false, message: START_BLOCKED_COPY.sessionRunning }
  }
  if (studio.dialogOpen) return { ok: false, message: copy.dialogOpen }
  // A Go Live in flight owns the transport (B-14), this one included.
  if (
    shouldIgnoreGoLiveAction({
      goLiveConfirmationPending:
        studio.goLiveConfirmationPending ||
        studio.openGoLiveConfirmationInFlightRef.current !== null ||
        studio.confirmGoLiveInFlightPromiseRef.current !== null,
      startRequestPending:
        studio.startRequestPending || studio.sessionStartInFlightRef.current !== null
    })
  ) {
    return { ok: false, message: copy.inFlight }
  }
  const config = studio.config
  const exclusions = headlessExclusions(config.streaming, request.destinations)
  if (!exclusions.ok) return { ok: false, message: exclusions.message }
  let excludedTargetIds = exclusions.excludedTargetIds
  const intent = livestreamIntent(config.recordEnabled)
  const allowPartial = request.allowPartial === true
  const suppressCaptions = request.withoutCaptions === true

  // The dialog's preflight, owning the transport as the dialog's does
  // (B-7): Record, ⌘K and the remotes wait, and Go Live says Checking….
  const preflightRun = (async () => {
    studio.setGoLiveConfirmationPending(true)
    try {
      return await studio.runGoLivePreflight(
        intent,
        streamingWithoutTargets(config.streaming, excludedTargetIds),
        headlessDraft(studio.streamMetadataDraft, request.title)
      )
    } finally {
      studio.setGoLiveConfirmationPending(false)
    }
  })()
  const preflightGate = preflightRun.then(
    () => undefined,
    () => undefined
  )
  studio.openGoLiveConfirmationInFlightRef.current = preflightGate
  let run: GoLivePreflightRun
  try {
    run = await preflightRun
  } catch (error) {
    return { ok: false, message: sessionStartFailureMessage(error) }
  } finally {
    if (studio.openGoLiveConfirmationInFlightRef.current === preflightGate) {
      studio.openGoLiveConfirmationInFlightRef.current = null
    }
  }
  if (run.kind === 'refused') return { ok: false, message: run.reason }
  if (run.kind === 'settling') return { ok: false, message: LIVESTREAM_STILL_SETTLING }
  if (run.kind === 'offline') {
    return { ok: false, message: connectionBlockedReason(studio.wsStatus) ?? copy.inFlight }
  }

  // "Go live without captions" folds into captions' answer, as in the dialog.
  const captionsReadiness = decideGoLiveCaptionsReadiness({
    persistedEnabled: config.captions.enabled,
    suppressForSession: suppressCaptions || studio.captionsPlatformUnavailable !== null,
    capabilities: run.capabilities,
    outputReadiness: studio.goLiveCaptionOutputReadiness,
    platformUnavailable: studio.captionsPlatformUnavailable
  })
  const entitlementGate = goLiveEntitlementGate({
    entitlements: studio.entitlements,
    streaming: config.streaming
  })
  let preflight = run.preflight
  const decide = (partial: boolean) =>
    decideHeadlessGoLive({
      preflight,
      draft: run.draft,
      sentStreaming: streamingWithoutTargets(config.streaming, excludedTargetIds),
      captionsReadiness,
      entitlementGate,
      allowPartial: partial
    })
  let decision = decide(allowPartial)
  if (decision.kind === 'exclude') {
    // "Go live without {destination}" for each one that isn't ready; the
    // dialog checks again after every one.
    excludedTargetIds = [...excludedTargetIds, ...decision.targetIds]
    const rechecked = await studio.revalidateGoLive(config.streaming, excludedTargetIds)
    if (!rechecked) return { ok: false, message: copy.didNotStart }
    preflight = rechecked
    decision = decide(false)
  }
  if (decision.kind !== 'confirm') {
    return { ok: false, message: decision.kind === 'refuse' ? decision.message : copy.inFlight }
  }

  if (suppressCaptions) studio.setSuppressCaptionsForSession(true)
  const outcome = await studio.runGoLiveConfirmation({
    excludedTargetIds,
    draft: run.draft,
    preflight,
    captionsReadiness,
    suppressCaptions
  })
  const live = (streaming: StreamingSettings): HeadlessGoLiveOutcome => ({
    ok: true,
    destinations: streaming.targets
      .filter((target) => target.enabled)
      .map((target) => ({ id: target.id, platform: target.platform, label: target.label })),
    recording: intent.record
  })
  switch (outcome.kind) {
    case 'ignored':
      return { ok: false, message: copy.inFlight }
    case 'captions':
      return {
        ok: false,
        message: `${copy.captionsTitle}: ${outcome.description} ${copy.withoutCaptionsHint}`
      }
    case 'scheduled-changed':
      return { ok: false, message: copy.scheduledChanged }
    case 'blocked': {
      preflight = outcome.preflight
      const blocked = decide(false)
      return {
        ok: false,
        message: blocked.kind === 'refuse' ? blocked.message : copy.didNotStart
      }
    }
    case 'failed':
      return { ok: false, message: sessionStartFailureMessage(outcome.error) }
    case 'partial': {
      const next = decideHeadlessPartialSetup(outcome.setup, allowPartial)
      if (next.kind === 'refuse') {
        // What Cancel does with a partial setup: nothing prepared stays behind.
        void studio.settlePreparedPlatformLifecycle(outcome.setup.streaming)
        return { ok: false, message: next.message }
      }
      return (await studio.startOnReadyDestinations({ setup: outcome.setup, suppressCaptions }))
        ? live(outcome.setup.streaming)
        : { ok: false, message: copy.didNotStart }
    }
    case 'started':
      return outcome.started ? live(outcome.streaming) : { ok: false, message: copy.didNotStart }
  }
}
