import {
  ArrowCounterClockwise,
  ArrowsClockwise,
  Broadcast,
  CaretDown,
  CheckCircle,
  FloppyDisk,
  Gauge,
  LinkSimple,
  LockSimple,
  MagnifyingGlass,
  SignOut,
  TextAa,
  TwitchLogo,
  Warning,
  WarningCircle,
  XLogo,
  YoutubeLogo,
  type Icon
} from '@phosphor-icons/react'
import { useEffect, useMemo, useState, type ReactElement } from 'react'

import { ListRow } from '@/components/list-row'
import { PanelSection } from '@/components/panel-section'
import { CaptionsControls } from '@/components/captions/captions-controls'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
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
  StreamAuthMode,
  StreamMetadataDraft,
  StreamMetadataValidation,
  StreamPlatform,
  StreamPrivacy,
  StreamTargetRuntime,
  StreamTargetSettings,
  StreamingSettings,
  StreamUrlMode,
  VideoSettings,
  TwitchCategory,
  XNativeLiveCapability,
  YouTubeChannel
} from '@/lib/backend'
import {
  isStreamTargetReady,
  oauthUnavailableReason,
  streamOutputVideoForTarget,
  streamOutputVideoSettings,
  videoProfileCompatibility
} from '@/lib/capture'
import { streamingDestinationEnableGate, type EntitlementUiGate } from '@/lib/entitlement-ui'
import { entitlementDisabledReason } from '@/lib/entitlements'
import { streamKeyPlatformMismatch, streamKeyTailHint } from '@/lib/stream-key-format'
import { cn } from '@/lib/utils'
import { VIDEORC_WEB_LINKS } from '@/lib/videorc-web-links'

type BadgeTone = 'success' | 'warning' | 'destructive' | 'outline'

const PLATFORM_ICON: Record<StreamPlatform, Icon> = {
  youtube: YoutubeLogo,
  twitch: TwitchLogo,
  x: XLogo,
  custom: Broadcast
}

export function StreamingTab(): ReactElement {
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
    twitchCategories,
    twitchCategorySearchPending,
    searchTwitchCategories,
    xNativeCapability,
    xNativeCapabilityLoading,
    refreshXNativeCapability,
    authorizeXLive,
    stopSession
  } = useStudioCore()
  const streaming = captureConfig.streaming
  const { video } = captureConfig
  const streamVideo = streamOutputVideoSettings(
    video,
    captureConfig.streamEnabled ? streaming : undefined
  )
  const splitOutputActive =
    captureConfig.recordEnabled &&
    captureConfig.streamEnabled &&
    streaming.enabled &&
    !sameVideoOutput(video, streamVideo)
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

  return (
    <div className="grid gap-5 lg:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)]">
      <div className="flex flex-col gap-5">
        {livestreamingEntitlementReason && !isSessionActive ? (
          <div className="flex items-start gap-2 rounded-row border border-warning/40 bg-warning/10 p-3 text-sm text-warning-foreground dark:text-warning">
            <WarningCircle className="mt-0.5 size-4 shrink-0" weight="fill" />
            <span>{livestreamingEntitlementReason}</span>
          </div>
        ) : null}
        {isSessionActive && problems.length > 0 && !dismissed ? (
          <StreamFailureBanner
            problems={problems}
            onDismiss={() => setDismissed(true)}
            onStopAll={() => void stopSession()}
          />
        ) : null}
        {isSessionActive ? (
          <p className="text-sm text-muted-foreground">
            Destination credentials are locked while a session is live.
          </p>
        ) : null}
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
        {/* Broadcast info: its own section below the destination rows — the
            rows own auth/credentials, this owns what the stream says
            (ux-ia plan, slice 7). */}
        <MetadataEditor
          disabled={streamingControlsDisabled}
          draft={streamMetadataDraft}
          pending={streamMetadataSavePending}
          twitchCategories={twitchCategories}
          twitchCategorySearchPending={twitchCategorySearchPending}
          targets={streaming.targets}
          validation={streamMetadataValidation}
          onPatchDraft={patchStreamMetadataDraft}
          onPatchTarget={patchStreamTargetMetadataDraft}
          onSave={() => void saveStreamMetadataDraft()}
          onSearchTwitchCategories={searchTwitchCategories}
        />
      </div>

      <div className="flex flex-col gap-5">
        {compatibilityMessage ? (
          <div className="flex items-start gap-2 rounded-row border border-warning/40 bg-warning/10 p-3 text-sm text-warning-foreground dark:text-warning">
            <WarningCircle className="mt-0.5 size-4 shrink-0" weight="fill" />
            <span>{compatibilityMessage}</span>
          </div>
        ) : null}
        <StreamingReadiness
          ffmpegReady={Boolean(health?.ffmpeg.available)}
          profileCompatible={!compatibility.blockingReason}
          recordEnabled={captureConfig.recordEnabled}
          recordingVideo={video}
          splitOutputActive={splitOutputActive}
          streaming={streaming}
          streamVideo={streamVideo}
          targets={streaming.targets}
        />
        <CaptionsControls />
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
    <div className="flex flex-col gap-3 rounded-row border border-warning/40 bg-warning/10 p-3">
      <div className="flex items-start gap-2.5">
        <WarningCircle className="size-5 shrink-0 text-warning" weight="fill" />
        <div className="flex flex-col gap-1 text-sm">
          <span className="font-medium">Some destinations aren’t live</span>
          {failed.length ? (
            <span className="text-muted-foreground">
              Stopped: {failed.map((target) => target.label).join(', ')}. The other destinations
              keep streaming.
            </span>
          ) : null}
          {skipped.length ? (
            <span className="text-muted-foreground">
              Skipped:{' '}
              {skipped
                .map((target) =>
                  target.message ? `${target.label} (${target.message})` : target.label
                )
                .join(', ')}
              .
            </span>
          ) : null}
        </div>
      </div>
      <div className="flex gap-2">
        <Button size="sm" variant="destructive" onClick={onStopAll}>
          Stop all
        </Button>
        <Button size="sm" variant="outline" onClick={onDismiss}>
          Continue streaming
        </Button>
      </div>
    </div>
  )
}

function configuredBadge(enabled: boolean, ready: boolean): { tone: BadgeTone; label: string } {
  if (!enabled) {
    return { tone: 'outline', label: 'Off' }
  }
  return ready ? { tone: 'success', label: 'Ready' } : { tone: 'warning', label: 'Needs setup' }
}

function runtimeBadge(runtime: StreamTargetRuntime): { tone: BadgeTone; label: string } {
  switch (runtime.state) {
    case 'live':
      return { tone: 'success', label: 'On air' }
    case 'connecting':
      return { tone: 'warning', label: 'Connecting' }
    case 'failed':
      return { tone: 'destructive', label: 'Stopped' }
    case 'not-configured':
      return { tone: 'warning', label: 'Skipped' }
    case 'stopped':
      return { tone: 'outline', label: 'Ended' }
    default:
      return { tone: 'outline', label: 'Idle' }
  }
}

function DestinationCard({
  target,
  account,
  credentials,
  disabled,
  enableGate,
  runtime,
  validation,
  xNativeCapability,
  xNativeCapabilityLoading,
  youtubeChannels,
  youtubeChannelsLoading,
  onConnect,
  onDisconnect,
  onPatch,
  onSaveManualStreamKey,
  onRestorePreviousStreamKey,
  onRefreshYouTubeChannels,
  onRefreshXNativeCapability,
  onAuthorizeXLive,
  onSelectYouTubeChannel
}: {
  target: StreamTargetSettings
  account?: PlatformAccount
  credentials?: OAuthProviderCredentialStatus
  disabled: boolean
  enableGate: EntitlementUiGate
  runtime?: StreamTargetRuntime
  validation?: PlatformAccountValidation
  xNativeCapability: XNativeLiveCapability | null
  xNativeCapabilityLoading: boolean
  youtubeChannels: YouTubeChannel[]
  youtubeChannelsLoading: boolean
  onConnect: (platform: StreamPlatform) => void
  onDisconnect: (platform: StreamPlatform) => void
  onPatch: (targetId: string, patch: Partial<StreamTargetSettings>) => void
  onSaveManualStreamKey: (targetId: string, streamKey: string) => Promise<boolean>
  onRestorePreviousStreamKey: (targetId: string) => Promise<void>
  onRefreshYouTubeChannels: (accountId?: string) => Promise<void>
  onRefreshXNativeCapability: (accountId?: string) => Promise<void>
  onAuthorizeXLive: () => Promise<void>
  onSelectYouTubeChannel: (channelId: string, accountId?: string) => Promise<void>
}): ReactElement {
  const ready = isStreamTargetReady(target)
  const fullUrl = target.urlMode === 'full-url'
  const nativeDestination = target.platform !== 'custom'
  const oauthUnavailableMessage =
    oauthUnavailableReason(target.platform) ??
    (credentials?.ready === false ? credentials.message : null)
  const oauthMode = nativeDestination && target.authMode === 'oauth' && !oauthUnavailableMessage
  // While a session is live the runtime status (on air / stopped / skipped) takes
  // over the badge; otherwise it reflects the saved-credential readiness.
  const savedStatusBadge = target.status ? streamTargetStatusBadge(target.status.state) : null
  const badge = runtime
    ? runtimeBadge(runtime)
    : (savedStatusBadge ?? configuredBadge(target.enabled, ready))
  const statusMessage = runtime?.message ?? target.status?.message
  const enableLockGate = !disabled && !target.enabled && !enableGate.allowed ? enableGate : null
  const enableLockUpgradeUrl = enableLockGate?.upgradeUrl
  const enableSwitchDisabled = disabled || Boolean(enableLockGate)
  const enableLockId = `${target.id}-enable-lock`
  const [manualStreamKeyDraft, setManualStreamKeyDraft] = useState(target.streamKey)
  const [fullUrlDraft, setFullUrlDraft] = useState(target.serverUrl)
  // A pending save that needs the user's explicit OK: replacing a saved key,
  // or a paste whose shape matches a DIFFERENT platform's key format.
  const [pendingKeySave, setPendingKeySave] = useState<{
    value: string
    mode: 'key' | 'full-url'
    warning: string | null
  } | null>(null)
  const [confirmingClear, setConfirmingClear] = useState(false)

  useEffect(() => {
    setManualStreamKeyDraft(target.streamKey)
  }, [target.id, target.streamKey])
  useEffect(() => {
    setFullUrlDraft(target.serverUrl)
  }, [target.id, target.serverUrl])
  useEffect(() => {
    if (target.authMode === 'oauth' && oauthUnavailableMessage) {
      onPatch(target.id, { authMode: 'manual-rtmp' })
    }
  }, [oauthUnavailableMessage, onPatch, target.authMode, target.id])

  const credentialLabel = fullUrl ? 'RTMP URL' : 'stream key'

  // Row + detail (ux-ia plan, slice 7): the row shows identity and state; the
  // expandable detail holds ONLY auth + credentials. Needs-setup targets start
  // open so first-run configuration is zero extra clicks.
  const [expanded, setExpanded] = useState(() => target.enabled && !ready)

  const saveAndClearDraft = (value: string, mode: 'key' | 'full-url'): void => {
    void onSaveManualStreamKey(target.id, value).then((saved) => {
      // Only discard what the user typed once the key is truly stored.
      if (saved) {
        if (mode === 'full-url') {
          setFullUrlDraft('')
        } else {
          setManualStreamKeyDraft('')
        }
      }
    })
  }

  const requestManualKeySave = (value: string, mode: 'key' | 'full-url'): void => {
    const trimmed = value.trim()
    if (!trimmed) {
      return
    }
    const warning = mode === 'key' ? streamKeyPlatformMismatch(target.platform, trimmed) : null
    if (target.streamKeyPresent || warning) {
      setPendingKeySave({ value, mode, warning })
      return
    }
    saveAndClearDraft(value, mode)
  }

  const confirmPendingKeySave = (): void => {
    const pending = pendingKeySave
    setPendingKeySave(null)
    if (pending) {
      saveAndClearDraft(pending.value, pending.mode)
    }
  }

  const confirmClearKey = (): void => {
    setConfirmingClear(false)
    setManualStreamKeyDraft('')
    setFullUrlDraft('')
    void onSaveManualStreamKey(target.id, '')
  }

  const patchEnabled = (enabled: boolean): void => {
    if (enabled && !enableGate.allowed) {
      return
    }
    onPatch(target.id, { enabled })
  }

  return (
    <section
      className="flex flex-col gap-4 rounded-panel border border-border p-4"
      data-slot="destination-card"
    >
      {/* The reference row anatomy: vivid platform tile · title · account
          context · spring · state meta · enable switch (videorc-design).
          Clicking the row toggles the auth/credentials detail. */}
      <ListRow
        className="-mx-1 h-auto min-h-9 cursor-pointer px-1"
        icon={<PlatformGlyph platform={target.platform} />}
        title={target.label}
        context={account?.accountLabel ?? (oauthMode ? undefined : 'Manual RTMP')}
        meta={<Badge variant={badge.tone}>{badge.label}</Badge>}
        role="button"
        aria-expanded={expanded}
        onClick={() => setExpanded((value) => !value)}
      >
        <span onClick={(event) => event.stopPropagation()}>
          {enableLockGate ? (
            // A dead disabled switch reads as broken; the lock chip says what
            // this actually is — a Premium feature — and IS the upgrade
            // affordance (multistream gate UI flow).
            <button
              aria-describedby={enableLockId}
              aria-label={`${target.label} requires Videorc Premium`}
              className="cursor-pointer"
              type="button"
              onClick={() =>
                enableLockUpgradeUrl ? openExternalUrl(enableLockUpgradeUrl) : undefined
              }
            >
              <Badge variant="outline">
                <LockSimple className="size-3" weight="fill" />
                Premium
              </Badge>
            </button>
          ) : (
            <Switch
              aria-label={`Enable ${target.label}`}
              checked={target.enabled}
              disabled={enableSwitchDisabled}
              onCheckedChange={patchEnabled}
            />
          )}
        </span>
        <CaretDown
          className={cn(
            'size-3.5 shrink-0 text-muted-foreground transition-transform',
            expanded && 'rotate-180'
          )}
        />
      </ListRow>
      {statusMessage ? (
        <span className="-mt-2 text-xs text-muted-foreground">{statusMessage}</span>
      ) : null}
      {enableLockGate ? (
        <div
          className="-mt-2 flex flex-wrap items-center gap-2 border-l-2 border-warning/50 pl-3 text-xs text-warning-foreground dark:text-warning"
          id={enableLockId}
        >
          <WarningCircle className="size-3.5 shrink-0" weight="fill" />
          <span className="min-w-0 flex-1">{enableLockGate.reason}</span>
          {enableLockUpgradeUrl ? (
            <Button
              className="h-auto px-0 text-xs"
              size="xs"
              variant="link"
              onClick={() => openExternalUrl(enableLockUpgradeUrl)}
            >
              View Premium
            </Button>
          ) : null}
        </div>
      ) : null}

      {!expanded ? null : (
        <>
          {target.platform === 'custom' ? (
            <Field>
              <FieldLabel>URL mode</FieldLabel>
              <ToggleGroup
                className="w-full"
                disabled={disabled}
                type="single"
                value={target.urlMode ?? 'server-and-key'}
                variant="outline"
                onValueChange={(value) =>
                  value && onPatch(target.id, { urlMode: value as StreamUrlMode })
                }
              >
                <ToggleGroupItem value="server-and-key">Server + key</ToggleGroupItem>
                <ToggleGroupItem value="full-url">Full URL</ToggleGroupItem>
              </ToggleGroup>
            </Field>
          ) : null}

          {nativeDestination ? (
            <Field>
              <FieldLabel>Auth mode</FieldLabel>
              {oauthUnavailableMessage ? (
                <div className="flex flex-col gap-2 rounded-row border bg-muted/30 px-3 py-2 text-xs text-muted-foreground sm:flex-row sm:items-center sm:justify-between">
                  <span>{oauthUnavailableMessage}</span>
                  <Badge className="w-fit" variant="outline">
                    Manual RTMP
                  </Badge>
                </div>
              ) : (
                <ToggleGroup
                  className="w-full"
                  disabled={disabled}
                  type="single"
                  value={target.authMode}
                  variant="outline"
                  onValueChange={(value) =>
                    value && onPatch(target.id, { authMode: value as StreamAuthMode })
                  }
                >
                  <ToggleGroupItem value="oauth">OAuth</ToggleGroupItem>
                  <ToggleGroupItem value="manual-rtmp">Manual RTMP</ToggleGroupItem>
                </ToggleGroup>
              )}
            </Field>
          ) : null}

          {oauthMode ? (
            <OAuthAccountPanel
              account={account}
              credentials={credentials}
              disabled={disabled}
              platform={target.platform}
              validation={validation}
              xNativeCapability={xNativeCapability}
              xNativeCapabilityLoading={xNativeCapabilityLoading}
              youtubeChannels={youtubeChannels}
              youtubeChannelsLoading={youtubeChannelsLoading}
              onConnect={onConnect}
              onDisconnect={onDisconnect}
              onRefreshYouTubeChannels={onRefreshYouTubeChannels}
              onRefreshXNativeCapability={onRefreshXNativeCapability}
              onAuthorizeXLive={onAuthorizeXLive}
              onSelectYouTubeChannel={onSelectYouTubeChannel}
              onUseManualRtmp={() => onPatch(target.id, { authMode: 'manual-rtmp' })}
            />
          ) : (
            <>
              <Field>
                <FieldLabel htmlFor={`${target.id}-server`}>
                  {fullUrl ? 'Full RTMP URL' : 'RTMP server'}
                </FieldLabel>
                <div className="flex gap-2">
                  <Input
                    disabled={disabled}
                    id={`${target.id}-server`}
                    placeholder={
                      fullUrl
                        ? target.streamKeyPresent
                          ? `URL saved · ends ${target.streamKeyHint ?? '••••'} — paste to replace`
                          : 'rtmp://server/app/key'
                        : 'rtmp://server/app'
                    }
                    type={fullUrl ? 'password' : 'text'}
                    value={fullUrl ? fullUrlDraft : target.serverUrl}
                    onBlur={() => {
                      if (fullUrl) {
                        requestManualKeySave(fullUrlDraft, 'full-url')
                      }
                    }}
                    onChange={(event) =>
                      fullUrl
                        ? setFullUrlDraft(event.target.value)
                        : onPatch(target.id, { serverUrl: event.target.value })
                    }
                    onKeyDown={(event) => {
                      if (fullUrl && event.key === 'Enter') {
                        requestManualKeySave(fullUrlDraft, 'full-url')
                      }
                    }}
                  />
                  {fullUrl && target.streamKeyPresent ? (
                    <Button
                      disabled={disabled}
                      size="sm"
                      variant="outline"
                      onClick={() => setConfirmingClear(true)}
                    >
                      Clear
                    </Button>
                  ) : null}
                </div>
                {fullUrl ? (
                  <FieldDescription>
                    {target.streamKeyPresent
                      ? `URL saved securely · ends ${target.streamKeyHint ?? '••••'}. Pasting a new one asks before replacing it.`
                      : 'Saved securely because full RTMP URLs can include the stream key.'}
                  </FieldDescription>
                ) : null}
              </Field>

              {!fullUrl ? (
                <Field>
                  <FieldLabel htmlFor={`${target.id}-key`}>Stream key</FieldLabel>
                  <div className="flex gap-2">
                    <Input
                      autoComplete="off"
                      disabled={disabled}
                      id={`${target.id}-key`}
                      placeholder={
                        target.streamKeyPresent
                          ? `Key saved · ends ${target.streamKeyHint ?? '••••'} — paste to replace`
                          : 'paste your stream key'
                      }
                      type="password"
                      value={manualStreamKeyDraft}
                      onBlur={() => requestManualKeySave(manualStreamKeyDraft, 'key')}
                      onChange={(event) => setManualStreamKeyDraft(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter') {
                          requestManualKeySave(manualStreamKeyDraft, 'key')
                        }
                      }}
                    />
                    {target.streamKeyPresent ? (
                      <Button
                        disabled={disabled}
                        size="sm"
                        variant="outline"
                        onClick={() => setConfirmingClear(true)}
                      >
                        Clear
                      </Button>
                    ) : null}
                  </div>
                  <FieldDescription>
                    {target.streamKeyPresent
                      ? `Key saved securely · ends ${target.streamKeyHint ?? '••••'}. Pasting a new one asks before replacing it.`
                      : 'Saved securely per platform — switching platforms never overwrites another key.'}
                  </FieldDescription>
                </Field>
              ) : null}

              {target.previousStreamKeyPresent ? (
                <Button
                  className="w-fit"
                  disabled={disabled}
                  size="sm"
                  variant="ghost"
                  onClick={() => void onRestorePreviousStreamKey(target.id)}
                >
                  <ArrowCounterClockwise />
                  Restore previous {credentialLabel}
                  {target.previousStreamKeyHint ? ` (ends ${target.previousStreamKeyHint})` : ''}
                </Button>
              ) : null}
            </>
          )}

          <Dialog
            open={pendingKeySave !== null}
            onOpenChange={(open) => {
              if (!open) {
                setPendingKeySave(null)
              }
            }}
          >
            <DialogContent>
              <DialogHeader>
                <DialogTitle>
                  {target.streamKeyPresent
                    ? `Replace the ${target.label} ${credentialLabel}?`
                    : `Save this ${credentialLabel} to ${target.label}?`}
                </DialogTitle>
                <DialogDescription>
                  {target.streamKeyPresent
                    ? `The saved ${credentialLabel}${
                        target.streamKeyHint ? ` ending ${target.streamKeyHint}` : ''
                      } will be replaced by the new one ending ${streamKeyTailHint(
                        pendingKeySave?.value ?? ''
                      )}. The old one is kept as your previous ${credentialLabel}, so you can restore it.`
                    : `The key ending ${streamKeyTailHint(pendingKeySave?.value ?? '')} will be saved to ${target.label}.`}
                </DialogDescription>
              </DialogHeader>
              {pendingKeySave?.warning ? (
                <div className="flex items-start gap-2 rounded-row border border-warning/40 bg-warning/10 p-3 text-sm text-warning-foreground dark:text-warning">
                  <Warning className="mt-0.5 shrink-0" />
                  <span>{pendingKeySave.warning}</span>
                </div>
              ) : null}
              <DialogFooter>
                <Button variant="outline" onClick={() => setPendingKeySave(null)}>
                  Cancel
                </Button>
                <Button
                  variant={pendingKeySave?.warning ? 'destructive' : 'default'}
                  onClick={confirmPendingKeySave}
                >
                  {target.streamKeyPresent
                    ? `Replace ${credentialLabel}`
                    : `Save ${credentialLabel}`}
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>

          <Dialog open={confirmingClear} onOpenChange={setConfirmingClear}>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>{`Remove the ${target.label} ${credentialLabel}?`}</DialogTitle>
                <DialogDescription>
                  {`The saved ${credentialLabel}${
                    target.streamKeyHint ? ` ending ${target.streamKeyHint}` : ''
                  } is kept as your previous ${credentialLabel} after removal, so you can restore it.`}
                </DialogDescription>
              </DialogHeader>
              <DialogFooter>
                <Button variant="outline" onClick={() => setConfirmingClear(false)}>
                  Cancel
                </Button>
                <Button variant="destructive" onClick={confirmClearKey}>
                  Remove {credentialLabel}
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>

          {target.platform === 'x' && !oauthMode ? (
            <p className="text-xs text-muted-foreground">
              X needs Media Studio Producer access; copy the RTMP URL and key from a Producer
              source.
            </p>
          ) : null}
        </>
      )}
    </section>
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

// The vivid 24px rounded-square platform tile — per the design skill, source
// and platform icons are the ONLY large saturated color in the chrome.
const PLATFORM_GLYPH_TINT: Record<StreamPlatform, string> = {
  youtube: 'bg-[#ff0033]/15 text-[#ff0033]',
  twitch: 'bg-[#9146ff]/15 text-[#a970ff]',
  x: 'bg-foreground/10 text-foreground',
  custom: 'bg-foreground/10 text-muted-foreground'
}

function PlatformGlyph({ platform }: { platform: StreamPlatform }): ReactElement {
  const Icon = PLATFORM_ICON[platform]
  return (
    <span
      className={cn(
        'flex size-6 items-center justify-center rounded-[6px]',
        PLATFORM_GLYPH_TINT[platform]
      )}
    >
      <Icon className="size-4" weight="fill" />
    </span>
  )
}

function streamTargetStatusBadge(state: NonNullable<StreamTargetSettings['status']>['state']): {
  tone: BadgeTone
  label: string
} {
  switch (state) {
    case 'ready':
      return { tone: 'success', label: 'Prepared' }
    case 'connecting':
      return { tone: 'warning', label: 'Updating' }
    case 'live':
      return { tone: 'success', label: 'On air' }
    case 'warning':
      return { tone: 'warning', label: 'Review' }
    case 'failed':
      return { tone: 'destructive', label: 'Failed' }
    case 'stopped':
      return { tone: 'outline', label: 'Ended' }
    default:
      return { tone: 'outline', label: 'Idle' }
  }
}

function OAuthAccountPanel({
  account,
  credentials,
  disabled,
  platform,
  validation,
  xNativeCapability,
  xNativeCapabilityLoading,
  youtubeChannels,
  youtubeChannelsLoading,
  onConnect,
  onDisconnect,
  onRefreshYouTubeChannels,
  onRefreshXNativeCapability,
  onAuthorizeXLive,
  onSelectYouTubeChannel,
  onUseManualRtmp
}: {
  account?: PlatformAccount
  credentials?: OAuthProviderCredentialStatus
  disabled: boolean
  platform: StreamPlatform
  validation?: PlatformAccountValidation
  xNativeCapability: XNativeLiveCapability | null
  xNativeCapabilityLoading: boolean
  youtubeChannels: YouTubeChannel[]
  youtubeChannelsLoading: boolean
  onConnect: (platform: StreamPlatform) => void
  onDisconnect: (platform: StreamPlatform) => void
  onRefreshYouTubeChannels: (accountId?: string) => Promise<void>
  onRefreshXNativeCapability: (accountId?: string) => Promise<void>
  onAuthorizeXLive: () => Promise<void>
  onSelectYouTubeChannel: (channelId: string, accountId?: string) => Promise<void>
  onUseManualRtmp: () => void
}): ReactElement {
  const [youtubeConsentOpen, setYoutubeConsentOpen] = useState(false)
  const [youtubeConsentAccepted, setYoutubeConsentAccepted] = useState(false)

  if (!account) {
    const connectDisabled = disabled || credentials?.ready === false
    return (
      <>
        <div className="flex flex-col gap-2 rounded-row border bg-muted/30 p-3">
          <div className="flex items-center justify-between gap-3">
            <span className="text-sm font-medium">No account connected</span>
            <Button
              disabled={connectDisabled}
              size="sm"
              variant="secondary"
              onClick={() => {
                if (platform === 'youtube') {
                  setYoutubeConsentAccepted(false)
                  setYoutubeConsentOpen(true)
                } else {
                  onConnect(platform)
                }
              }}
            >
              <LinkSimple data-icon="inline-start" weight="bold" />
              Connect
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            {credentials?.message ?? 'Uses backend provider credentials.'}
          </p>
          {credentials ? (
            <Badge className="w-fit" variant={credentials.ready ? 'outline' : 'warning'}>
              {credentialSourceLabel(credentials)}
            </Badge>
          ) : null}
        </div>

        {platform === 'youtube' ? (
          <Dialog open={youtubeConsentOpen} onOpenChange={setYoutubeConsentOpen}>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Connect YouTube to Videorc</DialogTitle>
                <DialogDescription>
                  Videorc uses YouTube API Services to identify your channel and manage your live
                  broadcasts and chat. The requested YouTube permission is stored locally on this
                  computer and can be revoked with Disconnect at any time.
                </DialogDescription>
              </DialogHeader>
              <div className="grid gap-3 text-sm">
                <div className="flex flex-wrap gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => openExternalUrl(VIDEORC_WEB_LINKS.privacy)}
                  >
                    Privacy Policy
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => openExternalUrl(VIDEORC_WEB_LINKS.terms)}
                  >
                    Videorc Terms
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => openExternalUrl('https://www.youtube.com/t/terms')}
                  >
                    YouTube Terms
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => openExternalUrl('https://policies.google.com/privacy')}
                  >
                    Google Privacy
                  </Button>
                </div>
                <label className="flex items-start gap-3 rounded-row border bg-muted/30 p-3">
                  <Checkbox
                    checked={youtubeConsentAccepted}
                    onCheckedChange={(checked) => setYoutubeConsentAccepted(checked === true)}
                  />
                  <span>
                    I agree to the Videorc and YouTube terms and want to connect my YouTube account.
                  </span>
                </label>
              </div>
              <DialogFooter>
                <Button variant="outline" onClick={() => setYoutubeConsentOpen(false)}>
                  Cancel
                </Button>
                <Button
                  disabled={!youtubeConsentAccepted}
                  onClick={() => {
                    setYoutubeConsentOpen(false)
                    onConnect('youtube')
                  }}
                >
                  Continue to Google
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        ) : null}
      </>
    )
  }

  const youtubeChannelOptions =
    platform === 'youtube' &&
    !youtubeChannels.some((channel) => channel.channelId === account.accountId)
      ? [
          {
            channelId: account.accountId,
            title: account.accountLabel,
            handle: account.accountHandle,
            avatarUrl: account.avatarUrl
          },
          ...youtubeChannels
        ]
      : youtubeChannels

  return (
    <div className="flex flex-col gap-2 rounded-row border bg-muted/30 p-3">
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-1">
          <span className="truncate text-sm font-medium">{account.accountLabel}</span>
          <span className="truncate text-xs text-muted-foreground">
            {account.accountHandle ?? account.accountId}
          </span>
        </div>
        <Badge variant={account.status === 'connected' ? 'success' : 'warning'}>
          {account.status === 'connected' ? 'Connected' : 'Reconnect'}
        </Badge>
      </div>
      {validation ? (
        <div className="flex flex-col gap-1 rounded-row bg-background/60 px-2 py-1.5">
          <Badge className="w-fit" variant={validationBadge(validation).tone}>
            {validationBadge(validation).label}
          </Badge>
          <span className="text-xs text-muted-foreground">{validation.message}</span>
        </div>
      ) : null}
      <div className="flex flex-wrap gap-1">
        {account.scopes.length ? (
          account.scopes.map((scope) => (
            <Badge key={scope} variant="outline">
              {scope}
            </Badge>
          ))
        ) : (
          <span className="text-xs text-muted-foreground">No granted scopes reported.</span>
        )}
      </div>
      {platform === 'youtube' ? (
        <Field>
          <FieldLabel>YouTube channel</FieldLabel>
          <div className="flex gap-2">
            <Select
              disabled={disabled || youtubeChannelsLoading || youtubeChannelOptions.length === 0}
              value={account.accountId}
              onValueChange={(channelId) =>
                void onSelectYouTubeChannel(channelId, account.accountId)
              }
            >
              <SelectTrigger className="min-w-0 flex-1">
                <SelectValue
                  placeholder={youtubeChannelsLoading ? 'Loading channels' : 'Select channel'}
                />
              </SelectTrigger>
              <SelectContent>
                {youtubeChannelOptions.map((channel) => (
                  <SelectItem key={channel.channelId} value={channel.channelId}>
                    {channel.title}
                    {channel.handle ? ` (${channel.handle})` : ''}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button
              disabled={disabled || youtubeChannelsLoading}
              size="sm"
              variant="outline"
              onClick={() => void onRefreshYouTubeChannels(account.accountId)}
            >
              <ArrowsClockwise data-icon="inline-start" weight="bold" />
              {youtubeChannelsLoading ? 'Loading' : 'Refresh'}
            </Button>
          </div>
          <FieldDescription>
            {youtubeChannels.length
              ? 'Switching channels clears prepared YouTube ingest state for the previous channel.'
              : 'Refresh after connecting to load channels available to this Google account.'}
          </FieldDescription>
        </Field>
      ) : null}
      {platform === 'x' ? (
        <div className="flex flex-col gap-2 rounded-row bg-background/60 px-2 py-1.5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <Badge
              className="w-fit"
              variant={xNativeCapability?.nativeAvailable ? 'success' : 'warning'}
            >
              {xNativeCapability?.nativeAvailable
                ? 'X API ready'
                : xNativeCapability?.state === 'needs-authorization'
                  ? 'Authorization needed'
                  : xNativeCapability?.state === 'missing-credentials'
                    ? 'Credentials needed'
                    : xNativeCapability?.state === 'account-mismatch'
                      ? 'Account mismatch'
                      : 'X API check needed'}
            </Badge>
            <Button
              disabled={disabled || xNativeCapabilityLoading}
              size="sm"
              variant="outline"
              onClick={() => void onRefreshXNativeCapability(account.accountId)}
            >
              <ArrowsClockwise data-icon="inline-start" weight="bold" />
              {xNativeCapabilityLoading ? 'Checking' : 'Refresh'}
            </Button>
          </div>
          <span className="text-xs text-muted-foreground">
            {xNativeCapabilityLoading
              ? 'Checking X native live capability.'
              : (xNativeCapability?.message ?? 'X native live capability has not been checked.')}
          </span>
          {xNativeCapability ? (
            <div className="flex flex-wrap gap-2 text-xs">
              <a
                className="text-primary underline-offset-4 hover:underline"
                href={xNativeCapability.docsUrl}
                onClick={(event) => {
                  event.preventDefault()
                  openExternalUrl(xNativeCapability.docsUrl)
                }}
                rel="noreferrer"
                target="_blank"
              >
                X Producer docs
              </a>
              <a
                className="text-primary underline-offset-4 hover:underline"
                href={xNativeCapability.apiOverviewUrl}
                onClick={(event) => {
                  event.preventDefault()
                  openExternalUrl(xNativeCapability.apiOverviewUrl)
                }}
                rel="noreferrer"
                target="_blank"
              >
                X API overview
              </a>
            </div>
          ) : null}
          {xNativeCapability && !xNativeCapability.nativeAvailable ? (
            <div className="flex flex-col gap-1.5">
              {xNativeCapability.state === 'needs-authorization' ||
              xNativeCapability.state === 'account-mismatch' ? (
                <div className="flex flex-col gap-1">
                  <Button
                    className="w-fit"
                    disabled={disabled}
                    size="sm"
                    onClick={() => void onAuthorizeXLive()}
                  >
                    Authorize X Live
                  </Button>
                  <span className="text-xs text-muted-foreground">
                    Opens x.com in the browser to approve live broadcasting for this account. The
                    token stays in the local secret store.
                  </span>
                </div>
              ) : null}
              <Button
                className="w-fit"
                disabled={disabled}
                size="sm"
                variant="secondary"
                onClick={onUseManualRtmp}
              >
                Switch to Manual RTMP
              </Button>
              <span className="text-xs text-muted-foreground">
                Manual RTMP is still available as an explicit fallback: create an RTMP source in X
                Producer, then paste its URL and stream key here in Manual RTMP mode.
              </span>
            </div>
          ) : null}
        </div>
      ) : null}
      <Button
        disabled={disabled}
        size="sm"
        variant="outline"
        onClick={() => onDisconnect(platform)}
      >
        <SignOut data-icon="inline-start" weight="bold" />
        Disconnect
      </Button>
    </div>
  )
}

function credentialSourceLabel(credentials: OAuthProviderCredentialStatus): string {
  switch (credentials.clientIdSource) {
    case 'environment':
      return 'Environment override'
    case 'bundled':
      return 'Bundled default'
    case 'missing':
      return 'Missing client ID'
  }
}

function validationBadge(validation: PlatformAccountValidation): {
  tone: BadgeTone
  label: string
} {
  switch (validation.state) {
    case 'valid':
      return { tone: 'success', label: 'Validated' }
    case 'refreshed':
      return { tone: 'success', label: 'Refreshed' }
    case 'needs-reconnect':
      return { tone: 'warning', label: 'Needs reconnect' }
    default:
      return { tone: 'outline', label: 'Not checked' }
  }
}

function MetadataEditor({
  draft,
  validation,
  targets,
  disabled,
  pending,
  twitchCategories,
  twitchCategorySearchPending,
  onPatchDraft,
  onPatchTarget,
  onSave,
  onSearchTwitchCategories
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
}): ReactElement {
  const nativeTargets = targets.filter((target) => target.platform !== 'custom')
  const globalTitleIssue = metadataIssue(validation, 'title')

  return (
    <PanelSection
      action={
        <Button
          disabled={disabled || !draft || pending}
          size="sm"
          variant="secondary"
          onClick={onSave}
        >
          <FloppyDisk data-icon="inline-start" weight="bold" />
          {pending ? 'Saving' : 'Save'}
        </Button>
      }
      icon={TextAa}
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
              Applies to YouTube. Twitch channels are always public; X broadcasts are always public
              — use its Announce toggle below to control the announcement post.
            </FieldDescription>
          </Field>

          <div className="flex flex-col gap-4">
            {draft.targetOverrides.map((override) => {
              const target = nativeTargets.find((item) => item.platform === override.platform)
              return (
                <MetadataOverride
                  disabled={disabled}
                  draft={draft}
                  key={override.platform}
                  label={target?.label ?? platformLabel(override.platform)}
                  override={override}
                  twitchCategories={twitchCategories}
                  twitchCategorySearchPending={twitchCategorySearchPending}
                  validation={validation}
                  onPatch={(patch) => onPatchTarget(override.platform, patch)}
                  onSearchTwitchCategories={onSearchTwitchCategories}
                />
              )
            })}
          </div>

          {validation && !validation.valid ? (
            <div className="rounded-row border border-warning/40 bg-warning/10 p-3 text-xs text-muted-foreground">
              {validation.issues.length} metadata warning{validation.issues.length === 1 ? '' : 's'}{' '}
              before Go Live.
            </div>
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

function MetadataOverride({
  override,
  draft,
  label,
  disabled,
  twitchCategories,
  twitchCategorySearchPending,
  validation,
  onPatch,
  onSearchTwitchCategories
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
}): ReactElement {
  const titleIssue = metadataIssue(validation, 'title', override.platform)
  const fieldsDisabled = disabled || !override.customize
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

  return (
    <div className="flex flex-col gap-3 border-t pt-4 first:border-t-0 first:pt-0">
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 flex-col">
          <span className="truncate text-sm font-medium">{label}</span>
          <span className="truncate text-xs text-muted-foreground">
            {override.customize ? 'Custom metadata' : 'Inherits global metadata'}
          </span>
        </div>
        <Switch
          aria-label={`Customize ${label}`}
          checked={override.customize}
          disabled={disabled}
          onCheckedChange={(customize) => onPatch({ customize })}
        />
      </div>

      <Field>
        <FieldLabel htmlFor={`${override.platform}-metadata-title`}>Title</FieldLabel>
        <Input
          aria-invalid={Boolean(titleIssue)}
          disabled={fieldsDisabled}
          id={`${override.platform}-metadata-title`}
          placeholder={draft.title || 'Inherits global title'}
          value={override.title}
          onChange={(event) => onPatch({ title: event.target.value })}
        />
        {titleIssue ? <FieldDescription>{titleIssue.message}</FieldDescription> : null}
      </Field>

      <Field>
        <FieldLabel htmlFor={`${override.platform}-metadata-description`}>Description</FieldLabel>
        <Textarea
          className="min-h-20 resize-y"
          disabled={fieldsDisabled || twitch || x}
          id={`${override.platform}-metadata-description`}
          placeholder={
            twitch
              ? 'Not supported by Twitch'
              : x
                ? 'Not supported by X'
                : draft.description || 'Inherits global description'
          }
          value={twitch || x ? '' : override.description}
          onChange={(event) => onPatch({ description: event.target.value })}
        />
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
        <div className="grid gap-3 sm:grid-cols-2">
          <Field>
            <FieldLabel>Privacy</FieldLabel>
            <Select
              disabled={fieldsDisabled}
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
          <Field>
            <FieldLabel>Made for kids</FieldLabel>
            <ToggleGroup
              className="w-full"
              disabled={fieldsDisabled}
              type="single"
              value={override.youtubeMadeForKids ? 'yes' : 'no'}
              variant="outline"
              onValueChange={(value) => value && onPatch({ youtubeMadeForKids: value === 'yes' })}
            >
              <ToggleGroupItem value="no">No</ToggleGroupItem>
              <ToggleGroupItem value="yes">Yes</ToggleGroupItem>
            </ToggleGroup>
          </Field>
        </div>
      ) : null}

      {twitch ? (
        <div className="grid gap-3 sm:grid-cols-2">
          <Field>
            <FieldLabel htmlFor="twitch-category">Category</FieldLabel>
            <div className="flex gap-2">
              <Input
                disabled={fieldsDisabled}
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
                  fieldsDisabled ||
                  twitchCategorySearchPending ||
                  twitchCategoryQuery.trim().length < 2
                }
                size="sm"
                variant="outline"
                onClick={() => void onSearchTwitchCategories(twitchCategoryQuery)}
              >
                <MagnifyingGlass data-icon="inline-start" weight="bold" />
                {twitchCategorySearchPending ? 'Searching' : 'Search'}
              </Button>
            </div>
            {twitchCategoryOptions.length ? (
              <Select
                disabled={fieldsDisabled || twitchCategorySearchPending}
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
              disabled={fieldsDisabled}
              id="twitch-language"
              placeholder="en"
              value={override.twitchLanguage ?? ''}
              onChange={(event) => onPatch({ twitchLanguage: event.target.value })}
            />
          </Field>
        </div>
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
            disabled={fieldsDisabled}
            onCheckedChange={(xAnnounce) => onPatch({ xAnnounce })}
          />
        </div>
      ) : null}
    </div>
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
    case 'x':
      return 'X'
    default:
      return 'Custom'
  }
}

function StreamingReadiness({
  targets,
  ffmpegReady,
  profileCompatible,
  recordEnabled,
  recordingVideo,
  splitOutputActive,
  streaming,
  streamVideo
}: {
  targets: StreamTargetSettings[]
  ffmpegReady: boolean
  profileCompatible: boolean
  recordEnabled: boolean
  recordingVideo: VideoSettings
  splitOutputActive: boolean
  streaming: StreamingSettings
  streamVideo: VideoSettings
}): ReactElement {
  const enabled = targets.filter((target) => target.enabled)
  const readyCount = enabled.filter(isStreamTargetReady).length
  const allReady = enabled.length > 0 && readyCount === enabled.length
  const targetOutputs = enabled.map((target) => ({
    target,
    video: streamOutputVideoForTarget(recordingVideo, streaming, target)
  }))
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
      return (
        video.bitrateKbps <= 6000 ||
        (video.preset === 'stream-youtube-4k30' &&
          target?.platform === 'youtube' &&
          video.bitrateKbps === 30000)
      )
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
    <PanelSection icon={Gauge} title="Multistream readiness">
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
            : '—'
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

function sameVideoOutput(left: VideoSettings, right: VideoSettings): boolean {
  return (
    left.width === right.width &&
    left.height === right.height &&
    left.fps === right.fps &&
    left.bitrateKbps === right.bitrateKbps
  )
}

function formatVideoOutput(video: VideoSettings): string {
  return `${video.width}×${video.height} @ ${video.fps}`
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
          <CheckCircle className="size-4 shrink-0 text-primary" weight="fill" />
        ) : (
          <WarningCircle className="size-4 shrink-0 text-muted-foreground" weight="fill" />
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
