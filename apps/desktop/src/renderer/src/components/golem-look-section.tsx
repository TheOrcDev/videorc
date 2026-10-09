import { CloseIcon, ImageIcon, RefreshIcon, SparkleIcon, SpinnerIcon } from '@/components/icons'
import {
  useRef,
  useState,
  type DragEvent,
  type KeyboardEvent,
  type ReactElement,
  type ReactNode
} from 'react'

import { LazyGolemPetPreview } from '@/components/golem-pet-preview-lazy'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Field, FieldDescription, FieldGroup, FieldLabel } from '@/components/ui/field'
import { Kbd } from '@/components/ui/kbd'
import { Skeleton } from '@/components/ui/skeleton'
import { Textarea } from '@/components/ui/textarea'
import {
  useGolemLook,
  useGolemLookClient,
  type GolemLookClient,
  type GolemLookState
} from '@/hooks/use-golem-look'
import { useStudioCore } from '@/hooks/use-studio'
import type { CohostAvatarState, CohostPersona } from '@/lib/backend'
import { COHOST_AVATAR_STATES } from '@/lib/backend'
import { GOLEM_DEFAULT_PACK, golemStateImageUrl } from '@/lib/golem-default-pack'
import {
  GOLEM_LOOK_DESCRIPTION_MAX_CHARS,
  GOLEM_LOOK_DESCRIPTION_PLACEHOLDER,
  GOLEM_LOOK_PICTURE_HINT,
  GOLEM_LOOK_PICTURE_TYPES,
  golemLookAllowanceCopy,
  golemLookAvailability,
  golemLookDraftImages,
  isGolemLookRedoState,
  prepareGolemLookPicture,
  type GolemLookPicture
} from '@/lib/golem-look-view'
import { GOLEM_STATE_LABELS } from '@/lib/golem-persona-view'
import { openGolemPetCreator } from '@/lib/golem-pet-creator-nav'
import { GOLEM_STILL_PACK_ID } from '@/lib/golem-pet-view'
import { displayKeyGlyph } from '@/lib/platform'
import { cn } from '@/lib/utils'
import { golemAssetUrl } from '../../../shared/golem-assets'

/** The draft's living preview: big enough to read the pose, small beside the actions. */
const DRAFT_PREVIEW_PX = 112

type LookView = 'working' | 'draft' | 'current'

interface ChosenPicture {
  name: string
  /** An object URL of the original file, for the thumbnail. */
  url: string
  prepared: GolemLookPicture
}

/**
 * "Your Golem's look" (plan 169 D10 to D13), the Avatar section's Still
 * panel. One click makes the whole set: describe the Golem, add a picture
 * for inspiration, or both, and Create my Golem (⌘↵) makes idle, talking,
 * laughing and thinking in the house look. The set is a draft (four result
 * tiles, the living preview playing it) until Keep this look; Try again
 * makes a new character, Discard drops it, and Redo (R on a focused tile)
 * makes talk, laugh or think again from the draft's idle. Without a draft
 * the tiles show the current look, view-only, and Make it Alive opens the
 * Alive creator with it. No uploads per state (D10).
 *
 * Premium, cloud AI consent and a web that offers the look gate it, each
 * with its own hint. Nothing toasts: the tiles are the confirmation.
 */
export interface GolemLookSectionProps {
  /** Tests inject the backend; the app opens its own client. */
  client?: GolemLookClient | null
  /** Tests inject the picture prep; the app downscales and re-encodes. */
  preparePicture?: (file: File) => Promise<GolemLookPicture>
}

export function GolemLookSection({
  client: injectedClient,
  preparePicture = prepareGolemLookPicture
}: GolemLookSectionProps): ReactElement | null {
  const {
    account,
    aiCapabilities,
    aiConsent,
    cohostGate,
    cohostSettings,
    patchCohostSettings,
    runtimeInfo
  } = useStudioCore()
  const connected = useGolemLookClient()
  const client = injectedClient !== undefined ? injectedClient : connected
  const { state, controller } = useGolemLook(client)
  const persona = cohostSettings?.persona ?? null
  const availability = golemLookAvailability({
    signedIn: account?.status === 'signed-in',
    gate: cohostGate,
    consented: aiConsent,
    capabilities: state.capabilities ?? aiCapabilities ?? null
  })
  const modKey = displayKeyGlyph('⌘', runtimeInfo?.platform)

  const [description, setDescription] = useState('')
  const [picture, setPicture] = useState<ChosenPicture | null>(null)
  const [preparing, setPreparing] = useState(false)
  const [pictureError, setPictureError] = useState<string | null>(null)
  const [saveError, setSaveError] = useState<string | null>(null)
  const fileInput = useRef<HTMLInputElement>(null)
  const [dragging, setDragging] = useState(false)

  if (!persona) return null

  const creating = state.pending === 'create' || state.running?.kind === 'create'
  const busy = state.pending !== null || state.running !== null
  const view: LookView = creating ? 'working' : state.draft ? 'draft' : 'current'
  const hasInput = description.trim().length > 0 || picture !== null
  const inputsOff = !availability.allowed && !availability.redoAllowed
  const canCreate = Boolean(controller) && availability.allowed && hasInput && !busy && !preparing

  const choose = async (file: File): Promise<void> => {
    setPictureError(null)
    setPreparing(true)
    try {
      const prepared = await preparePicture(file)
      if (picture) URL.revokeObjectURL(picture.url)
      setPicture({ name: file.name, url: URL.createObjectURL(file), prepared })
    } catch (error) {
      setPictureError(error instanceof Error ? error.message : 'That picture could not be read.')
    } finally {
      setPreparing(false)
    }
  }
  const clearPicture = (): void => {
    if (picture) URL.revokeObjectURL(picture.url)
    setPicture(null)
    setPictureError(null)
  }

  const create = (): void => {
    if (!canCreate || !controller) return
    setSaveError(null)
    void controller.create({
      description: description.trim() || undefined,
      inspirationBase64: picture?.prepared.base64
    })
  }
  const keep = async (): Promise<void> => {
    if (!controller) return
    setSaveError(null)
    const settings = await controller.keep()
    if (!settings) return
    // The provider's copy of the persona follows the backend's.
    await patchCohostSettings({ persona: settings.persona }).catch((error: unknown) =>
      setSaveError(error instanceof Error ? error.message : 'Could not save your Golem.')
    )
  }
  const keepAllowed = Boolean(controller) && view === 'draft' && !busy

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key !== 'Enter' || !(event.metaKey || event.ctrlKey)) return
    event.preventDefault()
    if (view === 'draft') {
      if (keepAllowed) void keep()
    } else {
      create()
    }
  }

  const onDrop = (event: DragEvent<HTMLElement>): void => {
    event.preventDefault()
    setDragging(false)
    if (busy || inputsOff) return
    const file = event.dataTransfer.files?.[0]
    if (file) void choose(file)
  }

  const hint =
    availability.reason ??
    (availability.remaining !== null ? golemLookAllowanceCopy(availability.remaining) : null)
  const problem = state.problem?.message ?? saveError

  return (
    <div data-testid="golem-look" data-view={view} onKeyDown={onKeyDown}>
      <FieldGroup variant="grouped">
        <Field>
          <FieldLabel htmlFor="golem-look-description">Your Golem&apos;s look</FieldLabel>
          <FieldDescription>
            Describe your Golem, add a picture for inspiration, or both. It is drawn in the Golem
            style in four poses, and nothing changes until you keep it. Part of Videorc Premium;
            uses cloud AI.
          </FieldDescription>
          <div className="flex flex-wrap items-stretch gap-3">
            <Textarea
              className="min-h-24 min-w-48 flex-1"
              disabled={inputsOff || creating}
              id="golem-look-description"
              maxLength={GOLEM_LOOK_DESCRIPTION_MAX_CHARS}
              placeholder={GOLEM_LOOK_DESCRIPTION_PLACEHOLDER}
              value={description}
              onChange={(event) => setDescription(event.target.value)}
            />
            <div
              className={cn(
                'relative flex w-40 shrink-0 flex-col items-center justify-center gap-1.5 overflow-hidden rounded-row border border-border bg-foreground/[0.03] p-2 text-center',
                dragging && 'bg-accent'
              )}
              data-testid="golem-look-picture"
              onDragLeave={() => setDragging(false)}
              onDragOver={(event) => {
                event.preventDefault()
                if (!busy && !inputsOff) setDragging(true)
              }}
              onDrop={onDrop}
            >
              {picture ? (
                <>
                  <img
                    alt="Inspiration"
                    className="h-16 w-full rounded-chip object-contain"
                    draggable={false}
                    src={picture.url}
                  />
                  <span className="w-full truncate text-xs text-muted-foreground">
                    {picture.name}
                  </span>
                  <Button
                    aria-label="Remove the picture"
                    className="absolute top-1 right-1"
                    disabled={creating}
                    size="icon-xs"
                    title="Remove"
                    type="button"
                    variant="ghost"
                    onClick={clearPicture}
                  >
                    <CloseIcon />
                  </Button>
                </>
              ) : (
                <Button
                  className="h-auto w-full flex-1 flex-col gap-1.5 whitespace-normal py-2 text-xs font-normal text-muted-foreground"
                  data-testid="golem-look-picture-pick"
                  disabled={inputsOff || creating || preparing}
                  type="button"
                  variant="ghost"
                  onClick={() => fileInput.current?.click()}
                >
                  {preparing ? (
                    <SpinnerIcon className="size-4 animate-spin" />
                  ) : (
                    <ImageIcon className="size-4" />
                  )}
                  {preparing ? 'Preparing the picture…' : GOLEM_LOOK_PICTURE_HINT}
                </Button>
              )}
              <input
                ref={fileInput}
                accept={GOLEM_LOOK_PICTURE_TYPES.join(',')}
                className="hidden"
                data-testid="golem-look-picture-input"
                type="file"
                onChange={(event) => {
                  const file = event.currentTarget.files?.[0]
                  event.currentTarget.value = ''
                  if (file) void choose(file)
                }}
              />
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            {view !== 'draft' ? (
              <Button
                data-testid="golem-look-create"
                disabled={!canCreate}
                type="button"
                onClick={create}
              >
                {creating ? (
                  <SpinnerIcon className="animate-spin" data-icon="inline-start" />
                ) : (
                  <SparkleIcon data-icon="inline-start" />
                )}
                {creating ? 'Creating your Golem…' : 'Create my Golem'}
                <Kbd className="ml-0.5">{modKey}↵</Kbd>
              </Button>
            ) : null}
            {hint ? (
              <span className="text-xs tabular-nums text-subtle" data-testid="golem-look-hint">
                {hint}
              </span>
            ) : null}
          </div>
          {pictureError || problem ? (
            <p className="text-xs text-destructive" data-testid="golem-look-error">
              {pictureError ?? problem}
            </p>
          ) : null}
        </Field>
        <Field>
          <FieldLabel>
            {view === 'working'
              ? 'Making your Golem'
              : view === 'draft'
                ? 'Your new look'
                : 'Current look'}
          </FieldLabel>
          <FieldDescription>
            {view === 'working'
              ? 'Idle first, then talking, laughing and thinking from it. About a minute.'
              : view === 'draft'
                ? 'Keep it to make it your Golem. Redo remakes one pose from this idle.'
                : persona.source === 'default'
                  ? 'The default Golem until you create your own.'
                  : 'What your Golem wears on stream.'}
          </FieldDescription>
          <LookTiles
            availabilityRedo={availability.redoAllowed}
            busy={busy}
            controller={controller}
            persona={persona}
            state={state}
            view={view}
          />
          {view === 'draft' && state.draft ? (
            <div
              className="flex flex-wrap items-center gap-4"
              data-testid="golem-look-draft-actions"
            >
              <LazyGolemPetPreview
                className="rounded-row border border-border bg-foreground/[0.03]"
                label={`${persona.name}, new look`}
                motion={persona.motion}
                packId={GOLEM_STILL_PACK_ID}
                personaId={persona.id}
                placeholder={<Skeleton className="size-full rounded-row" />}
                size={DRAFT_PREVIEW_PX}
                stillImages={golemLookDraftImages(state.draft, state.revision)}
              />
              <div className="flex min-w-48 flex-1 flex-col gap-2">
                <p className="text-xs text-muted-foreground">
                  The new look, alive. Click it to react.
                </p>
                <div className="flex flex-wrap items-center gap-2">
                  <Button
                    data-testid="golem-look-keep"
                    disabled={!keepAllowed}
                    type="button"
                    onClick={() => void keep()}
                  >
                    Keep this look
                    <Kbd className="ml-0.5">{modKey}↵</Kbd>
                  </Button>
                  <Button
                    data-testid="golem-look-try-again"
                    disabled={!canCreate}
                    title={hasInput ? undefined : 'Describe your Golem or add a picture first.'}
                    type="button"
                    variant="outline"
                    onClick={create}
                  >
                    <RefreshIcon data-icon="inline-start" />
                    Try again
                  </Button>
                  <Button
                    data-testid="golem-look-discard"
                    disabled={!controller || busy}
                    type="button"
                    variant="ghost"
                    onClick={() => void controller?.discard()}
                  >
                    Discard
                  </Button>
                </div>
              </div>
            </div>
          ) : null}
          {view === 'current' && persona.source !== 'default' ? (
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <Button
                data-testid="golem-look-make-alive"
                size="sm"
                type="button"
                variant="outline"
                onClick={() =>
                  openGolemPetCreator({
                    reference: 'persona-idle',
                    notes: description.trim() || undefined
                  })
                }
              >
                <SparkleIcon data-icon="inline-start" />
                Make it Alive
              </Button>
              <span className="text-xs text-subtle">
                The same character, moving: it looks around and reacts.
              </span>
            </div>
          ) : null}
        </Field>
      </FieldGroup>
    </div>
  )
}

function LookTiles({
  view,
  state,
  persona,
  controller,
  busy,
  availabilityRedo
}: {
  view: LookView
  state: GolemLookState
  persona: CohostPersona
  controller: ReturnType<typeof useGolemLook>['controller']
  busy: boolean
  availabilityRedo: boolean
}): ReactElement {
  const draftImages = state.draft ? golemLookDraftImages(state.draft, state.revision) : null
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-4" data-testid="golem-look-tiles">
      {COHOST_AVATAR_STATES.map((avatarState) => {
        const label = GOLEM_STATE_LABELS[avatarState]
        if (view === 'working') {
          const phase = state.phases[avatarState]
          return (
            <LookTile
              key={avatarState}
              label={label}
              state={avatarState}
              status={
                phase === 'done'
                  ? 'Done'
                  : avatarState === 'idle'
                    ? 'Drawing the character…'
                    : 'Next, from idle'
              }
              working
            />
          )
        }
        if (view === 'draft' && draftImages) {
          const path = draftImages[avatarState]
          const redoing = state.running?.kind === 'redo' && state.running.state === avatarState
          const error =
            state.stateErrors[avatarState] ??
            (path ? undefined : state.draft?.failed[avatarState]?.message)
          const canRedo = isGolemLookRedoState(avatarState)
          return (
            <LookTile
              key={avatarState}
              error={redoing ? undefined : error}
              label={label}
              redo={
                canRedo && controller
                  ? {
                      disabled: busy || !availabilityRedo,
                      run: () => {
                        if (isGolemLookRedoState(avatarState)) void controller.redo(avatarState)
                      }
                    }
                  : undefined
              }
              state={avatarState}
              status={redoing ? 'Redrawing…' : undefined}
              url={path ? golemAssetUrl(path) : null}
              working={redoing}
            />
          )
        }
        const url = golemStateImageUrl(persona, avatarState)
        const bundled = url === GOLEM_DEFAULT_PACK[avatarState]
        const fallsBack = !bundled && !persona.images[avatarState]
        return (
          <LookTile
            key={avatarState}
            badge={bundled ? 'Default' : fallsBack ? 'Uses idle' : undefined}
            label={label}
            state={avatarState}
            url={url}
          />
        )
      })}
    </div>
  )
}

/**
 * One pose. Its own size container, because its width follows the Avatar
 * section's column (about 110 to 350 px): the R chip shows only where it
 * fits beside Redo, and only while the tile has the focus.
 */
function LookTile({
  state,
  label,
  url = null,
  badge,
  status,
  error,
  working = false,
  redo
}: {
  state: CohostAvatarState
  label: string
  url?: string | null
  badge?: string
  status?: string
  error?: string
  working?: boolean
  redo?: { disabled: boolean; run: () => void }
}): ReactNode {
  return (
    <div
      className="group/golem-tile @container/golem-tile flex flex-col gap-2 rounded-row border border-border bg-muted/20 p-2 outline-none focus-visible:ring-2 focus-visible:ring-ring"
      data-testid="golem-look-tile"
      data-state={state}
      tabIndex={redo ? 0 : undefined}
      onKeyDown={(event) => {
        if (!redo || redo.disabled || event.metaKey || event.ctrlKey || event.altKey) return
        if (event.target !== event.currentTarget) return
        if (event.key === 'r' || event.key === 'R') {
          event.preventDefault()
          redo.run()
        }
      }}
    >
      <div className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1">
        <span className="text-xs font-medium text-foreground">{label}</span>
        {badge ? <Badge variant="outline">{badge}</Badge> : null}
      </div>
      {working ? (
        <Skeleton className="aspect-square w-full rounded-chip" data-testid="golem-look-skeleton" />
      ) : url ? (
        <div className="aspect-square w-full overflow-hidden rounded-chip bg-muted/30">
          <img
            alt={`${label} picture`}
            className="size-full object-contain"
            decoding="async"
            draggable={false}
            src={url}
          />
        </div>
      ) : (
        <div className="flex aspect-square w-full items-center justify-center rounded-chip bg-muted/30">
          <ImageIcon aria-hidden className="size-5 text-subtle" />
        </div>
      )}
      {status ? (
        <p className="text-xs text-muted-foreground" role="status">
          {status}
        </p>
      ) : null}
      {error ? (
        <p className="text-xs text-subtle" data-testid="golem-look-tile-error">
          {error}
        </p>
      ) : null}
      {redo ? (
        <Button
          className="w-full"
          data-testid="golem-look-redo"
          disabled={redo.disabled || working}
          size="xs"
          type="button"
          variant="ghost"
          onClick={redo.run}
        >
          <RefreshIcon data-icon="inline-start" />
          Redo
          <Kbd className="ml-0.5 hidden @min-[7.5rem]/golem-tile:group-focus/golem-tile:inline-flex">
            R
          </Kbd>
        </Button>
      ) : null}
    </div>
  )
}
