import { useState, type ReactElement } from 'react'

import { BuddyEmblem } from '@/components/buddy-emblem'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { SegmentedControl } from '@/components/ui/segmented-control'
import type { CohostAutoChat, CohostTalkMode } from '@/lib/backend'
import {
  BUDDY_AUTO_CHAT_CONSENT_STORAGE_KEY,
  BUDDY_TALK_LABELS,
  BUDDY_TALK_MODES,
  buddyBehaviourChips,
  buddyDisplayName,
  buddyModeChangeStep,
  buddyPostingConsentSentence,
  buddyPostingConsentTitle,
  buddyTalkHint,
  buddyTalkLabel,
  type BuddyBehaviourId
} from '@/lib/buddy-auto-chat-view'

/**
 * A change of "{name} talks" with its one consent (plan 211 D5): Off and
 * Bubble apply at once, because nothing is posted as you in either; the
 * first time Suggest is chosen the consent dialog says what posting as you
 * means, and Allow lands there. Lifted out of the control (plan 239) so the
 * off-the-picture notice's "Use Suggest" asks through the same dialog.
 */
export interface BuddyTalkRequest {
  requestTalk: (next: CohostTalkMode) => void
  consentOpen: boolean
  closeConsent: () => void
  acceptConsent: () => void
}

export function useBuddyTalkRequest(
  talk: CohostTalkMode,
  onTalkChange: (talk: CohostTalkMode) => void
): BuddyTalkRequest {
  const [postingConsented, setPostingConsented] = useState(() => readPostingConsent())
  const [consentOpen, setConsentOpen] = useState(false)
  return {
    requestTalk: (next) => {
      if (next === talk) return
      if (buddyModeChangeStep({ next, consented: postingConsented }) === 'consent') {
        setConsentOpen(true)
        return
      }
      onTalkChange(next)
    },
    consentOpen,
    closeConsent: () => setConsentOpen(false),
    // The consent is asked only on the way to Suggest, so Allow lands there.
    acceptConsent: () => {
      persistPostingConsent()
      setPostingConsented(true)
      setConsentOpen(false)
      onTalkChange('suggest')
    }
  }
}

/**
 * The avatar's talk control (plan 164 S-D6, plan 174 S3.14a, D7, plan 211
 * D1; the Stream Manager's Avatar block since plan 239): one "{name} talks:
 * Off | Bubble | Suggest" segmented control that governs only how the
 * avatar talks on its own, with the chosen value's meaning as a line under
 * it, never a tooltip. Whether Sidekick runs at all is Sidekick Live, its
 * own switch in the Sidekick block's header: this control never turns
 * Sidekick on or off.
 *
 * Greetings, Answers and Banter have one home each (plan 174 F-24): the
 * greeting lines on Avatar → Greetings, Answers and Banter on Sidekick →
 * Chat (plan 239). Here they are read-only summary chips, each a way there.
 */
export function BuddyChatControls({
  autoChat,
  aiGreetings = false,
  name = null,
  picture = null,
  disabled = false,
  talkRequest,
  onTalkChange,
  onOpenChatSettings
}: {
  autoChat: CohostAutoChat
  /**
   * Sidekick may write greetings with AI (plan 192 D3, D7): Premium and cloud
   * AI allowed. With the AI switch on, the Greetings chip says "· AI".
   */
  aiGreetings?: boolean
  /** The streamer's name for the avatar: the label and the consent dialog use it. */
  name?: string | null
  /**
   * That avatar's own picture (its idle pose): the consent dialog shows the
   * avatar it names, not the emblem. Absent, the emblem.
   */
  picture?: string | null
  disabled?: boolean
  /**
   * The owner's talk request (plan 239): it renders the consent dialog
   * once, for this control and the notice. Absent, the control keeps its
   * own and renders the dialog itself.
   */
  talkRequest?: BuddyTalkRequest
  onTalkChange: (talk: CohostTalkMode) => void
  /** Opens a behaviour's home in the main window. Absent, the chips are inert. */
  onOpenChatSettings?: (behaviour: BuddyBehaviourId) => void
}): ReactElement {
  const ownRequest = useBuddyTalkRequest(autoChat.talk, onTalkChange)
  const request = talkRequest ?? ownRequest

  return (
    <>
      <div className="flex min-w-0 flex-col gap-1.5 px-3 py-2" data-slot="buddy-chat-controls">
        <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1.5">
          {/* The label carries the avatar's name, so a long one (24
              characters) wraps the segments under it instead of squeezing
              them: the three values never wrap inside the track. */}
          <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
            <span className="min-w-0 text-label break-words text-subtle" id="buddy-talk-label">
              {buddyTalkLabel(name)}
            </span>
            <SegmentedControl
              aria-describedby="buddy-talk-hint"
              aria-labelledby="buddy-talk-label"
              className="shrink-0 flex-nowrap"
              disabled={disabled}
              options={BUDDY_TALK_MODES.map((talk) => ({
                value: talk,
                label: BUDDY_TALK_LABELS[talk],
                'data-buddy-talk': talk
              }))}
              size="sm"
              value={autoChat.talk}
              onValueChange={request.requestTalk}
            />
          </div>
          {/* Read-only: each behaviour is switched in its one home (plan 174
              D7, plan 239). The tone rides the dot, the words say the state,
              and each chip is the way there. */}
          <div
            aria-label={`What ${buddyDisplayName(name)} says`}
            className="flex min-w-0 flex-wrap items-center gap-1"
            data-slot="buddy-behaviour-chips"
            role="group"
          >
            {buddyBehaviourChips(autoChat, { aiGreetings }).map((chip) => (
              <Badge
                key={chip.id}
                render={
                  <button
                    aria-label={chip.name}
                    data-behaviour={chip.id}
                    data-on={chip.on || undefined}
                    data-testid="buddy-behaviour-chip"
                    disabled={!onOpenChatSettings}
                    type="button"
                    onClick={() => onOpenChatSettings?.(chip.id)}
                  />
                }
                variant={chip.on ? 'success' : 'neutral'}
              >
                {chip.text}
              </Badge>
            ))}
          </div>
        </div>
        <p
          className="text-xs text-muted-foreground"
          data-slot="buddy-talk-hint"
          id="buddy-talk-hint"
        >
          {buddyTalkHint(autoChat.talk, name)}
        </p>
      </div>

      {talkRequest ? null : (
        <BuddyPostingConsentDialog name={name} picture={picture} request={request} />
      )}
    </>
  )
}

/** "Let {name} post as you?" (plan 164 S-D6, plan 211 D5): the one posting consent. */
export function BuddyPostingConsentDialog({
  request,
  name = null,
  picture = null
}: {
  request: BuddyTalkRequest
  name?: string | null
  picture?: string | null
}): ReactElement {
  return (
    <Dialog
      open={request.consentOpen}
      onOpenChange={(open) => {
        if (!open) request.closeConsent()
      }}
    >
      <DialogContent showCloseButton={false}>
        <DialogHeader>
          <div className="flex items-center gap-3">
            {picture ? (
              <img
                alt=""
                aria-hidden
                className="size-14 shrink-0 select-none object-contain"
                data-slot="buddy-chat-consent-picture"
                decoding="async"
                draggable={false}
                src={picture}
              />
            ) : (
              <BuddyEmblem size="lg" />
            )}
            <div className="flex flex-col gap-1">
              <DialogTitle>{buddyPostingConsentTitle(name)}</DialogTitle>
              <DialogDescription data-testid="buddy-chat-consent-sentence">
                {buddyPostingConsentSentence(name)}
              </DialogDescription>
            </div>
          </div>
        </DialogHeader>
        <DialogFooter>
          <Button type="button" variant="ghost" onClick={request.closeConsent}>
            Not now
          </Button>
          <Button data-testid="buddy-chat-accept" type="button" onClick={request.acceptConsent}>
            Allow
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function readPostingConsent(): boolean {
  try {
    return localStorage.getItem(BUDDY_AUTO_CHAT_CONSENT_STORAGE_KEY) === '1'
  } catch {
    return false
  }
}

function persistPostingConsent(): void {
  try {
    localStorage.setItem(BUDDY_AUTO_CHAT_CONSENT_STORAGE_KEY, '1')
  } catch {
    // Private storage can refuse; the dialog then asks again next time.
  }
}
