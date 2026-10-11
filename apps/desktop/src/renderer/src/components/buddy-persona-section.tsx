import { ResetIcon, ZoomInIcon } from '@/components/icons'
import { useEffect, useRef, useState, type ReactElement } from 'react'

import { BuddyExampleChips } from '@/components/buddy-example-chips'
import { PanelSection } from '@/components/panel-section'
import { Alert, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/confirm-dialog'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { SegmentedControl } from '@/components/ui/segmented-control'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useStudioCore } from '@/hooks/use-studio'
import type { CohostBubbleStyle, CohostPersona } from '@/lib/backend'
import {
  BUDDY_BUBBLE_LABELS,
  BUDDY_BUBBLE_STYLES,
  BUDDY_NAME_MAX_CHARS,
  BUDDY_NAME_REQUIRED,
  BUDDY_PERSONALITY_EXAMPLES,
  BUDDY_PERSONALITY_MAX_CHARS,
  freshBuddyPersona,
  buddyNameToSave
} from '@/lib/buddy-persona-view'
import { BUDDY_ONBOARDING_STEP3 } from '@/lib/buddy-onboarding-copy'
import { toastUserError } from '@/lib/user-error'
import { BuddyBubbleSample } from '@/components/buddy-bubble-sample'
import { BUDDY_LIBRARY_CONTEXT_MAX_CHARS } from '../../../shared/buddy-library'

/**
 * The Buddy creation screen (plan 164 S-A4): name it, give it a personality,
 * tell it about you and pick its bubble. Everything here is free (D6) and
 * persists through `patchCohostSettings` on blur or change, with no success
 * toasts (the design skill): the screen is the confirmation. Its looks moved
 * to the Avatar section (plan 168 S-D2), where "Your Buddy's look" is the
 * Still panel (`BuddyLookSection`, plan 169) beside the living preview.
 *
 * "About you" (plan 174 G-9) is the one home of the facts Buddy answers
 * from: the same words as the onboarding's step 3 and the library's edit
 * dialog, saved as the Buddy's notes, which the backend keeps in step with
 * the library Buddy's "About you".
 *
 * Stream Manager operates the Buddy (plan 164, owner pick); this screen only
 * creates it.
 */
export function BuddyPersonaSection(): ReactElement | null {
  const { cohostSettings, patchCohostSettings } = useStudioCore()
  const persona = cohostSettings?.persona ?? null
  const notes = cohostSettings?.notes ?? ''
  const [error, setError] = useState<string | null>(null)
  const save = async (next: CohostPersona): Promise<void> => {
    setError(null)
    try {
      await patchCohostSettings({ persona: next })
    } catch (failure: unknown) {
      const message = failure instanceof Error ? failure.message : "Couldn't save the changes."
      setError(message)
      throw failure
    }
  }
  const saveQuietly = (next: CohostPersona): void => {
    void save(next).catch(() => undefined)
  }
  const saveNotes = (next: string): void => {
    setError(null)
    void patchCohostSettings({ notes: next }).catch((failure: unknown) =>
      setError(failure instanceof Error ? failure.message : "Couldn't save the changes.")
    )
  }

  const [startOverOpen, setStartOverOpen] = useState(false)
  const [bubbleZoomOpen, setBubbleZoomOpen] = useState(false)

  if (!persona) return null
  const setBubbleStyle = (bubbleStyle: CohostBubbleStyle): void => {
    if (bubbleStyle !== persona.bubbleStyle) saveQuietly({ ...persona, bubbleStyle })
  }

  const startOver = async (): Promise<void> => {
    setStartOverOpen(false)
    try {
      await window.videorc.removeBuddyPersona(persona.id)
      await save(freshBuddyPersona(crypto.randomUUID()))
    } catch (failure: unknown) {
      toastUserError(failure, { action: 'start', object: 'over' }, { id: 'buddy-start-over' })
    }
  }

  return (
    <PanelSection
      description="Name it, give it a personality and tell it about you. It answers to its name in chat and in voice; Stream Manager runs it while you're live."
      title="Name and personality"
    >
      <div className="flex flex-wrap items-start gap-2" data-slot="buddy-header">
        <BuddyNameField persona={persona} onSave={saveQuietly} />
        <Button
          className="mt-0.5"
          size="xs"
          type="button"
          variant="ghost"
          onClick={() => setStartOverOpen(true)}
        >
          <ResetIcon data-icon="inline-start" />
          Start over
        </Button>
      </div>
      {/* A save that failed is the section's (plan 174 G-7). */}
      {error ? (
        <Alert data-testid="buddy-save-error" variant="destructive">
          <AlertTitle>{error}</AlertTitle>
        </Alert>
      ) : null}

      <FieldGroup variant="grouped">
        <BuddyPersonalityField persona={persona} onSave={saveQuietly} />
        <BuddyAboutField notes={notes} onSave={saveNotes} />

        <Field>
          <FieldLabel>Bubble</FieldLabel>
          <FieldDescription>
            How {persona.name} talks on stream: no voice, a comic bubble above it.
          </FieldDescription>
          <div className="flex flex-wrap items-center gap-4">
            <BuddyBubbleStyleToggle
              id="buddy-bubble-style"
              value={persona.bubbleStyle}
              onChange={setBubbleStyle}
            />
            <div className="flex items-end gap-1">
              {/* The sample itself opens the zoom too (owner, 2026-10-09);
                  the magnifier stays the keyboard path, so this one is
                  out of the tab order. */}
              <Button
                aria-label="Zoom in on the bubble"
                className="h-auto rounded-row p-0 hover:bg-transparent active:bg-transparent"
                data-testid="buddy-bubble-sample-zoom"
                tabIndex={-1}
                type="button"
                variant="ghost"
                onClick={() => setBubbleZoomOpen(true)}
              >
                <BuddyBubbleSample persona={persona} style={persona.bubbleStyle} />
              </Button>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    aria-label="Zoom in on the bubble"
                    data-testid="buddy-bubble-zoom"
                    size="icon"
                    type="button"
                    variant="ghost"
                    onClick={() => setBubbleZoomOpen(true)}
                  >
                    <ZoomInIcon />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>Zoom in</TooltipContent>
              </Tooltip>
            </div>
          </div>
        </Field>
      </FieldGroup>

      {/* The sample is a stream-sized bitmap shown small; zoomed, it is drawn
          again at twice the size so the bubble reads. */}
      <Dialog open={bubbleZoomOpen} onOpenChange={setBubbleZoomOpen}>
        <DialogContent data-testid="buddy-bubble-zoom-dialog" size="lg">
          <DialogHeader>
            <DialogTitle>Bubble</DialogTitle>
            <DialogDescription>
              How {persona.name} talks on stream, drawn the way your stream gets it.
            </DialogDescription>
          </DialogHeader>
          <BuddyBubbleStyleToggle
            aria-label="Bubble style"
            value={persona.bubbleStyle}
            onChange={setBubbleStyle}
          />
          <div className="flex h-112 items-end justify-center rounded-row border border-border bg-inset p-3">
            <BuddyBubbleSample persona={persona} size="zoomed" style={persona.bubbleStyle} />
          </div>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        cancelLabel={`Keep ${persona.name}`}
        confirmLabel="Start over"
        description={`${persona.name}'s name, personality, pictures and moves are deleted from this computer. Your greetings and chat settings stay.`}
        open={startOverOpen}
        testId="buddy-start-over"
        title="Start over with a new Buddy?"
        onCancel={() => setStartOverOpen(false)}
        onConfirm={() => void startOver()}
      />
    </PanelSection>
  )
}

/** Speech, Thought or Shout: beside the sample, and again in its zoom. */
function BuddyBubbleStyleToggle({
  id,
  'aria-label': ariaLabel,
  value,
  onChange
}: {
  id?: string
  'aria-label'?: string
  value: CohostBubbleStyle
  onChange: (next: CohostBubbleStyle) => void
}): ReactElement {
  return (
    <SegmentedControl
      aria-label={ariaLabel}
      className="w-fit"
      id={id}
      options={BUDDY_BUBBLE_STYLES.map((bubble) => ({
        value: bubble,
        label: BUDDY_BUBBLE_LABELS[bubble]
      }))}
      size="sm"
      value={value}
      onValueChange={onChange}
    />
  )
}

/** The name, saved on blur or Enter; empty never saves and says why. */
function BuddyNameField({
  persona,
  onSave
}: {
  persona: CohostPersona
  onSave: (next: CohostPersona) => void
}): ReactElement {
  const [draft, setDraft] = useState(persona.name)
  const savedRef = useRef(persona.name)
  const [invalid, setInvalid] = useState(false)
  // Follow the backend value until the streamer types; after that the draft
  // is the truth until it is saved.
  useEffect(() => {
    if (savedRef.current === persona.name) return
    savedRef.current = persona.name
    setDraft(persona.name)
  }, [persona.name])
  const commit = (): void => {
    const name = buddyNameToSave(draft)
    if (!name) {
      setInvalid(true)
      return
    }
    setInvalid(false)
    if (name === persona.name) return
    savedRef.current = name
    onSave({ ...persona, name })
  }
  return (
    <div className="flex w-72 max-w-full flex-col gap-1">
      <Input
        aria-invalid={invalid || undefined}
        aria-label="Name"
        className="text-base font-medium"
        id="buddy-name"
        maxLength={BUDDY_NAME_MAX_CHARS}
        placeholder="Buddy"
        value={draft}
        onBlur={commit}
        onChange={(event) => {
          setDraft(event.target.value)
          if (invalid && buddyNameToSave(event.target.value)) setInvalid(false)
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter') event.currentTarget.blur()
        }}
      />
      {invalid ? (
        <FieldError data-testid="buddy-name-error">{BUDDY_NAME_REQUIRED}</FieldError>
      ) : null}
    </div>
  )
}

function BuddyPersonalityField({
  persona,
  onSave
}: {
  persona: CohostPersona
  onSave: (next: CohostPersona) => void
}): ReactElement {
  const [draft, setDraft] = useState(persona.personality)
  const savedRef = useRef(persona.personality)
  useEffect(() => {
    if (savedRef.current === persona.personality) return
    savedRef.current = persona.personality
    setDraft(persona.personality)
  }, [persona.personality])
  const dirty = draft !== persona.personality
  const commit = (next = draft): void => {
    if (next === persona.personality) return
    savedRef.current = next
    onSave({ ...persona, personality: next })
  }
  return (
    <Field>
      <FieldLabel htmlFor="buddy-personality">Personality</FieldLabel>
      <FieldDescription>
        Who {persona.name} is. Its answers and remarks are written in this voice.
      </FieldDescription>
      <Textarea
        className="min-h-20"
        id="buddy-personality"
        maxLength={BUDDY_PERSONALITY_MAX_CHARS}
        placeholder="Grumpy, loyal, loves bad puns…"
        value={draft}
        onBlur={() => commit()}
        onChange={(event) => setDraft(event.target.value)}
      />
      <div className="flex flex-wrap items-center gap-2">
        {/* A chip fills an empty field at once and asks over typed text (plan 174 G-3). */}
        <BuddyExampleChips
          examples={BUDDY_PERSONALITY_EXAMPLES}
          value={draft}
          what="personality"
          onFill={(example) => {
            setDraft(example)
            commit(example)
          }}
        />
        <span className="ml-auto text-xs tabular-nums text-muted-foreground">
          {[...draft].length}/{BUDDY_PERSONALITY_MAX_CHARS}
        </span>
        {dirty ? (
          <span className="text-xs text-muted-foreground">Unsaved. Click away to save.</span>
        ) : null}
      </div>
    </Field>
  )
}

/**
 * "About you" (plan 174 G-9): the facts Buddy answers viewers from, saved
 * on blur as the Buddy's notes. One name and one home, the same words the
 * onboarding and the library's edit dialog use.
 */
function BuddyAboutField({
  notes,
  onSave
}: {
  notes: string
  onSave: (notes: string) => void
}): ReactElement {
  const [draft, setDraft] = useState(notes)
  const savedRef = useRef(notes)
  useEffect(() => {
    if (savedRef.current === notes) return
    savedRef.current = notes
    setDraft(notes)
  }, [notes])
  const dirty = draft !== notes
  const overLimit = [...draft].length > BUDDY_LIBRARY_CONTEXT_MAX_CHARS
  const commit = (): void => {
    if (!dirty || overLimit) return
    savedRef.current = draft
    onSave(draft)
  }
  return (
    <Field>
      <FieldLabel htmlFor="cohost-notes">About you</FieldLabel>
      <FieldDescription>{BUDDY_ONBOARDING_STEP3.aboutHelp}</FieldDescription>
      <Textarea
        className="min-h-24"
        id="cohost-notes"
        maxLength={BUDDY_LIBRARY_CONTEXT_MAX_CHARS}
        placeholder={BUDDY_ONBOARDING_STEP3.aboutPlaceholder}
        value={draft}
        onBlur={commit}
        onChange={(event) => setDraft(event.target.value)}
      />
      <div className="flex flex-wrap items-center gap-2">
        <span className="ml-auto text-xs tabular-nums text-muted-foreground">
          {[...draft].length}/{BUDDY_LIBRARY_CONTEXT_MAX_CHARS}
        </span>
        {dirty ? (
          <span className="text-xs text-muted-foreground">Unsaved. Click away to save.</span>
        ) : null}
      </div>
    </Field>
  )
}
