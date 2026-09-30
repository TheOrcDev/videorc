import {
  AlertIcon,
  ChevronDownIcon,
  LinkIcon,
  ResetIcon,
  SignOutIcon,
  SyncIcon,
  WarningIcon
} from '@/components/icons'
import { useEffect, useState, type ReactElement } from 'react'

import { ListRow } from '@/components/list-row'
import { PlatformGlyph } from '@/components/platform-glyph'
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
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
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
import { isStreamTargetReady, oauthUnavailableReason } from '@/lib/capture'
import type { EntitlementUiGate } from '@/lib/entitlement-ui'
import { streamKeyPlatformMismatch, streamKeyTailHint } from '@/lib/stream-key-format'
import { cn } from '@/lib/utils'
import { VIDEORC_WEB_LINKS } from '@/lib/videorc-web-links'
import { TWITCH_AUDIENCE_SCOPES } from '../../../../shared/platform-scopes'

// One destination (plan 080 S5): moved out of streaming-tab.tsx, which had
// grown past 2,300 lines, so the card redesign has a home of its own.

type BadgeTone = 'success' | 'warning' | 'destructive' | 'live' | 'outline'

function configuredBadge(enabled: boolean, ready: boolean): { tone: BadgeTone; label: string } {
  if (!enabled) {
    return { tone: 'outline', label: 'Off' }
  }
  return ready ? { tone: 'success', label: 'Ready' } : { tone: 'warning', label: 'Needs setup' }
}

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

export function DestinationCard({
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
    <section className="flex flex-col" data-slot="destination-card">
      {/* The reference row anatomy: vivid platform tile · title · account
          context · spring · state meta · enable switch (videorc-design).
          Clicking the row toggles the auth/credentials detail. */}
      <ListRow
        className="h-auto min-h-10 py-1"
        icon={<PlatformGlyph platform={target.platform} />}
        title={target.label}
        context={account?.accountLabel ?? (oauthMode ? undefined : 'Manual RTMP')}
        meta={
          <span className="flex items-center gap-1.5">
            {target.outputOrientation === 'vertical' ? <Badge variant="outline">9:16</Badge> : null}
            <Badge variant={badge.tone}>{badge.label}</Badge>
          </span>
        }
        role="button"
        aria-expanded={expanded}
        onClick={() => setExpanded((value) => !value)}
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
      {/* Status, guidance, and the expanded auth detail sit under the row;
          the block collapses when it has nothing to say. */}
      <div className="flex flex-col gap-3 px-3 pb-3 empty:hidden">
        {statusMessage ? (
          <span className="text-xs text-muted-foreground">{statusMessage}</span>
        ) : null}
        {expanded && manualKeyGuidance(target.platform) ? (
          <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
            <span className="min-w-0">{manualKeyGuidance(target.platform)?.copy}</span>
            <Button
              className="h-auto px-0 text-xs"
              size="xs"
              variant="link"
              onClick={() => openExternalUrl(manualKeyGuidance(target.platform)?.url ?? '')}
            >
              {manualKeyGuidance(target.platform)?.linkLabel}
            </Button>
          </div>
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
                            ? `Key saved · ends ${target.streamKeyHint ?? '••••'}. Paste to replace`
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
                        : 'Saved securely per platform. Switching platforms never overwrites another key.'}
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
                    <ResetIcon />
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

            {target.platform === 'x' && !oauthMode ? (
              <p className="text-xs text-muted-foreground">
                X needs Media Studio Producer access; copy the RTMP URL and key from a Producer
                source.
              </p>
            ) : null}
          </>
        )}
      </div>
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
                  // A first Twitch connection asks for the follow and sub
                  // permissions too (plan 071, S2), so Activity names
                  // followers from the first stream.
                  onConnect(
                    platform,
                    platform === 'twitch' ? { optionalScopes: TWITCH_AUDIENCE_SCOPES } : undefined
                  )
                }
              }}
            >
              <LinkIcon data-icon="inline-start" weight="bold" />
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
        <div className="flex min-w-0 items-center gap-2.5">
          {/* The platform account's own avatar (stored at connect time and
              resolved through main's allowlisted cache); initials fallback. */}
          <AvatarCircle avatarUrl={account.avatarUrl} name={account.accountLabel} />
          <div className="flex min-w-0 flex-col gap-1">
            <span className="truncate text-sm font-medium">{account.accountLabel}</span>
            <span className="truncate text-xs text-muted-foreground">
              {account.accountHandle ?? account.accountId}
            </span>
          </div>
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
      {platform === 'twitch' &&
      !TWITCH_AUDIENCE_SCOPES.every((scope) => account.scopes.includes(scope)) ? (
        <div className="flex items-center justify-between gap-3 rounded-row bg-background/60 px-2 py-1.5">
          <span className="text-xs text-muted-foreground">
            Follow alerts and your sub count in the Stream Manager need one more Twitch permission.
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
              <SyncIcon data-icon="inline-start" weight="bold" />
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
              <SyncIcon data-icon="inline-start" weight="bold" />
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
        <SignOutIcon data-icon="inline-start" weight="bold" />
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
