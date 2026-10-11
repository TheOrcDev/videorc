import type {
  CohostActivityTemplateKind,
  CohostAutoChat,
  CohostAutoChatMode,
  CohostGreetingPlatform,
  CohostGreetingTemplate,
  CohostUtteranceTriggerKind,
  StreamPlatform
} from '@/lib/backend'
import { CHAT_SEND_PLATFORM_MAX_CHARS } from '@/lib/chat-send'
import { platformLabel } from '@/lib/platform-copy'

// Automatic chat (plan 164 Phase D): the pure side of the greetings editor
// (Buddy tab → Chat) and the Stream Manager's mode control. The backend
// resolves the real greetings (`cohost_greetings.rs`); this mirror only
// previews and warns, so the editor never disagrees with what goes out.

/**
 * The name copy uses when the character speaks or acts (plan 174 J2-20):
 * the streamer's own name for it ("Grum"), else "Buddy". The feature itself
 * is always "Buddy", with no article.
 */
export function buddyDisplayName(name: string | null | undefined): string {
  return name?.trim() || 'Buddy'
}

/** The product promise (plan 164 D4), everywhere the old one was. */
export const BUDDY_POSTS_PROMISE =
  'Buddy posts only in the modes you turn on. Everything is off by default.'

export const BUDDY_MODE_LABELS: Record<CohostAutoChatMode, string> = {
  off: 'Off',
  suggest: 'Suggest',
  auto: 'Auto'
}
export const BUDDY_MODES: readonly CohostAutoChatMode[] = ['off', 'suggest', 'auto']

/**
 * The posting control's name (plan 174 S3.14a, D7): it governs only what
 * Buddy posts as you. Whether Buddy runs at all is Buddy Live, its own switch.
 */
export const BUDDY_POSTING_LABEL = 'Chat posting'

/** What the chosen mode means, as the line under the control (plan 174 F-12). */
export const BUDDY_MODE_HINTS: Record<CohostAutoChatMode, string> = {
  off: 'Nothing is posted.',
  suggest: 'Each message is a card here; one click sends it.',
  auto: 'Messages go out by themselves, within the limits.'
}

export type BuddyBehaviourId = 'greetings' | 'answers' | 'banter'

export const BUDDY_BEHAVIOUR_IDS: readonly BuddyBehaviourId[] = ['greetings', 'answers', 'banter']

/** Each behaviour's one name, the same on the Buddy page and in the Stream Manager. */
export const BUDDY_BEHAVIOUR_LABELS: Record<BuddyBehaviourId, string> = {
  greetings: 'Greetings',
  answers: 'Answers',
  banter: 'Banter'
}

/** Where the behaviours are turned on and off: their one home (plan 174 D7). */
export const BUDDY_BEHAVIOUR_HOME = 'Buddy → Chat'

export interface BuddyBehaviourChip {
  id: BuddyBehaviourId
  label: string
  on: boolean
  /** On with nothing to post (plan 174 F-11): Greetings without a line. */
  empty: boolean
  /** "Greetings on", "Answers off", "Greetings on, no lines": the chip's text. */
  text: string
  /** The chip's accessible name: its state and the way to change it. */
  name: string
}

/** Greetings is on but has no line to post (plan 174 F-11). */
export const BUDDY_GREETINGS_EMPTY_NOTE =
  'Greetings is on, but has no lines yet: nothing is posted until you add some.'

/**
 * The three behaviours as read-only summary chips (plan 174 S3.14a, D7): each
 * says whether it is on and links to its one home, Buddy → Chat, so the
 * Stream Manager never grows a second set of switches.
 */
export function buddyBehaviourChips(
  autoChat: Pick<CohostAutoChat, 'greetings' | 'answers' | 'banter'>
): BuddyBehaviourChip[] {
  return BUDDY_BEHAVIOUR_IDS.map((id) => {
    const label = BUDDY_BEHAVIOUR_LABELS[id]
    const on = autoChat[id].enabled
    const empty = id === 'greetings' && on && autoChat.greetings.templates.length === 0
    const text = empty ? `${label} on, no lines` : `${label} ${on ? 'on' : 'off'}`
    const name = empty
      ? `${text}. Nothing is posted until you add some in ${BUDDY_BEHAVIOUR_HOME}.`
      : `${text}. Change it in ${BUDDY_BEHAVIOUR_HOME}.`
    return { id, label, on, empty, text, name }
  })
}

/** The posting consent dialog's title (plan 164 S-D6): the character asks. */
export function buddyPostingConsentTitle(name: string | null | undefined): string {
  return `Let ${buddyDisplayName(name)} post as you?`
}

/** The posting consent dialog (plan 164 S-D6), word for word. */
export function buddyPostingConsentSentence(name: string | null | undefined): string {
  return `${buddyDisplayName(name)} posts to your chats as you, on the platforms you stream to, only in the modes you turn on. You can read every message later in Buddy → Reports.`
}

export const BUDDY_AUTO_CONFIRM_SENTENCE = 'Automatic messages are sent without asking you first.'

/** Where the window remembers the one-time consent (like the nudge). */
export const BUDDY_AUTO_CHAT_CONSENT_STORAGE_KEY = 'videorc.buddyAutoChatConsent'

/**
 * What a mode change needs first: the consent dialog the first time the
 * mode leaves Off, then, for Auto, its own explicit confirm (every time).
 * Auto is never reachable without the second click.
 */
export function buddyModeChangeStep({
  next,
  consented
}: {
  next: CohostAutoChatMode
  consented: boolean
}): 'apply' | 'consent' | 'confirm-auto' {
  if (next === 'off') return 'apply'
  if (!consented) return 'consent'
  return next === 'auto' ? 'confirm-auto' : 'apply'
}

export const BUDDY_TEMPLATE_KIND_TITLES: Record<CohostActivityTemplateKind, string> = {
  follow: 'Follow',
  sub: 'Sub',
  resub: 'Resub',
  'sub-gift': 'Gifted sub',
  'community-sub-gift': 'Community gift',
  membership: 'Membership',
  cheer: 'Cheer',
  kicks: 'KICKs',
  'super-chat': 'Super Chat',
  'super-sticker': 'Super Sticker',
  raid: 'Raid',
  'watch-streak': 'Watch streak',
  'power-up': 'Power-up',
  redemption: 'Redemption'
}

/** The platforms each kind comes from, for the row's hint. */
export const BUDDY_TEMPLATE_KIND_PLATFORMS: Record<
  CohostActivityTemplateKind,
  readonly CohostGreetingPlatform[]
> = {
  follow: ['twitch', 'kick', 'x'],
  sub: ['twitch'],
  resub: ['twitch'],
  'sub-gift': ['twitch'],
  'community-sub-gift': ['twitch'],
  membership: ['youtube'],
  cheer: ['twitch'],
  kicks: ['kick'],
  'super-chat': ['youtube'],
  'super-sticker': ['youtube'],
  raid: ['twitch'],
  'watch-streak': ['twitch'],
  'power-up': ['twitch'],
  redemption: ['twitch']
}

export const BUDDY_GREETING_PLATFORM_LABELS: Record<CohostGreetingPlatform, string> = {
  twitch: platformLabel('twitch'),
  youtube: platformLabel('youtube'),
  kick: platformLabel('kick'),
  x: platformLabel('x')
}

/** The braces a template may use, in the order the Fields popover lists them. */
export const BUDDY_TEMPLATE_FIELDS: readonly { field: string; hint: string }[] = [
  { field: 'name', hint: 'Display name' },
  { field: 'handle', hint: '@login where the platform has one' },
  { field: 'platform', hint: 'Twitch, YouTube, Kick or X' },
  { field: 'months', hint: 'Months subscribed' },
  { field: 'streak', hint: 'Streams in a row' },
  { field: 'count', hint: 'Gifts, bits, raid viewers' },
  { field: 'amount', hint: 'Money, bits, KICKs or points' },
  { field: 'reward', hint: 'Reward or Power-up title' },
  { field: 'names', hint: 'Everyone in a burst' },
  { field: 'others', hint: 'How many more in a burst' }
]

const KNOWN_FIELDS = new Set(BUDDY_TEMPLATE_FIELDS.map((entry) => entry.field))

/** The sample the preview resolves against, one per kind (the same shapes
 * the fake connector delivers, `fake_events()` in live_chat.rs). */
export interface BuddySampleFields {
  name: string
  handle: string
  platform: string
  months?: number
  streak?: number
  count?: number
  amount?: string
  reward?: string
}

export const BUDDY_SAMPLE_FIELDS: Record<CohostActivityTemplateKind, BuddySampleFields> = {
  follow: { name: 'new_friend', handle: '@new_friend', platform: 'Twitch' },
  sub: { name: 'morgaesis', handle: 'morgaesis', platform: 'Twitch' },
  resub: { name: 'morgaesis', handle: 'morgaesis', platform: 'Twitch', months: 8 },
  'sub-gift': { name: 'generous', handle: 'generous', platform: 'Twitch', count: 1 },
  'community-sub-gift': { name: 'generous', handle: 'generous', platform: 'Twitch', count: 5 },
  membership: { name: 'Newbie', handle: 'Newbie', platform: 'YouTube' },
  cheer: {
    name: 'sarzdotmd',
    handle: 'sarzdotmd',
    platform: 'Twitch',
    count: 1500,
    amount: '1,500 bits'
  },
  kicks: {
    name: 'kick_tipper',
    handle: 'kick_tipper',
    platform: 'Kick',
    count: 500,
    amount: '500 KICKs'
  },
  'super-chat': { name: 'Maria', handle: 'Maria', platform: 'YouTube', amount: '$5.00' },
  'super-sticker': { name: 'Jonas', handle: 'Jonas', platform: 'YouTube', amount: '€2.00' },
  raid: { name: 'raider42', handle: 'raider42', platform: 'Twitch', count: 234 },
  'watch-streak': { name: 'loyal_lurker', handle: 'loyal_lurker', platform: 'Twitch', streak: 20 },
  'power-up': {
    name: 'party_starter',
    handle: 'party_starter',
    platform: 'Twitch',
    count: 300,
    amount: '300 bits'
  },
  redemption: {
    name: 'hydration_hero',
    handle: 'hydration_hero',
    platform: 'Twitch',
    count: 500,
    amount: '500 Diamonds',
    reward: 'Hydrate'
  }
}

/** The starter set an empty list offers (plan 164 S-D5, owner copy). */
export const BUDDY_STARTER_TEMPLATES: readonly Omit<CohostGreetingTemplate, 'id'>[] = [
  { kind: 'follow', text: 'Welcome, {name}!', state: 'talk', enabled: true },
  { kind: 'sub', text: '{name} joined the ranks', state: 'laugh', enabled: true },
  {
    kind: 'resub',
    text: '{name} joined the ranks ({months} months)',
    state: 'laugh',
    enabled: true
  },
  { kind: 'cheer', text: '{amount} from {name}, much obliged', state: 'talk', enabled: true },
  { kind: 'raid', text: '{name} brings {count} warriors. Welcome!', state: 'laugh', enabled: true },
  { kind: 'watch-streak', text: '{name}, {streak} streams strong', state: 'talk', enabled: true }
]

export const BUDDY_TEMPLATE_TEXT_MAX_CHARS = 200
export const BUDDY_TEMPLATES_MAX = 60

export function newGreetingTemplate(
  kind: CohostActivityTemplateKind,
  overrides: Partial<Omit<CohostGreetingTemplate, 'id' | 'kind'>> = {}
): CohostGreetingTemplate {
  return {
    id: crypto.randomUUID(),
    kind,
    text: '',
    state: 'talk',
    enabled: true,
    ...overrides
  }
}

function fieldValue(fields: BuddySampleFields, field: string): string | null {
  switch (field) {
    case 'name':
      return fields.name
    case 'handle':
      return fields.handle
    case 'platform':
      return fields.platform
    case 'months':
      return fields.months === undefined ? '' : String(fields.months)
    case 'streak':
      return fields.streak === undefined ? '' : String(fields.streak)
    case 'count':
      return fields.count === undefined ? '' : fields.count.toLocaleString('en-US')
    case 'amount':
      return fields.amount ?? ''
    case 'reward':
      return fields.reward ?? ''
    case 'names':
      return fields.name
    case 'others':
      return ''
    default:
      return null
  }
}

/**
 * The preview line (the backend's `resolve_template`, mirrored): known
 * braces fill from the sample, unknown ones stay literal and are reported,
 * runs of spaces collapse.
 */
export function resolveGreetingPreview(
  text: string,
  fields: BuddySampleFields
): { text: string; unknown: string[] } {
  const unknown: string[] = []
  const resolved = text.replace(/\{([^{}]*)\}/g, (literal, raw: string) => {
    const field = raw.trim()
    const value = fieldValue(fields, field)
    if (value === null) {
      if (!unknown.includes(field)) unknown.push(field)
      return literal
    }
    return value
  })
  return { text: resolved.split(/\s+/).filter(Boolean).join(' '), unknown }
}

/** The platforms a template reaches: its own, else every one it is for. */
export function greetingTemplatePlatforms(
  template: Pick<CohostGreetingTemplate, 'kind' | 'platform'>
): readonly CohostGreetingPlatform[] {
  return template.platform ? [template.platform] : BUDDY_TEMPLATE_KIND_PLATFORMS[template.kind]
}

/**
 * The editor's inline warnings (plan 164 S-D5): the text over a cap on a
 * platform it reaches (X takes 140), and braces nothing fills. Never a
 * silent cut: the backend clips with an ellipsis and says so in the log.
 */
export function greetingTemplateWarnings(
  template: Pick<CohostGreetingTemplate, 'kind' | 'platform' | 'text'>
): string[] {
  const warnings: string[] = []
  const { text, unknown } = resolveGreetingPreview(
    template.text,
    BUDDY_SAMPLE_FIELDS[template.kind]
  )
  for (const platform of greetingTemplatePlatforms(template)) {
    const cap = CHAT_SEND_PLATFORM_MAX_CHARS[platform as StreamPlatform]
    if (text.length > cap) {
      warnings.push(
        `${BUDDY_GREETING_PLATFORM_LABELS[platform]} takes ${cap} characters; this one is ${text.length}.`
      )
    }
  }
  if (unknown.length > 0) {
    warnings.push(
      `${unknown.map((field) => `{${field}}`).join(', ')} ${unknown.length === 1 ? 'is' : 'are'} not a field and will be posted as written.`
    )
  }
  return warnings
}

export function isKnownGreetingField(field: string): boolean {
  return KNOWN_FIELDS.has(field)
}

export const BUDDY_UTTERANCE_TRIGGER_LABELS: Record<CohostUtteranceTriggerKind, string> = {
  greeting: 'Greeting',
  answer: 'Answer',
  banter: 'Banter',
  manual: 'Say'
}
