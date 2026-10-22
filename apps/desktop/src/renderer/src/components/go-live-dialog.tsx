import { CaptionsIcon, LivestreamIcon } from '@/components/icons'
import { useId, useRef, useState, type KeyboardEvent, type ReactElement } from 'react'

import { ListRow, GroupedList } from '@/components/list-row'
import { LockAlert } from '@/components/lock-alert'
import { PlatformGlyph } from '@/components/platform-glyph'
import { SectionLabel } from '@/components/section-label'
import { StatusBadge, type StatusTone } from '@/components/status-badge'
import { BroadcastInfoFields } from '@/components/streaming/broadcast-info-fields'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { DisabledReason } from '@/components/ui/disabled-reason'
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { ShortcutKeys } from '@/components/ui/shortcut-keys'
import { useStudioBanners, useStudioCore } from '@/hooks/use-studio'
import { simulcastArmed } from '@/lib/capture'
import type {
  CommentsReadState,
  CommentsWriteState,
  GoLiveDestinationPreflight,
  StreamPlatform,
  StreamTargetSettings,
  StreamingSettings,
  VideoSettings
} from '@/lib/backend'
import { broadcastInfoIssues } from '@/lib/broadcast-info'
import { type EntitlementUiGate } from '@/lib/entitlement-ui'
import { unlockActionForGate } from '@/lib/lock-view'
import type { GoLiveCaptionsReadiness } from '@/lib/captions-preflight'
import { GO_LIVE_DIALOG_TITLE, goLiveConfirmLabel, goLiveOnReadyLabel } from '@/lib/go-live-copy'
import {
  goLiveDialogView,
  goLivePendingLabel,
  type GoLiveDestinationView,
  type GoLivePhase
} from '@/lib/go-live-dialog-view'
import { streamingWithoutTargets } from '@/lib/go-live-exclusions'
import { softwareStreamAdvice, type SoftwareStreamAdvice } from '@/lib/go-live-output'
import { START_NOTICE_LABELS, overlayAndBannerStartNotices } from '@/lib/banner-start-notices'
import { formatVideoQuality } from '@/lib/format-video'
import { outputLabel } from '@/lib/performance-check'
import { isCommandKey, shortcutAriaKeys } from '@/lib/platform'
import { destinationLabel, platformLabel } from '@/lib/platform-copy'
import { shortcutAccelerator } from '@/lib/shortcuts'
import { YOUTUBE_STREAM_KEY_LINK_LABEL, YOUTUBE_STREAM_KEY_URL } from '@/lib/youtube-quota-copy'

/** Why the primary waits: the dialog lists what blocks it above the button. */
const GO_LIVE_BLOCKED_REASON = 'Fix the items above, then go live.'

/** The note under a destination left out of this livestream (B-8). */
export const GO_LIVE_EXCLUDED_NOTE = 'Only for this livestream. Your destination stays on.'

/** Platforms whose destinations sign in, so a Reconnect can fix them. */
const SIGN_IN_PLATFORMS: ReadonlySet<StreamPlatform> = new Set(['youtube', 'twitch', 'kick', 'x'])

export type GoLiveResolution = 'exclude' | 'include' | 'manual-rtmp'

// The Go Live dialog (plan 174 S3.4): stream details, then the destinations
// as one grouped list, then one Alert per kind of callout (destructive for
// what blocks, warning for limits, default for advice). ⌘↵ goes live; the
// first focus is the title (or the primary); the pending primary names the
// phase. The dialog rides the studio state machine (no second one) through
// the props GoLiveDialogHost threads in.
export function GoLiveConfirmationDialog({
  open,
  pending,
  phase = null,
  partialSetup,
  preflight,
  entitlementGate,
  draft,
  captionsReadiness,
  excludedTargets = [],
  platform,
  onPatchDraft,
  onCancel,
  onConfirm,
  onContinuePartial,
  onContinueWithoutCaptions,
  onResolveBlocker,
  onReconnect,
  onRecheck
}: {
  open: boolean
  pending: boolean
  /** Where a confirmed Go Live is, for the pending label. */
  phase?: GoLivePhase | null
  partialSetup: ReturnType<typeof useStudioCore>['goLivePartialSetup']
  preflight: ReturnType<typeof useStudioCore>['goLivePreflight']
  entitlementGate: EntitlementUiGate
  draft: ReturnType<typeof useStudioCore>['streamMetadataDraft']
  captionsReadiness: GoLiveCaptionsReadiness
  /** Saved destinations left out of this livestream only. */
  excludedTargets?: readonly StreamTargetSettings[]
  platform?: string
  onPatchDraft: ReturnType<typeof useStudioCore>['patchStreamMetadataDraft']
  onCancel: () => void
  onConfirm: () => void
  onContinuePartial: () => void
  onContinueWithoutCaptions: () => void
  onResolveBlocker: (targetId: string, resolution: GoLiveResolution) => void
  /** Signs the platform in again (opens the browser). */
  onReconnect?: (platform: StreamPlatform) => void
  /** Runs the check again, after a Reconnect. */
  onRecheck?: () => void
}): ReactElement {
  const {
    captureConfig,
    performanceCheck,
    streamOutputTopologyPreflight,
    streamSharedEncodeFallbackVideo,
    overlayLayout
  } = useStudioCore()
  const { banners } = useStudioBanners()
  const titleRef = useRef<HTMLInputElement>(null)
  const primaryRef = useRef<HTMLButtonElement>(null)
  const cancelRef = useRef<HTMLButtonElement>(null)
  // Destinations the streamer sent to sign in again: their row offers "Check
  // again" once they are back. Cleared when the dialog closes.
  const [reconnected, setReconnected] = useState<readonly string[]>([])
  const [wasOpen, setWasOpen] = useState(open)
  if (open !== wasOpen) {
    setWasOpen(open)
    if (!open) setReconnected([])
  }

  // The livestream this Go Live sends: the saved destinations minus the ones
  // left out of it (B-8). The advice below describes this one, so a left-out
  // vertical or Instagram destination is never mentioned.
  const excludedIds = excludedTargets.map((target) => target.id)
  const sentStreaming = streamingWithoutTargets(captureConfig.streaming, excludedIds)
  const sentCapture =
    sentStreaming === captureConfig.streaming
      ? captureConfig
      : { ...captureConfig, streaming: sentStreaming }
  const simulcast = simulcastArmed(sentCapture)

  // D13 (plan 164): every overlay switch pair this session cannot honour,
  // said before start. The auxiliary leg is the topology's, never an
  // overlay's: the vertical leg when simulcast is armed, a split stream leg
  // when the output check proved one, else the one shared encode. Banners
  // that are showing count as one item, "Banners" (plan 186).
  const overlayNotices = overlayAndBannerStartNotices(
    {
      recordEnabled: captureConfig.recordEnabled,
      streamEnabled: true,
      auxLeg: simulcast
        ? 'vertical-simulcast'
        : captureConfig.recordEnabled &&
            !streamSharedEncodeFallbackVideo &&
            (streamOutputTopologyPreflight.state !== 'ready' ||
              streamOutputTopologyPreflight.result.outputRoles.includes('stream'))
          ? 'stream'
          : 'none'
    },
    overlayLayout,
    banners
  )
  // What the finished check and this computer's measurement say about the
  // stream as configured, before anything starts.
  const streamPerformanceAdvice =
    streamOutputTopologyPreflight.state === 'ready' && !simulcast
      ? softwareStreamAdvice({
          streamVideo: streamOutputTopologyPreflight.result.streamProfile,
          encodeBackend: streamOutputTopologyPreflight.result.effectiveEncodeBackend,
          state: performanceCheck
        })
      : null
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
  const canConfirm = !pending && Boolean(preflight) && !blocked
  const canContinuePartial =
    !pending && !entitlementBlocker && !captionsReadiness.blocksStart && Boolean(partialSetup)
  const confirmAccelerator = shortcutAccelerator('go-live-confirm')

  // ⌘↵ is the primary, wherever focus is in the dialog (B-14).
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key !== 'Enter' || !isCommandKey(event, platform)) return
    event.preventDefault()
    if (event.repeat) return
    if (partialSetup) {
      if (canContinuePartial) onContinuePartial()
    } else if (canConfirm) {
      onConfirm()
    }
  }

  // The first focus is the title, else the primary, never a button that
  // changes a destination (B-14).
  const focusFirst = (event: Event): void => {
    event.preventDefault()
    for (const element of [titleRef.current, primaryRef.current, cancelRef.current]) {
      if (element && !element.disabled) {
        element.focus()
        return
      }
    }
  }

  const reconnect = (destination: GoLiveDestinationPreflight): void => {
    onReconnect?.(destination.platform)
    setReconnected((current) =>
      current.includes(destination.targetId) ? current : [...current, destination.targetId]
    )
  }

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onCancel()}>
      <DialogContent
        className="gap-4"
        // Stable hooks for the live lab's CDP driver (plan 178 U6): the
        // dialog says whether a confirmed Go Live is still under way.
        data-pending={pending ? 'true' : 'false'}
        data-phase={phase?.kind}
        data-testid="go-live-dialog"
        size="xl"
        onKeyDown={onKeyDown}
        onOpenAutoFocus={focusFirst}
      >
        <DialogHeader>
          <DialogTitle>{GO_LIVE_DIALOG_TITLE}</DialogTitle>
          <DialogDescription>
            Check your destinations and stream details before Videorc starts the livestream.
          </DialogDescription>
        </DialogHeader>

        <DialogBody>
          <div className="flex flex-col gap-5">
            {hasInstantTargets ? (
              <section
                aria-label="Stream details"
                className="flex flex-col gap-2"
                data-testid="go-live-details"
              >
                <SectionLabel as="h3">Stream details</SectionLabel>
                <BroadcastInfoFields
                  disabled={pending || !draft}
                  idPrefix="go-live"
                  privacyNote="Twitch, Kick and X are always public."
                  titleRef={titleRef}
                  titleRequired
                  value={{
                    title: draft?.title ?? '',
                    description: draft?.description ?? '',
                    privacy: instantYouTube ? (draft?.defaultPrivacy ?? 'private') : undefined
                  }}
                  onChange={(patch) =>
                    onPatchDraft({
                      ...(patch.title !== undefined ? { title: patch.title } : {}),
                      ...(patch.description !== undefined
                        ? { description: patch.description }
                        : {}),
                      ...(patch.privacy !== undefined ? { defaultPrivacy: patch.privacy } : {})
                    })
                  }
                />
              </section>
            ) : null}

            <section aria-label="Destinations" className="flex flex-col gap-2">
              <div className="flex items-center justify-between gap-3">
                <SectionLabel as="h3">Destinations</SectionLabel>
                {view.summary ? (
                  <StatusBadge
                    tone={view.destinationsReady ? 'good' : 'warn'}
                    value={view.summary}
                  />
                ) : null}
              </div>
              {hasScheduledTargets ? (
                <Alert>
                  <AlertDescription>
                    A scheduled event starts now, even if its time is earlier or later.
                    {hasInstantTargets
                      ? ' The stream details above go to the other destinations.'
                      : ''}
                  </AlertDescription>
                </Alert>
              ) : null}
              {view.destinations.length || excludedTargets.length ? (
                <GroupedList data-testid="go-live-destinations">
                  {view.destinations.map((row) => (
                    <GoLiveDestinationRow
                      key={row.destination.targetId}
                      pending={pending}
                      reconnected={reconnected.includes(row.destination.targetId)}
                      scheduledFallback={sentTargets.find(
                        (target) => target.id === row.destination.targetId
                      )}
                      view={row}
                      onRecheck={onRecheck}
                      onReconnect={onReconnect ? reconnect : undefined}
                      onResolveBlocker={onResolveBlocker}
                    />
                  ))}
                  {excludedTargets.map((target) => (
                    <GoLiveExcludedRow
                      key={target.id}
                      pending={pending}
                      target={target}
                      onInclude={() => onResolveBlocker(target.id, 'include')}
                    />
                  ))}
                </GroupedList>
              ) : (
                <p className="text-sm text-muted-foreground">
                  No destination is on. Turn one on in Livestream → Setup.
                </p>
              )}
            </section>

            {captionsReadiness.kind !== 'disabled' ? (
              <GoLiveCaptionsStatus
                pending={pending}
                readiness={captionsReadiness}
                onContinueWithoutCaptions={onContinueWithoutCaptions}
              />
            ) : null}

            {entitlementBlocker ? (
              <LockAlert
                action={unlockActionForGate(entitlementBlocker)}
                reason={entitlementBlocker.reason}
              />
            ) : null}

            {view.generalErrors.length ? (
              <Alert data-testid="go-live-blockers" variant="destructive">
                <AlertTitle>Fix before going live</AlertTitle>
                <AlertDescription>
                  <ul className="grid gap-1">
                    {view.generalErrors.map((message) => (
                      <li key={message}>{message}</li>
                    ))}
                  </ul>
                </AlertDescription>
              </Alert>
            ) : null}

            {view.warnings.length ? (
              <Alert data-testid="go-live-limits" variant="warning">
                <AlertTitle>Chat limits</AlertTitle>
                <AlertDescription>
                  <ul className="grid gap-1">
                    {view.warnings.map((message) => (
                      <li key={message}>{message}</li>
                    ))}
                  </ul>
                </AlertDescription>
              </Alert>
            ) : null}

            {simulcast ? <GoLiveSimulcastAdvisory streaming={sentStreaming} /> : null}

            <GoLiveOutputAdvice
              advice={streamPerformanceAdvice}
              recordEnabled={captureConfig.recordEnabled}
              sharedVideo={streamSharedEncodeFallbackVideo}
            />

            {overlayNotices.length ? (
              <Alert data-videorc-go-live-overlay-notices="">
                <AlertTitle>Overlays this time</AlertTitle>
                <AlertDescription>
                  <ul className="grid gap-1">
                    {overlayNotices.map((notice) => (
                      <li
                        key={`${notice.item}:${notice.notice}`}
                        data-videorc-go-live-overlay-notice={notice.item}
                      >
                        <span className="font-medium text-foreground">
                          {START_NOTICE_LABELS[notice.item]}
                        </span>
                        {' · '}
                        {notice.notice}
                      </li>
                    ))}
                  </ul>
                </AlertDescription>
              </Alert>
            ) : null}

            {partialSetup ? (
              <Alert data-testid="go-live-partial-setup" variant="warning">
                <AlertTitle>Some destinations couldn&apos;t be set up</AlertTitle>
                <AlertDescription className="flex flex-col gap-2">
                  <ul className="grid gap-1.5">
                    {partialSetup.failures.map((failure) => (
                      <li key={failure.targetId} className="flex flex-col gap-1.5">
                        <span>
                          {platformLabel(failure.platform)}: {failure.label}. {failure.message}
                        </span>
                        {failure.fallback === 'manual-rtmp' ? (
                          // Plan 094 (G5): YouTube's API is paused, so the key path
                          // is the way to go live. The destination flips to its
                          // stream key, a saved change; the key itself comes
                          // from YouTube Studio.
                          <span className="flex flex-wrap items-center gap-2">
                            <Button
                              disabled={pending}
                              variant="outline"
                              onClick={() => onResolveBlocker(failure.targetId, 'manual-rtmp')}
                            >
                              Use stream key
                            </Button>
                            <Button
                              className="h-auto p-0 text-xs"
                              variant="link"
                              onClick={() => openExternalUrl(YOUTUBE_STREAM_KEY_URL)}
                            >
                              {YOUTUBE_STREAM_KEY_LINK_LABEL}
                            </Button>
                          </span>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                  <p className="text-xs">Ready: {partialSetup.readyLabels.join(', ')}</p>
                </AlertDescription>
              </Alert>
            ) : null}
          </div>
        </DialogBody>

        <DialogFooter>
          <Button
            ref={cancelRef}
            data-testid="go-live-cancel"
            disabled={pending}
            variant="ghost"
            onClick={onCancel}
          >
            Cancel
          </Button>
          {partialSetup ? (
            <Button
              ref={primaryRef}
              aria-keyshortcuts={shortcutAriaKeys(confirmAccelerator, platform)}
              data-testid="go-live-continue-partial"
              disabled={!canContinuePartial}
              onClick={onContinuePartial}
            >
              <LivestreamIcon data-icon="inline-start" weight="fill" />
              {pending ? goLivePendingLabel(phase) : goLiveOnReadyLabel(partialSetup.readyLabels)}
              {pending ? null : (
                <ShortcutKeys
                  accelerator={confirmAccelerator}
                  className="ml-1"
                  platform={platform}
                />
              )}
            </Button>
          ) : (
            // The primary always says what it does (D3); while something above
            // blocks it, the reason rides on hover and focus, never as its label.
            <DisabledReason reason={!pending && blocked ? GO_LIVE_BLOCKED_REASON : null}>
              <Button
                ref={primaryRef}
                aria-keyshortcuts={shortcutAriaKeys(confirmAccelerator, platform)}
                data-testid="go-live-confirm"
                disabled={!canConfirm}
                onClick={onConfirm}
              >
                <LivestreamIcon data-icon="inline-start" weight="fill" />
                {pending
                  ? goLivePendingLabel(phase)
                  : goLiveConfirmLabel(preflight?.destinations.length ?? 0)}
                {pending ? null : (
                  <ShortcutKeys
                    accelerator={confirmAccelerator}
                    className="ml-1"
                    platform={platform}
                  />
                )}
              </Button>
            </DisabledReason>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/**
 * What this computer changes about the stream before it starts (plan 090):
 * a step-down to the output it can hold, a warning when nothing held, or the
 * recording matching the stream. Quiet when the saved settings go out as is.
 */
export function GoLiveOutputAdvice({
  advice,
  recordEnabled,
  sharedVideo
}: {
  advice: SoftwareStreamAdvice | null
  recordEnabled: boolean
  sharedVideo: VideoSettings | null
}): ReactElement | null {
  if (advice?.kind === 'below-floor') {
    return (
      <Alert variant="warning">
        <AlertTitle>This computer may not keep up</AlertTitle>
        <AlertDescription>
          Nothing held steady in its performance check, not even {outputLabel(advice.floor)}.
          Viewers will likely see a stuttering picture. Close other apps, or check again in Output.
        </AlertDescription>
      </Alert>
    )
  }
  if (advice?.kind === 'step-down') {
    return (
      <Alert>
        <AlertTitle>Streaming at {outputLabel(advice.video)}</AlertTitle>
        <AlertDescription>
          This computer can&apos;t encode {outputLabel(advice.requested)} in real time, so this
          session uses the largest output that held steady in its performance check
          {recordEnabled ? ', for the recording too' : ''}. Your saved settings stay as they are.
        </AlertDescription>
      </Alert>
    )
  }
  if (sharedVideo && recordEnabled) {
    return (
      <Alert>
        <AlertTitle>Recording will match the stream</AlertTitle>
        <AlertDescription>
          This computer can&apos;t encode a separate recording while streaming, so both use{' '}
          {formatVideoQuality(sharedVideo, { bitrate: true })} for this session.
        </AlertDescription>
      </Alert>
    )
  }
  return null
}

/**
 * Captions for this livestream: a quiet row when ready, advice when skipped
 * for this livestream, and a blocker with its one-livestream way out.
 */
export function GoLiveCaptionsStatus({
  readiness,
  pending,
  onContinueWithoutCaptions
}: {
  readiness: GoLiveCaptionsReadiness
  pending: boolean
  onContinueWithoutCaptions: () => void
}): ReactElement {
  if (readiness.kind === 'blocked') {
    return (
      <Alert data-testid="go-live-captions" variant="destructive">
        <AlertTitle>Captions can&apos;t start</AlertTitle>
        <AlertDescription className="flex flex-col items-start gap-2">
          <span>{readiness.description}</span>
          <Button
            data-testid="go-live-captions-skip"
            disabled={pending}
            variant="outline"
            onClick={onContinueWithoutCaptions}
          >
            Go live without captions
          </Button>
        </AlertDescription>
      </Alert>
    )
  }
  if (readiness.kind === 'skipped') {
    return (
      <Alert data-testid="go-live-captions">
        <AlertTitle>No captions this time</AlertTitle>
        <AlertDescription>{readiness.description}</AlertDescription>
      </Alert>
    )
  }
  return (
    <GroupedList data-testid="go-live-captions">
      <section className="flex flex-col">
        <ListRow
          className="h-auto min-h-10 py-1.5"
          icon={<CaptionsIcon className="size-4 text-muted-foreground" weight="duotone" />}
          title="Captions"
        >
          <StatusBadge tone={readiness.kind === 'ready' ? 'good' : 'neutral'} value="Ready" />
        </ListRow>
        <p className="pr-3 pb-3 pl-10.5 text-xs text-muted-foreground">{readiness.description}</p>
      </section>
    </GroupedList>
  )
}

function openExternalUrl(url: string): void {
  const opener = window.videorc?.openOAuthUrl
  if (opener) {
    void opener(url)
    return
  }

  window.open(url, '_blank', 'noopener,noreferrer')
}

/**
 * One destination (plan 174 S3.4, B-12 and D-7): the platform tile, its
 * name, the account (or "Stream key") as context, one status chip; under it
 * the scheduled event, what it needs, its chat, and its fixes. "Go live
 * without {name}" is for this livestream only (B-8); "Use stream key" (S2.2's
 * one name for that fix) is a saved change; "Reconnect {platform}…" signs in
 * again, then "Check again" asks the backend once more.
 */
export function GoLiveDestinationRow({
  view,
  pending,
  reconnected = false,
  scheduledFallback,
  onResolveBlocker,
  onReconnect,
  onRecheck
}: {
  view: GoLiveDestinationView
  pending: boolean
  /** The streamer was sent to sign in again: offer "Check again". */
  reconnected?: boolean
  /** The saved target, for a scheduled event the preflight didn't echo. */
  scheduledFallback?: StreamTargetSettings
  onResolveBlocker: (targetId: string, resolution: GoLiveResolution) => void
  onReconnect?: (destination: GoLiveDestinationPreflight) => void
  onRecheck?: () => void
}): ReactElement {
  const { destination, ready, problem } = view
  const titleId = useId()
  const oauth = destination.authMode === 'oauth'
  const scheduledTitle = destination.scheduled?.title ?? scheduledFallback?.scheduledEventTitle
  const scheduledStart = destination.scheduled?.startUtc ?? scheduledFallback?.scheduledStartUtc
  // X broadcasts carry no visibility; only YouTube shows one.
  const scheduledPrivacy =
    destination.platform === 'youtube'
      ? (destination.scheduled?.privacy ?? scheduledFallback?.scheduledPrivacy)
      : undefined
  const scheduled =
    destination.scheduled || scheduledFallback?.scheduledEventId
      ? [
          scheduledTitle ? `Scheduled: ${scheduledTitle}` : 'Scheduled event',
          scheduledPrivacy ? capitalize(scheduledPrivacy) : undefined,
          scheduledStart ? new Date(scheduledStart).toLocaleString() : undefined
        ]
          .filter(Boolean)
          .join(' · ')
      : null
  const canSignIn = oauth && SIGN_IN_PLATFORMS.has(destination.platform)

  return (
    <section
      aria-labelledby={titleId}
      className="flex flex-col"
      data-ready={ready}
      data-slot="go-live-destination"
      data-target-id={destination.targetId}
      data-testid="go-live-destination"
    >
      <ListRow
        className="h-auto min-h-10 py-1.5"
        // How it connects, in the Livestream page's words: the account it
        // signs in with, or its stream key (plan 174 S2.2, D-7).
        context={oauth ? (destination.accountLabel ?? 'Sign in') : 'Stream key'}
        icon={<PlatformGlyph platform={destination.platform} />}
        title={<span id={titleId}>{destinationLabel(destination.label)}</span>}
      >
        <StatusBadge tone={ready ? 'good' : 'warn'} value={ready ? 'Ready' : 'Needs attention'} />
      </ListRow>
      <div
        className="flex min-w-0 flex-col gap-2 pr-3 pb-3 pl-13"
        data-slot="go-live-destination-body"
      >
        {scheduled ? <p className="text-xs text-muted-foreground">{scheduled}</p> : null}
        {!ready && problem ? <p className="text-xs text-foreground">{problem}</p> : null}
        <GoLiveCommentsStatus
          message={destination.chatMessage}
          read={destination.chatRead}
          write={destination.chatWrite}
        />
        {!ready ? (
          <div className="flex flex-wrap gap-2">
            {canSignIn && onReconnect ? (
              reconnected && onRecheck ? (
                <Button disabled={pending} variant="outline" onClick={onRecheck}>
                  Check again
                </Button>
              ) : (
                <Button
                  disabled={pending}
                  variant="outline"
                  onClick={() => onReconnect(destination)}
                >
                  {destination.accountLabel ? 'Reconnect' : 'Connect'}{' '}
                  {platformLabel(destination.platform)}…
                </Button>
              )
            ) : null}
            {oauth ? (
              <Button
                disabled={pending}
                variant="outline"
                onClick={() => onResolveBlocker(destination.targetId, 'manual-rtmp')}
              >
                Use stream key
              </Button>
            ) : null}
            <Button
              data-testid="go-live-destination-exclude"
              disabled={pending}
              variant="outline"
              onClick={() => onResolveBlocker(destination.targetId, 'exclude')}
            >
              Go live without {destinationLabel(destination.label)}
            </Button>
          </div>
        ) : null}
      </div>
    </section>
  )
}

/** A destination left out of this livestream (B-8): it stays on in Livestream. */
export function GoLiveExcludedRow({
  target,
  pending,
  onInclude
}: {
  target: StreamTargetSettings
  pending: boolean
  onInclude: () => void
}): ReactElement {
  const titleId = useId()
  return (
    <section
      aria-labelledby={titleId}
      className="flex flex-col"
      data-slot="go-live-excluded"
      data-target-id={target.id}
      data-testid="go-live-excluded"
    >
      <ListRow
        className="h-auto min-h-10 py-1.5"
        context={target.authMode === 'oauth' ? (target.accountLabel ?? 'Sign in') : 'Stream key'}
        icon={<PlatformGlyph platform={target.platform} />}
        title={<span id={titleId}>{target.label}</span>}
      >
        <StatusBadge tone="neutral" value="Left out" />
      </ListRow>
      <div className="flex min-w-0 flex-wrap items-center gap-2 pr-3 pb-3 pl-13">
        <p className="min-w-0 flex-1 text-xs text-muted-foreground">{GO_LIVE_EXCLUDED_NOTE}</p>
        <Button
          data-testid="go-live-include"
          disabled={pending}
          variant="outline"
          onClick={onInclude}
        >
          Add back
        </Button>
      </div>
    </section>
  )
}

const READ_TONE: Record<CommentsReadState, StatusTone> = {
  ready: 'good',
  connecting: 'neutral',
  'waiting-for-broadcast-context': 'neutral',
  ended: 'neutral',
  failed: 'error',
  unavailable: 'neutral'
}

const WRITE_TONE: Record<CommentsWriteState, StatusTone> = {
  ready: 'good',
  'missing-scope': 'warn',
  'read-only': 'neutral',
  failed: 'error',
  unavailable: 'neutral'
}

/** What chat can do on a destination: read, send, and why not. */
export function GoLiveCommentsStatus({
  read,
  write,
  message
}: {
  read: CommentsReadState
  write: CommentsWriteState
  message: string
}): ReactElement {
  return (
    <div className="flex flex-col gap-1.5">
      <div aria-label="Chat read and send status" className="flex flex-wrap gap-1.5" role="group">
        <StatusBadge label="Read" tone={READ_TONE[read]} value={commentsReadLabel(read)} />
        <StatusBadge label="Send" tone={WRITE_TONE[write]} value={commentsWriteLabel(write)} />
      </div>
      {message ? <p className="text-xs text-muted-foreground">{message}</p> : null}
    </div>
  )
}

function commentsReadLabel(state: CommentsReadState): string {
  switch (state) {
    case 'ready':
      return 'Ready'
    case 'connecting':
      return 'Connecting'
    case 'waiting-for-broadcast-context':
      return 'After publish'
    case 'ended':
      return 'Ended'
    case 'failed':
      return 'Failed'
    case 'unavailable':
      return 'Unavailable'
  }
}

function commentsWriteLabel(state: CommentsWriteState): string {
  switch (state) {
    case 'ready':
      return 'Ready'
    case 'missing-scope':
      return 'Reconnect to send'
    case 'read-only':
      return 'Read-only'
    case 'failed':
      return 'Failed'
    case 'unavailable':
      return 'Unavailable'
  }
}

function capitalize(word: string): string {
  return word.charAt(0).toUpperCase() + word.slice(1)
}

// Dual-orientation sessions double the encode count and the upstream
// bandwidth: advice, never a block (per-target dropped-frame status is the
// honest live signal). Instagram's manual publish step lives here because it
// happens AT Go Live time, not while configuring the card. `streaming` is
// what this Go Live sends (left-out destinations already off).
function GoLiveSimulcastAdvisory({ streaming }: { streaming: StreamingSettings }): ReactElement {
  const enabled = streaming.targets.filter(
    (target) => target.enabled && streaming.enabledTargetIds.includes(target.id)
  )
  const totalKbps = enabled.reduce(
    (sum, target) => sum + (target.outputBitrateKbps ?? streaming.defaultBitrateKbps),
    0
  )
  const mbps = Math.max(1, Math.round(totalKbps / 1000))
  const hasInstagram = enabled.some((target) => target.platform === 'instagram')
  return (
    <Alert>
      <AlertTitle>Streaming both orientations</AlertTitle>
      <AlertDescription className="flex flex-col gap-1">
        <span>
          The horizontal scene streams to your landscape destinations while the saved vertical scene
          streams to the vertical ones, about {mbps} Mbps upstream across all legs.
        </span>
        {hasInstagram ? (
          <span>
            Instagram: once Videorc starts sending, press “Go live” in Instagram Live Producer to
            publish the stream to your profile.
          </span>
        ) : null}
      </AlertDescription>
    </Alert>
  )
}
