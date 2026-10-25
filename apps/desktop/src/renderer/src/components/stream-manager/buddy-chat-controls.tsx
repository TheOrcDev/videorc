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
import type { CohostAutoChat, CohostAutoChatMode } from '@/lib/backend'
import {
  BUDDY_AUTO_CHAT_CONSENT_STORAGE_KEY,
  BUDDY_AUTO_CONFIRM_SENTENCE,
  BUDDY_MODE_HINTS,
  BUDDY_MODE_LABELS,
  BUDDY_MODES,
  BUDDY_POSTING_LABEL,
  buddyBehaviourChips,
  buddyModeChangeStep,
  buddyPostingConsentSentence,
  buddyPostingConsentTitle
} from '@/lib/buddy-auto-chat-view'

/**
 * The Buddy pane's chat posting control (plan 164 S-D6, plan 174 S3.14a, D7):
 * one `Off | Suggest | Auto` segmented control that governs only what Buddy
 * posts as you, with the chosen mode's meaning as a line under it, never a
 * tooltip. Whether Buddy runs at all is Buddy Live, its own switch in the
 * pane header: this control never turns Buddy on or off. The first time the
 * mode leaves Off the consent dialog says what posting as you means; Auto
 * asks once more, every time.
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
  onModeChange,
  onOpenChatSettings
}: {
  autoChat: CohostAutoChat
  /**
   * Buddy may write greetings with AI (plan 192 D3, D7): Premium and cloud AI
   * allowed. With Greetings' own AI switch on, the chip says "· AI".
   */
  aiGreetings?: boolean
  /** The streamer's name for Buddy: the consent dialog asks in its name. */
  name?: string | null
  /**
   * That Buddy's own picture (its idle pose): the consent dialog shows the
   * Buddy it names, not the feature emblem. Absent, the emblem.
   */
  picture?: string | null
  disabled?: boolean
  onModeChange: (mode: CohostAutoChatMode) => void
  /** Opens Buddy → Chat in the main window. Absent, the chips are inert. */
  onOpenChatSettings?: () => void
}): ReactElement {
  const [postingConsented, setPostingConsented] = useState(() => readPostingConsent())
  const [pending, setPending] = useState<CohostAutoChatMode | null>(null)
  const [step, setStep] = useState<'consent' | 'confirm-auto' | null>(null)

  const requestMode = (next: CohostAutoChatMode): void => {
    if (next === autoChat.mode) return
    const needed = buddyModeChangeStep({ next, consented: postingConsented })
    if (needed === 'apply') {
      onModeChange(next)
      return
    }
    setPending(next)
    setStep(needed)
  }

  const closeDialog = (): void => {
    setPending(null)
    setStep(null)
  }

  // Consent lands in Suggest (plan 164 D4); Auto then needs its own click.
  const acceptConsent = (): void => {
    persistPostingConsent()
    setPostingConsented(true)
    onModeChange('suggest')
    if (pending === 'auto') {
      setStep('confirm-auto')
      return
    }
    closeDialog()
  }

  const confirmAuto = (): void => {
    onModeChange('auto')
    closeDialog()
  }

  return (
    <>
      <div
        className="flex min-w-0 flex-col gap-1.5 border-b border-border px-3 py-2"
        data-slot="buddy-chat-controls"
      >
        <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1.5">
          <div className="flex min-w-0 items-center gap-2">
            <span className="shrink-0 text-label text-subtle" id="buddy-chat-posting-label">
              {BUDDY_POSTING_LABEL}
            </span>
            <SegmentedControl
              aria-describedby="buddy-chat-posting-hint"
              aria-labelledby="buddy-chat-posting-label"
              disabled={disabled}
              options={BUDDY_MODES.map((mode) => ({
                value: mode,
                label: BUDDY_MODE_LABELS[mode],
                'data-buddy-mode': mode
              }))}
              size="sm"
              value={autoChat.mode}
              onValueChange={requestMode}
            />
          </div>
          {/* Read-only: the behaviours are switched in Buddy → Chat, their
              one home (plan 174 D7). The tone rides the dot, the words say
              the state, and each chip is the way there. */}
          <div
            aria-label="What Buddy posts"
            className="flex min-w-0 flex-wrap items-center gap-1"
            data-slot="buddy-behaviour-chips"
            role="group"
          >
            {buddyBehaviourChips(autoChat, { aiGreetings }).map((chip) => (
              <Badge key={chip.id} asChild variant={chip.on ? 'success' : 'neutral'}>
                <button
                  aria-label={chip.name}
                  data-behaviour={chip.id}
                  data-on={chip.on || undefined}
                  data-testid="buddy-behaviour-chip"
                  disabled={!onOpenChatSettings}
                  type="button"
                  onClick={onOpenChatSettings}
                >
                  {chip.text}
                </button>
              </Badge>
            ))}
          </div>
        </div>
        <p
          className="text-xs text-muted-foreground"
          data-slot="buddy-mode-hint"
          id="buddy-chat-posting-hint"
        >
          {BUDDY_MODE_HINTS[autoChat.mode]}
        </p>
      </div>

      <Dialog
        open={step !== null}
        onOpenChange={(open) => {
          if (!open) closeDialog()
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
                <DialogTitle>
                  {step === 'confirm-auto' ? 'Turn on Auto?' : buddyPostingConsentTitle(name)}
                </DialogTitle>
                <DialogDescription data-testid="buddy-chat-consent-sentence">
                  {step === 'confirm-auto'
                    ? BUDDY_AUTO_CONFIRM_SENTENCE
                    : buddyPostingConsentSentence(name)}
                </DialogDescription>
              </div>
            </div>
          </DialogHeader>
          {step === 'consent' ? (
            <p className="text-xs text-muted-foreground">
              You land in Suggest: every message is a card here, and one click sends it.
            </p>
          ) : null}
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={closeDialog}>
              Not now
            </Button>
            {step === 'confirm-auto' ? (
              <Button data-testid="buddy-chat-confirm-auto" type="button" onClick={confirmAuto}>
                Turn on Auto
              </Button>
            ) : (
              <Button data-testid="buddy-chat-accept" type="button" onClick={acceptConsent}>
                Allow
              </Button>
            )}
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
