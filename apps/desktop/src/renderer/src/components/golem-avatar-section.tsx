import { DeleteIcon, FolderIcon, SparkleIcon, ZoomInIcon } from '@/components/icons'
import { useState, type KeyboardEvent, type ReactElement, type ReactNode, type Ref } from 'react'

import type { GolemPetPreviewHandle, GolemPetPreviewInfo } from '@/components/golem-pet-preview'
import { LazyGolemPetPreview } from '@/components/golem-pet-preview-lazy'
import { GroupedList, ListRow } from '@/components/list-row'
import { PanelSection } from '@/components/panel-section'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Empty, EmptyContent, EmptyDescription } from '@/components/ui/empty'
import { Kbd } from '@/components/ui/kbd'
import { Skeleton } from '@/components/ui/skeleton'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import type { GolemPets } from '@/hooks/use-golem-pets'
import { useStudioCore } from '@/hooks/use-studio'
import type { CohostPersona, GolemPetImportResult, GolemPetSummary } from '@/lib/backend'
import { openGolemPetCreator } from '@/lib/golem-pet-creator-nav'
import {
  GOLEM_AVATAR_KIND_LABELS,
  GOLEM_TAB_PREVIEW_PX,
  golemPetCreateAvailability,
  golemPetPosesLabel,
  golemPetSourceLabel,
  type GolemPetCreateAvailability
} from '@/lib/golem-pet-view'
import { ipcErrorMessage } from '@/lib/ipc-error-message'
import type { GolemMotionSettings } from '../../../shared/golem-pet'

export type GolemAvatarView = 'still' | 'alive'

/** The preview in its zoom dialog: big enough to check the Golem out. */
const ZOOM_PREVIEW_PX = 420

export interface GolemAvatarSectionProps {
  persona: CohostPersona
  pets: GolemPets
  /** Still, or Alive (which can show before a pack is worn: the empty state). */
  view: GolemAvatarView
  /** Persists the choice when it can; a refusal shows under the section. */
  onViewChange: (view: GolemAvatarView) => Promise<void>
  /** The pack the preview plays: `still`, a pack id, or null for none. */
  previewPackId: string | null
  previewRef: Ref<GolemPetPreviewHandle>
  /** What the preview moves with: the Motion section's draft while it is dragged. */
  motion: GolemMotionSettings
  onPreviewLoad?: (info: GolemPetPreviewInfo) => void
  /** The Still panel: the four state images (`GolemStillLooks`). */
  stillPanel: ReactNode
  /** Wear a pack (persists `persona.avatar`). */
  onWear: (packId: string) => Promise<void>
  /** The worn pack is being removed: the Golem goes back to Still, the view stays Alive. */
  onUnwear: () => Promise<void>
  /** Tests inject the folder picker; the app uses `importGolemPetFolder`. */
  importFolder?: (personaId: string) => Promise<GolemPetImportResult | null>
}

function isTextEntry(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  return (
    target.isContentEditable ||
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target.getAttribute('role') === 'combobox'
  )
}

/**
 * Avatar (plan 168 S-D2, D2): Still or Alive, with the living preview
 * beside it. Still is the four state images (the plan 164 tiles); Alive is
 * a pet pack, chosen from the persona's packs, imported from a page-pet
 * folder (free, `Kbd` I) or made with the creator (Premium, Phase F).
 * Everything persists through `patchCohostSettings` with no success toast:
 * the preview is the confirmation. Refusals show inline in the backend's
 * words.
 */
export function GolemAvatarSection({
  persona,
  pets,
  view,
  onViewChange,
  previewPackId,
  previewRef,
  motion,
  onPreviewLoad,
  stillPanel,
  onWear,
  onUnwear,
  importFolder
}: GolemAvatarSectionProps): ReactElement {
  const { account, aiCapabilities, aiConsent, cohostGate } = useStudioCore()
  const create = golemPetCreateAvailability({
    signedIn: account?.status === 'signed-in',
    gate: cohostGate,
    consented: aiConsent,
    capabilities: aiCapabilities ?? null
  })
  const [previewError, setPreviewError] = useState<string | null>(null)
  const [importing, setImporting] = useState(false)
  const [importError, setImportError] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  // The pack the confirm names; it stays set while the dialog fades out.
  const [removeTarget, setRemoveTarget] = useState<GolemPetSummary | null>(null)
  const [removeOpen, setRemoveOpen] = useState(false)
  const [zoomOpen, setZoomOpen] = useState(false)
  const [zoomError, setZoomError] = useState<string | null>(null)
  const wornPackId = persona.avatar.kind === 'alive' ? persona.avatar.packId : null

  const importPack = async (): Promise<void> => {
    if (importing) return
    setImportError(null)
    setActionError(null)
    setImporting(true)
    try {
      const pick = importFolder ?? window.videorc.importGolemPetFolder
      const imported = await pick(persona.id)
      if (!imported) return
      await pets.refresh()
      await onWear(imported.pack.packId)
    } catch (failure: unknown) {
      setImportError(ipcErrorMessage(failure))
    } finally {
      setImporting(false)
    }
  }

  const wear = (pack: GolemPetSummary): void => {
    if (pack.packId === wornPackId) return
    setActionError(null)
    onWear(pack.packId).catch((failure: unknown) =>
      setActionError(failure instanceof Error ? failure.message : `Could not wear ${pack.name}.`)
    )
  }

  const remove = async (pack: GolemPetSummary): Promise<void> => {
    setRemoveOpen(false)
    setActionError(null)
    try {
      if (pack.packId === wornPackId) await onUnwear()
      await pets.remove(pack.packId)
    } catch (failure: unknown) {
      setActionError(
        `Could not remove ${pack.name}: ${failure instanceof Error ? failure.message : String(failure)}`
      )
    }
  }

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (view !== 'alive' || event.metaKey || event.ctrlKey || event.altKey) return
    if ((event.key === 'i' || event.key === 'I') && !isTextEntry(event.target)) {
      event.preventDefault()
      void importPack()
    }
  }

  const wornPack = pets.packs?.find((pack) => pack.packId === wornPackId) ?? null

  return (
    <PanelSection
      action={
        <ToggleGroup
          aria-label="Avatar"
          data-testid="golem-avatar-kind"
          size="sm"
          type="single"
          value={view}
          onValueChange={(next) => {
            if (next !== 'still' && next !== 'alive') return
            setActionError(null)
            onViewChange(next).catch((failure: unknown) =>
              setActionError(
                failure instanceof Error ? failure.message : 'Could not save your Golem.'
              )
            )
          }}
        >
          {(['still', 'alive'] as const).map((kind) => (
            <ToggleGroupItem key={kind} className="px-3 text-xs" value={kind}>
              {GOLEM_AVATAR_KIND_LABELS[kind]}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
      }
      description="How your Golem looks on stream and here. Still is your four images; Alive is a pet pack that looks around and reacts. Importing a pack is free; creating one is part of Premium."
      title="Avatar"
    >
      <div
        className="flex flex-col gap-4 sm:flex-row sm:items-start"
        data-testid="golem-avatar"
        data-view={view}
        onKeyDown={onKeyDown}
      >
        {previewPackId ? (
          <div className="flex shrink-0 flex-col items-center gap-2 self-center sm:self-start">
            <LazyGolemPetPreview
              ref={previewRef}
              className="rounded-row border border-border bg-foreground/[0.03]"
              label={persona.name}
              motion={motion}
              packId={previewPackId}
              personaId={persona.id}
              placeholder={<Skeleton className="size-full rounded-row" />}
              size={GOLEM_TAB_PREVIEW_PX}
              stillImages={persona.images}
              onError={setPreviewError}
              onLoad={(info) => {
                setPreviewError(null)
                onPreviewLoad?.(info)
              }}
            />
            {previewError ? (
              <p
                className="max-w-40 text-center text-xs text-destructive"
                data-testid="golem-preview-error"
              >
                {previewError}
              </p>
            ) : (
              <div className="flex items-center gap-1">
                <p className="text-[11px] text-subtle">Click it to react</p>
                <Button
                  aria-label={`Zoom in on ${persona.name}`}
                  data-testid="golem-preview-zoom"
                  size="icon-xs"
                  title="Zoom in"
                  type="button"
                  variant="ghost"
                  onClick={() => {
                    setZoomError(null)
                    setZoomOpen(true)
                  }}
                >
                  <ZoomInIcon />
                </Button>
              </div>
            )}
          </div>
        ) : null}
        <div className="flex min-w-0 flex-1 flex-col gap-3">
          {view === 'still' ? (
            stillPanel
          ) : (
            <AlivePanel
              create={create}
              importError={importError}
              importing={importing}
              pets={pets}
              wornPack={wornPack}
              wornPackId={wornPackId}
              onImport={() => void importPack()}
              onRemove={(pack) => {
                setRemoveTarget(pack)
                setRemoveOpen(true)
              }}
              onWear={wear}
            />
          )}
          {actionError ? (
            <p className="text-xs text-destructive" data-testid="golem-avatar-error">
              {actionError}
            </p>
          ) : null}
        </div>
      </div>

      {/* The living preview, large: it follows the pointer and reacts to a
          click like the small one, with the same pack, motion and images. */}
      {previewPackId ? (
        <Dialog open={zoomOpen} onOpenChange={setZoomOpen}>
          <DialogContent className="sm:max-w-lg" data-testid="golem-preview-zoom-dialog">
            <DialogHeader>
              <DialogTitle>{persona.name}</DialogTitle>
              <DialogDescription>
                It follows your pointer and reacts when you click it.
              </DialogDescription>
            </DialogHeader>
            <div className="flex justify-center">
              <LazyGolemPetPreview
                className="rounded-row border border-border bg-foreground/[0.03]"
                label={persona.name}
                motion={motion}
                packId={previewPackId}
                personaId={persona.id}
                placeholder={<Skeleton className="size-full rounded-row" />}
                size={ZOOM_PREVIEW_PX}
                stillImages={persona.images}
                onError={setZoomError}
                onLoad={() => setZoomError(null)}
              />
            </div>
            {zoomError ? (
              <p
                className="text-center text-xs text-destructive"
                data-testid="golem-preview-zoom-error"
              >
                {zoomError}
              </p>
            ) : null}
          </DialogContent>
        </Dialog>
      ) : null}

      <Dialog open={removeOpen} onOpenChange={setRemoveOpen}>
        <DialogContent showCloseButton={false}>
          <DialogHeader>
            <DialogTitle>Remove {removeTarget?.name}?</DialogTitle>
            <DialogDescription>
              Its files are deleted from this computer.
              {removeTarget?.source === 'videorc-creator'
                ? ' Making it again uses one of your creations.'
                : ' You can import it again from its folder.'}
              {removeTarget?.packId === wornPackId ? ` ${persona.name} goes back to Still.` : ''}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button autoFocus type="button" variant="ghost" onClick={() => setRemoveOpen(false)}>
              Keep it
            </Button>
            <Button
              data-testid="golem-pack-remove-confirm"
              type="button"
              variant="destructive"
              onClick={() => {
                if (removeTarget) void remove(removeTarget)
              }}
            >
              Remove
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </PanelSection>
  )
}

function AlivePanel({
  pets,
  wornPack,
  wornPackId,
  create,
  importing,
  importError,
  onWear,
  onImport,
  onRemove
}: {
  pets: GolemPets
  wornPack: GolemPetSummary | null
  wornPackId: string | null
  create: GolemPetCreateAvailability
  importing: boolean
  importError: string | null
  onWear: (pack: GolemPetSummary) => void
  onImport: () => void
  onRemove: (pack: GolemPetSummary) => void
}): ReactElement {
  const packs = pets.packs
  const createButton = (
    <Button
      data-testid="golem-pack-create"
      disabled={!create.allowed}
      type="button"
      variant="outline"
      onClick={openGolemPetCreator}
    >
      <SparkleIcon data-icon="inline-start" />
      Create
    </Button>
  )
  const importButton = (
    <Button
      data-testid="golem-pack-import"
      disabled={importing}
      type="button"
      variant="outline"
      onClick={onImport}
    >
      <FolderIcon data-icon="inline-start" />
      {importing ? 'Importing…' : 'Import pack…'}
      <Kbd className="ml-0.5">I</Kbd>
    </Button>
  )
  const createHint = create.reason ?? create.allowance
  return (
    <>
      {pets.error ? (
        <Alert data-testid="golem-packs-error" variant="destructive">
          <AlertTitle>Could not list your packs</AlertTitle>
          <AlertDescription>{pets.error}</AlertDescription>
        </Alert>
      ) : packs === null ? (
        <p className="text-xs text-muted-foreground" role="status">
          Loading your packs…
        </p>
      ) : packs.length === 0 ? (
        <Empty className="flex-none gap-3 p-6" data-testid="golem-alive-empty">
          <EmptyDescription className="text-xs text-subtle">
            No living Golem yet. Import a page-pet pack, or create one from your Golem.
          </EmptyDescription>
          <EmptyContent className="max-w-none flex-row flex-wrap justify-center gap-2">
            {createButton}
            {importButton}
          </EmptyContent>
        </Empty>
      ) : (
        <>
          <div aria-label="Your packs" role="radiogroup">
            <GroupedList label="Packs">
              {packs.map((pack) => {
                const worn = pack.packId === wornPackId
                return (
                  <ListRow
                    key={pack.packId}
                    aria-checked={worn}
                    context={`${golemPetPosesLabel(pack)} · ${golemPetSourceLabel(pack)}`}
                    data-testid="golem-pack-row"
                    meta={worn ? 'Wearing' : undefined}
                    role="radio"
                    selected={worn}
                    tabIndex={0}
                    title={pack.name}
                    onClick={() => onWear(pack)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault()
                        onWear(pack)
                      }
                    }}
                  />
                )
              })}
            </GroupedList>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {createButton}
            {importButton}
            <span className="flex-1" />
            <Button
              data-testid="golem-pack-remove"
              disabled={!wornPack || wornPack.packId.startsWith('bundled:')}
              type="button"
              variant="ghost"
              onClick={() => {
                if (wornPack) onRemove(wornPack)
              }}
            >
              <DeleteIcon data-icon="inline-start" />
              Remove
            </Button>
          </div>
        </>
      )}
      {createHint ? (
        <p className="text-xs tabular-nums text-subtle" data-testid="golem-create-hint">
          {createHint}
        </p>
      ) : null}
      {importError ? (
        <Alert data-testid="golem-import-error" variant="destructive">
          <AlertTitle>Could not import that pack</AlertTitle>
          <AlertDescription>{importError}</AlertDescription>
        </Alert>
      ) : null}
    </>
  )
}
