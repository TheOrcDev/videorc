import {
  AlertIcon,
  GaugeIcon,
  HeartbeatIcon,
  SaveIcon,
  SearchIcon,
  SuccessIcon,
  SyncIcon,
  TextIcon
} from '@/components/icons'
import { lazy, Suspense, useEffect, useMemo, useState, type ReactElement } from 'react'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
const ScheduledStreams = lazy(() =>
  import('@/components/scheduled-streams').then((m) => ({ default: m.ScheduledStreams }))
)

import { GroupedList } from '@/components/list-row'
import { PlatformGlyph } from '@/components/platform-glyph'
import { PanelSection } from '@/components/panel-section'
import { DestinationCard } from '@/components/streaming/destination-card'
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger
} from '@/components/ui/accordion'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { metadataOverrideSummary, visibleMetadataOverrides } from '@/lib/stream-metadata-summary'
import { Button } from '@/components/ui/button'
import { Field, FieldDescription, FieldLabel } from '@/components/ui/field'
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
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import {
  useStudioCore,
  useStudioDiagnostics,
  type StreamOutputTopologyPreflight
} from '@/hooks/use-studio'
import type {
  DiagnosticStats,
  PlatformAccount,
  PlatformAccountValidation,
  OAuthProviderCredentialStatus,
  StreamHealth,
  StreamMetadataDraft,
  StreamMetadataValidation,
  StreamPlatform,
  StreamPrivacy,
  StreamTargetRuntime,
  StreamTargetSettings,
  VideoSettings,
  TwitchCategory,
  KickCategory
} from '@/lib/backend'
import {
  isStreamTargetReady,
  providerStreamOutputPlanOptions,
  resolveProviderStreamOutputPlan,
  STREAM_OUTPUT_GOP_SECONDS,
  streamVideoProfileValidationReason,
  type ProviderStreamOutputPlan,
  videoProfileCompatibility
} from '@/lib/capture'
import { streamingDestinationEnableGate } from '@/lib/entitlement-ui'
import { entitlementDisabledReason } from '@/lib/entitlements'
import {
  classifyStreamHealthAttribution,
  type StreamHealthAttribution
} from '@/lib/stream-health-attribution'

type BadgeTone = 'success' | 'warning' | 'destructive' | 'live' | 'outline'

export function StreamingTab(): ReactElement {
  const [view, setView] = useState(() =>
    sessionStorage.getItem('videorc-scheduling-view') === 'upcoming' ? 'upcoming' : 'setup'
  )
  useEffect(() => {
    const open = () => setView('upcoming')
    window.addEventListener('videorc:upcoming', open)
    sessionStorage.removeItem('videorc-scheduling-view')
    return () => window.removeEventListener('videorc:upcoming', open)
  }, [])
  return (
    <Tabs className="gap-0" value={view} onValueChange={setView}>
      {/* Setup / Upcoming leads the page body; the toolbar carries only the
          title (owner call, 2026-09-23: no buttons in its top-right corner). */}
      <div className="border-b border-border px-gutter py-2">
        <TabsList aria-label="Livestream view">
          <TabsTrigger value="setup">Setup</TabsTrigger>
          <TabsTrigger value="upcoming">Upcoming</TabsTrigger>
        </TabsList>
      </div>
      <TabsContent value="setup">
        <StreamingSetup />
      </TabsContent>
      <TabsContent value="upcoming">
        <Suspense fallback={<p role="status">Loading upcoming streams…</p>}>
          <ScheduledStreams />
        </Suspense>
      </TabsContent>
    </Tabs>
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
    health,
    entitlements,
    isSessionActive,
    streamMetadataDraft,
    streamMetadataSavePending,
    streamMetadataValidation,
    streamTargets,
    streamOutputTopologyPreflight,
    refreshStreamOutputTopology,
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
    stopSession
  } = useStudioCore()
  const { diagnosticStats, streamHealth } = useStudioDiagnostics()
  const streaming = captureConfig.streaming
  const { video } = captureConfig
  const preflightProvesSeparateOutput =
    streamOutputTopologyPreflight.state === 'ready' &&
    streamOutputTopologyPreflight.result.outputRoles.length === 2 &&
    streamOutputTopologyPreflight.result.outputRoles[0] === 'recording' &&
    streamOutputTopologyPreflight.result.outputRoles[1] === 'stream' &&
    streamOutputTopologyPreflight.result.effectiveBridgeOutput !== 'raw-yuv420p' &&
    (streamOutputTopologyPreflight.result.probeState === 'passed' ||
      streamOutputTopologyPreflight.result.probeState === 'not-required')
  const separateEncodedOutputRoleAvailable = isSessionActive
    ? diagnosticStats.encoderBridgeSeparateOutputEncodersActive
    : preflightProvesSeparateOutput
  const providerPlan = resolveProviderStreamOutputPlan(
    video,
    captureConfig.streamEnabled ? streaming : undefined,
    providerStreamOutputPlanOptions(captureConfig, separateEncodedOutputRoleAvailable)
  )
  const compatibility = videoProfileCompatibility(captureConfig)
  const compatibilityMessage = compatibility.blockingReason ?? compatibility.warning
  const livestreamingEntitlementReason = entitlementDisabledReason(entitlements, 'livestreaming')
  const streamingControlsDisabled = isSessionActive || Boolean(livestreamingEntitlementReason)

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

  // A destination is "in trouble" while live if its leg dropped (failed) or it was
  // skipped this session for incomplete credentials (not-configured).
  const problems = streamTargets.filter(
    (runtime) => runtime.state === 'failed' || runtime.state === 'not-configured'
  )

  const [dismissed, setDismissed] = useState(false)
  useEffect(() => {
    if (!isSessionActive) {
      setDismissed(false)
    }
  }, [isSessionActive])

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
              <Alert variant="warning">
                <AlertIcon weight="fill" />
                <AlertDescription>{livestreamingEntitlementReason}</AlertDescription>
              </Alert>
            ) : null}
            {isSessionActive && problems.length > 0 && !dismissed ? (
              <StreamFailureBanner
                problems={problems}
                onDismiss={() => setDismissed(true)}
                onStopAll={() => void stopSession()}
              />
            ) : null}
            {isSessionActive ? (
              <p className="text-xs text-muted-foreground">
                Destination credentials are locked while a session is live.
              </p>
            ) : null}
            {scheduledTargets.map((target) => (
              <Alert key={`scheduled-${target.id}`}>
                <AlertDescription className="flex flex-wrap items-center justify-between gap-2 text-foreground">
                  <span className="min-w-0 truncate">
                    {target.label}: {target.scheduledEventTitle}
                  </span>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={isSessionActive}
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
          description="Where the stream goes. Expand a destination for its account or key."
          title="Destinations"
        >
          <GroupedList>
            {streaming.targets.map((target) => (
              <DestinationCard
                account={accountByPlatform.get(target.platform)}
                credentials={credentialsByPlatform.get(target.platform)}
                disabled={streamingControlsDisabled}
                enableGate={streamingDestinationEnableGate({
                  entitlements,
                  streaming,
                  targetId: target.id
                })}
                key={target.id}
                runtime={runtimeById.get(target.id)}
                target={target}
                validation={validationByPlatform.get(target.platform)}
                xNativeCapability={xNativeCapability}
                xNativeCapabilityLoading={xNativeCapabilityLoading}
                youtubeChannels={youtubeChannels}
                youtubeChannelsLoading={youtubeChannelsLoading}
                onConnect={connectPlatformAccount}
                onDisconnect={disconnectPlatformAccount}
                onPatch={patchStreamingTarget}
                onSaveManualStreamKey={saveManualStreamKey}
                onRestorePreviousStreamKey={restorePreviousStreamKey}
                onRefreshYouTubeChannels={refreshYouTubeChannels}
                onRefreshXNativeCapability={refreshXNativeCapability}
                onAuthorizeXLive={authorizeXLive}
                onSelectYouTubeChannel={selectYouTubeChannel}
              />
            ))}
          </GroupedList>
        </PanelSection>
        {/* Broadcast info: its own section below the destinations; the rows
            own auth/credentials, this owns what the stream says (ux-ia plan,
            slice 7). */}
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

      <div className="flex min-w-0 flex-col border-t lg:border-t-0">
        {compatibilityMessage ? (
          <div className="border-b border-border p-gutter">
            <Alert variant="warning">
              <AlertIcon weight="fill" />
              <AlertDescription>{compatibilityMessage}</AlertDescription>
            </Alert>
          </div>
        ) : null}
        <LiveOutputHealth
          diagnosticStats={diagnosticStats}
          isSessionActive={isSessionActive}
          preflight={streamOutputTopologyPreflight}
          providerPlan={providerPlan}
          streamEnabled={captureConfig.streamEnabled && streaming.enabled}
          streamHealth={streamHealth}
          streamTargets={streamTargets}
          onRetry={refreshStreamOutputTopology}
        />
        <StreamingReadiness
          ffmpegReady={Boolean(health?.ffmpeg.available)}
          profileCompatible={!compatibility.blockingReason}
          recordEnabled={captureConfig.recordEnabled}
          recordingVideo={video}
          providerPlan={providerPlan}
          targets={streaming.targets}
        />
      </div>
    </div>
  )
}

function StreamFailureBanner({
  problems,
  onStopAll,
  onDismiss
}: {
  problems: StreamTargetRuntime[]
  onStopAll: () => void
  onDismiss: () => void
}): ReactElement {
  const failed = problems.filter((target) => target.state === 'failed')
  const skipped = problems.filter((target) => target.state === 'not-configured')

  return (
    <Alert variant="warning">
      <AlertIcon weight="fill" />
      <AlertTitle>Some destinations aren’t live</AlertTitle>
      <AlertDescription className="flex flex-col gap-1">
        {failed.length ? (
          <span>
            Stopped: {failed.map((target) => target.label).join(', ')}. The other destinations keep
            streaming.
          </span>
        ) : null}
        {skipped.length ? (
          <span>
            Skipped:{' '}
            {skipped
              .map((target) =>
                target.message ? `${target.label} (${target.message})` : target.label
              )
              .join(', ')}
            .
          </span>
        ) : null}
        <span className="flex gap-2 pt-1.5">
          <Button size="sm" variant="destructive" onClick={onStopAll}>
            Stop all
          </Button>
          <Button size="sm" variant="outline" onClick={onDismiss}>
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
  const globalTitleIssue = metadataIssue(validation, 'title')
  // One row per connected native destination, in Destinations order. The
  // rows are accordions: closed, each is a label and a one-line summary.
  const visibleOverrides = visibleMetadataOverrides(targets, draft?.targetOverrides ?? [])
  const [openPlatforms, setOpenPlatforms] = useState<string[]>([])
  // A row with a validation issue stays open until the issue is gone, so the
  // warning is never hidden behind a closed row.
  const issuePlatforms = visibleOverrides
    .filter(({ override }) => metadataIssue(validation, 'title', override.platform))
    .map(({ override }) => override.platform)
  const accordionValue = Array.from(new Set([...openPlatforms, ...issuePlatforms]))

  return (
    <PanelSection
      action={
        <Button
          disabled={disabled || !draft || pending}
          size="sm"
          variant="secondary"
          onClick={onSave}
        >
          <SaveIcon data-icon="inline-start" weight="bold" />
          {pending ? 'Saving' : 'Save'}
        </Button>
      }
      icon={TextIcon}
      title="Broadcast info"
    >
      {!draft ? (
        <p className="text-sm text-muted-foreground">Loading metadata draft.</p>
      ) : (
        <>
          <Field>
            <FieldLabel htmlFor="stream-title">Title</FieldLabel>
            <Input
              aria-invalid={Boolean(globalTitleIssue)}
              disabled={disabled}
              id="stream-title"
              placeholder="Untitled livestream"
              value={draft.title}
              onChange={(event) => onPatchDraft({ title: event.target.value })}
            />
            {globalTitleIssue ? (
              <FieldDescription>{globalTitleIssue.message}</FieldDescription>
            ) : null}
          </Field>

          <Field>
            <FieldLabel htmlFor="stream-description">Description</FieldLabel>
            <Textarea
              className="min-h-24 resize-y"
              disabled={disabled}
              id="stream-description"
              placeholder="Optional"
              value={draft.description}
              onChange={(event) => onPatchDraft({ description: event.target.value })}
            />
          </Field>

          <Field>
            <FieldLabel>Default privacy</FieldLabel>
            <Select
              disabled={disabled}
              value={draft.defaultPrivacy}
              onValueChange={(value) => onPatchDraft({ defaultPrivacy: value as StreamPrivacy })}
            >
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="private">Private</SelectItem>
                <SelectItem value="unlisted">Unlisted</SelectItem>
                <SelectItem value="public">Public</SelectItem>
              </SelectContent>
            </Select>
            <FieldDescription>
              Applies to YouTube. Twitch channels are always public; X broadcasts are always public.
              Use the Announce switch in the X row below to control the announcement post.
            </FieldDescription>
          </Field>

          {visibleOverrides.length ? (
            <Accordion
              aria-label="Per-destination details"
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
                        onPatch={(patch) => onPatchTarget(override.platform, patch)}
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
              Connect YouTube, Twitch, Kick or X to set per-destination details.
            </p>
          )}

          {validation && !validation.valid ? (
            <Alert variant="warning">
              <AlertIcon weight="fill" />
              <AlertDescription>
                {validation.issues.length} metadata warning
                {validation.issues.length === 1 ? '' : 's'} before Go Live.
              </AlertDescription>
            </Alert>
          ) : (
            <Badge className="w-fit" variant="success">
              Metadata ready
            </Badge>
          )}
        </>
      )}
    </PanelSection>
  )
}

/**
 * Kick category: search, then pick. Kick needs the numeric id, so a typed name
 * alone sets nothing; clearing the field clears the category.
 */
function KickCategoryField({
  override,
  categories,
  pending,
  disabled,
  onPatch,
  onSearch
}: {
  override: StreamMetadataDraft['targetOverrides'][number]
  categories: KickCategory[]
  pending: boolean
  disabled: boolean
  onPatch: (patch: Partial<StreamMetadataDraft['targetOverrides'][number]>) => void
  onSearch?: (query: string) => Promise<void>
}): ReactElement {
  const [query, setQuery] = useState(override.kickCategoryName ?? '')
  const selected =
    override.kickCategoryId !== undefined
      ? { id: override.kickCategoryId, name: override.kickCategoryName ?? '' }
      : null
  const options =
    selected && !categories.some((category) => category.id === selected.id)
      ? [selected, ...categories]
      : categories

  return (
    <Field>
      <FieldLabel htmlFor="kick-category">Category</FieldLabel>
      <div className="flex gap-2">
        <Input
          disabled={disabled}
          id="kick-category"
          placeholder="Just Chatting"
          value={query}
          onChange={(event) => {
            setQuery(event.target.value)
            if (!event.target.value.trim()) {
              onPatch({ kickCategoryId: undefined, kickCategoryName: undefined })
            }
          }}
        />
        <Button
          disabled={disabled || pending || !onSearch || query.trim().length < 2}
          size="sm"
          variant="outline"
          onClick={() => void onSearch?.(query)}
        >
          <SearchIcon data-icon="inline-start" weight="bold" />
          {pending ? 'Searching' : 'Search'}
        </Button>
      </div>
      {options.length ? (
        <Select
          disabled={disabled || pending}
          value={override.kickCategoryId !== undefined ? String(override.kickCategoryId) : ''}
          onValueChange={(value) => {
            const category = options.find((item) => String(item.id) === value)
            if (category) {
              setQuery(category.name)
              onPatch({ kickCategoryId: category.id, kickCategoryName: category.name })
            }
          }}
        >
          <SelectTrigger className="w-full">
            <SelectValue placeholder="Select category" />
          </SelectTrigger>
          <SelectContent>
            {options.map((category) => (
              <SelectItem key={category.id} value={String(category.id)}>
                {category.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      ) : null}
      <FieldDescription>Search, then pick one. Kick needs a listed category.</FieldDescription>
    </Field>
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
  const [twitchCategoryQuery, setTwitchCategoryQuery] = useState(override.twitchCategoryName ?? '')
  const twitchCategoryOptions =
    twitch &&
    override.twitchCategoryId &&
    !twitchCategories.some((category) => category.id === override.twitchCategoryId)
      ? [
          {
            id: override.twitchCategoryId,
            name: override.twitchCategoryName ?? override.twitchCategoryId
          },
          ...twitchCategories
        ]
      : twitchCategories

  useEffect(() => {
    setTwitchCategoryQuery(override.twitchCategoryName ?? '')
  }, [override.twitchCategoryName])

  // The switch gates custom TEXT only. Platform settings below it (made for
  // kids, category, language, announce) always apply, on or off.
  const customTextHint = override.customize
    ? youtube
      ? `Replaces the global title, description and privacy for ${label}.`
      : `Replaces the global title for ${label}.`
    : youtube
      ? 'Uses the global title, description and privacy.'
      : 'Uses the global title.'

  return (
    <>
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 flex-col">
          <span className="text-sm font-medium">Custom title and description</span>
          <span className="text-xs text-muted-foreground">{customTextHint}</span>
        </div>
        <Switch
          aria-label={`Custom title and description for ${label}`}
          checked={override.customize}
          disabled={disabled}
          onCheckedChange={(customize) => onPatch({ customize })}
        />
      </div>

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
            {titleIssue ? <FieldDescription>{titleIssue.message}</FieldDescription> : null}
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
                <Select
                  disabled={disabled}
                  value={override.privacy}
                  onValueChange={(value) => onPatch({ privacy: value as StreamPrivacy })}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="private">Private</SelectItem>
                    <SelectItem value="unlisted">Unlisted</SelectItem>
                    <SelectItem value="public">Public</SelectItem>
                  </SelectContent>
                </Select>
              </Field>
            </>
          ) : null}
        </>
      ) : null}

      {youtube ? (
        <Field>
          <FieldLabel>Made for kids</FieldLabel>
          <ToggleGroup
            className="w-full"
            disabled={disabled}
            type="single"
            value={override.youtubeMadeForKids ? 'yes' : 'no'}
            variant="outline"
            onValueChange={(value) => value && onPatch({ youtubeMadeForKids: value === 'yes' })}
          >
            <ToggleGroupItem value="no">No</ToggleGroupItem>
            <ToggleGroupItem value="yes">Yes</ToggleGroupItem>
          </ToggleGroup>
        </Field>
      ) : null}

      {twitch ? (
        <div className="grid gap-3 sm:grid-cols-2">
          <Field>
            <FieldLabel htmlFor="twitch-category">Category</FieldLabel>
            <div className="flex gap-2">
              <Input
                disabled={disabled}
                id="twitch-category"
                placeholder="Just Chatting"
                value={twitchCategoryQuery}
                onChange={(event) => {
                  setTwitchCategoryQuery(event.target.value)
                  onPatch({ twitchCategoryId: undefined, twitchCategoryName: event.target.value })
                }}
              />
              <Button
                disabled={
                  disabled || twitchCategorySearchPending || twitchCategoryQuery.trim().length < 2
                }
                size="sm"
                variant="outline"
                onClick={() => void onSearchTwitchCategories(twitchCategoryQuery)}
              >
                <SearchIcon data-icon="inline-start" weight="bold" />
                {twitchCategorySearchPending ? 'Searching' : 'Search'}
              </Button>
            </div>
            {twitchCategoryOptions.length ? (
              <Select
                disabled={disabled || twitchCategorySearchPending}
                value={override.twitchCategoryId ?? ''}
                onValueChange={(categoryId) => {
                  const category = twitchCategoryOptions.find((item) => item.id === categoryId)
                  if (category) {
                    setTwitchCategoryQuery(category.name)
                    onPatch({ twitchCategoryId: category.id, twitchCategoryName: category.name })
                  }
                }}
              >
                <SelectTrigger className="w-full">
                  <SelectValue placeholder="Select category" />
                </SelectTrigger>
                <SelectContent>
                  {twitchCategoryOptions.map((category) => (
                    <SelectItem key={category.id} value={category.id}>
                      {category.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ) : null}
          </Field>
          <Field>
            <FieldLabel htmlFor="twitch-language">Language</FieldLabel>
            <Input
              disabled={disabled}
              id="twitch-language"
              placeholder="en"
              value={override.twitchLanguage ?? ''}
              onChange={(event) => onPatch({ twitchLanguage: event.target.value })}
            />
          </Field>
        </div>
      ) : null}

      {override.platform === 'kick' ? (
        <KickCategoryField
          categories={kickCategories}
          disabled={disabled}
          override={override}
          pending={kickCategorySearchPending}
          onPatch={onPatch}
          onSearch={onSearchKickCategories}
        />
      ) : null}

      {x ? (
        <div className="flex items-center justify-between gap-3">
          <div className="flex min-w-0 flex-col">
            <span className="text-sm font-medium">Announce on X timeline</span>
            <span className="text-xs text-muted-foreground">
              X broadcasts are always public. Off skips the announcement post.
            </span>
          </div>
          <Switch
            aria-label="Announce on X timeline"
            checked={override.xAnnounce ?? true}
            disabled={disabled}
            onCheckedChange={(xAnnounce) => onPatch({ xAnnounce })}
          />
        </div>
      ) : null}
    </>
  )
}

function metadataIssue(
  validation: StreamMetadataValidation | null,
  field: string,
  platform?: StreamPlatform
): StreamMetadataValidation['issues'][number] | undefined {
  return validation?.issues.find((issue) => issue.field === field && issue.platform === platform)
}

function platformLabel(platform: StreamPlatform): string {
  switch (platform) {
    case 'youtube':
      return 'YouTube'
    case 'twitch':
      return 'Twitch'
    case 'kick':
      return 'Kick'
    case 'x':
      return 'X'
    default:
      return 'Custom'
  }
}

function LiveOutputHealth({
  diagnosticStats,
  isSessionActive,
  preflight,
  providerPlan,
  streamEnabled,
  streamHealth,
  streamTargets,
  onRetry
}: {
  diagnosticStats: DiagnosticStats
  isSessionActive: boolean
  preflight: StreamOutputTopologyPreflight
  providerPlan: ProviderStreamOutputPlan
  streamEnabled: boolean
  streamHealth: StreamHealth | null
  streamTargets: StreamTargetRuntime[]
  onRetry: () => Promise<void>
}): ReactElement {
  const liveOutputActive = isSessionActive && streamEnabled
  const currentStreamHealth =
    streamHealth &&
    (!diagnosticStats.sessionId || diagnosticStats.sessionId === streamHealth.sessionId)
      ? streamHealth
      : null
  const attribution = liveOutputActive
    ? classifyStreamHealthAttribution(diagnosticStats, currentStreamHealth, streamTargets)
    : preflightAttribution(preflight)
  const badge = streamHealthBadge(attribution, liveOutputActive)
  const probeResult = !liveOutputActive && preflight.state === 'ready' ? preflight.result : null
  const requestedPath = liveOutputActive
    ? diagnosticStats.encoderBridgeRequestedVideoOutput
    : probeResult?.requestedBridgeOutput
  const effectivePath = liveOutputActive
    ? diagnosticStats.encoderBridgeEffectiveVideoOutput
    : probeResult?.effectiveBridgeOutput
  const effectiveEncoder = liveOutputActive
    ? diagnosticStats.encodeBackend
    : probeResult?.effectiveEncodeBackend
  const fallbackReason = liveOutputActive
    ? diagnosticStats.encoderBridgeEncodedOutputFallbackReason
    : probeResult?.fallbackReason
  const coalescedFrames = diagnosticStats.encoderBridgeSeparateOutputEncodersActive
    ? diagnosticStats.encoderBridgeStreamQueueDroppedFrames
    : diagnosticStats.encoderBridgeOutputQueueDroppedFrames
  const effectiveProviders = [
    ...new Set(
      providerPlan.targets
        .map(({ target }) => target?.platform)
        .filter((platform): platform is StreamPlatform => Boolean(platform))
        .map(platformLabel)
    )
  ].join(', ')
  const effectiveProfiles = providerPlan.targets.length
    ? providerPlan.targets
        .map(({ target, video }) =>
          target
            ? `${platformLabel(target.platform)} ${formatEffectiveStreamProfile(video)}`
            : formatEffectiveStreamProfile(video)
        )
        .join(' / ')
    : formatEffectiveStreamProfile(providerPlan.streamVideo)

  return (
    <PanelSection
      action={
        !liveOutputActive && preflight.state === 'failed' ? (
          <Button
            size="xs"
            variant="ghost"
            onClick={() => {
              void onRetry().catch(() => {})
            }}
          >
            <SyncIcon data-icon="inline-start" weight="bold" />
            Retry
          </Button>
        ) : null
      }
      contentClassName="gap-3"
      description={streamHealthDescription(attribution, liveOutputActive, preflight)}
      icon={HeartbeatIcon}
      title="Live output health"
    >
      <div className="flex items-center justify-between gap-3">
        <span className="text-[11px] font-semibold text-subtle">Classified stage</span>
        <Badge variant={badge.tone}>{badge.label}</Badge>
      </div>

      <div className="grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-3">
        <OutputMetric
          label="Delivered FPS"
          value={liveOutputActive ? formatLiveFps(currentStreamHealth?.fps) : '-'}
        />
        <OutputMetric
          label="Bitrate"
          value={
            liveOutputActive
              ? formatLiveBitrate(
                  currentStreamHealth?.bitrateKbps ?? diagnosticStats.streamMeasuredBitrateKbps
                )
              : '-'
          }
        />
        <OutputMetric
          label="Encoder speed"
          value={
            liveOutputActive
              ? formatEncoderSpeed(currentStreamHealth?.speed ?? diagnosticStats.encoderSpeed)
              : '-'
          }
        />
        <OutputMetric
          label="Duplicated"
          value={
            liveOutputActive
              ? formatFrameCount(
                  currentStreamHealth?.duplicatedFrames ?? diagnosticStats.streamDuplicatedFrames
                )
              : '-'
          }
        />
        <OutputMetric
          label="Dropped"
          value={
            liveOutputActive
              ? formatFrameCount(
                  currentStreamHealth?.droppedFrames ?? diagnosticStats.droppedFrames
                )
              : '-'
          }
        />
        <OutputMetric
          label="Coalesced"
          value={liveOutputActive ? formatFrameCount(coalescedFrames) : '-'}
        />
      </div>

      <div className="flex flex-col gap-1.5 border-t border-border pt-3">
        <ExactOutputPath
          label="Effective provider"
          value={effectiveProviders || 'No enabled destination'}
        />
        <ExactOutputPath label="Effective profile" value={effectiveProfiles} />
        <ExactOutputPath label="GOP" value={`${STREAM_OUTPUT_GOP_SECONDS} seconds`} />
        <ExactOutputPath
          label="Encode sharing"
          value={
            providerPlan.separateEncodedOutputRole
              ? 'Separate recording + stream roles'
              : 'Shared encode · strictest provider'
          }
        />
        <ExactOutputPath label="Requested path" value={requestedPath} />
        <ExactOutputPath label="Effective path" value={effectivePath} />
        <ExactOutputPath label="Effective encoder" value={effectiveEncoder} />
        {fallbackReason ? (
          <p className="border-t border-border pt-2 text-xs text-warning">
            Fallback reason: {fallbackReason}
          </p>
        ) : null}
      </div>
    </PanelSection>
  )
}

function preflightAttribution(preflight: StreamOutputTopologyPreflight): StreamHealthAttribution {
  if (preflight.state !== 'ready') {
    return 'unknown'
  }
  const result = preflight.result
  return result.fallbackReason ||
    result.requestedBridgeOutput !== result.effectiveBridgeOutput ||
    result.probeState === 'rejected' ||
    result.probeState === 'unsupported'
    ? 'fallback'
    : 'healthy'
}

function streamHealthBadge(
  attribution: StreamHealthAttribution,
  liveOutputActive: boolean
): { label: string; tone: BadgeTone } {
  if (!liveOutputActive && attribution === 'healthy') {
    return { label: 'Ready', tone: 'success' }
  }
  if (attribution === 'healthy') {
    return { label: 'Healthy', tone: 'success' }
  }
  if (attribution === 'unknown') {
    return { label: 'Unknown', tone: 'outline' }
  }
  if (attribution === 'fallback' || attribution === 'network' || attribution === 'preview') {
    return {
      label: attribution.charAt(0).toUpperCase() + attribution.slice(1),
      tone: 'warning'
    }
  }
  return {
    label: attribution.charAt(0).toUpperCase() + attribution.slice(1),
    tone: 'destructive'
  }
}

function streamHealthDescription(
  attribution: StreamHealthAttribution,
  liveOutputActive: boolean,
  preflight: StreamOutputTopologyPreflight
): string {
  if (!liveOutputActive) {
    switch (preflight.state) {
      case 'not-requested':
        return 'The exact output path has not been checked. Go Live stays blocked.'
      case 'pending':
        return 'Checking the exact output path. Go Live stays blocked until it finishes.'
      case 'failed':
        return `Output path check failed: ${preflight.message}`
      case 'ready':
        return attribution === 'fallback'
          ? 'The backend verified this fallback path for the selected output profile.'
          : 'The backend verified the exact output path for the selected profile.'
    }
  }

  switch (attribution) {
    case 'device':
      return 'A disconnected capture device is interrupting the livestream path.'
    case 'audio':
      return 'Audio capture is dropping data before the livestream encode.'
    case 'capture':
      return 'Capture is running below the target frame rate.'
    case 'render':
      return 'The compositor is running below the target frame rate.'
    case 'encoder':
      return 'The encoder or its bounded output queue is losing frames.'
    case 'fallback':
      return 'The livestream is using a backend-confirmed fallback output path.'
    case 'network':
      return 'Media stages are healthy, but delivery or a destination is degraded.'
    case 'preview':
      return 'Livestream media is healthy; only the local preview is degraded.'
    case 'healthy':
      return 'Backend evidence shows the livestream media and delivery path are healthy.'
    default:
      return 'Waiting for enough backend evidence to classify the active livestream.'
  }
}

function OutputMetric({ label, value }: { label: string; value: string }): ReactElement {
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <div className="truncate text-[11px] text-muted-foreground">{label}</div>
      <div className="text-sm font-medium tabular-nums">{value}</div>
    </div>
  )
}

function ExactOutputPath({ label, value }: { label: string; value?: string }): ReactElement {
  return (
    <div className="flex items-start justify-between gap-3 text-xs">
      <span className="shrink-0 text-muted-foreground">{label}</span>
      <code className="min-w-0 text-right break-words text-foreground">{value ?? 'unknown'}</code>
    </div>
  )
}

function formatLiveFps(value?: number): string {
  return typeof value === 'number' && Number.isFinite(value) ? `${value.toFixed(1)} fps` : '-'
}

function formatLiveBitrate(value?: number): string {
  return typeof value === 'number' && Number.isFinite(value)
    ? `${Math.round(value).toLocaleString()} kbps`
    : '-'
}

function formatEncoderSpeed(value?: number): string {
  return typeof value === 'number' && Number.isFinite(value) ? `${value.toFixed(2)}×` : '-'
}

function formatFrameCount(value?: number): string {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.max(0, Math.round(value)).toLocaleString()
    : '-'
}

function StreamingReadiness({
  targets,
  ffmpegReady,
  profileCompatible,
  providerPlan,
  recordEnabled,
  recordingVideo
}: {
  targets: StreamTargetSettings[]
  ffmpegReady: boolean
  profileCompatible: boolean
  providerPlan: ProviderStreamOutputPlan
  recordEnabled: boolean
  recordingVideo: VideoSettings
}): ReactElement {
  const enabled = targets.filter((target) => target.enabled)
  const readyCount = enabled.filter(isStreamTargetReady).length
  const allReady = enabled.length > 0 && readyCount === enabled.length
  const targetOutputs = providerPlan.targets.flatMap(({ target, video }) =>
    target ? [{ target, video }] : []
  )
  const streamVideo = providerPlan.streamVideo
  const splitOutputActive = providerPlan.separateEncodedOutputRole
  const outputVideos = targetOutputs.length
    ? targetOutputs.map((output) => output.video)
    : [streamVideo]
  const true4kStreamActive = outputVideos.some((video) => video.preset === 'stream-youtube-4k30')
  const mixedDestinationOutputs =
    true4kStreamActive &&
    targetOutputs.some((output) => output.video.preset !== 'stream-youtube-4k30')
  const presetOk =
    profileCompatible &&
    outputVideos.every((video, index) => {
      const target = targetOutputs[index]?.target
      return streamVideoProfileValidationReason(video, target?.platform) === null
    })
  const showRecordingOutput = recordEnabled && (splitOutputActive || true4kStreamActive)
  const compatibilityHint = true4kStreamActive
    ? ' · keep 4K on YouTube and companions stream-safe'
    : ' · choose stream-safe 1080p'
  // F-025: neutral fact labels — the ok flag and detail carry the verdict, so
  // the label can't contradict a warning icon.
  const outputCompatibilityLabel = true4kStreamActive
    ? mixedDestinationOutputs
      ? 'Mixed stream outputs'
      : 'YouTube 4K stream'
    : splitOutputActive
      ? 'Stream output'
      : 'Output preset'
  const outputCompatibilityDetail =
    targetOutputs.length > 1
      ? `${formatTargetOutputSummary(targetOutputs)}${presetOk ? '' : compatibilityHint}`
      : `${formatVideoOutput(streamVideo)} · ${streamVideo.bitrateKbps} kbps${
          presetOk ? '' : compatibilityHint
        }`
  const uploadMbps = enabled.length
    ? Math.round(
        (outputVideos.reduce((total, video) => total + video.bitrateKbps + 128, 0) * 1.1) / 100
      ) / 10
    : 0
  const diskMbPerMin = Math.round((recordingVideo.bitrateKbps / 8 / 1000) * 60)

  return (
    <PanelSection icon={GaugeIcon} title="Multistream readiness">
      <ChecklistRow
        detail={
          enabled.length ? `${readyCount}/${enabled.length} ready` : 'No destinations enabled'
        }
        label="Destinations ready"
        ok={allReady}
      />
      {showRecordingOutput ? (
        <InfoRow
          detail={`${formatVideoOutput(recordingVideo)} · ${recordingVideo.bitrateKbps} kbps`}
          label="Recording output"
        />
      ) : null}
      <ChecklistRow
        detail={outputCompatibilityDetail}
        label={outputCompatibilityLabel}
        ok={presetOk}
      />
      <ChecklistRow
        detail={ffmpegReady ? 'ready' : 'check Settings'}
        label="FFmpeg available"
        ok={ffmpegReady}
      />
      <InfoRow
        detail={
          enabled.length
            ? `~${uploadMbps} Mbps to ${enabled.length} destination${enabled.length > 1 ? 's' : ''}`
            : '-'
        }
        label="Estimated upload"
      />
      {recordEnabled ? <InfoRow detail={`~${diskMbPerMin} MB/min`} label="Estimated disk" /> : null}

      <p className="text-xs text-muted-foreground">
        {true4kStreamActive
          ? mixedDestinationOutputs
            ? 'YouTube 4K30 uses normal latency. Non-YouTube destinations use separate stream-safe 1080p outputs; upload is the sum of every active destination.'
            : 'YouTube 4K30 uses normal latency. Keep stable upload comfortably above 30 Mbps.'
          : splitOutputActive
            ? 'Recording and livestreaming use separate output encoders; the stream leg stays platform-safe for every destination.'
            : 'All destinations share one encode, so the bitrate is capped by the strictest platform (Twitch ~6000 kbps).'}
      </p>
    </PanelSection>
  )
}

function formatVideoOutput(video: VideoSettings): string {
  return `${video.width}×${video.height} @ ${video.fps}`
}

function formatEffectiveStreamProfile(video: VideoSettings): string {
  return `${formatVideoOutput(video)} fps · ${video.bitrateKbps.toLocaleString()} kbps CBR`
}

function formatTargetOutputSummary(
  outputs: Array<{ target: StreamTargetSettings; video: VideoSettings }>
): string {
  return outputs
    .map(
      ({ target, video }) =>
        `${platformLabel(target.platform)} ${formatVideoOutput(video)} · ${video.bitrateKbps} kbps`
    )
    .join(' / ')
}

function ChecklistRow({
  label,
  detail,
  ok
}: {
  label: string
  detail: string
  ok: boolean
}): ReactElement {
  return (
    <div className="flex items-start justify-between gap-3 text-sm">
      <div className="flex items-center gap-2">
        {ok ? (
          <SuccessIcon className="size-4 shrink-0 text-primary" weight="fill" />
        ) : (
          <AlertIcon className="size-4 shrink-0 text-muted-foreground" weight="fill" />
        )}
        <span>{label}</span>
      </div>
      <span className="text-right text-xs text-muted-foreground">{detail}</span>
    </div>
  )
}

function InfoRow({ label, detail }: { label: string; detail: string }): ReactElement {
  return (
    <div className="flex items-center justify-between gap-3 text-sm">
      <span className="text-muted-foreground">{label}</span>
      <span className="text-xs tabular-nums">{detail}</span>
    </div>
  )
}
