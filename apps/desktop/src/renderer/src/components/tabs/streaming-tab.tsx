import { AlertIcon, SaveIcon, TextIcon } from '@/components/icons'
import { lazy, Suspense, useCallback, useEffect, useMemo, useState, type ReactElement } from 'react'
import { PageTabs } from '@/components/page-tabs'
import { TabsContent } from '@/components/ui/tabs'
import { LIVESTREAM_VIEWS, type LivestreamViewId } from '@/lib/livestream-tabs'
const ScheduledStreams = lazy(() =>
  import('@/components/scheduled-streams').then((m) => ({ default: m.ScheduledStreams }))
)

import { GroupedList } from '@/components/list-row'
import { LockAlert, SessionLockAlert } from '@/components/lock-alert'
import { PlatformGlyph } from '@/components/platform-glyph'
import { PanelSection } from '@/components/panel-section'
import { StatusBadge } from '@/components/status-badge'
import { BroadcastInfoFields } from '@/components/streaming/broadcast-info-fields'
import { CategoryCombobox } from '@/components/streaming/category-combobox'
import { DestinationCard } from '@/components/streaming/destination-card'
import { youtubeQuotaPausedUntil } from '@/lib/youtube-quota'
import { GoLivePanel } from '@/components/streaming/go-live-panel'
import { ThumbnailField } from '@/components/streaming/thumbnail-field'
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger
} from '@/components/ui/accordion'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import {
  metadataOverrideSummary,
  streamDetailsStatus,
  visibleMetadataOverrides
} from '@/lib/stream-metadata-summary'
import { Button } from '@/components/ui/button'
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldError,
  FieldLabel
} from '@/components/ui/field'
import { SegmentedControl, type SegmentedControlOption } from '@/components/ui/segmented-control'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { useStudioCore } from '@/hooks/use-studio'
import type {
  PlatformAccount,
  PlatformAccountValidation,
  PlatformConnectOptions,
  OAuthProviderCredentialStatus,
  StreamMetadataDraft,
  StreamMetadataValidation,
  StreamPlatform,
  StreamPrivacy,
  StreamTargetRuntime,
  StreamTargetSettings,
  TwitchCategory,
  KickCategory
} from '@/lib/backend'
import { streamingDestinationCap, streamingDestinationEnableGate } from '@/lib/entitlement-ui'
import { entitlementDisabledReason } from '@/lib/entitlements'
import { smoothScrollBehavior } from '@/hooks/use-reduced-motion'
import { unlockActionForReason } from '@/lib/lock-view'
import { destinationSetup } from '@/lib/destination-readiness'
import { destinationLabel } from '@/lib/platform-copy'
import { otherDestinationsLine } from '@/lib/stream-target-notices'
import { destinationStateLabel } from '@/lib/state-labels'
import { broadcastThumbnailHint } from '@/lib/broadcast-info'
import { streamLanguageOptions } from '@/lib/stream-languages'

/**
 * Livestream (plan 174 S1.6b, A-14): Setup and Upcoming in a strip pinned
 * under the toolbar, like Settings; only the view under it scrolls. The view
 * lives in the shell, so the page reopens on the one used last and ⌘K can
 * open Upcoming by name.
 */
export function StreamingTab({
  view,
  onViewChange
}: {
  view: LivestreamViewId
  onViewChange: (view: LivestreamViewId) => void
}): ReactElement {
  return (
    <PageTabs
      label="Livestream view"
      tabs={LIVESTREAM_VIEWS}
      value={view}
      onValueChange={onViewChange}
    >
      <TabsContent value="setup">
        <StreamingSetup />
      </TabsContent>
      <TabsContent value="upcoming">
        <Suspense fallback={<p role="status">Loading upcoming streams…</p>}>
          <ScheduledStreams />
        </Suspense>
      </TabsContent>
    </PageTabs>
  )
}

function StreamingSetup(): ReactElement {
  const {
    captureConfig,
    connectPlatformAccount,
    disconnectPlatformAccount,
    patchStreamMetadataDraft,
    patchStreamTargetMetadataDraft,
    patchStreamingTarget,
    saveManualStreamKey,
    restorePreviousStreamKey,
    platformAccountValidations,
    platformAccounts,
    youtubeChannels,
    youtubeChannelsLoading,
    refreshYouTubeChannels,
    oauthProviderCredentials,
    saveStreamMetadataDraft,
    selectYouTubeChannel,
    entitlements,
    isSessionActive,
    goLiveConfirmationPending,
    goLivePartialSetup,
    streamMetadataDraft,
    streamMetadataSavePending,
    streamMetadataValidation,
    streamTargets,
    twitchCategories,
    twitchCategorySearchPending,
    searchTwitchCategories,
    kickCategories,
    kickCategorySearchPending,
    searchKickCategories,
    xNativeCapability,
    xNativeCapabilityLoading,
    refreshXNativeCapability,
    authorizeXLive,
    requestStopSession,
    youtubeQuota
  } = useStudioCore()
  const youtubeQuotaPaused = youtubeQuotaPausedUntil(youtubeQuota)
  const streaming = captureConfig.streaming
  const livestreamingEntitlementReason = entitlementDisabledReason(entitlements, 'livestreaming')
  const streamingControlsDisabled =
    isSessionActive ||
    goLiveConfirmationPending ||
    Boolean(goLivePartialSetup) ||
    Boolean(livestreamingEntitlementReason)

  const runtimeById = useMemo(() => {
    const map = new Map<string, StreamTargetRuntime>()
    for (const runtime of streamTargets) {
      map.set(runtime.targetId, runtime)
    }
    return map
  }, [streamTargets])

  const accountByPlatform = useMemo(() => {
    const map = new Map<StreamPlatform, PlatformAccount>()
    for (const account of platformAccounts) {
      map.set(account.platform, account)
    }
    return map
  }, [platformAccounts])

  const validationByPlatform = useMemo(() => {
    const map = new Map<StreamPlatform, PlatformAccountValidation>()
    for (const validation of platformAccountValidations) {
      map.set(validation.platform, validation)
    }
    return map
  }, [platformAccountValidations])

  const credentialsByPlatform = useMemo(() => {
    const map = new Map<StreamPlatform, OAuthProviderCredentialStatus>()
    for (const status of oauthProviderCredentials) {
      map.set(status.platform, status)
    }
    return map
  }, [oauthProviderCredentials])

  // A destination is "in trouble" while live if its leg dropped (failed), is
  // reconnecting, its platform says it isn't receiving the stream (warning,
  // plan 161), or it was skipped this session for incomplete credentials.
  const problems = streamTargets.filter((runtime) => DESTINATION_PROBLEM_STATES.has(runtime.state))
  // "Continue streaming" dismisses THIS set of problems. A destination that
  // drops later is new news and brings the banner back (plan 161).
  const problemsKey = problems.map((target) => `${target.targetId}:${target.state}`).join('|')

  const [dismissedKey, setDismissedKey] = useState<string | null>(null)
  useEffect(() => {
    if (!isSessionActive) {
      setDismissedKey(null)
    }
  }, [isSessionActive])
  const dismissed = dismissedKey === problemsKey

  // Plan 080 S7: the readiness list opens the card that needs attention.
  // Cards keep their own default until the user (or the list) toggles one.
  // The list moves focus to the destination's row too (plan 174 S3.5a,
  // D-24), so the keyboard lands where the eye goes.
  const [expandedOverrides, setExpandedOverrides] = useState<Record<string, boolean>>({})
  const openDestination = (targetId: string): void => {
    setExpandedOverrides((current) => ({ ...current, [targetId]: true }))
    requestAnimationFrame(() => {
      const card = document.getElementById(`destination-${targetId}`)
      card?.scrollIntoView({ behavior: smoothScrollBehavior(), block: 'nearest' })
      card
        ?.querySelector<HTMLElement>('[data-slot="list-row-button"]')
        ?.focus({ preventScroll: true })
    })
  }
  // Only the first destination that needs setup opens on its own (D-14).
  const firstNeedsSetupId = streaming.targets.find(
    (target) =>
      target.enabled && !destinationSetup(target, accountByPlatform.get(target.platform)).ready
  )?.id
  const destinationCap = streamingDestinationCap(entitlements, streaming)
  // The card shows the browser step itself (D-16), so the toast stays quiet.
  const connectFromCard = useCallback(
    (platform: StreamPlatform, options?: PlatformConnectOptions) =>
      connectPlatformAccount(platform, options, { showsBrowserStep: true }),
    [connectPlatformAccount]
  )

  const scheduledTargets = streaming.targets.filter((target) => target.scheduledEventId)
  const showNotices =
    Boolean(livestreamingEntitlementReason && !isSessionActive) ||
    (isSessionActive && problems.length > 0 && !dismissed) ||
    isSessionActive ||
    scheduledTargets.length > 0

  return (
    <div className="grid lg:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)]">
      <div className="flex min-w-0 flex-col lg:border-r">
        {showNotices ? (
          <div className="flex flex-col gap-2 border-b border-border p-gutter">
            {livestreamingEntitlementReason && !isSessionActive ? (
              <LockAlert
                action={unlockActionForReason(livestreamingEntitlementReason)}
                reason={livestreamingEntitlementReason}
              />
            ) : null}
            {isSessionActive && problems.length > 0 && !dismissed ? (
              <StreamFailureBanner
                onAir={streamTargets.filter((runtime) => runtime.state === 'live').length}
                problems={problems}
                onDismiss={() => setDismissedKey(problemsKey)}
                onEndLivestream={() => void requestStopSession('failure-banner')}
              />
            ) : null}
            {isSessionActive ? <SessionLockAlert locks={LIVESTREAM_SETUP_LOCKS} /> : null}
            {scheduledTargets.map((target) => (
              <Alert key={`scheduled-${target.id}`}>
                <AlertDescription className="flex flex-wrap items-center justify-between gap-2 text-foreground">
                  <span className="min-w-0 truncate">
                    {destinationLabel(target.label)}: {target.scheduledEventTitle}
                  </span>
                  <Button
                    variant="ghost"
                    disabled={
                      isSessionActive || goLiveConfirmationPending || Boolean(goLivePartialSetup)
                    }
                    onClick={() =>
                      patchStreamingTarget(target.id, {
                        scheduledEventId: undefined,
                        scheduledEventTitle: undefined,
                        scheduledPrivacy: undefined,
                        scheduledStartUtc: undefined
                      })
                    }
                  >
                    Use instant broadcast
                  </Button>
                </AlertDescription>
              </Alert>
            ))}
          </div>
        ) : null}
        <PanelSection
          description={`Where the stream goes. ${destinationCap.rule} Open a destination for its account or key.`}
          title="Destinations"
        >
          {destinationCap.notice && !streamingControlsDisabled ? (
            <Alert id={DESTINATION_CAP_NOTICE_ID}>
              <AlertTitle>{destinationCap.notice}</AlertTitle>
            </Alert>
          ) : null}
          <GroupedList>
            {streaming.targets.map((target) => (
              <DestinationCard
                account={accountByPlatform.get(target.platform)}
                credentials={credentialsByPlatform.get(target.platform)}
                defaultExpanded={target.id === firstNeedsSetupId}
                disabled={streamingControlsDisabled}
                enableLockDescriptionId={DESTINATION_CAP_NOTICE_ID}
                expanded={expandedOverrides[target.id]}
                onExpandedChange={(expanded) =>
                  setExpandedOverrides((current) => ({ ...current, [target.id]: expanded }))
                }
                enableGate={streamingDestinationEnableGate({
                  entitlements,
                  streaming,
                  targetId: target.id
                })}
                key={target.id}
                runtime={runtimeById.get(target.id)}
                sharedAccountWith={sharedAccountLabel(streaming.targets, target)}
                target={target}
                validation={validationByPlatform.get(target.platform)}
                xNativeCapability={xNativeCapability}
                xNativeCapabilityLoading={xNativeCapabilityLoading}
                youtubeChannels={youtubeChannels}
                youtubeChannelsLoading={youtubeChannelsLoading}
                onConnect={connectFromCard}
                onDisconnect={disconnectPlatformAccount}
                onPatch={patchStreamingTarget}
                onSaveManualStreamKey={saveManualStreamKey}
                onRestorePreviousStreamKey={restorePreviousStreamKey}
                onRefreshYouTubeChannels={refreshYouTubeChannels}
                onRefreshXNativeCapability={refreshXNativeCapability}
                onAuthorizeXLive={authorizeXLive}
                onSelectYouTubeChannel={selectYouTubeChannel}
                youtubeQuotaPausedUntil={youtubeQuotaPaused}
              />
            ))}
          </GroupedList>
        </PanelSection>
        {/* Stream details: its own section below the destinations; the rows
            own accounts and keys, this owns what the stream says (ux-ia plan,
            slice 7; plan 174 S3.5b). */}
        <MetadataEditor
          disabled={streamingControlsDisabled}
          draft={streamMetadataDraft}
          pending={streamMetadataSavePending}
          twitchCategories={twitchCategories}
          twitchCategorySearchPending={twitchCategorySearchPending}
          kickCategories={kickCategories}
          kickCategorySearchPending={kickCategorySearchPending}
          targets={streaming.targets}
          validation={streamMetadataValidation}
          onPatchDraft={patchStreamMetadataDraft}
          onPatchTarget={patchStreamTargetMetadataDraft}
          onSave={() => void saveStreamMetadataDraft()}
          onSearchTwitchCategories={searchTwitchCategories}
          onSearchKickCategories={searchKickCategories}
        />
      </div>

      <GoLivePanel onOpenDestination={openDestination} />
    </div>
  )
}

/**
 * YouTube Vertical signs in with the YouTube account (accounts are keyed by
 * platform). When the horizontal YouTube card is also signed in, the channel
 * and Disconnect live there and the vertical card says so (plan 080 S6).
 */
function sharedAccountLabel(
  targets: StreamTargetSettings[],
  target: StreamTargetSettings
): string | undefined {
  if (target.outputOrientation !== 'vertical' || target.authMode !== 'oauth') return undefined
  const owner = targets.find(
    (candidate) =>
      candidate.platform === target.platform &&
      candidate.id !== target.id &&
      candidate.outputOrientation !== 'vertical' &&
      candidate.authMode === 'oauth'
  )
  return owner?.label
}

/** What the session lock covers on Setup, named in its one notice (D-15). */
const LIVESTREAM_SETUP_LOCKS = 'Destinations, stream quality, Videorc Cloud and stream details'

/** The one cap notice; a switch held off by the cap points at it (D-14). */
const DESTINATION_CAP_NOTICE_ID = 'livestream-destination-cap'

const DESTINATION_PROBLEM_STATES: ReadonlySet<StreamTargetRuntime['state']> = new Set([
  'failed',
  'reconnecting',
  'warning',
  'not-configured'
])

/**
 * Destinations in trouble mid-stream. Its one destructive action ends the
 * whole livestream (every destination and the recording), so it says so and
 * asks through the End livestream dialog (plan 174 S0.1, D-4).
 */
export function StreamFailureBanner({
  problems,
  onAir = 0,
  onEndLivestream,
  onDismiss
}: {
  problems: StreamTargetRuntime[]
  /** How many destinations are on air beside the problems (J2-19). */
  onAir?: number
  onEndLivestream: () => void
  onDismiss: () => void
}): ReactElement {
  const failed = problems.filter((target) => target.state === 'failed')
  const reconnecting = problems.filter((target) => target.state === 'reconnecting')
  const notReceiving = problems.filter((target) => target.state === 'warning')
  const skipped = problems.filter((target) => target.state === 'not-configured')
  const names = (targets: StreamTargetRuntime[]): string =>
    targets.map((target) => destinationLabel(target.label)).join(', ')
  // Count-aware (plan 174 J2-19): "keep streaming" only when another one is on air.
  const stillOnAir =
    otherDestinationsLine(onAir) ?? 'No other destination is streaming, so viewers see nothing.'

  return (
    <Alert variant="warning">
      <AlertTitle>Some destinations aren’t on air</AlertTitle>
      <AlertDescription className="flex flex-col gap-1">
        {failed.length ? (
          <span>
            {destinationStateLabel('failed')}: {names(failed)}. {stillOnAir}
          </span>
        ) : null}
        {reconnecting.length ? (
          <span>
            Reconnecting: {names(reconnecting)}. Viewers there see nothing until it’s back.
          </span>
        ) : null}
        {notReceiving.length ? (
          <span>
            {destinationStateLabel('warning')}: {names(notReceiving)}. Videorc is still sending;
            check the platform’s live dashboard.
          </span>
        ) : null}
        {skipped.length ? (
          <span>
            {destinationStateLabel('not-configured')}:{' '}
            {skipped
              .map((target) =>
                target.message
                  ? `${destinationLabel(target.label)} (${target.message})`
                  : destinationLabel(target.label)
              )
              .join(', ')}
            .
          </span>
        ) : null}
        <span className="flex gap-2 pt-1.5">
          <Button variant="destructive" onClick={onEndLivestream}>
            End livestream
          </Button>
          <Button variant="outline" onClick={onDismiss}>
            Continue streaming
          </Button>
        </span>
      </AlertDescription>
    </Alert>
  )
}

export function MetadataEditor({
  draft,
  validation,
  targets,
  disabled,
  pending,
  twitchCategories,
  twitchCategorySearchPending,
  kickCategories = [],
  kickCategorySearchPending = false,
  onPatchDraft,
  onPatchTarget,
  onSave,
  onSearchTwitchCategories,
  onSearchKickCategories
}: {
  draft: StreamMetadataDraft | null
  validation: StreamMetadataValidation | null
  targets: StreamTargetSettings[]
  disabled: boolean
  pending: boolean
  twitchCategories: TwitchCategory[]
  twitchCategorySearchPending: boolean
  onPatchDraft: (patch: Partial<StreamMetadataDraft>) => void
  onPatchTarget: (
    platform: StreamMetadataDraft['targetOverrides'][number]['platform'],
    patch: Partial<StreamMetadataDraft['targetOverrides'][number]>
  ) => void
  onSave: () => void
  onSearchTwitchCategories: (query: string) => Promise<void>
  kickCategories?: KickCategory[]
  kickCategorySearchPending?: boolean
  onSearchKickCategories?: (query: string) => Promise<void>
}): ReactElement {
  // Unsaved edits (plan 174 S3.5b, D-5): an edit marks the draft as it was
  // loaded; a save or a reload brings a new `updatedAt`, which ends it.
  const [editedAt, setEditedAt] = useState<string | null>(null)
  const dirty = Boolean(draft) && editedAt === draft?.updatedAt
  // No error before the streamer has touched the title or saved (V-3).
  const [titleChecked, setTitleChecked] = useState(false)
  const markEdited = (): void => setEditedAt(draft?.updatedAt ?? null)
  const patchDraft = (patch: Partial<StreamMetadataDraft>): void => {
    markEdited()
    onPatchDraft(patch)
  }
  const patchTarget: typeof onPatchTarget = (platform, patch) => {
    markEdited()
    onPatchTarget(platform, patch)
  }
  // One row per native destination in use, in Destinations order. The rows
  // are accordions: closed, each is a label and a one-line summary.
  const visibleOverrides = visibleMetadataOverrides(targets, draft?.targetOverrides ?? [])
  const [openPlatforms, setOpenPlatforms] = useState<string[]>([])
  // A row with a validation issue stays open until the issue is gone, so the
  // warning is never hidden behind a closed row.
  const issuePlatforms = visibleOverrides
    .filter(({ override }) => metadataIssue(validation, 'title', override.platform))
    .map(({ override }) => override.platform)
  const accordionValue = Array.from(new Set([...openPlatforms, ...issuePlatforms]))
  // Privacy and the thumbnail are YouTube's: drawn while a YouTube
  // destination is on, and the thumbnail says why it can't be used when only
  // a stream key reaches YouTube (D-18).
  const youtubeTargets = targets.filter((target) => target.enabled && target.platform === 'youtube')
  const youtubeSignedIn = youtubeTargets.some((target) => target.authMode === 'oauth')
  const status = streamDetailsStatus({ dirty, validation })

  return (
    <PanelSection
      action={
        <span className="flex items-center gap-2">
          {status ? (
            <span data-testid="stream-details-status">
              <StatusBadge tone={status.tone} value={status.label} />
            </span>
          ) : null}
          <Button
            disabled={disabled || !draft || pending}
            variant="secondary"
            onClick={() => {
              setTitleChecked(true)
              onSave()
            }}
          >
            <SaveIcon data-icon="inline-start" weight="bold" />
            {pending ? 'Saving…' : 'Save'}
          </Button>
        </span>
      }
      icon={TextIcon}
      title="Stream details"
    >
      {!draft ? (
        <p className="text-sm text-muted-foreground" role="status">
          Loading stream details…
        </p>
      ) : (
        <>
          <BroadcastInfoFields
            disabled={disabled}
            idPrefix="stream"
            privacyNote="Twitch, Kick and X are always public."
            thumbnail={
              youtubeTargets.length ? (
                <ThumbnailField
                  alt="Livestream thumbnail"
                  assetId={draft.thumbnailAssetId}
                  disabled={disabled || !youtubeSignedIn}
                  hint={broadcastThumbnailHint({ youtubeSignedIn })}
                  onChange={(thumbnailAssetId) =>
                    patchDraft({ thumbnailAssetId: thumbnailAssetId ?? undefined })
                  }
                />
              ) : undefined
            }
            titleRequired={titleChecked}
            value={{
              title: draft.title,
              description: draft.description,
              privacy: youtubeTargets.length ? draft.defaultPrivacy : undefined
            }}
            onChange={(patch) => {
              if (patch.title !== undefined) setTitleChecked(true)
              patchDraft({
                ...(patch.title !== undefined ? { title: patch.title } : {}),
                ...(patch.description !== undefined ? { description: patch.description } : {}),
                ...(patch.privacy !== undefined ? { defaultPrivacy: patch.privacy } : {})
              })
            }}
          />

          {visibleOverrides.length ? (
            <Accordion
              aria-label="Details for each destination"
              type="multiple"
              value={accordionValue}
              onValueChange={setOpenPlatforms}
            >
              {visibleOverrides.map(({ override, label }) => {
                const issue = metadataIssue(validation, 'title', override.platform)
                return (
                  <AccordionItem key={override.platform} value={override.platform}>
                    <AccordionTrigger className="min-h-11 items-center gap-3 px-3 py-2 hover:bg-accent hover:no-underline">
                      <PlatformGlyph platform={override.platform} />
                      <span className="flex min-w-0 flex-1 items-baseline gap-2">
                        <span className="truncate">{label}</span>
                        <span className="truncate text-xs font-normal text-muted-foreground">
                          {metadataOverrideSummary(draft, override)}
                        </span>
                      </span>
                      {issue ? (
                        <AlertIcon
                          aria-label="Needs attention"
                          className="size-4 shrink-0 text-warning"
                          weight="fill"
                        />
                      ) : null}
                    </AccordionTrigger>
                    <AccordionContent className="flex flex-col gap-3 px-3">
                      <MetadataOverride
                        disabled={disabled}
                        draft={draft}
                        label={label}
                        override={override}
                        twitchCategories={twitchCategories}
                        twitchCategorySearchPending={twitchCategorySearchPending}
                        kickCategories={kickCategories}
                        kickCategorySearchPending={kickCategorySearchPending}
                        validation={validation}
                        onPatch={(patch) => patchTarget(override.platform, patch)}
                        onSearchTwitchCategories={onSearchTwitchCategories}
                        onSearchKickCategories={onSearchKickCategories}
                      />
                    </AccordionContent>
                  </AccordionItem>
                )
              })}
            </Accordion>
          ) : (
            <p className="text-xs text-muted-foreground">
              Turn on YouTube, Twitch, Kick or X in Destinations to set details for each.
            </p>
          )}
        </>
      )}
    </PanelSection>
  )
}

function MetadataOverride({
  override,
  draft,
  label,
  disabled,
  twitchCategories,
  twitchCategorySearchPending,
  kickCategories,
  kickCategorySearchPending,
  validation,
  onPatch,
  onSearchTwitchCategories,
  onSearchKickCategories
}: {
  override: StreamMetadataDraft['targetOverrides'][number]
  draft: StreamMetadataDraft
  label: string
  disabled: boolean
  twitchCategories: TwitchCategory[]
  twitchCategorySearchPending: boolean
  validation: StreamMetadataValidation | null
  onPatch: (patch: Partial<StreamMetadataDraft['targetOverrides'][number]>) => void
  onSearchTwitchCategories: (query: string) => Promise<void>
  kickCategories: KickCategory[]
  kickCategorySearchPending: boolean
  onSearchKickCategories?: (query: string) => Promise<void>
}): ReactElement {
  const titleIssue = metadataIssue(validation, 'title', override.platform)
  const twitch = override.platform === 'twitch'
  const youtube = override.platform === 'youtube'
  const x = override.platform === 'x'

  // The switch gates custom TEXT only. Platform settings below it (made for
  // kids, category, language, announce) always apply, on or off.
  const customTextHint = override.customize
    ? youtube
      ? `Replaces the title, description and privacy above for ${label}.`
      : `Replaces the title above for ${label}.`
    : youtube
      ? 'Uses the title, description and privacy above.'
      : 'Uses the title above.'

  return (
    <>
      <Field orientation="horizontal">
        <FieldContent>
          <FieldLabel htmlFor={`${override.platform}-metadata-customize`}>
            Custom title and description
          </FieldLabel>
          <FieldDescription>{customTextHint}</FieldDescription>
        </FieldContent>
        <Switch
          aria-label={`Custom title and description for ${label}`}
          checked={override.customize}
          disabled={disabled}
          id={`${override.platform}-metadata-customize`}
          onCheckedChange={(customize) => onPatch({ customize })}
        />
      </Field>

      {override.customize ? (
        <>
          <Field>
            <FieldLabel htmlFor={`${override.platform}-metadata-title`}>Title</FieldLabel>
            <Input
              aria-invalid={Boolean(titleIssue)}
              disabled={disabled}
              id={`${override.platform}-metadata-title`}
              placeholder={draft.title || 'Untitled livestream'}
              value={override.title}
              onChange={(event) => onPatch({ title: event.target.value })}
            />
            {titleIssue ? <FieldError>{titleIssue.message}</FieldError> : null}
            {twitch ? (
              <FieldDescription>Twitch supports title, category, and language.</FieldDescription>
            ) : null}
            {x ? (
              <FieldDescription>
                X broadcasts carry a title only; it doubles as the announcement post text.
              </FieldDescription>
            ) : null}
          </Field>

          {youtube ? (
            <>
              <Field>
                <FieldLabel htmlFor="youtube-metadata-description">Description</FieldLabel>
                <Textarea
                  className="min-h-20 resize-y"
                  disabled={disabled}
                  id="youtube-metadata-description"
                  placeholder={draft.description || 'Optional'}
                  value={override.description}
                  onChange={(event) => onPatch({ description: event.target.value })}
                />
              </Field>
              <Field>
                <FieldLabel>Privacy</FieldLabel>
                <SegmentedControl
                  disabled={disabled}
                  id="youtube-metadata-privacy"
                  options={PRIVACY_OPTIONS}
                  value={override.privacy}
                  onValueChange={(privacy) => onPatch({ privacy })}
                />
              </Field>
            </>
          ) : null}
        </>
      ) : null}

      {youtube ? (
        // A boolean is a Switch, not a No/Yes pair (plan 174 S1.7).
        <Field orientation="horizontal">
          <FieldLabel htmlFor="youtube-metadata-made-for-kids">Made for kids</FieldLabel>
          <Switch
            checked={Boolean(override.youtubeMadeForKids)}
            disabled={disabled}
            id="youtube-metadata-made-for-kids"
            onCheckedChange={(youtubeMadeForKids) => onPatch({ youtubeMadeForKids })}
          />
        </Field>
      ) : null}

      {twitch ? (
        <div className="grid gap-3 sm:grid-cols-2">
          <Field>
            <FieldLabel htmlFor="twitch-category">Category</FieldLabel>
            <CategoryCombobox
              disabled={disabled}
              id="twitch-category"
              label="Twitch category"
              pending={twitchCategorySearchPending}
              results={twitchCategories}
              value={
                override.twitchCategoryId
                  ? {
                      id: override.twitchCategoryId,
                      name: override.twitchCategoryName ?? override.twitchCategoryId
                    }
                  : null
              }
              onChange={(category) =>
                onPatch({ twitchCategoryId: category?.id, twitchCategoryName: category?.name })
              }
              onSearch={(query) => void onSearchTwitchCategories(query)}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="twitch-language">Language</FieldLabel>
            <Select
              disabled={disabled}
              value={override.twitchLanguage?.trim().toLowerCase() ?? ''}
              onValueChange={(twitchLanguage) => onPatch({ twitchLanguage })}
            >
              <SelectTrigger className="w-full" id="twitch-language">
                <SelectValue placeholder="Choose a language" />
              </SelectTrigger>
              <SelectContent>
                {streamLanguageOptions(override.twitchLanguage).map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
        </div>
      ) : null}

      {override.platform === 'kick' ? (
        <Field>
          <FieldLabel htmlFor="kick-category">Category</FieldLabel>
          <CategoryCombobox
            disabled={disabled || !onSearchKickCategories}
            id="kick-category"
            label="Kick category"
            pending={kickCategorySearchPending}
            results={kickCategories.map((category) => ({
              id: String(category.id),
              name: category.name
            }))}
            value={
              override.kickCategoryId !== undefined
                ? {
                    id: String(override.kickCategoryId),
                    name: override.kickCategoryName ?? String(override.kickCategoryId)
                  }
                : null
            }
            onChange={(category) =>
              onPatch({
                kickCategoryId: category ? Number(category.id) : undefined,
                kickCategoryName: category?.name
              })
            }
            onSearch={(query) => void onSearchKickCategories?.(query)}
          />
          <FieldDescription>Kick needs a category from its list.</FieldDescription>
        </Field>
      ) : null}

      {x ? (
        <Field orientation="horizontal">
          <FieldContent>
            <FieldLabel htmlFor="x-metadata-announce">Announce on X timeline</FieldLabel>
            <FieldDescription>
              X broadcasts are always public. Off skips the announcement post.
            </FieldDescription>
          </FieldContent>
          <Switch
            aria-label="Announce on X timeline"
            checked={override.xAnnounce ?? true}
            disabled={disabled}
            id="x-metadata-announce"
            onCheckedChange={(xAnnounce) => onPatch({ xAnnounce })}
          />
        </Field>
      ) : null}
    </>
  )
}

const PRIVACY_OPTIONS: SegmentedControlOption<StreamPrivacy>[] = [
  { value: 'private', label: 'Private' },
  { value: 'unlisted', label: 'Unlisted' },
  { value: 'public', label: 'Public' }
]

function metadataIssue(
  validation: StreamMetadataValidation | null,
  field: string,
  platform?: StreamPlatform
): StreamMetadataValidation['issues'][number] | undefined {
  return validation?.issues.find((issue) => issue.field === field && issue.platform === platform)
}
