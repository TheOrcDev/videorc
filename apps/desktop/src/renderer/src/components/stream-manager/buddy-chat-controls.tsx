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
  buddyModeChangeStep,
  buddyPostingConsentSentence,
  buddyPostingConsentTitle,
  buddyTalkHint,
  buddyTalkLabel
} from '@/lib/buddy-auto-chat-view'

/**
 * The Buddy pane's talk control (plan 164 S-D6, plan 174 S3.14a, D7, plan
 * 211 D1): one "{name} talks: Off | Bubble | Suggest" segmented control that
 * governs only how Buddy talks on its own, with the chosen value's meaning
 * as a line under it, never a tooltip. Whether Buddy runs at all is Buddy
 * Live, its own switch in the pane header: this control never turns Buddy on
 * or off. Off and Bubble apply at once, because Buddy posts nothing as you in
 * either; the first time Suggest is chosen the consent dialog says what
 * posting as you means (plan 211 D5).
 *
 * Greetings, Answers and Banter have one home, Buddy → Chat (plan 174 F-24):
 * here they are read-only summary chips, each a way there.
 */
export function BuddyChatControls({
  autoChat,
  aiGreetings = false,
  name = null,
  picture = null,
  disabled = false,
  onTalkChange,
  onOpenChatSettings
}: {
  autoChat: CohostAutoChat
  /**
   * Buddy may write greetings with AI (plan 192 D3, D7): Premium and cloud AI
   * allowed. With Greetings' own AI switch on, the chip says "· AI".
   */
  aiGreetings?: boolean
  /** The streamer's name for Buddy: the label and the consent dialog use it. */
  name?: string | null
  /**
   * That Buddy's own picture (its idle pose): the consent dialog shows the
   * Buddy it names, not the feature emblem. Absent, the emblem.
   */
  picture?: string | null
  disabled?: boolean
  onTalkChange: (talk: CohostTalkMode) => void
  /** Opens Buddy → Chat in the main window. Absent, the chips are inert. */
  onOpenChatSettings?: () => void
}): ReactElement {
  const [postingConsented, setPostingConsented] = useState(() => readPostingConsent())
  const [consentOpen, setConsentOpen] = useState(false)

  const requestTalk = (next: CohostTalkMode): void => {
    if (next === autoChat.talk) return
    if (buddyModeChangeStep({ next, consented: postingConsented }) === 'consent') {
      setConsentOpen(true)
      return
    }
    onTalkChange(next)
  }

  // The consent is asked only on the way to Suggest, so Allow lands there.
  const acceptConsent = (): void => {
    persistPostingConsent()
    setPostingConsented(true)
    setConsentOpen(false)
    onTalkChange('suggest')
  }

  return (
    <>
      <div
        className="flex min-w-0 flex-col gap-1.5 border-b border-border px-3 py-2"
        data-slot="buddy-chat-controls"
      >
        <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1.5">
          {/* The label carries the Buddy's name, so a long one (24
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
              onValueChange={requestTalk}
            />
          </div>
          {/* Read-only: the behaviours are switched in Buddy → Chat, their
              one home (plan 174 D7). The tone rides the dot, the words say
              the state, and each chip is the way there. */}
          <div
            aria-label="What Buddy says"
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
                    onClick={onOpenChatSettings}
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

      <Dialog open={consentOpen} onOpenChange={setConsentOpen}>
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
            <Button type="button" variant="ghost" onClick={() => setConsentOpen(false)}>
              Not now
            </Button>
            <Button data-testid="buddy-chat-accept" type="button" onClick={acceptConsent}>
              Allow
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
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
