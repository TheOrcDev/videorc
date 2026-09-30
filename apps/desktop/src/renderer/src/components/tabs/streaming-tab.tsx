import { AlertIcon, SaveIcon, SearchIcon, TextIcon } from '@/components/icons'
import { lazy, Suspense, useEffect, useMemo, useState, type ReactElement } from 'react'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
const ScheduledStreams = lazy(() =>
  import('@/components/scheduled-streams').then((m) => ({ default: m.ScheduledStreams }))
)

import { GroupedList } from '@/components/list-row'
import { PlatformGlyph } from '@/components/platform-glyph'
import { PanelSection } from '@/components/panel-section'
import { DestinationCard } from '@/components/streaming/destination-card'
import { GoLivePanel } from '@/components/streaming/go-live-panel'
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
import { useStudioCore } from '@/hooks/use-studio'
import type {
  PlatformAccount,
  PlatformAccountValidation,
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
import { streamingDestinationEnableGate } from '@/lib/entitlement-ui'
import { entitlementDisabledReason } from '@/lib/entitlements'

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
    entitlements,
    isSessionActive,
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
    stopSession
  } = useStudioCore()
  const streaming = captureConfig.streaming
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

  // Plan 080 S7: the readiness list opens the card that needs attention.
  // Cards keep their own default until the user (or the list) toggles one.
  const [expandedOverrides, setExpandedOverrides] = useState<Record<string, boolean>>({})
  const openDestination = (targetId: string): void => {
    setExpandedOverrides((current) => ({ ...current, [targetId]: true }))
    requestAnimationFrame(() =>
      document
        .getElementById(`destination-${targetId}`)
        ?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
    )
  }

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
