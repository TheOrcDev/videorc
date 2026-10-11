import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react'

import { BuddyIcon } from '@/components/icons'
import { BuddyCard } from '@/components/stream-manager/buddy-card'
import { useBuddyCardKeys } from '@/components/stream-manager/buddy-card-keys'
import { removalKeyAnswer } from '@/components/stream-manager/removal-cards'
import { StatusDot } from '@/components/status-dot'
import { Badge } from '@/components/ui/badge'
import type { CohostUtterance, StreamPlatform } from '@/lib/backend'
import { BUDDY_UTTERANCE_TRIGGER_LABELS, buddyDisplayName } from '@/lib/buddy-auto-chat-view'
import { platformLabel } from '@/lib/platform-copy'

/** Recent lines shown under the cards. */
const RECENT_MAX = 4

/** A chat destination a post can reach: the live snapshot's provider rows. */
export interface UtteranceDestination {
  id: string
  platform: StreamPlatform
}

/**
 * Where a proposed post goes (plan 174 F-13), as platform names: its own
 * destinations, or every one when it names none (the backend's "every
 * writable destination"). Empty when the window knows no destination yet.
 */
export function utteranceDestinationLabels(
  utterance: Pick<CohostUtterance, 'destinationIds'>,
  destinations: readonly UtteranceDestination[]
): string[] {
  const picked =
    utterance.destinationIds.length > 0
      ? destinations.filter((destination) => utterance.destinationIds.includes(destination.id))
      : destinations
  return [...new Set(picked.map((destination) => platformLabel(destination.platform)))]
}

/** The cards still waiting on the streamer: proposed and not yet expired. */
export function openProposedUtterances(
  utterances: readonly CohostUtterance[],
  nowMs: number
): CohostUtterance[] {
  return utterances.filter(
    (utterance) =>
      utterance.status === 'proposed' &&
      (!utterance.expiresAt || Date.parse(utterance.expiresAt) > nowMs)
  )
}

export type UtteranceKeyAnswer = 'send' | 'dismiss'

/**
 * What a window-level key means for the newest proposed card, or null to
 * leave it alone (plan 174 S0.2, S3.14c). ↵ sends; Esc dismisses, and ⌫ or
 * Delete dismiss too, all on the terms of a removal card's keys
 * (`removalKeyAnswer`): ↵ and ⌫ only while nothing has the keyboard, so a
 * focused chat row, menu or switch never posts as you; Esc anywhere but a
 * text field or an open menu; never with a modifier, a held key or during
 * IME composition; and never once another handler took the key.
 */
export function utteranceKeyAnswer(
  event: Parameters<typeof removalKeyAnswer>[0],
  activeElement: Element | null,
  body: Element | null
): UtteranceKeyAnswer | null {
  const answer =
    event.key === 'Enter'
      ? 'send'
      : event.key === 'Backspace' || event.key === 'Delete' || event.key === 'Escape'
        ? 'dismiss'
        : null
  if (!answer) return null
  // Picked field by field: a real event keeps these on its prototype, so a
  // spread would drop them (and a taken key would look free).
  const { defaultPrevented, repeat, isComposing, metaKey, ctrlKey, altKey, shiftKey } = event
  const asRemovalKey = {
    key: event.key === 'Escape' ? 'Escape' : 'Enter',
    defaultPrevented,
    repeat,
    isComposing,
    metaKey,
    ctrlKey,
    altKey,
    shiftKey
  }
  return removalKeyAnswer(asRemovalKey, activeElement, body) ? answer : null
}

/**
 * The Buddy's proposed cards (plan 164 S-D2, Suggest mode): what it wants to
 * post as you and where, with Send and Dismiss, then the last few lines it
 * said. The newest proposed card takes the window keys while nothing else has
 * the keyboard and the pane is on screen (after a voice command card and a
 * removal card, `buddy-card-keys.ts`); every card keeps its buttons.
 */
export function BuddyUtteranceCards({
  utterances,
  pending = false,
  active = false,
  name = null,
  destinations = NO_DESTINATIONS,
  onApprove,
  onDismiss
}: {
  utterances: readonly CohostUtterance[]
  pending?: boolean
  /** The streamer's name for Buddy: a card is the character asking. */
  name?: string | null
  /** The chats a post can reach, so a card says where it goes (plan 174 F-13). */
  destinations?: readonly UtteranceDestination[]
  /** The Buddy pane is on screen. The keys answer only then: a card behind
   * a tab never takes ↵ from whatever the streamer is doing. */
  active?: boolean
  onApprove: (utterance: CohostUtterance) => void
  onDismiss: (utterance: CohostUtterance) => void
}): ReactElement | null {
  const [nowMs, setNowMs] = useState(() => Date.now())
  const proposed = openProposedUtterances(utterances, nowMs)
  const recent = utterances
    .filter((utterance) => utterance.status !== 'proposed' && utterance.status !== 'dismissed')
    .slice(-RECENT_MAX)
    .reverse()
  const newest = proposed.at(-1) ?? null
  const onApproveRef = useRef(onApprove)
  const onDismissRef = useRef(onDismiss)
  useEffect(() => {
    onApproveRef.current = onApprove
    onDismissRef.current = onDismiss
  }, [onApprove, onDismiss])

  useEffect(() => {
    if (proposed.length === 0) return
    const timer = setInterval(() => setNowMs(Date.now()), 1_000)
    return () => clearInterval(timer)
  }, [proposed.length])

  const handleWindowKey = useCallback(
    (event: KeyboardEvent): boolean => {
      if (!newest) return false
      const answer = utteranceKeyAnswer(event, document.activeElement, document.body)
      if (!answer) return false
      event.preventDefault()
      if (answer === 'send') onApproveRef.current(newest)
      else onDismissRef.current(newest)
      return true
    },
    [newest]
  )
  useBuddyCardKeys('utterance', newest && !pending && active ? handleWindowKey : null)

  if (proposed.length === 0 && recent.length === 0) return null

  return (
    <div className="shrink-0 border-b border-border" data-slot="buddy-utterances">
      {proposed.length > 0 ? (
        <div className="flex flex-col gap-2 p-2">
          {proposed.map((utterance) => (
            <BuddyCard
              key={utterance.id}
              busy={pending}
              data-utterance-id={utterance.id}
              decline={{ label: 'Dismiss', testId: 'buddy-utterance-dismiss' }}
              icon={BuddyIcon}
              keys={utterance === newest}
              label={`${buddyDisplayName(name)} wants to post`}
              primary={{ label: 'Send', testId: 'buddy-utterance-send' }}
              testId="buddy-utterance-card"
              timer={utterance.expiresAt ? secondsLeft(utterance.expiresAt, nowMs) : null}
              title={
                <span data-slot="buddy-utterance-title">
                  {BUDDY_UTTERANCE_TRIGGER_LABELS[utterance.trigger.kind]} · posts as you
                  {destinationsLine(utterance, destinations)}
                </span>
              }
              onDecline={() => onDismiss(utterance)}
              onPrimary={() => onApprove(utterance)}
            >
              <span data-testid="buddy-utterance-text">{utterance.text}</span>
            </BuddyCard>
          ))}
        </div>
      ) : null}
      {recent.length > 0 ? (
        <ul className="flex flex-col px-3 py-1" data-slot="buddy-utterance-recent">
          {recent.map((utterance) => (
            <li
              key={utterance.id}
              className="flex h-6 min-w-0 items-center gap-1.5 text-[11px]"
              data-status={utterance.status}
              title={utterance.text}
            >
              <Badge className="shrink-0" variant="outline">
                {BUDDY_UTTERANCE_TRIGGER_LABELS[utterance.trigger.kind]}
              </Badge>
              <span className="min-w-0 flex-1 truncate text-muted-foreground">
                {utterance.text}
              </span>
              {/* Plan 174 F-13: a failed post reads as failed, in the dot's
                  tone and a plain word, never as faded struck text. */}
              <StatusDot
                className="shrink-0 text-[11px]"
                label={statusLabel(utterance)}
                tone={utterance.status === 'failed' ? 'error' : 'neutral'}
              />
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  )
}

const NO_DESTINATIONS: readonly UtteranceDestination[] = []

/** " · to Twitch and YouTube", or nothing when the window knows no chat. */
function destinationsLine(
  utterance: CohostUtterance,
  destinations: readonly UtteranceDestination[]
): string {
  const labels = utteranceDestinationLabels(utterance, destinations)
  if (labels.length === 0) return ''
  const list =
    labels.length === 1 ? labels[0] : `${labels.slice(0, -1).join(', ')} and ${labels.at(-1)}`
  return ` · to ${list}`
}

function statusLabel(utterance: CohostUtterance): string {
  switch (utterance.status) {
    case 'sent':
      return 'Posted'
    case 'failed':
      return 'Failed'
    case 'bubble-only':
      return 'On stream'
    default:
      return ''
  }
}

function secondsLeft(expiresAt: string, nowMs: number): string {
  const seconds = Math.max(0, Math.ceil((Date.parse(expiresAt) - nowMs) / 1000))
  return `${seconds}s`
}
