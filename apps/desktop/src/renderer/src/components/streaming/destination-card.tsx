import {
  AlertIcon,
  ChevronDownIcon,
  LinkIcon,
  ResetIcon,
  SignOutIcon,
  SyncIcon,
  WarningIcon
} from '@/components/icons'
import { useEffect, useState, type KeyboardEvent, type ReactElement } from 'react'

import { ListRow } from '@/components/list-row'
import {
  YOUTUBE_STREAM_KEY_LINK_LABEL,
  YOUTUBE_STREAM_KEY_URL,
  youtubeDestinationPausedMessage
} from '@/lib/youtube-quota'
import { PlatformGlyph } from '@/components/platform-glyph'
import { StatusBadge } from '@/components/status-badge'
import { StatusDot } from '@/components/status-dot'
import { Alert, AlertDescription } from '@/components/ui/alert'
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
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import type {
  OAuthProviderCredentialStatus,
  PlatformAccount,
  PlatformAccountValidation,
  PlatformConnectOptions,
  StreamAuthMode,
  StreamPlatform,
  StreamTargetRuntime,
  StreamTargetSettings,
  StreamUrlMode,
  XNativeLiveCapability,
  YouTubeChannel
} from '@/lib/backend'
import { AvatarCircle } from '@/lib/chat-avatar'
import { oauthUnavailableReason } from '@/lib/capture'
import { destinationSetup } from '@/lib/destination-readiness'
import type { EntitlementUiGate } from '@/lib/entitlement-ui'
import { streamKeyPlatformMismatch, streamKeyTailHint } from '@/lib/stream-key-format'
import { metadataPlatformLabel } from '@/lib/stream-metadata-summary'
import { cn } from '@/lib/utils'
import { VIDEORC_WEB_LINKS } from '@/lib/videorc-web-links'
import { TWITCH_AUDIENCE_SCOPES } from '../../../../shared/platform-scopes'

// One destination (plan 080 S5/S6). The owner's brief: "make it good and
// readable for someone connecting through OAuth or through RTMP". The row
// says only what needs the streamer (quiet when fine, specific when not); the
// open card holds the connection and nothing a streamer cannot act on (no
// OAuth scopes, no credential sources, no raw validation strings inline).

type BadgeTone = 'success' | 'warning' | 'destructive' | 'live' | 'outline'

function runtimeBadge(runtime: StreamTargetRuntime): { tone: BadgeTone; label: string } {
  switch (runtime.state) {
    case 'live':
      return { tone: 'live', label: 'On air' }
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

/**
 * The idle row badge: a saved broadcast state when there is one ("Prepared"),
 * "Needs setup" when an enabled destination cannot go live yet, and nothing
 * otherwise. Every idle card used to say "Idle", which said nothing.
 */
export function idleDestinationBadge(
  target: StreamTargetSettings,
  account: PlatformAccount | undefined
): { tone: BadgeTone; label: string } | null {
  const saved = target.status?.state
  if (saved && saved !== 'not-configured') return streamTargetStatusBadge(saved)
  if (target.enabled && !destinationSetup(target, account).ready) {
    return { tone: 'warning', label: 'Needs setup' }
  }
  return null
}

export function DestinationCard({
  target,
  account,
  credentials,
  disabled,
  enableGate,
  runtime,
  validation,
  sharedAccountWith,
  expanded: controlledExpanded,
  onExpandedChange,
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
  onSelectYouTubeChannel,
  youtubeQuotaPausedUntil
}: {
  target: StreamTargetSettings
  account?: PlatformAccount
  /** Plan 094: the shared YouTube API pause end, while paused. */
  youtubeQuotaPausedUntil?: Date | null
  credentials?: OAuthProviderCredentialStatus
  disabled: boolean
  enableGate: EntitlementUiGate
  runtime?: StreamTargetRuntime
  validation?: PlatformAccountValidation
  /**
   * Another destination's label when this one signs in with the same account
   * (YouTube Vertical beside YouTube): the channel and Disconnect live there.
   */
  sharedAccountWith?: string
  /** Controlled open state (the readiness list opens a card); uncontrolled when absent. */
  expanded?: boolean
  onExpandedChange?: (expanded: boolean) => void
  xNativeCapability: XNativeLiveCapability | null
  xNativeCapabilityLoading: boolean
  youtubeChannels: YouTubeChannel[]
  youtubeChannelsLoading: boolean
  onConnect: (platform: StreamPlatform, options?: PlatformConnectOptions) => void
  onDisconnect: (platform: StreamPlatform) => void
  onPatch: (targetId: string, patch: Partial<StreamTargetSettings>) => void
  onSaveManualStreamKey: (targetId: string, streamKey: string) => Promise<boolean>
  onRestorePreviousStreamKey: (targetId: string) => Promise<void>
  onRefreshYouTubeChannels: (accountId?: string) => Promise<void>
  onRefreshXNativeCapability: (accountId?: string) => Promise<void>
  onAuthorizeXLive: () => Promise<void>
  onSelectYouTubeChannel: (channelId: string, accountId?: string) => Promise<void>
}): ReactElement {
  const fullUrl = target.urlMode === 'full-url'
  const nativeDestination = target.platform !== 'custom'
  const platformName = metadataPlatformLabel(target.platform)
  // A platform that has no sign-in at all (TikTok, Instagram, Custom RTMP).
  const keyOnlyPlatform = Boolean(oauthUnavailableReason(target.platform))
  const oauthUnavailableMessage =
    oauthUnavailableReason(target.platform) ??
    (credentials?.ready === false ? credentials.message : null)
  const oauthMode = nativeDestination && target.authMode === 'oauth' && !oauthUnavailableMessage
  const setup = destinationSetup(target, account)
  // While a session is live the runtime status (on air / stopped / skipped)
  // takes over the badge; otherwise only something worth reading shows.
  // Plan 094: YouTube's API is paused (shared quota). The OAuth path can't
  // create a broadcast until the reset; the stream key still can.
  const youtubePaused =
    target.platform === 'youtube' && target.authMode === 'oauth' && youtubeQuotaPausedUntil
      ? youtubeQuotaPausedUntil
      : null
  const badge = runtime
    ? runtimeBadge(runtime)
    : youtubePaused
      ? { tone: 'warning' as const, label: 'API paused' }
      : idleDestinationBadge(target, account)
  const statusMessage = runtime?.message ?? target.status?.message
  // Multistreaming is free for every plan: the only enable gate left is the
  // shared destination cap (or a disabled livestreaming feature), so the
  // switch is always rendered and the strip below explains why it is off.
  const enableLockGate = !disabled && !target.enabled && !enableGate.allowed ? enableGate : null
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
  const guidance = oauthMode ? null : manualKeyGuidance(target.platform)

  // Row + detail (ux-ia plan, slice 7): the row shows identity and state; the
  // expandable detail holds ONLY the connection. Needs-setup targets start
  // open so first-run configuration is zero extra clicks.
  const [uncontrolledExpanded, setUncontrolledExpanded] = useState(
    () => target.enabled && !setup.ready
  )
  const expanded = controlledExpanded ?? uncontrolledExpanded
  const setExpanded = (next: boolean): void => {
    setUncontrolledExpanded(next)
    onExpandedChange?.(next)
  }
  const toggleFromKeyboard = (event: KeyboardEvent<HTMLDivElement>): void => {
    // Only the row itself: Space on the enable switch must not also toggle.
    if (event.target !== event.currentTarget) return
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      setExpanded(!expanded)
    }
  }

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
    <section className="flex flex-col" data-slot="destination-card" id={`destination-${target.id}`}>
      {/* The reference row anatomy: vivid platform tile · title · account
          context · spring · state meta · enable switch (videorc-design).
          Clicking the row, or Enter/Space on it, toggles the connection. */}
      <ListRow
        className="h-auto min-h-10 py-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        icon={<PlatformGlyph platform={target.platform} />}
        title={target.label}
        context={oauthMode ? account?.accountLabel : 'Stream key'}
        meta={
          target.outputOrientation === 'vertical' || badge ? (
            <span className="flex items-center gap-1.5">
              {target.outputOrientation === 'vertical' ? (
                <Badge variant="outline">9:16</Badge>
              ) : null}
              {badge ? <Badge variant={badge.tone}>{badge.label}</Badge> : null}
            </span>
          ) : undefined
        }
        role="button"
        tabIndex={0}
        aria-expanded={expanded}
        onClick={() => setExpanded(!expanded)}
        onKeyDown={toggleFromKeyboard}
      >
        <span onClick={(event) => event.stopPropagation()}>
          <Switch
            aria-describedby={enableLockGate ? enableLockId : undefined}
            aria-label={`Enable ${target.label}`}
            checked={target.enabled}
            disabled={enableSwitchDisabled}
            onCheckedChange={patchEnabled}
          />
        </span>
        <ChevronDownIcon
          className={cn(
            'size-3.5 shrink-0 text-muted-foreground transition-transform',
            expanded && 'rotate-180'
          )}
        />
      </ListRow>
      {/* Status, guidance, and the expanded connection sit under the row;
          the block collapses when it has nothing to say. */}
      <div className="flex flex-col gap-3 px-3 pb-3 empty:hidden">
        {statusMessage ? (
          <span className="text-xs text-muted-foreground">{statusMessage}</span>
        ) : null}
        {enableLockGate ? (
          // Neutral limit strip: a pipeline cap, not a plan boundary, so no
          // warning tint and no upgrade affordance.
          <div
            className="flex flex-wrap items-center gap-2 border-l-2 border-border pl-3 text-xs text-muted-foreground"
            id={enableLockId}
          >
            <AlertIcon className="size-3.5 shrink-0" weight="fill" />
            <span className="min-w-0 flex-1">{enableLockGate.reason}</span>
          </div>
        ) : null}

        {!expanded ? null : (
          <>
            {target.platform === 'custom' ? (
              <Field>
                <FieldLabel>URL mode</FieldLabel>
                <SegmentedChoice
                  disabled={disabled}
                  label="URL mode"
                  options={[
                    { value: 'server-and-key', label: 'Server + key' },
                    { value: 'full-url', label: 'Full URL' }
                  ]}
                  value={target.urlMode ?? 'server-and-key'}
                  onChange={(value) => onPatch(target.id, { urlMode: value as StreamUrlMode })}
                />
              </Field>
            ) : null}

            {nativeDestination && !oauthUnavailableMessage ? (
              <Field>
                <FieldLabel>Connect with</FieldLabel>
                <SegmentedChoice
                  disabled={disabled}
                  label="Connect with"
                  options={[
                    { value: 'oauth', label: 'Sign in' },
                    { value: 'manual-rtmp', label: 'Stream key' }
                  ]}
                  value={target.authMode}
                  onChange={(value) => onPatch(target.id, { authMode: value as StreamAuthMode })}
                />
              </Field>
            ) : null}

            {nativeDestination && oauthUnavailableMessage ? (
              <p className="text-xs text-muted-foreground" data-slot="destination-key-only">
                {keyOnlyPlatform
                  ? `${platformName} uses a stream key.`
                  : `Signing in to ${platformName} isn't available in this build. Use a stream key.`}
              </p>
            ) : null}

            {guidance ? (
              <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                <span className="min-w-0">{guidance.copy}</span>
                <Button
                  className="h-auto px-0 text-xs"
                  size="xs"
                  variant="link"
                  onClick={() => openExternalUrl(guidance.url)}
                >
                  {guidance.linkLabel}
                </Button>
              </div>
            ) : null}

            {youtubePaused ? (
              <Alert data-slot="youtube-quota-paused" variant="warning">
                <WarningIcon />
                <AlertDescription className="flex flex-col gap-2">
                  <span>{youtubeDestinationPausedMessage(youtubePaused)}</span>
                  <span className="flex flex-wrap items-center gap-2">
                    <Button
                      disabled={disabled}
                      size="sm"
                      variant="outline"
                      onClick={() => onPatch(target.id, { authMode: 'manual-rtmp' })}
                    >
                      Use stream key
                    </Button>
                    <Button
                      className="h-auto p-0 text-xs"
                      size="sm"
                      variant="link"
                      onClick={() => openExternalUrl(YOUTUBE_STREAM_KEY_URL)}
                    >
                      {YOUTUBE_STREAM_KEY_LINK_LABEL}
                    </Button>
                  </span>
                </AlertDescription>
              </Alert>
            ) : null}
            {oauthMode ? (
              <OAuthAccountPanel
                account={account}
                credentials={credentials}
                disabled={disabled}
                platform={target.platform}
                sharedAccountWith={sharedAccountWith}
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
                    {fullUrl ? 'Full RTMP URL' : 'Server URL'}
                  </FieldLabel>
                  <div className="flex gap-2">
                    <Input
                      disabled={disabled}
                      id={`${target.id}-server`}
                      placeholder={
                        fullUrl
                          ? target.streamKeyPresent
                            ? `URL saved · ends ${target.streamKeyHint ?? '••••'}. Paste to replace`
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
                        ? `Saved securely · ends ${target.streamKeyHint ?? '••••'}`
                        : 'Saved securely, since a full URL includes the stream key.'}
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
                            ? `Key saved · ends ${target.streamKeyHint ?? '••••'}. Paste to replace`
                            : 'Paste your stream key'
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
                    {target.streamKeyPresent ? (
                      <FieldDescription>
                        {`Saved securely · ends ${target.streamKeyHint ?? '••••'}`}
                      </FieldDescription>
                    ) : null}
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
                    <ResetIcon />
                    Restore previous {credentialLabel}
                    {target.previousStreamKeyHint ? ` (ends ${target.previousStreamKeyHint})` : ''}
                  </Button>
                ) : null}

                {target.platform === 'x' ? (
                  <p className="text-xs text-muted-foreground">
                    Copy the server URL and key from an RTMP source in X Media Studio Producer.
                  </p>
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
                  <Alert variant="warning">
                    <WarningIcon />
                    <AlertDescription>{pendingKeySave.warning}</AlertDescription>
                  </Alert>
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
          </>
        )}
      </div>
    </section>
  )
}

/** A two-way choice as the glass segmented control (design skill: Tabs). */
function SegmentedChoice({
  label,
  value,
  options,
  disabled,
  onChange
}: {
  label: string
  value: string
  options: Array<{ value: string; label: string }>
  disabled: boolean
  onChange: (value: string) => void
}): ReactElement {
  return (
    <Tabs value={value} onValueChange={(next) => next && onChange(next)}>
      <TabsList aria-label={label} className="w-full">
        {options.map((option) => (
          <TabsTrigger
            className="flex-1"
            disabled={disabled}
            key={option.value}
            value={option.value}
          >
            {option.label}
          </TabsTrigger>
        ))}
      </TabsList>
    </Tabs>
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

// Manual-key platforms rotate their key per broadcast and gate LIVE access on
// their side — link the user to the source of truth instead of promising
// automation Videorc cannot deliver (no public ingest APIs).
function manualKeyGuidance(
  platform: StreamPlatform
): { copy: string; url: string; linkLabel: string } | null {
  switch (platform) {
    case 'tiktok':
      return {
        copy: 'TikTok keys change every broadcast and need LIVE access on your account. Paste a fresh server URL and key each time from',
        url: 'https://livecenter.tiktok.com',
        linkLabel: 'TikTok LIVE Center'
      }
    case 'instagram':
      return {
        copy: 'Instagram keys come from Live Producer (professional accounts): start the stream here, then press "Go live" in',
        url: 'https://www.instagram.com/live/producer/',
        linkLabel: 'Live Producer'
      }
    case 'kick':
      return {
        copy: 'Kick keys live in Creator Dashboard → Settings → Stream Key. Copy the key from',
        url: 'https://dashboard.kick.com/channel/stream',
        linkLabel: 'kick.com'
      }
    default:
      return null
  }
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
      return { tone: 'live', label: 'On air' }
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

/**
 * The signed-in account's one status (plan 080 S6). It replaces a Connected
 * pill, a Validated badge and "Account access is valid." saying the same
 * thing three times. The provider's own words stay one hover away.
 */
export function accountStatus(
  account: PlatformAccount,
  validation: PlatformAccountValidation | undefined
): 'ok' | 'unchecked' | 'reconnect' {
  if (account.status !== 'connected' || validation?.state === 'needs-reconnect') {
    return 'reconnect'
  }
  return validation?.state === 'valid' || validation?.state === 'refreshed' ? 'ok' : 'unchecked'
}

function OAuthAccountPanel({
  account,
  credentials,
  disabled,
  platform,
  sharedAccountWith,
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
  sharedAccountWith?: string
  validation?: PlatformAccountValidation
  xNativeCapability: XNativeLiveCapability | null
  xNativeCapabilityLoading: boolean
  youtubeChannels: YouTubeChannel[]
  youtubeChannelsLoading: boolean
  onConnect: (platform: StreamPlatform, options?: PlatformConnectOptions) => void
  onDisconnect: (platform: StreamPlatform) => void
  onRefreshYouTubeChannels: (accountId?: string) => Promise<void>
  onRefreshXNativeCapability: (accountId?: string) => Promise<void>
  onAuthorizeXLive: () => Promise<void>
  onSelectYouTubeChannel: (channelId: string, accountId?: string) => Promise<void>
  onUseManualRtmp: () => void
}): ReactElement {
  const [youtubeConsentOpen, setYoutubeConsentOpen] = useState(false)
  const [youtubeConsentAccepted, setYoutubeConsentAccepted] = useState(false)
  const platformName = metadataPlatformLabel(platform)
  // A first Twitch connection asks for the follow and sub permissions too
  // (plan 071, S2), so Activity names followers from the first stream.
  const connect = (): void =>
    onConnect(
      platform,
      platform === 'twitch' ? { optionalScopes: TWITCH_AUDIENCE_SCOPES } : undefined
    )

  if (!account) {
    const connectDisabled = disabled || credentials?.ready === false
    return (
      <>
        <div className="flex flex-col gap-2" data-slot="destination-sign-in">
          <p className="text-xs text-muted-foreground">
            Videorc sets your title and gets the stream key for you.
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              className="w-fit"
              disabled={connectDisabled}
              size="sm"
              onClick={() => {
                if (platform === 'youtube') {
                  setYoutubeConsentAccepted(false)
                  setYoutubeConsentOpen(true)
                } else {
                  connect()
                }
              }}
            >
              <LinkIcon data-icon="inline-start" weight="bold" />
              Connect {platformName}
            </Button>
            {/* Developer builds only: say when an env var overrides the
                bundled OAuth client, which production users never see. */}
            {import.meta.env.DEV && credentials?.clientIdSource === 'environment' ? (
              <Badge variant="outline">Environment override</Badge>
            ) : null}
          </div>
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

  const status = accountStatus(account, validation)
  const shared = Boolean(sharedAccountWith)
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
    <div className="flex flex-col gap-3" data-slot="destination-account">
      {/* One account row: who, one status, and the rare actions at its end. */}
      <div className="flex items-center gap-2.5">
        {/* The platform account's own avatar (stored at connect time and
            resolved through main's allowlisted cache); initials fallback. */}
        <AvatarCircle avatarUrl={account.avatarUrl} name={account.accountLabel} />
        <div className="flex min-w-0 flex-1 flex-col">
          <span className="flex min-w-0 items-center gap-2">
            <span className="truncate text-sm font-medium">{account.accountLabel}</span>
            {status === 'ok' ? (
              <span
                aria-label="Connected"
                className="flex shrink-0"
                role="img"
                title={validation?.message}
              >
                <StatusDot tone="good" />
              </span>
            ) : null}
          </span>
          <span className="truncate text-xs text-muted-foreground">
            {account.accountHandle ?? account.accountId}
          </span>
        </div>
        {status === 'reconnect' ? (
          <span className="flex shrink-0" title={validation?.message}>
            <StatusBadge tone="warn" value="Needs reconnect" />
          </span>
        ) : null}
        {status === 'reconnect' ? (
          <Button disabled={disabled} size="sm" variant="outline" onClick={connect}>
            Reconnect
          </Button>
        ) : null}
        {shared ? null : (
          <Button
            disabled={disabled}
            size="sm"
            variant="ghost"
            onClick={() => onDisconnect(platform)}
          >
            <SignOutIcon data-icon="inline-start" weight="bold" />
            Disconnect
          </Button>
        )}
      </div>

      {status === 'reconnect' ? (
        <p className="text-xs text-muted-foreground">
          Videorc lost access to this account. Reconnect to keep streaming here.
        </p>
      ) : null}

      {platform === 'twitch' &&
      !TWITCH_AUDIENCE_SCOPES.every((scope) => account.scopes.includes(scope)) ? (
        <div className="flex items-center justify-between gap-3">
          <span className="text-xs text-muted-foreground">
            Follow alerts and sub count need one more Twitch permission.
          </span>
          <Button
            disabled={disabled}
            size="sm"
            variant="outline"
            onClick={() => onConnect('twitch', { optionalScopes: TWITCH_AUDIENCE_SCOPES })}
          >
            Reconnect Twitch
          </Button>
        </div>
      ) : null}

      {shared ? (
        <p className="text-xs text-muted-foreground">
          Same account and channel as {sharedAccountWith}.
        </p>
      ) : platform === 'youtube' ? (
        <Field>
          <FieldLabel>Channel</FieldLabel>
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
                  placeholder={
                    youtubeChannelsLoading
                      ? 'Loading channels…'
                      : youtubeChannelOptions.length === 0
                        ? 'Refresh to load your channels'
                        : 'Select channel'
                  }
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
              aria-label="Refresh channels"
              disabled={disabled || youtubeChannelsLoading}
              size="icon-sm"
              title="Refresh channels"
              variant="outline"
              onClick={() => void onRefreshYouTubeChannels(account.accountId)}
            >
              <SyncIcon className={cn(youtubeChannelsLoading && 'animate-spin')} weight="bold" />
            </Button>
          </div>
        </Field>
      ) : null}

      {platform === 'x' ? (
        <div className="flex flex-col gap-2" data-slot="destination-x-live">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <Badge
              className="w-fit"
              variant={xNativeCapability?.nativeAvailable ? 'success' : 'warning'}
            >
              {xNativeCapability?.nativeAvailable
                ? 'X Live ready'
                : xNativeCapability?.state === 'needs-authorization'
                  ? 'Authorization needed'
                  : xNativeCapability?.state === 'missing-credentials'
                    ? 'Credentials needed'
                    : xNativeCapability?.state === 'account-mismatch'
                      ? 'Account mismatch'
                      : 'Not checked yet'}
            </Badge>
            <Button
              disabled={disabled || xNativeCapabilityLoading}
              size="sm"
              variant="ghost"
              onClick={() => void onRefreshXNativeCapability(account.accountId)}
            >
              <SyncIcon data-icon="inline-start" weight="bold" />
              {xNativeCapabilityLoading ? 'Checking' : 'Check again'}
            </Button>
          </div>
          {xNativeCapability?.message && !xNativeCapability.nativeAvailable ? (
            <span className="text-xs text-muted-foreground">{xNativeCapability.message}</span>
          ) : null}
          {xNativeCapability && !xNativeCapability.nativeAvailable ? (
            <div className="flex flex-wrap items-center gap-2">
              {xNativeCapability.state === 'needs-authorization' ||
              xNativeCapability.state === 'account-mismatch' ? (
                <Button
                  disabled={disabled}
                  size="sm"
                  title="Opens x.com to approve live broadcasting for this account."
                  onClick={() => void onAuthorizeXLive()}
                >
                  Authorize X Live
                </Button>
              ) : null}
              <Button disabled={disabled} size="sm" variant="outline" onClick={onUseManualRtmp}>
                Use a stream key instead
              </Button>
            </div>
          ) : null}
          {xNativeCapability ? (
            <div className="flex flex-wrap gap-3 text-xs">
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
        </div>
      ) : null}
    </div>
  )
}
