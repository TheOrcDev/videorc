import { AlertIcon, CloseIcon, CohostIcon } from '@/components/icons'
import { useEffect, useRef, useState, type ReactElement } from 'react'

import { PanelSection } from '@/components/panel-section'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
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
import { useStudioCore } from '@/hooks/use-studio'
import type { CohostSettings, CohostSettingsPatch, CohostTone } from '@/lib/backend'
import {
  COHOST_CONSENT_SENTENCE,
  COHOST_SENSITIVITIES,
  COHOST_SENSITIVITY_LABELS,
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
 * Settings → Co-host. Persisted per profile through `cohost.settings.get/set`
 * (the engine reads the same row when it builds a tick), NOT through local
 * settings — so what the streamer types here is what the model is given.
 */
export function CohostSettingsSection(): ReactElement | null {
  const { cohostSettings, cohostGate, patchCohostSettings } = useStudioCore()
  const [notesDraft, setNotesDraft] = useState('')
  const [notesError, setNotesError] = useState<string | null>(null)
  const savedNotesRef = useRef<string | null>(null)
  const [ruleDraft, setRuleDraft] = useState('')
  const sensitivity = useCohostSensitivity()

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

  const locked = !cohostGate.allowed
  const showOnStream = cohostShowOnStreamMode(cohostSettings)
  const notesOverLimit = notesDraft.length > COHOST_NOTES_MAX_CHARS
  const notesDirty = notesDraft !== (cohostSettings.notes ?? '')

  const save = (patch: Parameters<typeof patchCohostSettings>[0]): void => {
    setNotesError(null)
    void patchCohostSettings(patch).catch((error: unknown) =>
      setNotesError(error instanceof Error ? error.message : 'Could not save Orcle settings.')
    )
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
      description="Alpha: expect rough edges. An AI producer reads your live chat, groups the questions people are actually asking, and drafts replies you approve. Nothing is ever sent without you."
      icon={CohostIcon}
      title="Orcle (alpha)"
    >
      {locked ? (
        <Alert variant="warning">
          <AlertIcon weight="fill" />
          <AlertTitle>Orcle is Premium</AlertTitle>
          <AlertDescription>
            {cohostGate.allowed ? null : cohostGate.reason}
            {!cohostGate.allowed && cohostGate.upgradeUrl ? (
              <Button
                className="ml-2 h-auto p-0 align-baseline"
                size="xs"
                variant="link"
                onClick={() => openExternalUrl(cohostGate.upgradeUrl as string)}
              >
                View Premium
              </Button>
            ) : null}
          </AlertDescription>
        </Alert>
      ) : null}

      <FieldGroup variant="grouped">
        <Field>
          <div className="flex items-center justify-between gap-3">
            <div className="flex min-w-0 flex-col gap-0.5">
              <FieldLabel htmlFor="cohost-enabled">Enable Orcle</FieldLabel>
              <p className="text-xs text-muted-foreground">
                Starts with your next livestream. {COHOST_CONSENT_SENTENCE} It needs the cloud-AI
                consent you set in Publish.
              </p>
            </div>
            <Switch
              checked={cohostSettings.enabled}
              disabled={locked}
              id="cohost-enabled"
              onCheckedChange={(enabled) => save({ enabled })}
            />
          </div>
        </Field>

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
            <span>What I talk about needs live captions.</span>
            <span>
              Orcle&apos;s picks: at most one card every 45 seconds; nothing Orcle flagged is ever
              shown.
            </span>
          </FieldDescription>
        </Field>
      </FieldGroup>
    </PanelSection>
  )
}

function openExternalUrl(url: string): void {
  const opener = window.videorc?.openOAuthUrl
  if (opener) {
    void opener(url)
    return
  }
  window.open(url, '_blank', 'noopener,noreferrer')
}
