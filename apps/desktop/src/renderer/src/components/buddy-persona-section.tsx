import { ResetIcon, ZoomInIcon } from '@/components/icons'
import { useEffect, useRef, useState, type ReactElement } from 'react'

import { PanelSection } from '@/components/panel-section'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Field, FieldDescription, FieldGroup, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
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
import { toast } from '@/lib/toast'
import { BuddyBubbleSample } from '@/components/buddy-bubble-sample'

/**
 * The Buddy creation screen (plan 164 S-A4): name it, give it a personality
 * and pick its bubble. Everything here is free (D6) and persists through
 * `patchCohostSettings` on blur or change, with no success toasts (the
 * design skill): the screen is the confirmation. Its looks moved to the
 * Avatar section (plan 168 S-D2), where "Your Buddy's look" is the Still
 * panel (`BuddyLookSection`, plan 169) beside the living preview.
 *
 * Stream Manager operates the Buddy (plan 164, owner pick); this screen only
 * creates it.
 */
export function BuddyPersonaSection(): ReactElement | null {
  const { cohostSettings, patchCohostSettings } = useStudioCore()
  const persona = cohostSettings?.persona ?? null
  const [error, setError] = useState<string | null>(null)
  const save = async (next: CohostPersona): Promise<void> => {
    setError(null)
    try {
      await patchCohostSettings({ persona: next })
    } catch (failure: unknown) {
      const message = failure instanceof Error ? failure.message : 'Could not save your Buddy.'
      setError(message)
      throw failure
    }
  }
  const saveQuietly = (next: CohostPersona): void => {
    void save(next).catch(() => undefined)
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
      toast.error('Could not start over', {
        description: failure instanceof Error ? failure.message : undefined
      })
    }
  }

  return (
    <PanelSection
      description="Name it, give it a personality and its looks. It answers to its name in chat and in voice; Stream Manager runs it while you're live."
      title="Your Buddy"
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
        {error ? (
          <span className="mt-1 text-xs text-destructive" data-slot="buddy-save-error">
            {error}
          </span>
        ) : null}
      </div>

      <FieldGroup variant="grouped">
        <BuddyPersonalityField persona={persona} onSave={saveQuietly} />

        <Field>
          <FieldLabel htmlFor="buddy-bubble-style">Bubble</FieldLabel>
          <FieldDescription>
            How your Buddy talks on stream: no voice, a comic bubble above it.
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
              <Button
                aria-label="Zoom in on the bubble"
                data-testid="buddy-bubble-zoom"
                size="icon-sm"
                title="Zoom in"
                type="button"
                variant="ghost"
                onClick={() => setBubbleZoomOpen(true)}
              >
                <ZoomInIcon />
              </Button>
            </div>
          </div>
        </Field>
      </FieldGroup>

      {/* The sample is a stream-sized bitmap shown small; zoomed, it is drawn
          again at twice the size so the bubble reads. */}
      <Dialog open={bubbleZoomOpen} onOpenChange={setBubbleZoomOpen}>
        <DialogContent className="sm:max-w-lg" data-testid="buddy-bubble-zoom-dialog">
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
          <div className="flex h-112 items-end justify-center rounded-row border border-border bg-foreground/[0.03] p-3">
            <BuddyBubbleSample persona={persona} size="zoomed" style={persona.bubbleStyle} />
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={startOverOpen} onOpenChange={setStartOverOpen}>
        <DialogContent showCloseButton={false}>
          <DialogHeader>
            <DialogTitle>Start over with a new Buddy?</DialogTitle>
            <DialogDescription>
              {persona.name}&apos;s name, personality, images and packs are deleted from this
              computer. Your greetings and chat settings stay.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button autoFocus type="button" variant="ghost" onClick={() => setStartOverOpen(false)}>
              Keep {persona.name}
            </Button>
            <Button type="button" variant="destructive" onClick={() => void startOver()}>
              Start over
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
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
    <ToggleGroup
      aria-label={ariaLabel}
      className="w-fit"
      id={id}
      size="sm"
      type="single"
      value={value}
      onValueChange={(next) => {
        if (next) onChange(next as CohostBubbleStyle)
      }}
    >
      {BUDDY_BUBBLE_STYLES.map((bubble) => (
        <ToggleGroupItem key={bubble} className="px-3 text-xs" value={bubble}>
          {BUDDY_BUBBLE_LABELS[bubble]}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
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
        placeholder="Name your Buddy"
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
        <span className="text-xs text-destructive" data-slot="buddy-name-error">
          {BUDDY_NAME_REQUIRED}
        </span>
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
        Who your Buddy is. Its answers and remarks are written in this voice.
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
        {BUDDY_PERSONALITY_EXAMPLES.map((example) => (
          <Button
            key={example}
            size="xs"
            type="button"
            variant="outline"
            onClick={() => {
              setDraft(example)
              commit(example)
            }}
          >
            {example}
          </Button>
        ))}
        <span className="ml-auto text-xs tabular-nums text-subtle">
          {[...draft].length}/{BUDDY_PERSONALITY_MAX_CHARS}
        </span>
        {dirty ? (
          <span className="text-xs text-muted-foreground">Unsaved. Click away to save.</span>
        ) : null}
      </div>
    </Field>
  )
}
