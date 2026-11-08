import { useEffect, useRef, useState, type ReactElement } from 'react'

import {
  FirstRunNextButton,
  FirstRunStepLayout,
  useFirstRunStepFrame
} from '@/components/first-run/setup-step-frame'
import { GroupedList } from '@/components/list-row'
import { OfflineAlert } from '@/components/lock-alert'
import { PlatformGlyph } from '@/components/platform-glyph'
import { StatusBadge } from '@/components/status-badge'
import { SignInPending, YouTubeConsentDialog } from '@/components/streaming/destination-card'
import { Button } from '@/components/ui/button'
import { useStudioCore } from '@/hooks/use-studio'
import type {
  OAuthProviderCredentialStatus,
  PlatformAccount,
  PlatformConnectOptions,
  StreamPlatform,
  StreamTargetSettings,
  StreamingSettings
} from '@/lib/backend'
import { oauthUnavailableReason } from '@/lib/capture'
import { streamingDestinationEnableGate } from '@/lib/entitlement-ui'
import { metadataPlatformLabel } from '@/lib/stream-metadata-summary'
import { platformConnectOptions } from '../../../../shared/platform-scopes'

/** The four platforms setup signs in to, each with its built-in destination (plan 207 D10). */
const SETUP_DESTINATIONS = [
  { platform: 'youtube', targetId: 'youtube' },
  { platform: 'twitch', targetId: 'twitch' },
  { platform: 'kick', targetId: 'kick' },
  { platform: 'x', targetId: 'x' }
] as const satisfies ReadonlyArray<{ platform: StreamPlatform; targetId: string }>

export type SetupPlatform = (typeof SETUP_DESTINATIONS)[number]['platform']

/**
 * The destinations a sign-in started in setup has just connected, each with
 * its patch: Sign in, and on (D10). A destination already on stays on; one
 * the cap of 5 would refuse keeps its switch.
 */
export function setupDestinationsToTurnOn({
  started,
  accounts,
  streaming,
  entitlements
}: {
  started: ReadonlySet<SetupPlatform>
  accounts: readonly PlatformAccount[]
  streaming: StreamingSettings
  entitlements: Parameters<typeof streamingDestinationEnableGate>[0]['entitlements']
}): Array<{
  platform: SetupPlatform
  targetId: string
  accountId: string
  patch: Partial<StreamTargetSettings>
}> {
  const turnOn: ReturnType<typeof setupDestinationsToTurnOn> = []
  for (const { platform, targetId } of SETUP_DESTINATIONS) {
    if (!started.has(platform)) continue
    const account = accounts.find((candidate) => candidate.platform === platform)
    if (account?.status !== 'connected') continue
    const target = streaming.targets.find((candidate) => candidate.id === targetId)
    if (!target) continue
    const gate = streamingDestinationEnableGate({ entitlements, streaming, targetId })
    turnOn.push({
      platform,
      targetId,
      accountId: account.accountId,
      patch: { authMode: 'oauth', enabled: target.enabled || gate.allowed }
    })
  }
  return turnOn
}

type Connect = (
  platform: StreamPlatform,
  options?: PlatformConnectOptions
) => Promise<string | null | void>

/**
 * One platform: its mark, its name, connected or not, and the one button.
 * The wait for the browser is the Livestream page's own (`SignInPending`),
 * and belongs to the account as it was at the click, so a sign-in that lands
 * ends it.
 */
function DestinationSetupRow({
  platform,
  account,
  credentials,
  disabled,
  xLiveNeedsAuthorizing,
  onConnect,
  onAuthorizeXLive
}: {
  platform: SetupPlatform
  account: PlatformAccount | undefined
  credentials: OAuthProviderCredentialStatus | undefined
  disabled: boolean
  xLiveNeedsAuthorizing: boolean
  onConnect: Connect
  onAuthorizeXLive: () => void
}): ReactElement {
  const name = metadataPlatformLabel(platform)
  const [consentOpen, setConsentOpen] = useState(false)
  const [signIn, setSignIn] = useState<{ url: string | null; from: string } | null>(null)
  const accountVersion = account ? `${account.status}|${account.updatedAt}` : 'none'
  const waiting = signIn && signIn.from === accountVersion ? signIn : null
  const connected = account?.status === 'connected'
  const unavailable =
    oauthUnavailableReason(platform) !== null || credentials?.ready === false
      ? `Signing in to ${name} isn't available in this build.`
      : null

  const startSignIn = (options?: PlatformConnectOptions): void => {
    const from = accountVersion
    setSignIn({ url: null, from })
    void Promise.resolve(onConnect(platform, options)).then((url) => {
      if (url === null) setSignIn(null)
      else if (typeof url === 'string') {
        setSignIn((current) => (current?.from === from ? { url, from } : current))
      }
    })
  }

  const action = waiting ? null : !connected && !unavailable ? (
    <Button
      aria-label={`${name}: Sign in…`}
      disabled={disabled}
      variant="outline"
      onClick={() => {
        // YouTube's consent comes first, exactly as on the Livestream page.
        if (platform === 'youtube') setConsentOpen(true)
        else startSignIn(platformConnectOptions(platform))
      }}
    >
      Sign in…
    </Button>
  ) : connected && platform === 'x' && xLiveNeedsAuthorizing ? (
    <Button disabled={disabled} variant="outline" onClick={onAuthorizeXLive}>
      Authorize X Live…
    </Button>
  ) : null

  return (
    <div
      className="flex items-start gap-3 px-3 py-2.5"
      data-first-run-destination={platform}
      data-state={connected ? 'connected' : waiting ? 'waiting' : 'not-connected'}
    >
      <PlatformGlyph platform={platform} />
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-medium text-foreground">{name}</span>
          <span aria-live="polite" className="inline-flex">
            <StatusBadge
              tone={connected ? 'good' : 'neutral'}
              value={connected ? 'Connected' : 'Not connected'}
            />
          </span>
          {connected && account?.accountLabel ? (
            <span className="truncate text-meta text-muted-foreground">{account.accountLabel}</span>
          ) : null}
        </div>
        {unavailable ? <p className="text-meta text-muted-foreground">{unavailable}</p> : null}
        {waiting ? (
          <SignInPending platformName={name} url={waiting.url} onCancel={() => setSignIn(null)} />
        ) : null}
      </div>
      {action}
      {platform === 'youtube' ? (
        <YouTubeConsentDialog
          open={consentOpen}
          onContinue={() => startSignIn()}
          onOpenChange={setConsentOpen}
        />
      ) : null}
    </div>
  )
}

/**
 * Step 5, "Where you stream" (plan 207 S7, D10), only for Livestreams or
 * Both: sign in to YouTube, Twitch, Kick or X. A sign-in started here also
 * switches that destination to Sign in and turns it on (inside the cap), so
 * Go Live works after setup. Stream keys, TikTok, Instagram and Custom RTMP
 * open Livestream → Setup instead. A replay shows the accounts as they are
 * and turns nothing off.
 */
export function DestinationsStep(): ReactElement {
  const {
    captureConfig,
    entitlements,
    platformAccounts,
    oauthProviderCredentials,
    connectPlatformAccount,
    patchStreamingTarget,
    xNativeCapability,
    refreshXNativeCapability,
    authorizeXLive,
    wsStatus
  } = useStudioCore()
  const frame = useFirstRunStepFrame()
  const offline = wsStatus !== 'connected'
  const streaming = captureConfig.streaming
  const accountFor = (platform: StreamPlatform): PlatformAccount | undefined =>
    platformAccounts.find((account) => account.platform === platform)
  // Sign-ins started on this step: when their account lands, the destination
  // turns on. Nothing else here changes a destination.
  const started = useRef(new Set<SetupPlatform>())

  useEffect(() => {
    const turnOn = setupDestinationsToTurnOn({
      started: started.current,
      accounts: platformAccounts,
      streaming,
      entitlements
    })
    for (const { platform, targetId, accountId, patch } of turnOn) {
      started.current.delete(platform)
      patchStreamingTarget(targetId, patch)
      if (platform === 'x') void refreshXNativeCapability(accountId)
    }
  }, [entitlements, patchStreamingTarget, platformAccounts, refreshXNativeCapability, streaming])

  const connect: Connect = (platform, options) => {
    started.current.add(platform as SetupPlatform)
    // The row shows the browser step itself, so the toast stays quiet.
    return connectPlatformAccount(platform, options, { showsBrowserStep: true })
  }

  return (
    <FirstRunStepLayout
      description="Sign in, and Videorc sets your title and gets the stream key for you. Each one you connect is turned on for Go Live."
      primary={<FirstRunNextButton />}
    >
      <div className="flex flex-col gap-4">
        {offline ? <OfflineAlert /> : null}
        <GroupedList aria-label="Where you stream">
          {SETUP_DESTINATIONS.map(({ platform }) => (
            <DestinationSetupRow
              key={platform}
              account={accountFor(platform)}
              credentials={oauthProviderCredentials.find((status) => status.platform === platform)}
              disabled={offline || frame.leaving}
              platform={platform}
              xLiveNeedsAuthorizing={
                xNativeCapability !== null &&
                !xNativeCapability.nativeAvailable &&
                (xNativeCapability.state === 'needs-authorization' ||
                  xNativeCapability.state === 'account-mismatch')
              }
              onAuthorizeXLive={() => void authorizeXLive()}
              onConnect={connect}
            />
          ))}
        </GroupedList>
        <div className="flex items-center gap-3" data-first-run-stream-key="">
          <p className="min-w-0 flex-1 text-meta text-muted-foreground">
            Using a stream key, TikTok or Instagram? Set it up in Livestream.
          </p>
          <Button disabled={frame.leaving} variant="outline" onClick={() => frame.leaveTo('live')}>
            Open Livestream
          </Button>
        </div>
      </div>
    </FirstRunStepLayout>
  )
}
