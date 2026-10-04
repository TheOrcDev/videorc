import type { CohostSettings, CohostState, PlatformAccount } from './backend'
import { removeMessagesReadiness } from '../../../shared/platform-scopes'
import { COHOST_ERROR_TOAST_MESSAGES, cohostErrorDetail } from './cohost-state'
import { cohostErrorDetailText, cohostListeningView } from './cohost-view'
import type { EntitlementUiGate } from './entitlement-ui'
import type { OrcleTabId } from './orcle-tabs'

// The Orcle tab (plan 119 S2): Videorc's AI tab, under Studio. Everything here
// is a pure derivation of what the studio provider already holds, so the tab,
// its tests and the Comments window cannot disagree about what Orcle Live is
// doing.

/**
 * What Orcle Live does (plan 119 decision 4), as the Live tab's "What Orcle
 * does" rows (plan 150): each names the Orcle tab that holds its settings, so
 * the row is a way there rather than a pitch.
 */
export const ORCLE_LIVE_POWERS: readonly {
  title: string
  description: string
  tab: OrcleTabId
}[] = [
  {
    title: 'Never miss a question',
    description:
      'Questions from every platform, grouped, each with a drafted reply you approve. Answer out loud and Orcle clears it.',
    tab: 'chat'
  },
  {
    title: 'Chat stays safe',
    description:
      'Spam, scams and abuse are flagged against your own rules. Orcle never acts on its own.',
    tab: 'chat'
  },
  {
    title: 'The room, handled',
    description:
      "Orcle greets first-timers, reminds you of your promises, nudges you in dead air, tells you when viewers say your audio broke, and can put the comment you're talking about on screen.",
    tab: 'chat'
  },
  {
    title: 'Talk to Orcle',
    description: 'Ask Orcle to put a comment on stream, take it down, or remove it from chat.',
    tab: 'voice'
  }
]

/**
 * What Cloud AI covers, one line per use (plan 119 decision 3). Every consent
 * dialog (Orcle Live, Clean cut) and the Cloud AI row show this one list, so a
 * feature that needs cloud AI extends the consent here, never in a second
 * store.
 */
export const CLOUD_AI_USES: readonly string[] = [
  'Orcle reads your live chat.',
  "Orcle hears you while you're live: your microphone audio goes to Videorc's cloud speech-to-text and comes back as text.",
  "Clean cut uploads a recording's audio, never the video, in short chunks for a word-by-word transcript, and sends its sentences to Videorc's cloud AI to find retakes. Neither is kept on Videorc servers after the job finishes."
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

// --- Voice commands (plan 140, S6 part A) -------------------------------------

/** What you can say: the web guide's phrases, shortened for the desktop. The
 * first phrase shows in the row; every one is in its tooltip. */
export const ORCLE_VOICE_COMMANDS: readonly {
  title: string
  result: string
  phrases: readonly string[]
}[] = [
  {
    title: 'Highlight',
    result: 'Puts it on stream.',
    phrases: [
      'Orcle, highlight the comment from coders X',
      'Orcle, put this one up',
      'Orcle, show the last comment',
      "Orcle, show coders X's question"
    ]
  },
  {
    title: 'Clear',
    result: 'Takes it off stream.',
    phrases: [
      'Orcle, take it down',
      'Orcle, clear the highlight',
      'Orcle, remove it from the screen'
    ]
  },
  {
    title: 'Remove',
    result: 'Shows it first. Removes it when you confirm.',
    phrases: [
      'This one is toxic. Remove it from our chat.',
      'Orcle, delete the comment from coders X'
    ]
  },
  {
    title: 'Answer',
    result: 'Confirms or stops a removal.',
    phrases: ['Yes', 'Do it', 'Remove it', 'No', 'Cancel', 'Never mind']
  }
]

/** One line of quoted phrases, as the row shows them. */
export function orcleVoicePhrasesLabel(phrases: readonly string[], count = 1): string {
  return phrases
    .slice(0, count)
    .map((phrase) => `“${phrase}”`)
    .join(', ')
}

export const ORCLE_VOICE_COMMANDS_DESCRIPTION =
  'Ask Orcle to put a comment on stream, take it down, or remove it from chat.'

export const ORCLE_VOICE_COMMANDS_OFF = 'Turn on Orcle Live to use voice commands.'

/** The numbers the web guide promises (contract part A). */
export const ORCLE_REMOVAL_LIMITS =
  'A removal waits 20 seconds for your answer, then nothing is removed. At most 10 removals a minute.'

export const ORCLE_REMOVAL_FALLBACK =
  'If the platform cannot remove it, Orcle hides it in Videorc and tells you viewers may still see it.'

export const ORCLE_VOICE_PREMIUM =
  "Voice commands are part of Orcle, which is Premium. Remove from chat in a comment's menu is free for everyone."

export const ORCLE_REMOVE_MESSAGES_NO_ACCOUNT =
  'Connect YouTube, Twitch, Kick or X under Livestream to remove their chat messages.'

/** The platforms that can remove a chat message, in the Livestream order. */
const REMOVE_MESSAGES_PLATFORMS = ['youtube', 'twitch', 'kick', 'x'] as const

const REMOVE_MESSAGES_PLATFORM_LABELS: Record<(typeof REMOVE_MESSAGES_PLATFORMS)[number], string> =
  {
    youtube: 'YouTube',
    twitch: 'Twitch',
    kick: 'Kick',
    x: 'X'
  }

export interface RemoveMessagesRow {
  platform: (typeof REMOVE_MESSAGES_PLATFORMS)[number]
  label: string
  accountLabel: string | null
  ready: boolean
  /** "Ready", or what fixes it. */
  message: string
  action: { kind: 'reconnect'; label: 'Reconnect' } | { kind: 'authorize-x'; label: string } | null
}

/**
 * "Remove messages" per connected platform, from `removeMessagesReadiness`
 * (S5): ready, or the one fix. Twitch, Kick and YouTube reconnect; X is
 * fixed by Authorize X Live. A platform without an account has no row.
 */
export function removeMessagesRows(
  accounts: readonly Pick<PlatformAccount, 'platform' | 'scopes' | 'status' | 'accountLabel'>[],
  { xLiveAuthorized }: { xLiveAuthorized?: boolean } = {}
): RemoveMessagesRow[] {
  return REMOVE_MESSAGES_PLATFORMS.flatMap((platform): RemoveMessagesRow[] => {
    const account = accounts.find((candidate) => candidate.platform === platform)
    if (!account) return []
    const label = REMOVE_MESSAGES_PLATFORM_LABELS[platform]
    const ready = removeMessagesReadiness(platform, account, { xLiveAuthorized }) === 'ready'
    const accountLabel = account.accountLabel?.trim() || null
    if (ready) return [{ platform, label, accountLabel, ready, message: 'Ready', action: null }]
    if (platform === 'x') {
      return [
        {
          platform,
          label,
          accountLabel,
          ready,
          message: 'Authorize X Live to let Orcle remove messages.',
          action: { kind: 'authorize-x', label: 'Authorize X Live' }
        }
      ]
    }
    return [
      {
        platform,
        label,
        accountLabel,
        ready,
        message: `Reconnect ${label} to let Orcle remove messages.`,
        action: { kind: 'reconnect', label: 'Reconnect' }
      }
    ]
  })
}
