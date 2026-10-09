import { SparkleIcon } from '@/components/icons'
import { useState, type KeyboardEvent, type ReactElement } from 'react'

import { LazyBuddyPetPreview } from '@/components/buddy-pet-preview-lazy'
import {
  BuddyPoseTile,
  BuddyPoseTiles,
  type BuddyPoseTilesCopy
} from '@/components/buddy-look-tiles'
import { Button } from '@/components/ui/button'
import { Field, FieldDescription, FieldGroup, FieldLabel } from '@/components/ui/field'
import { Kbd } from '@/components/ui/kbd'
import { Skeleton } from '@/components/ui/skeleton'
import { useBuddyLook, useBuddyLookClient, type BuddyLookClient } from '@/hooks/use-buddy-look'
import { useStudioCore } from '@/hooks/use-studio'
import { COHOST_AVATAR_STATES } from '@/lib/backend'
import { BUDDY_DEFAULT_PACK, buddyStateImageUrl } from '@/lib/buddy-default-pack'
import { buddyLookAvailability, buddyLookDraftImages } from '@/lib/buddy-look-view'
import { BUDDY_STATE_LABELS } from '@/lib/buddy-persona-view'
import { openBuddyPetCreator } from '@/lib/buddy-pet-creator-nav'
import { BUDDY_STILL_PACK_ID } from '@/lib/buddy-pet-view'
import { displayKeyGlyph } from '@/lib/platform'

/** The draft's living preview: big enough to read the pose, small beside the actions. */
const DRAFT_PREVIEW_PX = 112

type LookView = 'working' | 'draft' | 'current'

/** Plan 169's words for the tiles in this panel. */
const LOOK_PANEL_TILES_COPY: BuddyPoseTilesCopy = {
  labels: BUDDY_STATE_LABELS,
  redo: 'Redo',
  working: (state, phase) =>
    phase === 'done' ? 'Done' : state === 'idle' ? 'Drawing the character…' : 'Next, from idle',
  redrawing: 'Redrawing…',
  failed: (reason) => reason
}

/**
 * "Your Buddy's look" (plan 169 D10 to D13), the Avatar section's Still
 * panel. Since plan 170 a new look is made in the four-step onboarding
 * (New Buddy, under My Buddies); this panel shows the active look and, while
 * a look is being made or waits as a draft (the onboarding closed before
 * deciding), the same four tiles: Redo (R on a focused tile), Keep this
 * look (⌘↵) and Discard. Make it Alive opens the Alive creator with the
 * current look. Nothing toasts: the tiles are the confirmation.
 */
export interface BuddyLookSectionProps {
  /** Tests inject the backend; the app shares the Buddy tab's client. */
  client?: BuddyLookClient | null
}

export function BuddyLookSection({
  client: injectedClient
}: BuddyLookSectionProps): ReactElement | null {
  const {
    account,
    aiCapabilities,
    aiConsent,
    cohostGate,
    cohostSettings,
    patchCohostSettings,
    runtimeInfo
  } = useStudioCore()
  const connected = useBuddyLookClient()
  const client = injectedClient !== undefined ? injectedClient : connected
  const { state, controller } = useBuddyLook(client)
  const persona = cohostSettings?.persona ?? null
  const availability = buddyLookAvailability({
    signedIn: account?.status === 'signed-in',
    gate: cohostGate,
    consented: aiConsent,
    capabilities: state.capabilities ?? aiCapabilities ?? null
  })
  const modKey = displayKeyGlyph('⌘', runtimeInfo?.platform)
  const [saveError, setSaveError] = useState<string | null>(null)

  if (!persona) return null

  const creating = state.pending === 'create' || state.running?.kind === 'create'
  const busy = state.pending !== null || state.running !== null
  const view: LookView = creating ? 'working' : state.draft ? 'draft' : 'current'

  const keep = async (): Promise<void> => {
    if (!controller) return
    setSaveError(null)
    const settings = await controller.keep()
    if (!settings) return
    // The provider's copy of the persona follows the backend's.
    await patchCohostSettings({ persona: settings.persona }).catch((error: unknown) =>
      setSaveError(error instanceof Error ? error.message : 'Could not save your Buddy.')
    )
  }
  const keepAllowed = Boolean(controller) && view === 'draft' && !busy

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key !== 'Enter' || !(event.metaKey || event.ctrlKey)) return
    if (view !== 'draft') return
    event.preventDefault()
    if (keepAllowed) void keep()
  }

  const problem = state.problem?.message ?? saveError

  return (
    <div data-testid="buddy-look" data-view={view} onKeyDown={onKeyDown}>
      <FieldGroup variant="grouped">
        <Field>
          <FieldLabel>
            {view === 'working'
              ? 'Making your Buddy'
              : view === 'draft'
                ? 'Your new look'
                : 'Current look'}
          </FieldLabel>
          <FieldDescription>
            {view === 'working'
              ? 'Idle first, then talking, laughing and thinking from it. About a minute.'
              : view === 'draft'
                ? 'Keep it to make it your Buddy. Redo remakes one pose from this idle.'
                : persona.source === 'default'
                  ? 'The default Buddy until you create your own.'
                  : 'What your Buddy wears on stream.'}
          </FieldDescription>
          {view === 'current' ? (
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4" data-testid="buddy-look-tiles">
              {COHOST_AVATAR_STATES.map((avatarState) => {
                const url = buddyStateImageUrl(persona, avatarState)
                const bundled = url === BUDDY_DEFAULT_PACK[avatarState]
                const fallsBack = !bundled && !persona.images[avatarState]
                return (
                  <BuddyPoseTile
                    key={avatarState}
                    badge={bundled ? 'Default' : fallsBack ? 'Uses idle' : undefined}
                    label={BUDDY_STATE_LABELS[avatarState]}
                    state={avatarState}
                    url={url}
                  />
                )
              })}
            </div>
          ) : (
            <BuddyPoseTiles
              busy={busy}
              controller={controller}
              copy={LOOK_PANEL_TILES_COPY}
              redoAllowed={availability.redoAllowed}
              state={state}
              view={view}
            />
          )}
          {view === 'draft' && state.draft ? (
            <div
              className="flex flex-wrap items-center gap-4"
              data-testid="buddy-look-draft-actions"
            >
              <LazyBuddyPetPreview
                className="rounded-row border border-border bg-foreground/[0.03]"
                label={`${persona.name}, new look`}
                motion={persona.motion}
                packId={BUDDY_STILL_PACK_ID}
                personaId={persona.id}
                placeholder={<Skeleton className="size-full rounded-row" />}
                size={DRAFT_PREVIEW_PX}
                stillImages={buddyLookDraftImages(state.draft, state.revision)}
              />
              <div className="flex min-w-48 flex-1 flex-col gap-2">
                <p className="text-xs text-muted-foreground">
                  The new look, alive. Click it to react.
                </p>
                <div className="flex flex-wrap items-center gap-2">
                  <Button
                    data-testid="buddy-look-keep"
                    disabled={!keepAllowed}
                    type="button"
                    onClick={() => void keep()}
                  >
                    Keep this look
                    <Kbd className="ml-0.5">{modKey}↵</Kbd>
                  </Button>
                  <Button
                    data-testid="buddy-look-discard"
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
                data-testid="buddy-look-make-alive"
                size="sm"
                type="button"
                variant="outline"
                onClick={() => openBuddyPetCreator({ reference: 'persona-idle' })}
              >
                <SparkleIcon data-icon="inline-start" />
                Make it Alive
              </Button>
              <span className="text-xs text-subtle">
                The same character, moving: it looks around and reacts.
              </span>
            </div>
          ) : null}
          {problem ? (
            <p className="text-xs text-destructive" data-testid="buddy-look-error">
              {problem}
            </p>
          ) : null}
        </Field>
      </FieldGroup>
    </div>
  )
}
