import { ImageIcon, ResetIcon, SparkleIcon, UploadIcon, ZoomInIcon } from '@/components/icons'
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
import { Kbd } from '@/components/ui/kbd'
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { Skeleton } from '@/components/ui/skeleton'
import { Textarea } from '@/components/ui/textarea'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import {
  unavailableGolemAvatarRequester,
  useGolemAvatar,
  useGolemAvatarRequester,
  type GolemAvatarRequester,
  type GolemTileProgress
} from '@/hooks/use-golem-avatar'
import { useStudioCore } from '@/hooks/use-studio'
import type { CohostAvatarState, CohostBubbleStyle, CohostPersona } from '@/lib/backend'
import { COHOST_AVATAR_STATES } from '@/lib/backend'
import { golemHasOwnImage, golemStateImageUrl } from '@/lib/golem-default-pack'
import {
  GOLEM_AVATAR_STYLE_LABELS,
  GOLEM_AVATAR_STYLES,
  GOLEM_BUBBLE_LABELS,
  GOLEM_BUBBLE_STYLES,
  GOLEM_NAME_MAX_CHARS,
  GOLEM_NAME_REQUIRED,
  GOLEM_OPAQUE_HINT,
  GOLEM_PERSONALITY_EXAMPLES,
  GOLEM_PERSONALITY_MAX_CHARS,
  GOLEM_PROMPT_MAX_CHARS,
  GOLEM_STATE_LABELS,
  freshGolemPersona,
  golemGenerateAvailability,
  golemNameToSave,
  withGolemImage,
  type GolemAvatarStyle
} from '@/lib/golem-persona-view'
import { displayKeyGlyph } from '@/lib/platform'
import { toast } from '@/lib/toast'
import { cn } from '@/lib/utils'
import { GolemBubbleSample } from '@/components/golem-bubble-sample'

/**
 * The Golem creation screen (plan 164 S-A4): name it, give it a personality
 * and pick its bubble. Everything here is free (D6) and persists through
 * `patchCohostSettings` on blur or change, with no success toasts (the
 * design skill): the screen is the confirmation. Its looks moved to the
 * Avatar section (plan 168 S-D2), where the four state images are the Still
 * panel (`GolemStillLooks`) beside the living preview.
 *
 * Stream Manager operates the Golem (plan 164, owner pick); this screen only
 * creates it.
 */
export function GolemPersonaSection(): ReactElement | null {
  const { cohostSettings, patchCohostSettings } = useStudioCore()
  const persona = cohostSettings?.persona ?? null
  const [error, setError] = useState<string | null>(null)
  const save = async (next: CohostPersona): Promise<void> => {
    setError(null)
    try {
      await patchCohostSettings({ persona: next })
    } catch (failure: unknown) {
      const message = failure instanceof Error ? failure.message : 'Could not save your Golem.'
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
      await window.videorc.removeGolemPersona(persona.id)
      await save(freshGolemPersona(crypto.randomUUID()))
    } catch (failure: unknown) {
      toast.error('Could not start over', {
        description: failure instanceof Error ? failure.message : undefined
      })
    }
  }

  return (
    <PanelSection
      description="Name it, give it a personality and its looks. It answers to its name in chat and in voice; Stream Manager runs it while you're live."
      title="Your Golem"
    >
      <div className="flex flex-wrap items-start gap-2" data-slot="golem-header">
        <GolemNameField persona={persona} onSave={saveQuietly} />
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
          <span className="mt-1 text-xs text-destructive" data-slot="golem-save-error">
            {error}
          </span>
        ) : null}
      </div>

      <FieldGroup variant="grouped">
        <GolemPersonalityField persona={persona} onSave={saveQuietly} />

        <Field>
          <FieldLabel htmlFor="golem-bubble-style">Bubble</FieldLabel>
          <FieldDescription>
            How your Golem talks on stream: no voice, a comic bubble above it.
          </FieldDescription>
          <div className="flex flex-wrap items-center gap-4">
            <GolemBubbleStyleToggle
              id="golem-bubble-style"
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
                data-testid="golem-bubble-sample-zoom"
                tabIndex={-1}
                type="button"
                variant="ghost"
                onClick={() => setBubbleZoomOpen(true)}
              >
                <GolemBubbleSample persona={persona} style={persona.bubbleStyle} />
              </Button>
              <Button
                aria-label="Zoom in on the bubble"
                data-testid="golem-bubble-zoom"
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
        <DialogContent className="sm:max-w-lg" data-testid="golem-bubble-zoom-dialog">
          <DialogHeader>
            <DialogTitle>Bubble</DialogTitle>
            <DialogDescription>
              How {persona.name} talks on stream, drawn the way your stream gets it.
            </DialogDescription>
          </DialogHeader>
          <GolemBubbleStyleToggle
            aria-label="Bubble style"
            value={persona.bubbleStyle}
            onChange={setBubbleStyle}
          />
          <div className="flex h-112 items-end justify-center rounded-row border border-border bg-foreground/[0.03] p-3">
            <GolemBubbleSample persona={persona} size="zoomed" style={persona.bubbleStyle} />
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={startOverOpen} onOpenChange={setStartOverOpen}>
        <DialogContent showCloseButton={false}>
          <DialogHeader>
            <DialogTitle>Start over with a new Golem?</DialogTitle>
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

/**
 * The Still panel (plan 164 S-A4's Looks, plan 168 S-D2): the four state
 * images, each uploaded or generated, and Generate all from one prompt.
 * Upload is free; only Generate is Premium + consent + a web that offers the
 * route, and when it is not, the buttons are disabled with the one reason
 * under the tiles. Saves through `patchCohostSettings` with no success toast.
 */
export function GolemStillLooks({
  requestAvatar
}: {
  /** Tests inject the backend call; the app uses `useGolemAvatarRequester`. */
  requestAvatar?: GolemAvatarRequester
} = {}): ReactElement | null {
  const { account, aiCapabilities, aiConsent, cohostGate, cohostSettings, patchCohostSettings } =
    useStudioCore()
  const connectedRequester = useGolemAvatarRequester()
  const request = requestAvatar ?? connectedRequester ?? unavailableGolemAvatarRequester
  const persona = cohostSettings?.persona ?? null
  const [error, setError] = useState<string | null>(null)
  const save = async (next: CohostPersona): Promise<void> => {
    setError(null)
    try {
      await patchCohostSettings({ persona: next })
    } catch (failure: unknown) {
      setError(failure instanceof Error ? failure.message : 'Could not save your Golem.')
      throw failure
    }
  }

  const availability = golemGenerateAvailability({
    signedIn: account?.status === 'signed-in',
    gate: cohostGate,
    consented: aiConsent,
    capabilities: aiCapabilities
  })

  const personaRef = useRef(persona)
  personaRef.current = persona
  const { progress, busy, generateOne, generateAll } = useGolemAvatar({
    request,
    onImage: async (state, result) => {
      const current = personaRef.current
      if (!current) return
      await save(withGolemImage(current, state, result.path, 'generated'))
    }
  })

  const [prompt, setPrompt] = useState('')
  const [style, setStyle] = useState<GolemAvatarStyle>('cartoon')
  const { runtimeInfo } = useStudioCore()
  const modKey = displayKeyGlyph('⌘', runtimeInfo?.platform)

  if (!persona) return null
  const canGenerate = availability.allowed && !busy
  const promptReady = prompt.trim().length > 0

  const upload = async (state: CohostAvatarState): Promise<void> => {
    try {
      const imported = await window.videorc.importGolemImage(persona.id, state)
      if (!imported) return
      await save(withGolemImage(persona, state, imported.path, 'uploaded'))
    } catch (failure: unknown) {
      toast.error(`Could not use that image for ${GOLEM_STATE_LABELS[state]}`, {
        description: failure instanceof Error ? failure.message : undefined
      })
    }
  }

  const runGenerateAll = (): void => {
    if (!canGenerate || !promptReady) return
    void generateAll(persona, prompt.trim(), style)
  }

  return (
    <FieldGroup variant="grouped">
      <Field>
        <FieldLabel htmlFor="golem-prompt">State images</FieldLabel>
        <FieldDescription>
          Upload a PNG or WebP with transparency per state, or describe your Golem and generate all
          four. Generation is part of Videorc Premium and uses cloud AI.
        </FieldDescription>
        <div className="flex flex-wrap items-center gap-2">
          <Input
            className="min-w-48 flex-1"
            disabled={!availability.allowed}
            id="golem-prompt"
            maxLength={GOLEM_PROMPT_MAX_CHARS}
            placeholder="Describe it: a small stone golem with glowing eyes…"
            value={prompt}
            onChange={(event) => setPrompt(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                event.preventDefault()
                runGenerateAll()
              }
            }}
          />
          <Select
            disabled={!availability.allowed}
            value={style}
            onValueChange={(next) => setStyle(next as GolemAvatarStyle)}
          >
            <SelectTrigger aria-label="Style" className="w-28">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                {GOLEM_AVATAR_STYLES.map((preset) => (
                  <SelectItem key={preset} value={preset}>
                    {GOLEM_AVATAR_STYLE_LABELS[preset]}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
          <Button
            data-testid="golem-generate-all"
            disabled={!canGenerate || !promptReady}
            type="button"
            onClick={runGenerateAll}
          >
            <SparkleIcon data-icon="inline-start" />
            Generate all
            <Kbd className="ml-0.5">{modKey}↵</Kbd>
          </Button>
        </div>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4" data-slot="golem-tiles">
          {COHOST_AVATAR_STATES.map((state) => (
            <GolemStateTile
              key={state}
              canGenerate={canGenerate && promptReady}
              persona={persona}
              progress={progress[state]}
              state={state}
              onGenerate={() => void generateOne(persona, state, prompt.trim(), style)}
              onUpload={() => void upload(state)}
            />
          ))}
        </div>
        {availability.reason ? (
          <p className="text-xs text-subtle" data-slot="golem-generate-hint">
            {availability.reason}
          </p>
        ) : availability.remaining !== null ? (
          <p className="text-xs tabular-nums text-subtle" data-slot="golem-generate-hint">
            {availability.remaining} generations left today
          </p>
        ) : null}
        {error ? (
          <p className="text-xs text-destructive" data-slot="golem-save-error">
            {error}
          </p>
        ) : null}
      </Field>
    </FieldGroup>
  )
}

/** Speech, Thought or Shout: beside the sample, and again in its zoom. */
function GolemBubbleStyleToggle({
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
      {GOLEM_BUBBLE_STYLES.map((bubble) => (
        <ToggleGroupItem key={bubble} className="px-3 text-xs" value={bubble}>
          {GOLEM_BUBBLE_LABELS[bubble]}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  )
}

/** The name, saved on blur or Enter; empty never saves and says why. */
function GolemNameField({
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
    const name = golemNameToSave(draft)
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
        id="golem-name"
        maxLength={GOLEM_NAME_MAX_CHARS}
        placeholder="Name your Golem"
        value={draft}
        onBlur={commit}
        onChange={(event) => {
          setDraft(event.target.value)
          if (invalid && golemNameToSave(event.target.value)) setInvalid(false)
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter') event.currentTarget.blur()
        }}
      />
      {invalid ? (
        <span className="text-xs text-destructive" data-slot="golem-name-error">
          {GOLEM_NAME_REQUIRED}
        </span>
      ) : null}
    </div>
  )
}

function GolemPersonalityField({
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
      <FieldLabel htmlFor="golem-personality">Personality</FieldLabel>
      <FieldDescription>
        Who your Golem is. Its answers and remarks are written in this voice.
      </FieldDescription>
      <Textarea
        className="min-h-20"
        id="golem-personality"
        maxLength={GOLEM_PERSONALITY_MAX_CHARS}
        placeholder="Grumpy, loyal, loves bad puns…"
        value={draft}
        onBlur={() => commit()}
        onChange={(event) => setDraft(event.target.value)}
      />
      <div className="flex flex-wrap items-center gap-2">
        {GOLEM_PERSONALITY_EXAMPLES.map((example) => (
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
          {[...draft].length}/{GOLEM_PERSONALITY_MAX_CHARS}
        </span>
        {dirty ? (
          <span className="text-xs text-muted-foreground">Unsaved. Click away to save.</span>
        ) : null}
      </div>
    </Field>
  )
}

/**
 * One state: its image (or the bundled default), Upload and Generate.
 *
 * The tile is its own size container, because its width follows the
 * Avatar section's column, not the window: four tiles beside the preview run
 * from about 110 px wide (a 960 px window) to 350 px. Upload and Generate sit
 * side by side only where both fit whole, and stack full width under that;
 * the U chip shows only where it fits beside Upload's label, so nothing
 * spills past the tile or cuts a word.
 */
function GolemStateTile({
  persona,
  state,
  progress,
  canGenerate,
  onUpload,
  onGenerate
}: {
  persona: CohostPersona
  state: CohostAvatarState
  progress: GolemTileProgress
  canGenerate: boolean
  onUpload: () => void
  onGenerate: () => void
}): ReactElement {
  const own = golemHasOwnImage(persona, state)
  const generating = progress.phase === 'generating'
  return (
    <div
      className="@container/golem-tile flex flex-col gap-2 rounded-row border border-border bg-muted/20 p-2"
      data-slot="golem-tile"
      data-state={state}
      tabIndex={0}
      onKeyDown={(event) => {
        if (event.key === 'u' || event.key === 'U') {
          event.preventDefault()
          onUpload()
        }
      }}
    >
      <div className="flex flex-wrap items-center justify-between gap-x-2">
        <span className="text-xs font-medium text-foreground">{GOLEM_STATE_LABELS[state]}</span>
        {!own ? <span className="text-xs text-subtle">Default</span> : null}
      </div>
      {generating ? (
        <Skeleton className="aspect-square w-full rounded-chip" data-testid="golem-tile-skeleton" />
      ) : (
        <div className="relative aspect-square w-full overflow-hidden rounded-chip bg-muted/30">
          <img
            alt={`${GOLEM_STATE_LABELS[state]} image`}
            className={cn('size-full object-contain', !own && 'opacity-70')}
            decoding="async"
            draggable={false}
            src={golemStateImageUrl(persona, state)}
          />
          {!own ? (
            <ImageIcon
              aria-hidden
              className="absolute right-1.5 bottom-1.5 size-4 text-muted-foreground"
            />
          ) : null}
        </div>
      )}
      <div
        className="grid grid-cols-1 gap-1 @min-[13.5rem]/golem-tile:grid-cols-2"
        data-slot="golem-tile-actions"
      >
        <Button
          className="w-full"
          disabled={generating}
          size="xs"
          type="button"
          variant="ghost"
          onClick={onUpload}
        >
          <UploadIcon data-icon="inline-start" />
          Upload
          <Kbd className="ml-0.5 hidden @min-[7.5rem]/golem-tile:inline-flex">U</Kbd>
        </Button>
        <Button
          className="w-full"
          data-testid="golem-generate"
          disabled={!canGenerate || generating}
          size="xs"
          type="button"
          variant="ghost"
          onClick={onGenerate}
        >
          <SparkleIcon data-icon="inline-start" />
          Generate
        </Button>
      </div>
      {progress.phase === 'failed' ? (
        <p className="text-xs text-subtle" data-slot="golem-tile-error">
          {progress.error}
        </p>
      ) : progress.phase === 'done' && progress.opaque ? (
        <p className="text-xs text-subtle" data-slot="golem-tile-opaque">
          {GOLEM_OPAQUE_HINT}
        </p>
      ) : null}
    </div>
  )
}
