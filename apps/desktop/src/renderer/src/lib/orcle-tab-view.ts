import type { CohostSettings, CohostState } from './backend'
import { COHOST_ERROR_TOAST_MESSAGES, cohostErrorDetail } from './cohost-state'
import { cohostErrorDetailText, cohostListeningView } from './cohost-view'
import type { EntitlementUiGate } from './entitlement-ui'

// The Orcle tab (plan 119 S2): Videorc's AI tab, under Studio, where Publish
// was. Everything here is a pure derivation of what the studio provider
// already holds, so the tab, its tests and the Comments window cannot
// disagree about what Orcle Live is doing.

/** The page's intro line. Clean cut (phase 2) changes it to "Live with you.
 * Edits after." */
export const ORCLE_TAB_DESCRIPTION = "Your AI producer while you're live."

/** What Orcle Live does, in three powers (plan 119 decision 4). */
export const ORCLE_LIVE_POWERS: readonly { title: string; description: string }[] = [
  {
    title: 'Never miss a question',
    description:
      'Questions from every platform, grouped, each with a drafted reply you approve. Answer out loud and Orcle clears it.'
  },
  {
    title: 'Chat stays safe',
    description:
      'Spam, scams and abuse are flagged against your own rules. Orcle never acts on its own.'
  },
  {
    title: 'The room, handled',
    description:
      "Orcle greets first-timers, reminds you of your promises, nudges you in dead air, tells you when viewers say your audio broke, and can put the comment you're talking about on screen."
  }
]

/**
 * What Cloud AI covers, one line per use (plan 119 decision 3). The consent
 * dialog and the Cloud AI row show this one list, so a feature that needs
 * cloud AI extends the consent here, never in a second store. Clean cut adds
 * its line: "Clean cut uploads your recording's audio to transcribe it."
 */
export const CLOUD_AI_USES: readonly string[] = [
  'Orcle reads your live chat.',
  "Orcle hears you while you're live: your microphone audio goes to Videorc's cloud speech-to-text and comes back as text."
]

/** What is kept, and where, after the list of uses. */
export const CLOUD_AI_KEEPS =
  "Videorc servers don't keep your chat or your audio. A short report of each stream is saved on this computer."

export type OrcleLiveStatusKind = 'off' | 'on' | 'live' | 'attention'

export const ORCLE_LIVE_STATUS_LABELS: Record<OrcleLiveStatusKind, string> = {
  off: 'Off',
  on: 'On, joins your next stream',
  live: 'Live now',
  attention: 'Needs attention'
}

export interface OrcleLiveStatus {
  kind: OrcleLiveStatusKind
  label: string
  /** A plain reason. Always set for `attention`; for `live`, only when Orcle
   * reads chat but cannot hear you. */
  reason: string | null
  /** The server's own words for a failed pass, for the tooltip. */
  detail: string | null
}

/** What unlocks Orcle Live for this account, and its one plain line. */
export interface OrcleLiveUnlock {
  action: { kind: 'sign-in' } | { kind: 'view-premium'; url: string } | null
  reason: string
}

export interface OrcleLiveViewInput {
  /** `cohost.settings`; null until the backend answers. */
  settings: Pick<CohostSettings, 'enabled'> | null
  signedIn: boolean
  /** The `live-cohost` Premium gate. */
  gate: EntitlementUiGate
  /** Renderer-owned cloud-AI consent (`videorc.aiConsent`). */
  consented: boolean
  /** On air right now (`sessionIsLive`): Orcle only runs during a stream. */
  live: boolean
  /** The latest `cohost.state`; null until the engine reports. */
  state: CohostState | null
}

export interface OrcleLiveView {
  status: OrcleLiveStatus
  /** The switch shows the stored choice. */
  checked: boolean
  /** A locked account can still turn Orcle off, never on. */
  switchDisabled: boolean
  /** Null when nothing is locked. */
  unlock: OrcleLiveUnlock | null
  /** "Open Stream Manager" shows while a stream is live. */
  streamManager: boolean
}

export const ORCLE_SIGNED_OUT_REASON = 'Sign in to use Orcle Live, part of Videorc Premium.'

export const ORCLE_CONSENT_OFF_REASON =
  "Cloud AI is off, so Orcle can't read chat or hear you. Allow it under Customize."

function status(
  kind: OrcleLiveStatusKind,
  reason: string | null = null,
  detail: string | null = null
): OrcleLiveStatus {
  return { kind, label: ORCLE_LIVE_STATUS_LABELS[kind], reason, detail }
}

export function orcleLiveUnlock(
  signedIn: boolean,
  gate: EntitlementUiGate
): OrcleLiveUnlock | null {
  if (!signedIn) return { action: { kind: 'sign-in' }, reason: ORCLE_SIGNED_OUT_REASON }
  if (gate.allowed) return null
  return {
    action: gate.upgradeUrl ? { kind: 'view-premium', url: gate.upgradeUrl } : null,
    reason: gate.reason
  }
}

/**
 * The status line. Off and on are the streamer's choice; live and attention
 * are what happened to it. The checks run in the order a streamer can fix
 * them: the account, then consent, then the engine's own report.
 */
export function orcleLiveStatus({
  enabled,
  unlock,
  consented,
  live,
  state
}: {
  enabled: boolean
  unlock: OrcleLiveUnlock | null
  consented: boolean
  live: boolean
  state: CohostState | null
}): OrcleLiveStatus {
  if (!enabled) return status('off')
  if (unlock) return status('attention', unlock.reason)
  if (!consented) return status('attention', ORCLE_CONSENT_OFF_REASON)
  if (!live) return status('on')
  if (state?.status === 'paused' || state?.status === 'error') {
    const reason = state.reason
      ? COHOST_ERROR_TOAST_MESSAGES[state.reason]
      : state.status === 'paused'
        ? 'Orcle paused.'
        : 'Orcle hit an error.'
    return status('attention', reason, cohostErrorDetailText(cohostErrorDetail(state)))
  }
  // Reading chat, or starting to. Not hearing you is a line, not an alarm.
  const listening = cohostListeningView(state?.listening)
  return status('live', listening?.state === 'blocked' ? listening.label : null)
}

export function orcleLiveView(input: OrcleLiveViewInput): OrcleLiveView {
  const enabled = input.settings?.enabled === true
  const unlock = orcleLiveUnlock(input.signedIn, input.gate)
  return {
    status: orcleLiveStatus({
      enabled,
      unlock,
      consented: input.consented,
      live: input.live,
      state: input.state
    }),
    checked: enabled,
    switchDisabled: input.settings === null || (!enabled && unlock !== null),
    unlock,
    streamManager: input.live
  }
}
