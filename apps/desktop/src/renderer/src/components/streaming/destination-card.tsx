import { StreamQualityControl } from './stream-quality-control'
import { streamQualityOverride } from '@/lib/output-quality'
import {
  ChevronDownIcon,
  CopyIcon,
  ExternalLinkIcon,
  LinkIcon,
  ResetIcon,
  SignOutIcon,
  SyncIcon
} from '@/components/icons'
import { useEffect, useState, type ReactElement, type ReactNode } from 'react'

import { ConfirmDialog } from '@/components/confirm-dialog'
import { ListRow, ListRowButton } from '@/components/list-row'
import {
  YOUTUBE_STREAM_KEY_LINK_LABEL,
  YOUTUBE_STREAM_KEY_URL,
  youtubeDestinationPausedMessage
} from '@/lib/youtube-quota-copy'
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
import { Field, FieldDescription, FieldError, FieldLabel } from '@/components/ui/field'
import { InfoTooltip } from '@/components/ui/info-tooltip'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { Spinner } from '@/components/ui/spinner'
import { Switch } from '@/components/ui/switch'
import { SegmentedControl, type SegmentedControlOption } from '@/components/ui/segmented-control'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
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
import { oauthUnavailableReason, streamServerUrlIssue, videoPresets } from '@/lib/capture'
import { useCopyText } from '@/lib/copy-text'
import { destinationSetup } from '@/lib/destination-readiness'
import { formatBitrate, formatVideoQuality } from '@/lib/format-video'
import { destinationLabel } from '@/lib/platform-copy'
import { destinationStateLabel } from '@/lib/state-labels'
import type { EntitlementUiGate } from '@/lib/entitlement-ui'
import { streamKeyPlatformMismatch, streamKeyTailHint } from '@/lib/stream-key-format'
import { metadataPlatformLabel } from '@/lib/stream-metadata-summary'
import { cn } from '@/lib/utils'
import { VIDEORC_WEB_LINKS } from '@/lib/videorc-web-links'
import {
  isScopeReconnectPlatform,
  permissionReconnectOptions,
  platformConnectOptions,
  removeMessagesReadiness,
  removeMessagesReconnectCopy,
  TWITCH_AUDIENCE_SCOPES,
  TWITCH_BITS_POINTS_SCOPES
} from '../../../../shared/platform-scopes'

// One destination (plan 080 S5/S6). The owner's brief: "make it good and
// readable for someone connecting through OAuth or through RTMP". The row
// says only what needs the streamer (quiet when fine, specific when not); the
// open card holds the connection and nothing a streamer cannot act on (no
// OAuth scopes, no credential sources, no raw validation strings inline).

type BadgeTone = 'success' | 'warning' | 'destructive' | 'live' | 'outline'

const URL_MODE_OPTIONS: SegmentedControlOption<StreamUrlMode>[] = [
  { value: 'server-and-key', label: 'Server + key' },
  { value: 'full-url', label: 'Full URL' }
]

const AUTH_MODE_OPTIONS: SegmentedControlOption<StreamAuthMode>[] = [
  { value: 'oauth', label: 'Sign in' },
  { value: 'manual-rtmp', label: 'Stream key' }
]

const RUNTIME_BADGE_TONES: Record<StreamTargetRuntime['state'], BadgeTone> = {
  live: 'live',
  connecting: 'warning',
  reconnecting: 'warning',
  warning: 'warning',
  failed: 'destructive',
  'not-configured': 'warning',
  ready: 'outline',
  stopped: 'outline'
}

/** The running destination's badge: the one destination vocabulary (plan 174 J2-4). */
function runtimeBadge(runtime: StreamTargetRuntime): { tone: BadgeTone; label: string } {
  return {
    tone: RUNTIME_BADGE_TONES[runtime.state] ?? 'outline',
    label: destinationStateLabel(runtime.state)
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

/**
 * The quality a destination streams at when it overrides the default (plan
 * 174 S3.5a, D-17): the row's tag names it on every row that has one, and
 * says nothing when the destination uses the default.
 */
export function destinationQualityTag(
  target: Pick<StreamTargetSettings, 'outputPreset' | 'outputBitrateKbps'>
): string | null {
  const preset = target.outputPreset ? videoPresets[target.outputPreset] : undefined
  if (preset) return formatVideoQuality(preset)
  if (target.outputBitrateKbps) return formatBitrate(target.outputBitrateKbps) || null
  return null
}

export function DestinationCard({
  target,
  account,
  credentials,
  disabled,
  defaultExpanded = false,
  enableGate,
  enableLockDescriptionId,
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
  /**
   * Opens on mount. The page passes it to the first destination that needs
   * setup only, so one form is open, not every incomplete one (D-14).
   */
  defaultExpanded?: boolean
  enableGate: EntitlementUiGate
  /** The page's one cap notice, which says why the switch is off (D-14). */
  enableLockDescriptionId?: string
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
  /**
   * Starts a sign-in. A promise of the sign-in link turns on the waiting
   * state with Copy link (D-16); null means it never reached the browser.
   */
  onConnect: (
    platform: StreamPlatform,
    options?: PlatformConnectOptions
  ) => void | Promise<string | null | void>
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
  // switch is always rendered and the page's one cap notice says why it is
  // off (plan 174 S3.5a, D-14), instead of a strip under every row.
  const enableLockGate = !disabled && !target.enabled && !enableGate.allowed ? enableGate : null
  const enableSwitchDisabled = disabled || Boolean(enableLockGate)
  const [manualStreamKeyDraft, setManualStreamKeyDraft] = useState(target.streamKey)
  const [fullUrlDraft, setFullUrlDraft] = useState(target.serverUrl)
  // Server URL rules (D-19): a saved bad URL says so at once; a typed one
  // after the field is left, so typing never starts with an error.
  const [serverUrlChecked, setServerUrlChecked] = useState(() =>
    Boolean(streamServerUrlIssue(target.serverUrl))
  )
  const [fullUrlIssue, setFullUrlIssue] = useState<string | null>(null)
  const serverUrlIssue = fullUrl
    ? fullUrlIssue
    : serverUrlChecked
      ? streamServerUrlIssue(target.serverUrl)
      : null
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
  // The row's inline context (V-2): the vertical twin says 9:16 in words
  // beside how it connects, so no tag pushes the controls out of line.
  const rowContext =
    [
      target.outputOrientation === 'vertical' ? '9:16' : null,
      oauthMode ? account?.accountLabel : 'Stream key'
    ]
      .filter(Boolean)
      .join(' · ') || undefined
  const qualityTag = destinationQualityTag(target)

  // Row + detail (ux-ia plan, slice 7): the row shows identity and state; the
  // expandable detail holds ONLY the connection. The page opens the first
  // destination that needs setup, so first-run setup is zero extra clicks.
  const [uncontrolledExpanded, setUncontrolledExpanded] = useState(defaultExpanded)
  const expanded = controlledExpanded ?? uncontrolledExpanded
  const setExpanded = (next: boolean): void => {
    setUncontrolledExpanded(next)
    onExpandedChange?.(next)
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
    if (mode === 'full-url') {
      const issue = streamServerUrlIssue(trimmed, true)
      setFullUrlIssue(issue)
      if (issue) return
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
      {/* The reference row anatomy: vivid platform tile · title · inline
          context · spring · state and quality tags · the controls in a fixed
          trailing column, so every row's switch lines up (plan 174 S3.5a,
          V-2). The title is the row's button, stretched over the row: a
          click anywhere, or Enter/Space on it, toggles the connection. The
          switch is its sibling, never inside a button (S0.5, D-12). */}
      <ListRow
        className="relative"
        context={rowContext}
        interactive
        icon={<PlatformGlyph platform={target.platform} />}
        title={
          <ListRowButton aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>
            {destinationLabel(target.label)}
          </ListRowButton>
        }
      >
        {badge ? <Badge variant={badge.tone}>{badge.label}</Badge> : null}
        {qualityTag ? (
          <Badge data-testid="destination-quality" variant="outline">
            <span className="sr-only">Stream quality: </span>
            {qualityTag}
          </Badge>
        ) : null}
        <span
          className="relative flex shrink-0 items-center gap-2"
          data-slot="destination-controls"
        >
          <Switch
            aria-describedby={enableLockGate ? enableLockDescriptionId : undefined}
            aria-label={`Enable ${destinationLabel(target.label)}`}
            checked={target.enabled}
            disabled={enableSwitchDisabled}
            onCheckedChange={patchEnabled}
          />
          <ChevronDownIcon
            className={cn(
              'size-3.5 shrink-0 text-muted-foreground transition-transform',
              expanded && 'rotate-180'
            )}
          />
        </span>
      </ListRow>
      {/* Status and the expanded connection sit under the row; the block
          collapses when it has nothing to say. */}
      <div className="flex flex-col gap-3 px-3 pb-3 empty:hidden">
        {statusMessage ? (
          <span className="text-xs text-muted-foreground">{statusMessage}</span>
        ) : null}

        {!expanded ? null : (
          <>
            <StreamQualityControl
              value={target.outputPreset ?? 'default'}
              disabled={disabled}
              youtube={target.platform === 'youtube'}
              inherit
              onChange={(preset) => onPatch(target.id, streamQualityOverride(preset))}
            />
            {target.platform === 'custom' ? (
              <Field>
                <FieldLabel>URL mode</FieldLabel>
                <SegmentedControl
                  className="w-full"
                  disabled={disabled}
                  options={URL_MODE_OPTIONS}
                  value={target.urlMode ?? 'server-and-key'}
                  onValueChange={(urlMode) => onPatch(target.id, { urlMode })}
                />
              </Field>
            ) : null}

            {nativeDestination && !oauthUnavailableMessage ? (
              <Field>
                <FieldLabel>Connect with</FieldLabel>
                <SegmentedControl
                  className="w-full"
                  disabled={disabled}
                  options={AUTH_MODE_OPTIONS}
                  value={target.authMode}
                  onValueChange={(authMode) => onPatch(target.id, { authMode })}
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
              <p className="text-xs text-muted-foreground" data-slot="destination-key-guidance">
                {guidance.copy}
                {guidance.link ? (
                  <>
                    {' '}
                    <ExternalLinkButton url={guidance.link.url}>
                      {guidance.link.label}
                    </ExternalLinkButton>
                  </>
                ) : null}
              </p>
            ) : null}

            {youtubePaused ? (
              <Alert data-testid="youtube-quota-paused" variant="warning">
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
                    <ExternalLinkButton url={YOUTUBE_STREAM_KEY_URL}>
                      {YOUTUBE_STREAM_KEY_LINK_LABEL}
                    </ExternalLinkButton>
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
                <Field data-invalid={serverUrlIssue ? true : undefined}>
                  <FieldLabel htmlFor={`${target.id}-server`}>
                    {fullUrl ? 'Full RTMP URL' : 'Server URL'}
                  </FieldLabel>
                  <div className="flex gap-2">
                    <Input
                      aria-invalid={serverUrlIssue ? true : undefined}
                      disabled={disabled}
                      id={`${target.id}-server`}
                      placeholder={
                        fullUrl
                          ? target.streamKeyPresent
                            ? 'Paste a new URL to replace it'
                            : 'rtmp://server/app/key'
                          : 'rtmp://server/app'
                      }
                      type={fullUrl ? 'password' : 'text'}
                      value={fullUrl ? fullUrlDraft : target.serverUrl}
                      onBlur={() => {
                        if (!fullUrl) setServerUrlChecked(true)
                      }}
                      onChange={(event) => {
                        if (fullUrl) {
                          setFullUrlDraft(event.target.value)
                          setFullUrlIssue(null)
                        } else {
                          onPatch(target.id, { serverUrl: event.target.value })
                        }
                      }}
                      onKeyDown={(event) => {
                        if (fullUrl && event.key === 'Enter') {
                          requestManualKeySave(fullUrlDraft, 'full-url')
                        }
                      }}
                    />
                    {fullUrl && fullUrlDraft.trim() ? (
                      <Button
                        disabled={disabled}
                        size="sm"
                        onClick={() => requestManualKeySave(fullUrlDraft, 'full-url')}
                      >
                        Save URL
                      </Button>
                    ) : null}
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
                  {serverUrlIssue ? <FieldError>{serverUrlIssue}</FieldError> : null}
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
                    {/* An explicit Save key (D-39): leaving the field never
                        saves, so no confirmation pops up on a stray click. */}
                    <div className="flex gap-2">
                      <Input
                        autoComplete="off"
                        disabled={disabled}
                        id={`${target.id}-key`}
                        placeholder={
                          target.streamKeyPresent
                            ? 'Paste a new key to replace it'
                            : 'Paste your stream key'
                        }
                        type="password"
                        value={manualStreamKeyDraft}
                        onChange={(event) => setManualStreamKeyDraft(event.target.value)}
                        onKeyDown={(event) => {
                          if (event.key === 'Enter') {
                            requestManualKeySave(manualStreamKeyDraft, 'key')
                          }
                        }}
                      />
                      {manualStreamKeyDraft.trim() ? (
                        <Button
                          disabled={disabled}
                          size="sm"
                          onClick={() => requestManualKeySave(manualStreamKeyDraft, 'key')}
                        >
                          Save key
                        </Button>
                      ) : null}
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
              </>
            )}

            <ConfirmDialog
              confirmLabel={
                target.streamKeyPresent ? `Replace ${credentialLabel}` : `Save ${credentialLabel}`
              }
              confirmVariant={pendingKeySave?.warning ? 'destructive' : 'default'}
              description={
                target.streamKeyPresent
                  ? `The saved ${credentialLabel}${
                      target.streamKeyHint ? ` ending ${target.streamKeyHint}` : ''
                    } will be replaced by the new one ending ${streamKeyTailHint(
                      pendingKeySave?.value ?? ''
                    )}. The old one is kept as your previous ${credentialLabel}, so you can restore it.`
                  : `The key ending ${streamKeyTailHint(pendingKeySave?.value ?? '')} will be saved to ${destinationLabel(target.label)}.`
              }
              open={pendingKeySave !== null}
              testId="stream-key-save"
              title={
                target.streamKeyPresent
                  ? `Replace the ${destinationLabel(target.label)} ${credentialLabel}?`
                  : `Save this ${credentialLabel} to ${destinationLabel(target.label)}?`
              }
              onCancel={() => setPendingKeySave(null)}
              onConfirm={confirmPendingKeySave}
            >
              {pendingKeySave?.warning ? (
                <Alert variant="warning">
                  <AlertDescription>{pendingKeySave.warning}</AlertDescription>
                </Alert>
              ) : null}
            </ConfirmDialog>

            <ConfirmDialog
              confirmLabel={`Remove ${credentialLabel}`}
              description={`The saved ${credentialLabel}${
                target.streamKeyHint ? ` ending ${target.streamKeyHint}` : ''
              } is kept as your previous ${credentialLabel} after removal, so you can restore it.`}
              open={confirmingClear}
              testId="stream-key-remove"
              title={`Remove the ${destinationLabel(target.label)} ${credentialLabel}?`}
              onCancel={() => setConfirmingClear(false)}
              onConfirm={confirmClearKey}
            />
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

/**
 * An external page, opened in the browser (plan 174 S3.5a, D-20): one look
 * for every link on the card, a link button with the external mark.
 */
function ExternalLinkButton({ url, children }: { url: string; children: ReactNode }): ReactElement {
  return (
    <Button
      className="h-auto gap-1 p-0 text-xs"
      size="xs"
      variant="link"
      onClick={() => openExternalUrl(url)}
    >
      {children}
      <ExternalLinkIcon aria-hidden />
    </Button>
  )
}

/**
 * Where to find the stream key, for every platform that takes one (plan 174
 * S3.5a, D-20). Some platforms rotate their key per broadcast and gate live
 * access on their side, so the card links to the source of truth instead of
 * promising automation Videorc can't deliver (no public ingest APIs).
 */
export function manualKeyGuidance(platform: StreamPlatform): {
  copy: string
  link?: { url: string; label: string }
} {
  switch (platform) {
    case 'youtube':
      return {
        copy: 'Copy the stream key from YouTube Studio: Go live, then Stream.',
        link: { url: YOUTUBE_STREAM_KEY_URL, label: 'YouTube Studio' }
      }
    case 'twitch':
      return {
        copy: 'Copy the primary stream key from your Twitch dashboard: Settings, then Stream.',
        link: { url: 'https://dashboard.twitch.tv/settings/stream', label: 'Twitch dashboard' }
      }
    case 'kick':
      return {
        copy: 'Kick keys live in Creator Dashboard → Settings → Stream Key.',
        link: { url: 'https://dashboard.kick.com/channel/stream', label: 'Kick dashboard' }
      }
    case 'x':
      return {
        copy: 'Copy the server URL and key from an RTMP source in X Media Studio Producer.',
        link: { url: 'https://studio.x.com', label: 'Media Studio' }
      }
    case 'tiktok':
      return {
        copy: 'TikTok keys change every broadcast and need LIVE access on your account. Paste a fresh server URL and key each time.',
        link: { url: 'https://livecenter.tiktok.com', label: 'TikTok LIVE Center' }
      }
    case 'instagram':
      return {
        copy: 'Instagram keys come from Live Producer (professional accounts). Start the stream here, then press "Go live" there.',
        link: { url: 'https://www.instagram.com/live/producer/', label: 'Live Producer' }
      }
    default:
      return { copy: 'Your streaming server gives you its server URL and stream key.' }
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
    case 'failed':
    case 'stopped':
      return { tone: RUNTIME_BADGE_TONES[state], label: destinationStateLabel(state) }
    case 'warning':
      return { tone: 'warning', label: 'Review' }
    default:
      return { tone: 'outline', label: 'Idle' }
  }
}

/**
 * A sign-in waiting in the browser (plan 174 S3.5a, D-16): what Videorc is
 * waiting for, the link to open in another browser, and a way back to
 * Connect. The browser approves or refuses; Videorc only stops waiting.
 */
function SignInPending({
  platformName,
  url,
  onCancel
}: {
  platformName: string
  url: string | null
  onCancel: () => void
}): ReactElement {
  const { copied, copy } = useCopyText()
  return (
    <div className="flex flex-col gap-1.5" data-slot="destination-sign-in-pending">
      <div className="flex flex-wrap items-center gap-2">
        <span className="flex items-center gap-2 text-sm" role="status">
          <Spinner aria-hidden className="size-3.5 text-muted-foreground" />
          Waiting for your browser…
        </span>
        {url ? (
          <Button
            size="xs"
            variant="outline"
            onClick={() =>
              void copy(url, {
                title: "Couldn't copy the link",
                description: 'The page is already open in your default browser.'
              })
            }
          >
            <CopyIcon data-icon="inline-start" />
            {copied ? 'Copied' : 'Copy link'}
          </Button>
        ) : null}
        <Button size="xs" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        {`Signed in to ${platformName} in another browser? Copy the link and open it there.`}
      </p>
    </div>
  )
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

/**
 * The signed-in account's one permission row (plan 140, S5): what a reconnect
 * would add, or null when nothing is missing. One row and one button, since
 * its reconnect asks for all of a platform's optional permissions. Removing
 * messages leads; Twitch's Activity permissions (follow alerts, the sub count,
 * Power-ups and channel points, plan 162) ride along when they are missing.
 */
export function missingPermissionsRow(
  platform: StreamPlatform,
  account: Pick<PlatformAccount, 'scopes' | 'status'>
): { message: string; action: string } | null {
  const lacks = (scopes: readonly string[]): boolean =>
    platform === 'twitch' && !scopes.every((scope) => account.scopes.includes(scope))
  const audienceMissing = lacks(TWITCH_AUDIENCE_SCOPES)
  const bitsPointsMissing = lacks(TWITCH_BITS_POINTS_SCOPES)
  const activityMissing = audienceMissing || bitsPointsMissing
  if (
    isScopeReconnectPlatform(platform) &&
    removeMessagesReadiness(platform, account) === 'missing-scope'
  ) {
    const removeMessages = removeMessagesReconnectCopy(platform)
    const alongside =
      audienceMissing && bitsPointsMissing
        ? 'Follow alerts, the sub count, Power-ups and channel points'
        : audienceMissing
          ? 'Follow alerts and the sub count'
          : 'Power-ups and channel points'
    return {
      message: activityMissing ? `${removeMessages} ${alongside} need it too.` : removeMessages,
      action: 'Reconnect'
    }
  }
  if (activityMissing) {
    const what =
      audienceMissing && bitsPointsMissing
        ? 'Follow alerts, sub count, Power-ups and channel points'
        : audienceMissing
          ? 'Follow alerts and sub count'
          : 'Power-ups and channel points'
    return {
      message: `${what} need one more Twitch permission.`,
      action: 'Reconnect Twitch'
    }
  }
  return null
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
  onConnect: (
    platform: StreamPlatform,
    options?: PlatformConnectOptions
  ) => void | Promise<string | null | void>
  onDisconnect: (platform: StreamPlatform) => void
  onRefreshYouTubeChannels: (accountId?: string) => Promise<void>
  onRefreshXNativeCapability: (accountId?: string) => Promise<void>
  onAuthorizeXLive: () => Promise<void>
  onSelectYouTubeChannel: (channelId: string, accountId?: string) => Promise<void>
  onUseManualRtmp: () => void
}): ReactElement {
  const [youtubeConsentOpen, setYoutubeConsentOpen] = useState(false)
  const [youtubeConsentAccepted, setYoutubeConsentAccepted] = useState(false)
  // Plan 174 S0.3 (D-16): Disconnect signs the account out at once (YouTube
  // and YouTube Vertical share one), so it asks first.
  const [disconnectOpen, setDisconnectOpen] = useState(false)
  const platformName = metadataPlatformLabel(platform)
  // Connect and Reconnect ask for the platform's ordinary optional
  // permissions (plan 071 S2, plan 140 S5): all of Twitch's, so Activity names
  // followers and Buddy can remove messages from the first stream. The
  // permission row asks for every optional permission, which is the only
  // place Kick's moderation permission is requested.
  // The sign-in waits in the browser (plan 174 S3.5a, D-16): the card says
  // so, with the link to copy into another browser, until the account comes
  // back changed. The wait belongs to the account as it was at the click, so
  // a connect or reconnect that lands ends it without an effect.
  const accountVersion = account
    ? `${account.status}|${account.updatedAt}|${account.scopes.join(' ')}`
    : 'none'
  const [signIn, setSignIn] = useState<{ url: string | null; from: string } | null>(null)
  const waiting = signIn && signIn.from === accountVersion ? signIn : null
  const startSignIn = (options?: PlatformConnectOptions): void => {
    const from = accountVersion
    setSignIn({ url: null, from })
    void Promise.resolve(onConnect(platform, options)).then((url) => {
      if (url === null) {
        setSignIn(null)
      } else if (typeof url === 'string') {
        setSignIn((current) => (current?.from === from ? { url, from } : current))
      }
    })
  }
  const connect = (): void => startSignIn(platformConnectOptions(platform))
  const reconnectForPermissions = (): void => startSignIn(permissionReconnectOptions(platform))
  const pending = waiting ? (
    <SignInPending platformName={platformName} url={waiting.url} onCancel={() => setSignIn(null)} />
  ) : null

  if (!account) {
    const connectDisabled = disabled || credentials?.ready === false
    return (
      <>
        <div className="flex flex-col gap-2" data-slot="destination-sign-in">
          <p className="text-xs text-muted-foreground">
            Videorc sets your title and gets the stream key for you.
          </p>
          {pending ?? (
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
          )}
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
                <div className="flex flex-wrap gap-x-4 gap-y-1">
                  <ExternalLinkButton url={VIDEORC_WEB_LINKS.privacy}>
                    Privacy Policy
                  </ExternalLinkButton>
                  <ExternalLinkButton url={VIDEORC_WEB_LINKS.terms}>
                    Videorc Terms
                  </ExternalLinkButton>
                  <ExternalLinkButton url="https://www.youtube.com/t/terms">
                    YouTube Terms
                  </ExternalLinkButton>
                  <ExternalLinkButton url="https://policies.google.com/privacy">
                    Google Privacy
                  </ExternalLinkButton>
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
                    startSignIn()
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
  // A lost account shows Reconnect first; the backend keeps the permissions it
  // already held, and this row returns afterwards if one is still missing.
  const permissions = status === 'reconnect' ? null : missingPermissionsRow(platform, account)
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
              // The last account check, on hover and on focus (S1.10).
              <InfoTooltip className="shrink-0" content={validation?.message}>
                <span aria-label="Connected" className="flex shrink-0" role="img">
                  <StatusDot tone="good" />
                </span>
              </InfoTooltip>
            ) : null}
          </span>
          <span className="truncate text-xs text-muted-foreground">
            {account.accountHandle ?? account.accountId}
          </span>
        </div>
        {status === 'reconnect' ? (
          <InfoTooltip className="shrink-0" content={validation?.message}>
            <span className="flex shrink-0">
              <StatusBadge tone="warn" value="Needs reconnect" />
            </span>
          </InfoTooltip>
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
            onClick={() => setDisconnectOpen(true)}
          >
            <SignOutIcon data-icon="inline-start" weight="bold" />
            Disconnect
          </Button>
        )}
      </div>
      {pending}
      <ConfirmDialog
        confirmLabel={`Disconnect ${platformName}`}
        description={
          platform === 'youtube'
            ? 'Videorc signs out of YouTube and YouTube Vertical. To stream there again, connect the account again.'
            : `Videorc signs out of ${platformName}. To stream there again, connect the account again.`
        }
        open={disconnectOpen}
        testId="account-disconnect"
        title={`Disconnect ${platformName}?`}
        onCancel={() => setDisconnectOpen(false)}
        onConfirm={() => {
          setDisconnectOpen(false)
          onDisconnect(platform)
        }}
      />

      {status === 'reconnect' ? (
        <p className="text-xs text-muted-foreground">
          Videorc lost access to this account. Reconnect to keep streaming here.
        </p>
      ) : null}

      {permissions ? (
        <div
          className="flex items-center justify-between gap-3"
          data-slot="destination-permissions"
        >
          <span className="text-xs text-muted-foreground">{permissions.message}</span>
          <Button
            className="shrink-0"
            disabled={disabled}
            size="sm"
            variant="outline"
            onClick={reconnectForPermissions}
          >
            {permissions.action}
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
                        : 'Choose a channel'
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
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  aria-label="Refresh channels"
                  disabled={disabled || youtubeChannelsLoading}
                  size="icon-sm"
                  variant="outline"
                  onClick={() => void onRefreshYouTubeChannels(account.accountId)}
                >
                  <SyncIcon
                    className={cn(youtubeChannelsLoading && 'animate-spin')}
                    weight="bold"
                  />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Refresh channels</TooltipContent>
            </Tooltip>
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
              {xNativeCapabilityLoading ? 'Checking…' : 'Check again'}
            </Button>
          </div>
          {xNativeCapability?.message && !xNativeCapability.nativeAvailable ? (
            <span className="text-xs text-muted-foreground">{xNativeCapability.message}</span>
          ) : null}
          {xNativeCapability && !xNativeCapability.nativeAvailable ? (
            <div className="flex flex-wrap items-center gap-2">
              {xNativeCapability.state === 'needs-authorization' ||
              xNativeCapability.state === 'account-mismatch' ? (
                <InfoTooltip
                  content="Opens x.com to approve live broadcasting for this account."
                  focusable={false}
                >
                  <Button disabled={disabled} size="sm" onClick={() => void onAuthorizeXLive()}>
                    Authorize X Live
                  </Button>
                </InfoTooltip>
              ) : null}
              <Button disabled={disabled} size="sm" variant="outline" onClick={onUseManualRtmp}>
                Use a stream key instead
              </Button>
            </div>
          ) : null}
          {xNativeCapability ? (
            <div className="flex flex-wrap gap-3">
              <ExternalLinkButton url={xNativeCapability.docsUrl}>
                X Producer docs
              </ExternalLinkButton>
              <ExternalLinkButton url={xNativeCapability.apiOverviewUrl}>
                X API overview
              </ExternalLinkButton>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}
