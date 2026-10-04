import { CloseIcon } from '@/components/icons'
import { useEffect, useRef, useState, type ReactElement } from 'react'

import { PanelSection } from '@/components/panel-section'
import { Field, FieldDescription, FieldGroup, FieldLabel } from '@/components/ui/field'
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput
} from '@/components/ui/input-group'
import { Kbd } from '@/components/ui/kbd'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { setCohostSensitivity, useCohostSensitivity } from '@/hooks/use-cohost-sensitivity'
import { useStudioChat, useStudioCore } from '@/hooks/use-studio'
import type { CohostSettings, CohostSettingsPatch, CohostTone } from '@/lib/backend'
import {
  COHOST_LISTEN_CONSENT_SENTENCE,
  COHOST_SENSITIVITIES,
  COHOST_SENSITIVITY_LABELS,
  cohostListenAllowanceLabel,
  type CohostSensitivity
} from '@/lib/cohost-view'
import { cn } from '@/lib/utils'

export const COHOST_NOTES_MAX_CHARS = 4000
/** Mirrors the backend caps (`COHOST_RULES_MAX` / `COHOST_RULE_MAX_CHARS`). */
export const COHOST_RULES_MAX = 10
export const COHOST_RULE_MAX_CHARS = 120

const TONE_LABELS: Record<CohostTone, string> = {
  friendly: 'Friendly',
  short: 'Short',
  professional: 'Professional'
}

/** "Show on stream automatically" (plan 060 D8): one three-way choice over the
 * two engine flags. `autoHighlight` keeps meaning Orcle's picks and
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
  'voice-and-picks': "What I talk about and Orcle's picks"
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
 * Saving Orcle's settings (plan 119; Settings → Orcle before). Persisted per
 * profile through `cohost.settings.get/set` (the engine reads the same row
 * when it builds a tick), NOT through local settings — so what the streamer
 * types here is what the model is given.
 *
 * Orcle Live's switch owns `enabled` and the Premium gate's call to action,
 * so neither repeats here: a locked account sees these controls disabled.
 */
function useCohostSettingsSave(): {
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
      setError(failure instanceof Error ? failure.message : 'Could not save Orcle settings.')
    )
  }
  return {
    cohostSettings: cohostSettings ?? null,
    locked: !cohostGate.allowed,
    save,
    error,
    clearError: () => setError(null)
  }
}

/** A save that failed, under the section it belongs to. */
function SaveError({ error }: { error: string | null }): ReactElement | null {
  return error ? (
    <p className="text-xs text-destructive" data-slot="cohost-save-error">
      {error}
    </p>
  ) : null
}

/**
 * "Orcle hears you while you're live" (plan 068), on the Orcle tab's Live tab
 * (plan 150): listening is part of what turning Orcle on means, so it sits
 * under Orcle Live's switch rather than with the reply settings.
 */
export function CohostListenField(): ReactElement | null {
  const { cohostSettings, locked, save, error } = useCohostSettingsSave()
  if (!cohostSettings) return null
  return (
    <FieldGroup variant="grouped" data-slot="cohost-listen-field">
      <Field>
        <div className="flex items-center justify-between gap-3">
          <div className="flex min-w-0 flex-col gap-0.5">
            <FieldLabel htmlFor="cohost-listen">Orcle hears you while you&apos;re live</FieldLabel>
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
      <SaveError error={error} />
    </FieldGroup>
  )
}

/**
 * Replies (plan 150, Chat tab): how Orcle drafts the replies you approve, and
 * the facts it answers from.
 */
export function OrcleRepliesSection(): ReactElement | null {
  const { cohostSettings, locked, save, error } = useCohostSettingsSave()
  const [notesDraft, setNotesDraft] = useState('')
  const savedNotesRef = useRef<string | null>(null)
  // Follow the backend value until the streamer starts typing; after that the
  // draft is the truth until it is saved.
  useEffect(() => {
    const notes = cohostSettings?.notes ?? ''
    if (savedNotesRef.current === notes) return
    savedNotesRef.current = notes
    setNotesDraft(notes)
  }, [cohostSettings?.notes])
  if (!cohostSettings) {
    return null
  }
  const notesOverLimit = notesDraft.length > COHOST_NOTES_MAX_CHARS
  const notesDirty = notesDraft !== (cohostSettings.notes ?? '')
  const notesError = error
  return (
    <PanelSection
      description="How Orcle drafts the replies you approve, and the facts it answers from."
      title="Replies"
    >
      <FieldGroup variant="grouped">
        <Field>
          <FieldLabel htmlFor="cohost-tone">Reply tone</FieldLabel>
          <FieldDescription>How the drafted replies read before you edit them.</FieldDescription>
          <ToggleGroup
            className="w-fit"
            disabled={locked}
            id="cohost-tone"
            size="sm"
            type="single"
            value={cohostSettings.tone}
            onValueChange={(tone) => {
              if (tone) save({ tone: tone as CohostTone })
            }}
          >
            {(Object.keys(TONE_LABELS) as CohostTone[]).map((tone) => (
              <ToggleGroupItem key={tone} className="px-3 text-xs" value={tone}>
                {TONE_LABELS[tone]}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
        </Field>
        <Field>
          <FieldLabel htmlFor="cohost-notes">Orcle notes</FieldLabel>
          <FieldDescription>
            Facts Orcle answers from, one per line. For example:
            <br />
            <span className="text-subtle">Keyboard: Keychron Q1 with Boba U4T switches.</span>
            <br />
            <span className="text-subtle">
              Streaming schedule: Tuesdays and Fridays, 19:00 CET.
            </span>
          </FieldDescription>
          <Textarea
            className="min-h-28"
            disabled={locked}
            id="cohost-notes"
            maxLength={COHOST_NOTES_MAX_CHARS}
            placeholder="What people keep asking you: gear, schedule, links, prices…"
            value={notesDraft}
            onBlur={() => {
              if (!notesDirty || notesOverLimit) return
              savedNotesRef.current = notesDraft
              save({ notes: notesDraft })
            }}
            onChange={(event) => setNotesDraft(event.target.value)}
          />
          <div className="flex items-center gap-2">
            <span
              className={cn(
                'text-xs tabular-nums',
                notesOverLimit ? 'text-destructive' : 'text-subtle'
              )}
            >
              {notesDraft.length}/{COHOST_NOTES_MAX_CHARS}
            </span>
            {notesDirty ? (
              <span className="text-xs text-muted-foreground">Unsaved. Click away to save.</span>
            ) : null}
            {notesError ? <span className="text-xs text-destructive">{notesError}</span> : null}
          </div>
        </Field>
      </FieldGroup>
    </PanelSection>
  )
}

/**
 * Moderation (plan 150, Chat tab): what Orcle flags for you and what it may
 * put on stream. Orcle never acts on its own.
 */
export function OrcleModerationSection(): ReactElement | null {
  const { cohostSettings, locked, save, error } = useCohostSettingsSave()
  const [ruleDraft, setRuleDraft] = useState('')
  const sensitivity = useCohostSensitivity()
  if (!cohostSettings) {
    return null
  }
  const showOnStream = cohostShowOnStreamMode(cohostSettings)
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
      description="What Orcle flags for you, and what it may put on stream. Orcle never acts on its own."
      title="Moderation"
    >
      <FieldGroup variant="grouped">
        <Field>
          <FieldLabel htmlFor="cohost-rule-new">Chat rules</FieldLabel>
          <FieldDescription>
            Plain-language rules Orcle flags for you, like “no spoilers” or “English only”.
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
                <Kbd>↵</Kbd>
              </InputGroupButton>
            </InputGroupAddon>
          </InputGroup>
          <span className="text-xs tabular-nums text-subtle">
            {rules.length}/{COHOST_RULES_MAX}
          </span>
        </Field>
        <Field>
          <FieldLabel htmlFor="cohost-sensitivity">Flag sensitivity</FieldLabel>
          <FieldDescription>
            How sure Orcle must be before a flag shows up. Relaxed shows only the clear cases,
            Strict shows everything it noticed.
          </FieldDescription>
          <ToggleGroup
            className="w-fit"
            disabled={locked}
            id="cohost-sensitivity"
            size="sm"
            type="single"
            value={sensitivity}
            onValueChange={(next) => {
              if (next) setCohostSensitivity(next as CohostSensitivity)
            }}
          >
            {COHOST_SENSITIVITIES.map((step) => (
              <ToggleGroupItem key={step} className="px-3 text-xs" value={step}>
                {COHOST_SENSITIVITY_LABELS[step]}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
        </Field>
        <Field>
          <FieldLabel htmlFor="cohost-show-on-stream">Show on stream automatically</FieldLabel>
          <FieldDescription>
            Puts a chat comment on your stream by itself. You can always show one yourself with H.
          </FieldDescription>
          <ToggleGroup
            className="w-fit flex-wrap"
            disabled={locked}
            id="cohost-show-on-stream"
            size="sm"
            type="single"
            value={showOnStream}
            onValueChange={(mode) => {
              // Radix reports a click on the pressed item as '': keep that item,
              // which also rewrites a stored picks-only row as both flags on.
              const patch =
                COHOST_SHOW_ON_STREAM_PATCHES[(mode || showOnStream) as CohostShowOnStreamMode]
              if (
                patch.autoHighlight !== cohostSettings.autoHighlight ||
                patch.voiceHighlight !== cohostSettings.voiceHighlight
              ) {
                save(patch)
              }
            }}
          >
            {COHOST_SHOW_ON_STREAM_MODES.map((mode) => (
              <ToggleGroupItem key={mode} className="px-3 text-xs" value={mode}>
                {COHOST_SHOW_ON_STREAM_LABELS[mode]}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
          <FieldDescription className="flex flex-col gap-0.5">
            <span>What I talk about needs Orcle to hear you (or live captions).</span>
            <span>
              Orcle&apos;s picks: at most one card every 45 seconds; nothing Orcle flagged is ever
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
    <p className="text-xs tabular-nums text-subtle" data-slot="cohost-listen-allowance">
      {allowance}
    </p>
  )
}
