import { CloseIcon } from '@/components/icons'
import { useEffect, useState, type ReactElement } from 'react'

import { PanelSection } from '@/components/panel-section'
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from '@/components/ui/field'
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput
} from '@/components/ui/input-group'
import { ShortcutKeys } from '@/components/ui/shortcut-keys'
import { Slider } from '@/components/ui/slider'
import { SegmentedControl, type SegmentedControlOption } from '@/components/ui/segmented-control'
import { Switch } from '@/components/ui/switch'
import { setCohostSensitivity, useCohostSensitivity } from '@/hooks/use-cohost-sensitivity'
import { useStudioChat, useStudioCore } from '@/hooks/use-studio'
import type { CohostAutoChat, CohostSettings, CohostSettingsPatch, CohostTone } from '@/lib/backend'
import { BUDDY_POSTS_PROMISE } from '@/lib/buddy-auto-chat-view'
import { buddyTabLabel } from '@/lib/buddy-tabs'
import {
  COHOST_LISTEN_CONSENT_SENTENCE,
  COHOST_SENSITIVITIES,
  COHOST_SENSITIVITY_LABELS,
  cohostListenAllowanceLabel
} from '@/lib/cohost-view'

/** Mirrors the backend caps (`COHOST_RULES_MAX` / `COHOST_RULE_MAX_CHARS`). */
export const COHOST_RULES_MAX = 10
export const COHOST_RULE_MAX_CHARS = 120

const TONE_OPTIONS: SegmentedControlOption<CohostTone>[] = [
  { value: 'friendly', label: 'Friendly' },
  { value: 'short', label: 'Short' },
  { value: 'professional', label: 'Professional' }
]

/** "Show on stream automatically" (plan 060 D8): one three-way choice over the
 * two engine flags. `autoHighlight` keeps meaning Buddy's picks and
 * `voiceHighlight` means what the streamer talks about. */
export type CohostShowOnStreamMode = 'off' | 'voice' | 'voice-and-picks'

export const COHOST_SHOW_ON_STREAM_MODES: readonly CohostShowOnStreamMode[] = [
  'off',
  'voice',
  'voice-and-picks'
]

export const COHOST_SHOW_ON_STREAM_LABELS: Record<CohostShowOnStreamMode, string> = {
  off: 'Off',
  voice: 'What I talk about',
  'voice-and-picks': "What I talk about and Buddy's picks"
}

export const COHOST_SHOW_ON_STREAM_PATCHES: Record<
  CohostShowOnStreamMode,
  Required<Pick<CohostSettingsPatch, 'autoHighlight' | 'voiceHighlight'>>
> = {
  off: { autoHighlight: false, voiceHighlight: false },
  voice: { autoHighlight: false, voiceHighlight: true },
  'voice-and-picks': { autoHighlight: true, voiceHighlight: true }
}

/** Picks alone (stored before the voice source existed) reads as the third
 * option; choosing it again writes both flags. */
export function cohostShowOnStreamMode(
  settings: Pick<CohostSettings, 'autoHighlight' | 'voiceHighlight'>
): CohostShowOnStreamMode {
  if (settings.autoHighlight) return 'voice-and-picks'
  return settings.voiceHighlight ? 'voice' : 'off'
}

/**
 * Saving Buddy's settings (plan 119; Settings → Buddy before). Persisted per
 * profile through `cohost.settings.get/set` (the engine reads the same row
 * when it builds a tick), NOT through local settings — so what the streamer
 * types here is what the model is given.
 *
 * Buddy Live's switch owns `enabled` and the Premium gate's call to action,
 * so neither repeats here: a locked account sees these controls disabled.
 */
function useCohostSettingsSave(lockedByTab = false): {
  cohostSettings: CohostSettings | null
  locked: boolean
  save: (patch: CohostSettingsPatch) => void
  error: string | null
  clearError: () => void
} {
  const { cohostSettings, cohostGate, patchCohostSettings } = useStudioCore()
  const [error, setError] = useState<string | null>(null)
  const save = (patch: CohostSettingsPatch): void => {
    setError(null)
    void patchCohostSettings(patch).catch((failure: unknown) =>
      setError(failure instanceof Error ? failure.message : "Couldn't save Buddy settings.")
    )
  }
  return {
    cohostSettings: cohostSettings ?? null,
    locked: !cohostGate.allowed || lockedByTab,
    save,
    error,
    clearError: () => setError(null)
  }
}

/** A save that failed, under the section it belongs to. */
function SaveError({ error }: { error: string | null }): ReactElement | null {
  return error ? <FieldError data-testid="cohost-save-error">{error}</FieldError> : null
}

/**
 * "Buddy hears you while you're live" (plan 068), on the Buddy tab's Live tab
 * (plan 150): listening is part of what turning Buddy on means, so it sits
 * under Buddy Live's switch rather than with the reply settings.
 */
export function CohostListenField({
  locked: lockedByTab = false
}: {
  /** Buddy Live's unlock reason shows above: everything here is disabled (plan 150, D7). */
  locked?: boolean
} = {}): ReactElement | null {
  const { cohostSettings, locked, save, error } = useCohostSettingsSave(lockedByTab)
  if (!cohostSettings) return null
  // The error sits under the card, as in Moderation: a row in a grouped card
  // that is not a Field gets none of the card's padding (plan 168 S-02).
  return (
    <>
      <FieldGroup variant="grouped">
        <Field>
          <div className="flex items-center justify-between gap-3">
            <div className="flex min-w-0 flex-col gap-0.5">
              <FieldLabel htmlFor="cohost-listen">
                Buddy hears you while you&apos;re live
              </FieldLabel>
              <p className="text-xs text-muted-foreground">{COHOST_LISTEN_CONSENT_SENTENCE}</p>
              <CohostListenAllowance />
            </div>
            <Switch
              checked={cohostSettings.listen === true}
              disabled={locked}
              id="cohost-listen"
              onCheckedChange={(listen) => save({ listen })}
            />
          </div>
        </Field>
      </FieldGroup>
      <SaveError error={error} />
    </>
  )
}

/**
 * Replies (plan 150, Chat tab): how Buddy drafts the replies you approve.
 * The facts it answers from are "About you", under Name and personality
 * (plan 174 G-9): one name, one home.
 */
export function BuddyRepliesSection({
  locked: lockedByTab = false
}: {
  /** Buddy Live's unlock reason shows above: everything here is disabled (plan 150, D7). */
  locked?: boolean
} = {}): ReactElement | null {
  const { cohostSettings, locked, save, error } = useCohostSettingsSave(lockedByTab)
  if (!cohostSettings) {
    return null
  }
  const autoChat = cohostSettings.autoChat
  const saveAutoChat = (next: CohostAutoChat): void => save({ autoChat: next })
  return (
    <PanelSection
      description={`How Buddy drafts the replies you approve. It answers from About you, under Name and personality on the ${buddyTabLabel('live')} tab. Answers and Banter post as you, only in the modes you turn on in Stream Manager.`}
      title="Replies"
    >
      <FieldGroup variant="grouped">
        {/* Plan 164 S-D5: the two AI behaviours and their cooldowns. Premium
            and cloud AI, like the rest of this tab. */}
        <CohostCooldownField
          cooldown={autoChat.answers.cooldownSeconds}
          description="A reply when a viewer asks Buddy by name, at most one per cooldown."
          enabled={autoChat.answers.enabled}
          id="cohost-answers"
          label="Answers"
          locked={locked}
          max={300}
          onChange={(answers) => saveAutoChat({ ...autoChat, answers })}
        />
        <CohostCooldownField
          cooldown={autoChat.banter.cooldownSeconds}
          description="A short remark when you've been quiet for a while, never within a minute of a greeting or an answer."
          enabled={autoChat.banter.enabled}
          id="cohost-banter"
          label="Banter"
          locked={locked}
          max={1800}
          onChange={(banter) => saveAutoChat({ ...autoChat, banter })}
        />
        <Field>
          <FieldLabel>Reply tone</FieldLabel>
          <FieldDescription>How the drafted replies read before you edit them.</FieldDescription>
          <SegmentedControl
            className="w-fit"
            disabled={locked}
            id="cohost-tone"
            options={TONE_OPTIONS}
            size="sm"
            value={cohostSettings.tone}
            onValueChange={(tone) => save({ tone })}
          />
        </Field>
      </FieldGroup>
      <SaveError error={error} />
    </PanelSection>
  )
}

/** One AI behaviour with its switch and cooldown slider (plan 164 S-D5). */
function CohostCooldownField({
  id,
  label,
  description,
  enabled,
  cooldown,
  max,
  locked,
  onChange
}: {
  id: string
  label: string
  description: string
  enabled: boolean
  cooldown: number
  max: number
  locked: boolean
  onChange: (next: { enabled: boolean; cooldownSeconds: number }) => void
}): ReactElement {
  const [draft, setDraft] = useState(cooldown)
  useEffect(() => setDraft(cooldown), [cooldown])
  return (
    <Field>
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-0.5">
          <FieldLabel htmlFor={id}>{label}</FieldLabel>
          <FieldDescription>{description}</FieldDescription>
        </div>
        <Switch
          checked={enabled}
          disabled={locked}
          id={id}
          onCheckedChange={(next) => onChange({ enabled: next, cooldownSeconds: cooldown })}
        />
      </div>
      <div className="flex items-center gap-3">
        <Slider
          aria-label={`${label} cooldown`}
          className="max-w-56"
          disabled={locked}
          max={max}
          min={5}
          step={5}
          value={[draft]}
          onValueChange={([value]) => {
            if (value !== undefined) setDraft(value)
          }}
          onValueCommit={([value]) => {
            if (value !== undefined && value !== cooldown) {
              onChange({ enabled, cooldownSeconds: value })
            }
          }}
        />
        <span className="text-xs tabular-nums text-muted-foreground">
          {cooldownLabel(draft)} cooldown
        </span>
      </div>
    </Field>
  )
}

function cooldownLabel(seconds: number): string {
  if (seconds < 60) return `${seconds} s`
  const minutes = Math.floor(seconds / 60)
  const rest = seconds % 60
  return rest === 0 ? `${minutes} min` : `${minutes} min ${rest} s`
}

/**
 * Moderation (plan 150, Chat tab): what Buddy flags for you and what it may
 * put on stream. It posts only in the modes you turn on (plan 164 D4).
 */
export function BuddyModerationSection({
  locked: lockedByTab = false
}: {
  /** Buddy Live's unlock reason shows above: everything here is disabled (plan 150, D7). */
  locked?: boolean
} = {}): ReactElement | null {
  const { cohostSettings, locked, save, error } = useCohostSettingsSave(lockedByTab)
  const [ruleDraft, setRuleDraft] = useState('')
  const sensitivity = useCohostSensitivity()
  if (!cohostSettings) {
    return null
  }
  const showOnStream = cohostShowOnStreamMode(cohostSettings)
  const saveShowOnStream = (mode: CohostShowOnStreamMode): void => {
    const patch = COHOST_SHOW_ON_STREAM_PATCHES[mode]
    if (
      patch.autoHighlight !== cohostSettings.autoHighlight ||
      patch.voiceHighlight !== cohostSettings.voiceHighlight
    ) {
      save(patch)
    }
  }
  const rules = cohostSettings.rules ?? []
  const rulesFull = rules.length >= COHOST_RULES_MAX
  const addRule = (): void => {
    const rule = ruleDraft.trim()
    if (!rule || rulesFull) return
    setRuleDraft('')
    save({ rules: [...rules, rule] })
  }
  return (
    <PanelSection
      description={`What Buddy flags for you, and what it may put on stream. ${BUDDY_POSTS_PROMISE}`}
      title="Moderation"
    >
      <FieldGroup variant="grouped">
        <Field>
          <FieldLabel htmlFor="cohost-rule-new">Chat rules</FieldLabel>
          <FieldDescription>
            Plain-language rules Buddy flags for you, like “no spoilers” or “English only”.
          </FieldDescription>
          {rules.length > 0 ? (
            <ul aria-label="Chat rules" className="flex flex-col gap-1.5">
              {rules.map((rule, index) => (
                // Keyed on the saved text: a save (or a backend trim) remounts
                // the row with the stored value instead of syncing a draft.
                <li key={`${index}:${rule}`}>
                  <InputGroup>
                    <InputGroupInput
                      aria-label={`Chat rule ${index + 1}`}
                      defaultValue={rule}
                      disabled={locked}
                      maxLength={COHOST_RULE_MAX_CHARS}
                      onBlur={(event) => {
                        const next = event.target.value.trim()
                        if (next === rule) return
                        save({
                          rules: next
                            ? rules.map((current, at) => (at === index ? next : current))
                            : rules.filter((_, at) => at !== index)
                        })
                      }}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter') event.currentTarget.blur()
                      }}
                    />
                    <InputGroupAddon align="inline-end">
                      <InputGroupButton
                        aria-label={`Remove chat rule ${index + 1}`}
                        disabled={locked}
                        size="icon-xs"
                        onClick={() => save({ rules: rules.filter((_, at) => at !== index) })}
                      >
                        <CloseIcon />
                      </InputGroupButton>
                    </InputGroupAddon>
                  </InputGroup>
                </li>
              ))}
            </ul>
          ) : null}
          <InputGroup>
            <InputGroupInput
              disabled={locked || rulesFull}
              id="cohost-rule-new"
              maxLength={COHOST_RULE_MAX_CHARS}
              placeholder={rulesFull ? 'Remove a rule to add another' : 'Add a rule…'}
              value={ruleDraft}
              onChange={(event) => setRuleDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault()
                  addRule()
                }
              }}
            />
            <InputGroupAddon align="inline-end">
              <InputGroupButton
                disabled={locked || rulesFull || ruleDraft.trim().length === 0}
                size="xs"
                onClick={addRule}
              >
                Add
                <ShortcutKeys accelerator="Enter" />
              </InputGroupButton>
            </InputGroupAddon>
          </InputGroup>
          <span className="text-xs tabular-nums text-muted-foreground">
            {rules.length}/{COHOST_RULES_MAX}
          </span>
        </Field>
        <Field>
          <FieldLabel>Flag sensitivity</FieldLabel>
          <FieldDescription>
            How sure Buddy must be before a flag shows up. Relaxed shows only the clear cases,
            Strict shows everything it noticed.
          </FieldDescription>
          <SegmentedControl
            className="w-fit"
            disabled={locked}
            id="cohost-sensitivity"
            options={COHOST_SENSITIVITIES.map((step) => ({
              value: step,
              label: COHOST_SENSITIVITY_LABELS[step]
            }))}
            size="sm"
            value={sensitivity}
            onValueChange={setCohostSensitivity}
          />
        </Field>
        <Field>
          {/* Plan 174 F-18: "Show on stream" is the question's own action;
              the Buddy overlay is "{name} on stream"; this is the automatic one. */}
          <FieldLabel>Put comments on stream automatically</FieldLabel>
          <FieldDescription>
            Puts a chat comment on your stream by itself. You can always show one yourself with H.
          </FieldDescription>
          <SegmentedControl
            className="w-fit"
            disabled={locked}
            id="cohost-show-on-stream"
            options={COHOST_SHOW_ON_STREAM_MODES.map((mode) => ({
              value: mode,
              label: COHOST_SHOW_ON_STREAM_LABELS[mode],
              // Choosing the checked option again rewrites a stored picks-only
              // row as both flags on (cohostShowOnStreamMode).
              onClick: mode === showOnStream ? () => saveShowOnStream(mode) : undefined
            }))}
            size="sm"
            value={showOnStream}
            onValueChange={saveShowOnStream}
          />
          <FieldDescription className="flex flex-col gap-0.5">
            <span>What I talk about needs Buddy to hear you (or live captions).</span>
            <span>
              Buddy&apos;s picks: at most one card every 45 seconds; nothing Buddy flagged is ever
              shown.
            </span>
          </FieldDescription>
        </Field>
      </FieldGroup>
      <SaveError error={error} />
    </PanelSection>
  )
}

/**
 * Listening time left this month, or that it is used up (plan 068). Its own
 * component so only this line follows the live chat context; the server
 * reports the allowance on a chunk it metered as listening, so the line is
 * often absent.
 */
function CohostListenAllowance(): ReactElement | null {
  const { cohostState } = useStudioChat()
  const allowance = cohostListenAllowanceLabel(cohostState?.listening)
  if (!allowance) return null
  return (
    <p className="text-xs tabular-nums text-muted-foreground" data-slot="cohost-listen-allowance">
      {allowance}
    </p>
  )
}
