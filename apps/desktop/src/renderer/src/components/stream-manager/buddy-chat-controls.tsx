import { useState, type ReactElement } from 'react'

import { BuddyEmblem } from '@/components/buddy-emblem'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import type { CohostAutoChat, CohostAutoChatMode, CohostAutoChatRelayPatch } from '@/lib/backend'
import type { EntitlementUiGate } from '@/lib/entitlement-ui'
import {
  BUDDY_AUTO_CHAT_CONSENT_STORAGE_KEY,
  BUDDY_AUTO_CONFIRM_SENTENCE,
  BUDDY_CONSENT_SENTENCE,
  BUDDY_MODE_HINTS,
  BUDDY_MODE_LABELS,
  BUDDY_MODES,
  buddyModeChangeStep
} from '@/lib/buddy-auto-chat-view'
import { cn } from '@/lib/utils'

/**
 * The Buddy pane's chat mode (plan 164 S-D6): one `Off | Suggest | Auto`
 * segmented control and the three behaviour switches. The first time the
 * mode leaves Off the consent dialog says what posting as you means; Auto
 * asks once more, every time. Greetings are free; Answers and Banter need
 * Premium and cloud AI, and read disabled with the reason until then.
 */
export function BuddyChatControls({
  autoChat,
  gate,
  consented,
  disabled = false,
  onChange
}: {
  autoChat: CohostAutoChat
  gate: EntitlementUiGate
  /** Cloud-AI consent: Answers and Banter send chat to the cloud. */
  consented: boolean
  disabled?: boolean
  onChange: (patch: CohostAutoChatRelayPatch) => void
}): ReactElement {
  const [postingConsented, setPostingConsented] = useState(() => readPostingConsent())
  const [pending, setPending] = useState<CohostAutoChatMode | null>(null)
  const [step, setStep] = useState<'consent' | 'confirm-auto' | null>(null)

  const aiReason = !gate.allowed ? gate.reason : !consented ? 'Needs cloud AI.' : null

  const requestMode = (next: CohostAutoChatMode): void => {
    if (next === autoChat.mode) return
    const needed = buddyModeChangeStep({ next, consented: postingConsented })
    if (needed === 'apply') {
      onChange({ mode: next })
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
    onChange({ mode: 'suggest' })
    if (pending === 'auto') {
      setStep('confirm-auto')
      return
    }
    closeDialog()
  }

  const confirmAuto = (): void => {
    onChange({ mode: 'auto' })
    closeDialog()
  }

  return (
    <>
      <div
        className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1.5 border-b border-border px-3 py-1.5"
        data-slot="buddy-chat-controls"
      >
        <div className="flex min-w-0 items-center gap-2">
          <span className="shrink-0 text-[11px] font-semibold text-subtle">Chat</span>
          <ToggleGroup
            aria-label="Buddy chat mode"
            disabled={disabled}
            size="sm"
            type="single"
            value={autoChat.mode}
            onValueChange={(value) => {
              if (value) requestMode(value as CohostAutoChatMode)
            }}
          >
            {BUDDY_MODES.map((mode) => (
              <ToggleGroupItem
                key={mode}
                className="px-2.5 text-xs"
                data-buddy-mode={mode}
                title={BUDDY_MODE_HINTS[mode]}
                value={mode}
              >
                {BUDDY_MODE_LABELS[mode]}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
        </div>
        <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
          <BuddyBehaviourSwitch
            checked={autoChat.greetings.enabled}
            disabled={disabled}
            id="buddy-greetings"
            label="Greetings"
            title="Your own templates for follows, subs, cheers, raids and the rest. Free."
            onCheckedChange={(greetings) => onChange({ greetings })}
          />
          <BuddyBehaviourSwitch
            checked={autoChat.answers.enabled}
            disabled={disabled || aiReason !== null}
            id="buddy-answers"
            label="Answers"
            title={aiReason ?? 'A reply when a viewer asks the Buddy by name.'}
            onCheckedChange={(answers) => onChange({ answers })}
          />
          <BuddyBehaviourSwitch
            checked={autoChat.banter.enabled}
            disabled={disabled || aiReason !== null}
            id="buddy-banter"
            label="Banter"
            title={aiReason ?? 'A remark on dead air, rarely.'}
            onCheckedChange={(banter) => onChange({ banter })}
          />
        </div>
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
              <BuddyEmblem size="lg" />
              <div className="flex flex-col gap-1">
                <DialogTitle>
                  {step === 'confirm-auto' ? 'Turn on Auto?' : 'Let the Buddy post as you?'}
                </DialogTitle>
                <DialogDescription data-testid="buddy-chat-consent-sentence">
                  {step === 'confirm-auto' ? BUDDY_AUTO_CONFIRM_SENTENCE : BUDDY_CONSENT_SENTENCE}
                </DialogDescription>
              </div>
            </div>
          </DialogHeader>
          {step === 'consent' ? (
            <p className="text-xs text-subtle">
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

function BuddyBehaviourSwitch({
  id,
  label,
  title,
  checked,
  disabled,
  onCheckedChange
}: {
  id: string
  label: string
  title: string
  checked: boolean
  disabled: boolean
  onCheckedChange: (checked: boolean) => void
}): ReactElement {
  return (
    <div className={cn('flex items-center gap-1.5', disabled && 'opacity-70')} title={title}>
      <Switch
        checked={checked}
        disabled={disabled}
        id={id}
        size="sm"
        onCheckedChange={onCheckedChange}
      />
      <Label className="text-xs font-normal text-muted-foreground" htmlFor={id}>
        {label}
      </Label>
    </div>
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
