import type {
  GoLivePreflight,
  StreamMetadataDraft,
  StreamPlatform,
  StreamingSettings
} from './backend'
import type { GoLiveCaptionsReadiness } from './captions-preflight'
import type { EntitlementUiGate } from './entitlement-ui'
import { goLiveConfirmGate } from './go-live-dialog-view'
import type { GoLivePartialSetup } from './go-live-flow'
import { destinationLabel, platformLabel } from './platform-copy'

// Going live without the dialog (plan 209 S10, D13). An agent's `go_live`
// runs the Go Live dialog's own preflight and confirm in the Studio
// (hooks/use-studio.tsx) and decides here, purely, what the dialog would have
// shown: the same gate the dialog disables its primary on
// (`goLiveConfirmGate`), the same blockers in the dialog's words, and the
// two ways out the dialog offers, "Go live without {destination}" for every
// destination that isn't ready (`allowPartial`) and "Go live without
// captions" (`withoutCaptions`). A blocker only the streamer can fix (sign
// in, a missing key, Premium) is always a refusal: agents never connect
// accounts. Loaded with the first agent Go Live, never in the eager bundle.

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
