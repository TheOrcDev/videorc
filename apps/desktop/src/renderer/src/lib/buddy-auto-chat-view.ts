import type {
  CohostActivityTemplateKind,
  CohostAutoChat,
  CohostGreetingPlatform,
  CohostGreetings,
  CohostGreetingTemplate,
  CohostGreetingWelcomes,
  CohostTalkMode,
  CohostUtteranceState,
  CohostUtteranceTriggerKind,
  CohostWelcomeKind,
  CohostWelcomeLine,
  StreamPlatform
} from '@/lib/backend'
import { CHAT_SEND_PLATFORM_MAX_CHARS } from '@/lib/chat-send'
import { platformLabel } from '@/lib/platform-copy'

// Automatic chat (plan 164 Phase D): the pure side of the greetings editor
// (Buddy tab → Chat) and the Stream Manager's talk control. The backend
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

/**
 * The product promise (plan 164 D4, plan 211 D6), everywhere the old one
 * was. True by structure: nothing Buddy does on its own reaches chat; only
 * the streamer's click on a Suggest card posts as them.
 */
export const BUDDY_POSTS_PROMISE = 'Buddy never posts in your chat on its own.'

/** How Buddy talks (plan 211 D1), from least reach to most. */
export const BUDDY_TALK_MODES: readonly CohostTalkMode[] = ['off', 'bubble', 'suggest']

export const BUDDY_TALK_LABELS: Record<CohostTalkMode, string> = {
  off: 'Off',
  bubble: 'Bubble',
  suggest: 'Suggest'
}

/**
 * The talk control's name (plan 211 D1, plan 202 D1): "Grum talks", in the
 * streamer's name for Buddy. It governs only how Buddy talks on its own;
 * whether Buddy runs at all is Buddy Live, its own switch.
 */
export function buddyTalkLabel(name: string | null | undefined): string {
  return `${buddyDisplayName(name)} talks`
}

/** What the chosen value means, as the line under the control (plan 174 F-12). */
export function buddyTalkHint(talk: CohostTalkMode, name: string | null | undefined): string {
  const who = buddyDisplayName(name)
  switch (talk) {
    case 'off':
      return `${who} says nothing on its own.`
    case 'bubble':
      return `${who} talks on stream in its bubble. Nothing goes to chat.`
    case 'suggest':
      return 'Each message is a card here; one click posts it to chat as you.'
  }
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
  /** "Greetings on · AI", "Greetings on", "Answers off": the chip's text. */
  text: string
  /** The chip's accessible name: its state and the way to change it. */
  name: string
}

/**
 * The three behaviours as read-only summary chips (plan 174 S3.14a, D7): each
 * says whether it is on and links to its one home, Buddy → Chat, so the
 * Stream Manager never grows a second set of switches. An empty greetings
 * list posts the built-in lines (plan 192 D1), so "on" never means silent.
 * The chips say what will actually happen (D7): "Greetings on · AI" only
 * when Buddy may write them, `aiGreetings` (Premium and cloud AI allowed)
 * with Greetings' own AI switch on.
 */
export function buddyBehaviourChips(
  autoChat: Pick<CohostAutoChat, 'greetings' | 'answers' | 'banter'>,
  { aiGreetings = false }: { aiGreetings?: boolean } = {}
): BuddyBehaviourChip[] {
  return BUDDY_BEHAVIOUR_IDS.map((id) => {
    const label = BUDDY_BEHAVIOUR_LABELS[id]
    const on = autoChat[id].enabled
    const ai = id === 'greetings' && on && aiGreetings && greetingsAi(autoChat.greetings)
    const text = `${label} ${on ? 'on' : 'off'}${ai ? ' · AI' : ''}`
    return { id, label, on, text, name: `${text}. Change it in ${BUDDY_BEHAVIOUR_HOME}.` }
  })
}

/** The posting consent dialog's title (plan 164 S-D6): the character asks. */
export function buddyPostingConsentTitle(name: string | null | undefined): string {
  return `Let ${buddyDisplayName(name)} post as you?`
}

/**
 * The posting consent dialog (plan 164 S-D6, plan 211 D5), word for word:
 * Suggest is the one way Buddy's words reach chat, and only by a click.
 */
export function buddyPostingConsentSentence(name: string | null | undefined): string {
  return `${buddyDisplayName(name)} posts to your chats as you, on the platforms you stream to, only when you click its card. You can read every message later in Buddy → Reports.`
}

/** Where the window remembers the one-time consent (like the nudge). */
export const BUDDY_AUTO_CHAT_CONSENT_STORAGE_KEY = 'videorc.buddyAutoChatConsent'

/**
 * What a talk change needs first (plan 211 D5): Off and Bubble apply at
 * once, because Buddy posts nothing as you in either. Suggest asks for the
 * posting consent the first time, because one click there posts as you.
 */
export function buddyModeChangeStep({
  next,
  consented
}: {
  next: CohostTalkMode
  consented: boolean
}): 'apply' | 'consent' {
  return next === 'suggest' && !consented ? 'consent' : 'apply'
}

/** Every kind Buddy greets: the Activity kinds (`templates[]`) and the two
 * welcomes (`greetings.welcomes`, plan 192 D2). */
export type BuddyGreetingKind = CohostActivityTemplateKind | CohostWelcomeKind

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

/** The welcome rows' names (plan 192 S1.3), word for word. */
export const BUDDY_WELCOME_TITLES: Record<CohostWelcomeKind, string> = {
  'first-time': 'First-time chatters',
  returning: 'Returning chatters'
}

/** Where each welcome lives in `greetings.welcomes`. */
export const BUDDY_WELCOME_KEYS: Record<CohostWelcomeKind, keyof CohostGreetingWelcomes> = {
  'first-time': 'firstTime',
  returning: 'returning'
}

/** The platforms each kind comes from, for the row's hint. */
export const BUDDY_TEMPLATE_KIND_PLATFORMS: Record<
  BuddyGreetingKind,
  readonly CohostGreetingPlatform[]
> = {
  'first-time': ['twitch', 'youtube', 'kick', 'x'],
  returning: ['twitch', 'youtube', 'kick', 'x'],
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

/** The fields a welcome offers (plan 192 S1.3): a chat row has only these. */
export const BUDDY_WELCOME_FIELDS: readonly { field: string; hint: string }[] =
  BUDDY_TEMPLATE_FIELDS.filter((entry) => ['name', 'handle', 'platform'].includes(entry.field))

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

export const BUDDY_SAMPLE_FIELDS: Record<BuddyGreetingKind, BuddySampleFields> = {
  'first-time': { name: 'first_timer', handle: '@first_timer', platform: 'Twitch' },
  returning: { name: 'regular', handle: '@regular', platform: 'YouTube' },
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

/** One built-in line (plan 192 D1): what a kind posts while you have none. */
export interface BuddyBuiltinGreeting {
  kind: BuddyGreetingKind
  text: string
  state: CohostUtteranceState
}

/**
 * Buddy's built-in greeting lines (plan 192 D1, owner: "something simple
 * like hi"), one per kind, using only `{name}` so they read right whatever a
 * platform leaves empty. The mirror of Rust's `BUILTIN_GREETINGS`; both
 * suites assert they equal `protocol-fixtures/buddy-builtin-greetings.json`.
 */
export const BUDDY_BUILTIN_GREETINGS: readonly BuddyBuiltinGreeting[] = [
  { kind: 'first-time', text: 'Hi {name}, welcome to the stream!', state: 'talk' },
  { kind: 'returning', text: 'Welcome back, {name}!', state: 'talk' },
  { kind: 'follow', text: 'Welcome, {name}! Thanks for the follow.', state: 'talk' },
  { kind: 'sub', text: '{name} joined the ranks. Thank you!', state: 'laugh' },
  { kind: 'resub', text: '{name} is back in the ranks. Thank you!', state: 'laugh' },
  { kind: 'sub-gift', text: 'Thanks for the gift sub, {name}!', state: 'laugh' },
  {
    kind: 'community-sub-gift',
    text: '{name} gifted subs to the chat. Thank you!',
    state: 'laugh'
  },
  { kind: 'membership', text: 'Welcome to the members, {name}!', state: 'laugh' },
  { kind: 'cheer', text: 'Thanks for the bits, {name}!', state: 'talk' },
  { kind: 'kicks', text: 'Thanks for the Kicks, {name}!', state: 'talk' },
  { kind: 'super-chat', text: 'Thanks for the Super Chat, {name}!', state: 'talk' },
  { kind: 'super-sticker', text: 'Thanks for the Super Sticker, {name}!', state: 'talk' },
  { kind: 'raid', text: '{name} is raiding! Welcome, everyone!', state: 'laugh' },
  { kind: 'watch-streak', text: '{name}, thanks for the watch streak!', state: 'talk' },
  { kind: 'power-up', text: 'Thanks for the power-up, {name}!', state: 'talk' },
  { kind: 'redemption', text: 'Thanks for redeeming, {name}!', state: 'talk' }
]

const BUILTIN_BY_KIND = new Map(BUDDY_BUILTIN_GREETINGS.map((line) => [line.kind, line]))

/** The built-in line a kind posts while you have none of your own. */
export function builtinGreeting(kind: BuddyGreetingKind): BuddyBuiltinGreeting {
  return BUILTIN_BY_KIND.get(kind)!
}

/**
 * What a greeting kind posts (plan 192 D1, Rust's `pick_template`
 * mirrored): your enabled lines for the kind (and the platform, when one is
 * named); else off when the kind has lines and every one is switched off;
 * else the built-in line. An empty list never means silence.
 */
export type BuddyGreetingLine =
  | { source: 'yours'; templates: CohostGreetingTemplate[] }
  | { source: 'off' }
  | { source: 'built-in'; line: BuddyBuiltinGreeting }

export function resolveGreetingLine(
  templates: readonly CohostGreetingTemplate[],
  kind: CohostActivityTemplateKind,
  platform?: CohostGreetingPlatform
): BuddyGreetingLine {
  const ofKind = templates.filter((template) => template.kind === kind)
  const enabled = ofKind.filter(
    (template) =>
      template.enabled && (!platform || !template.platform || template.platform === platform)
  )
  if (enabled.length > 0) return { source: 'yours', templates: enabled }
  if (ofKind.length > 0 && ofKind.every((template) => !template.enabled)) return { source: 'off' }
  return { source: 'built-in', line: builtinGreeting(kind) }
}

/** Greetings' AI switch (plan 192 D3); an older backend omits it: on. */
export function greetingsAi(greetings: Pick<CohostGreetings, 'ai'>): boolean {
  return greetings.ai ?? true
}

/** The welcomes as stored, or Rust's default (both on, built-in lines). */
export function greetingWelcomes(
  greetings: Pick<CohostGreetings, 'welcomes'>
): CohostGreetingWelcomes {
  return greetings.welcomes ?? { firstTime: { enabled: true }, returning: { enabled: true } }
}

/** What a welcome posts (plan 192 S1.1): off, your line, or the built-in one. */
export function resolveWelcomeLine(
  welcome: CohostWelcomeLine,
  kind: CohostWelcomeKind
): { source: 'off' } | { source: 'yours' | 'built-in'; text: string; state: CohostUtteranceState } {
  if (!welcome.enabled) return { source: 'off' }
  const text = welcome.text?.trim()
  if (text) return { source: 'yours', text, state: welcome.state ?? 'talk' }
  const line = builtinGreeting(kind)
  return { source: 'built-in', text: line.text, state: welcome.state ?? line.state }
}

/**
 * A welcome with its line edited (plan 192 S1.1): trimmed, and an empty line
 * is absent (the built-in line), never `''` or null. Its other fields stay.
 */
export function withWelcomeText(welcome: CohostWelcomeLine, text: string): CohostWelcomeLine {
  const { text: _old, ...rest } = welcome
  const trimmed = text.trim()
  return trimmed ? { ...rest, text: trimmed } : rest
}

export const BUDDY_TEMPLATE_TEXT_MAX_CHARS = 200
export const BUDDY_TEMPLATES_MAX = 60

/**
 * A new line for a kind. It starts from the built-in line (plan 192 D1),
 * never empty: the settings refuse an empty line.
 */
export function newGreetingTemplate(
  kind: CohostActivityTemplateKind,
  overrides: Partial<Omit<CohostGreetingTemplate, 'id' | 'kind'>> = {}
): CohostGreetingTemplate {
  const builtin = builtinGreeting(kind)
  return {
    id: crypto.randomUUID(),
    kind,
    text: builtin.text,
    state: builtin.state,
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

/** A line the editor checks: a template, or a welcome's line (plan 192). */
export interface BuddyGreetingLineDraft {
  kind: BuddyGreetingKind
  platform?: CohostGreetingPlatform
  text: string
}

/** The platforms a template reaches: its own, else every one it is for. */
export function greetingTemplatePlatforms(
  template: Pick<BuddyGreetingLineDraft, 'kind' | 'platform'>
): readonly CohostGreetingPlatform[] {
  return template.platform ? [template.platform] : BUDDY_TEMPLATE_KIND_PLATFORMS[template.kind]
}

/**
 * The editor's inline warnings (plan 164 S-D5): the text over a cap on a
 * platform it reaches (X takes 140), and braces nothing fills. Never a
 * silent cut: the backend clips with an ellipsis and says so in the log.
 */
export function greetingTemplateWarnings(template: BuddyGreetingLineDraft): string[] {
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
