import { DeleteIcon, FolderIcon, PauseIcon, PlayIcon, SparkleIcon } from '@/components/icons'
import {
  lazy,
  Suspense,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactElement,
  type ReactNode,
  type Ref
} from 'react'

import { BuddyCreateGateAlert } from '@/components/buddy-create-gate-alert'
import type { BuddyPetPreviewHandle, BuddyPetPreviewInfo } from '@/components/buddy-pet-preview'
import { LazyBuddyPetPreview } from '@/components/buddy-pet-preview-lazy'
import { CloudAiConsentDialog } from '@/components/cloud-ai-consent-dialog'
import { GroupedList, ListRow } from '@/components/list-row'
import { PanelSection } from '@/components/panel-section'
import { Alert, AlertAction, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/confirm-dialog'
import { Empty, EmptyContent, EmptyDescription } from '@/components/ui/empty'
import { Kbd } from '@/components/ui/kbd'
import { Skeleton } from '@/components/ui/skeleton'
import { FieldError } from '@/components/ui/field'
import {
  SegmentedControl,
  segmentedTabStop,
  segmentedTargetIndex
} from '@/components/ui/segmented-control'
import type { BuddyPets } from '@/hooks/use-buddy-pets'
import { useStudioCore } from '@/hooks/use-studio'
import type { CohostPersona, BuddyPetImportResult, BuddyPetSummary } from '@/lib/backend'
import { buddyDisplayName } from '@/lib/buddy-auto-chat-view'
import { buddyAliveCreateGate, type BuddyCreateGate } from '@/lib/buddy-create-gate'
import { openBuddyPetCreator } from '@/lib/buddy-pet-creator-nav'
import {
  BUDDY_AVATAR_KIND_LABELS,
  BUDDY_TAB_PREVIEW_PX,
  buddyPetAllowanceLine,
  buddyPetPosesLabel,
  buddyPetSourceLabel,
  isBuddyShippedPack
} from '@/lib/buddy-pet-view'
import { ipcErrorMessage } from '@/lib/ipc-error-message'
import type { BuddyMotionSettings } from '../../../shared/buddy-pet'

export type BuddyAvatarView = 'still' | 'alive'

/** A look under Still that Alive would hide (plan 174 G-10): being drawn, or waiting. */
export type BuddyLookPending = 'working' | 'draft'

// Test your Buddy (plan 169 D14) is its own chunk, loaded on first open.
const BuddyTestDialog = lazy(() => import('@/components/buddy-test-dialog'))

export interface BuddyAvatarSectionProps {
  persona: CohostPersona
  pets: BuddyPets
  /** The pack the account library keeps for this Buddy, if any (plan 172
   * D10): removing it here removes it from the library too. */
  accountPackId?: string | null
  /** Still, or Alive (which can show before a pack is worn: the empty state). */
  view: BuddyAvatarView
  /** Persists the choice when it can; a refusal shows under the section. */
  onViewChange: (view: BuddyAvatarView) => Promise<void>
  /** The pack the preview plays: `still`, a pack id, or null for none. */
  previewPackId: string | null
  previewRef: Ref<BuddyPetPreviewHandle>
  /** What the preview moves with: the Motion section's draft while it is dragged. */
  motion: BuddyMotionSettings
  onPreviewLoad?: (info: BuddyPetPreviewInfo) => void
  /** The Still panel: the four state images (`BuddyStillLooks`). */
  stillPanel: ReactNode
  /** A new look under Still while Alive shows (plan 174 G-10); null when none. */
  lookPending?: BuddyLookPending | null
  /** Wear a pack (persists `persona.avatar`). */
  onWear: (packId: string) => Promise<void>
  /** The worn pack is being removed: the Buddy goes back to Still, the view stays Alive. */
  onUnwear: () => Promise<void>
  /** Tests inject the folder picker; the app uses `importBuddyPetFolder`. */
  importFolder?: (personaId: string) => Promise<BuddyPetImportResult | null>
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
 * beside it, its pause (plan 174 G-20) and Test (plan 169 D14, T while the
 * section has focus; it is the one place to see the Buddy big, G-22). Still
 * is the four state images (the plan 164 tiles); Alive is a pet pack,
 * chosen from the persona's packs, imported from a page-pet folder (free,
 * `Kbd` I) or made with the creator (Premium, Phase F). Everything persists
 * through `patchCohostSettings` with no success toast: the preview is the
 * confirmation. Refusals show inline in the backend's words, as the
 * section's Alert (G-7). Why Create is off is the one gate model's Alert
 * (G-5), and a new look hidden under Still says so above (G-10).
 */
export function BuddyAvatarSection({
  persona,
  pets,
  accountPackId = null,
  view,
  onViewChange,
  previewPackId,
  previewRef,
  motion,
  onPreviewLoad,
  stillPanel,
  lookPending = null,
  onWear,
  onUnwear,
  importFolder
}: BuddyAvatarSectionProps): ReactElement {
  const { account, aiCapabilities, aiConsent, cohostGate, setAiConsent } = useStudioCore()
  const createGate = buddyAliveCreateGate({
    signedIn: account?.status === 'signed-in',
    gate: cohostGate,
    consented: aiConsent,
    capabilities: aiCapabilities ?? null
  })
  const allowance = buddyPetAllowanceLine(aiCapabilities)
  const [consentOpen, setConsentOpen] = useState(false)
  const [previewError, setPreviewError] = useState<string | null>(null)
  const [paused, setPaused] = useState(false)
  const [importing, setImporting] = useState(false)
  const [importError, setImportError] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  // The pack the confirm names; it stays set while the dialog fades out.
  const [removeTarget, setRemoveTarget] = useState<BuddyPetSummary | null>(null)
  const [removeOpen, setRemoveOpen] = useState(false)
  const [testOpen, setTestOpen] = useState(false)
  // Each open starts a fresh test (Idle, the bubble on); 0 = never opened.
  const [testSession, setTestSession] = useState(0)
  const wornPackId = persona.avatar.kind === 'alive' ? persona.avatar.packId : null

  const importPack = async (): Promise<void> => {
    if (importing) return
    setImportError(null)
    setActionError(null)
    setImporting(true)
    try {
      const pick = importFolder ?? window.videorc.importBuddyPetFolder
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

  const wear = (pack: BuddyPetSummary): void => {
    if (pack.packId === wornPackId) return
    // A refused import is about that attempt: the next action clears it.
    setImportError(null)
    setActionError(null)
    onWear(pack.packId).catch((failure: unknown) =>
      setActionError(failure instanceof Error ? failure.message : `Couldn't wear ${pack.name}.`)
    )
  }

  const remove = async (pack: BuddyPetSummary): Promise<void> => {
    setRemoveOpen(false)
    setImportError(null)
    setActionError(null)
    try {
      if (pack.packId === wornPackId) await onUnwear()
      await pets.remove(pack.packId)
    } catch (failure: unknown) {
      setActionError(
        `Couldn't remove ${pack.name}: ${failure instanceof Error ? failure.message : String(failure)}`
      )
    }
  }

  const changeView = (next: BuddyAvatarView): void => {
    setImportError(null)
    setActionError(null)
    onViewChange(next).catch((failure: unknown) =>
      setActionError(failure instanceof Error ? failure.message : "Couldn't switch the avatar.")
    )
  }

  const openTest = (): void => {
    setTestSession((session) => session + 1)
    setTestOpen(true)
  }

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.metaKey || event.ctrlKey || event.altKey || isTextEntry(event.target)) return
    const key = event.key.toLowerCase()
    if (key === 't' && previewPackId) {
      event.preventDefault()
      openTest()
    } else if (key === 'i' && view === 'alive') {
      event.preventDefault()
      void importPack()
    }
  }

  const wornPack = pets.packs?.find((pack) => pack.packId === wornPackId) ?? null

  return (
    <PanelSection
      action={
        // Manual activation: this choice changes what viewers see, so arrow
        // keys browse and Space or Enter switches (plan 174 G-10).
        <SegmentedControl
          activationMode="manual"
          aria-label="Avatar"
          data-testid="buddy-avatar-kind"
          options={(['still', 'alive'] as const).map((kind) => ({
            value: kind,
            label: BUDDY_AVATAR_KIND_LABELS[kind]
          }))}
          size="sm"
          value={view}
          onValueChange={changeView}
        />
      }
      description={`How ${buddyDisplayName(persona.name)} looks on stream and here. Still is your four pictures. Alive moves: it looks around and reacts. Importing moves is free; creating them is part of Videorc Premium.`}
      title="Avatar"
    >
      {view === 'alive' && lookPending ? (
        <Alert data-testid="buddy-avatar-look-pending" icon={SparkleIcon}>
          <AlertTitle>
            {lookPending === 'working'
              ? `A new look for ${persona.name} is being drawn under Still.`
              : `A new look for ${persona.name} is waiting under Still.`}
          </AlertTitle>
          <AlertAction>
            <Button size="xs" type="button" variant="outline" onClick={() => changeView('still')}>
              Switch to Still
            </Button>
          </AlertAction>
        </Alert>
      ) : null}
      <div
        className="group/avatar flex flex-col gap-4 sm:flex-row sm:items-start"
        data-testid="buddy-avatar"
        data-view={view}
        onKeyDown={onKeyDown}
      >
        {previewPackId ? (
          <div className="flex shrink-0 flex-col items-center gap-2 self-center sm:self-start">
            <LazyBuddyPetPreview
              ref={previewRef}
              className="rounded-row border border-border bg-inset"
              label={persona.name}
              motion={motion}
              packId={previewPackId}
              paused={paused}
              personaId={persona.id}
              placeholder={<Skeleton className="size-full rounded-row" />}
              size={BUDDY_TAB_PREVIEW_PX}
              stillImages={persona.images}
              onError={setPreviewError}
              onLoad={(info) => {
                setPreviewError(null)
                onPreviewLoad?.(info)
              }}
            />
            {previewError ? (
              <FieldError className="max-w-40 text-center" data-testid="buddy-preview-error">
                {previewError}
              </FieldError>
            ) : (
              <>
                <div className="flex items-center gap-1">
                  <p className="text-[11px] text-subtle">Click it to react</p>
                  {/* Moving content pauses (plan 174 G-20, WCAG 2.2.2). */}
                  <Button
                    aria-label={paused ? `Play ${persona.name}` : `Pause ${persona.name}`}
                    aria-pressed={paused}
                    data-testid="buddy-preview-pause"
                    size="icon-xs"
                    type="button"
                    variant="ghost"
                    onClick={() => setPaused((current) => !current)}
                  >
                    {paused ? <PlayIcon /> : <PauseIcon />}
                  </Button>
                </div>
                <Button
                  aria-keyshortcuts="T"
                  data-testid="buddy-test-open"
                  size="xs"
                  type="button"
                  variant="ghost"
                  onClick={openTest}
                >
                  <PlayIcon data-icon="inline-start" />
                  Test
                  {/* The key works while the section has focus; its chip shows then. */}
                  <Kbd className="hidden group-focus-within/avatar:inline-flex">T</Kbd>
                </Button>
              </>
            )}
          </div>
        ) : null}
        <div className="flex min-w-0 flex-1 flex-col gap-3">
          {view === 'still' ? (
            stillPanel
          ) : (
            <AlivePanel
              allowance={allowance}
              gate={createGate}
              importError={importError}
              importing={importing}
              pets={pets}
              wornPack={wornPack}
              wornPackId={wornPackId}
              onAllowCloudAi={() => setConsentOpen(true)}
              onImport={() => void importPack()}
              onRemove={(pack) => {
                setRemoveTarget(pack)
                setRemoveOpen(true)
              }}
              onWear={wear}
            />
          )}
          {/* A refused wear, remove or switch is the section's (plan 174 G-7). */}
          {actionError ? (
            <Alert data-testid="buddy-avatar-error" variant="destructive">
              <AlertTitle>{actionError}</AlertTitle>
            </Alert>
          ) : null}
        </div>
      </div>

      {previewPackId && testSession > 0 ? (
        <Suspense fallback={null}>
          <BuddyTestDialog
            key={testSession}
            motion={motion}
            open={testOpen}
            packId={previewPackId}
            persona={persona}
            onOpenChange={setTestOpen}
          />
        </Suspense>
      ) : null}

      <CloudAiConsentDialog
        open={consentOpen}
        testId="buddy-avatar-consent"
        onAnswer={(accepted) => {
          setConsentOpen(false)
          if (accepted) setAiConsent(true)
        }}
      />

      <ConfirmDialog
        cancelLabel="Keep it"
        confirmLabel="Remove"
        description={
          <>
            {removeTarget && removeTarget.packId === accountPackId
              ? 'Its files are deleted from this computer and from your Videorc library, so no other computer gets them.'
              : 'Its files are deleted from this computer.'}
            {removeTarget?.source === 'videorc-creator'
              ? ' Making it again uses one of your creations.'
              : ' You can import it again from its folder.'}
            {removeTarget?.packId === wornPackId ? ` ${persona.name} goes back to Still.` : ''}
          </>
        }
        open={removeOpen}
        testId="buddy-pack-remove"
        title={`Remove ${removeTarget?.name ?? 'these moves'}?`}
        onCancel={() => setRemoveOpen(false)}
        onConfirm={() => {
          if (removeTarget) void remove(removeTarget)
        }}
      />
    </PanelSection>
  )
}

function AlivePanel({
  pets,
  wornPack,
  wornPackId,
  gate,
  allowance,
  importing,
  importError,
  onAllowCloudAi,
  onWear,
  onImport,
  onRemove
}: {
  pets: BuddyPets
  wornPack: BuddyPetSummary | null
  wornPackId: string | null
  /** Why Create is off (plan 174 G-5); null when it works. */
  gate: BuddyCreateGate | null
  /** "2 of 3 left this month", when the web reports the numbers. */
  allowance: string | null
  importing: boolean
  importError: string | null
  onAllowCloudAi: () => void
  onWear: (pack: BuddyPetSummary) => void
  onImport: () => void
  onRemove: (pack: BuddyPetSummary) => void
}): ReactElement {
  const packs = pets.packs
  // The moves are radios with roving focus (plan 174 G-18): arrow keys
  // browse, one tab stop (the worn row), Enter or Space wears. Browsing never
  // wears: wearing changes what viewers see.
  const rows = useRef<Array<HTMLButtonElement | null>>([])
  const enabled = (packs ?? []).map(() => true)
  const checkedIndex = (packs ?? []).findIndex((pack) => pack.packId === wornPackId)
  const tabStop = segmentedTabStop(enabled, checkedIndex)
  const onRowsKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.altKey || event.ctrlKey || event.metaKey) return
    const current = rows.current.findIndex((row) => row === event.target)
    if (current < 0) return
    const target = segmentedTargetIndex(enabled, current, event.key)
    if (target === null) return
    event.preventDefault()
    rows.current[target]?.focus()
  }
  const createButton = (
    <Button
      data-testid="buddy-pack-create"
      disabled={gate !== null}
      type="button"
      variant="outline"
      onClick={openBuddyPetCreator}
    >
      <SparkleIcon data-icon="inline-start" />
      Create
    </Button>
  )
  const importButton = (
    <Button
      data-testid="buddy-pack-import"
      disabled={importing}
      type="button"
      variant="outline"
      onClick={onImport}
    >
      <FolderIcon data-icon="inline-start" />
      {importing ? 'Importing…' : 'Import moves…'}
      <Kbd className="ml-0.5">I</Kbd>
    </Button>
  )
  return (
    <>
      {gate ? (
        <BuddyCreateGateAlert
          data-testid="buddy-create-gate"
          gate={gate}
          onAllowCloudAi={onAllowCloudAi}
        />
      ) : null}
      {pets.error ? (
        <Alert data-testid="buddy-packs-error" variant="destructive">
          <AlertTitle>Couldn&apos;t list your moves</AlertTitle>
          <AlertDescription>{pets.error}</AlertDescription>
        </Alert>
      ) : packs === null ? (
        <p className="text-xs text-muted-foreground" role="status">
          Loading your moves…
        </p>
      ) : packs.length === 0 ? (
        <Empty className="flex-none" data-testid="buddy-alive-empty">
          <EmptyDescription>
            No moves yet. Import them from a page-pet folder, or create them from a picture.
          </EmptyDescription>
          <EmptyContent className="max-w-none flex-row flex-wrap justify-center gap-2">
            {createButton}
            {importButton}
          </EmptyContent>
        </Empty>
      ) : (
        <>
          <div aria-label="Your moves" role="radiogroup" onKeyDown={onRowsKeyDown}>
            <GroupedList label="Moves">
              {packs.map((pack, index) => {
                const worn = pack.packId === wornPackId
                return (
                  <ListRow
                    key={pack.packId}
                    ref={(element) => {
                      rows.current[index] = element
                    }}
                    as="button"
                    aria-checked={worn}
                    context={`${buddyPetPosesLabel(pack)} · ${buddyPetSourceLabel(pack)}`}
                    data-testid="buddy-pack-row"
                    meta={worn ? 'Wearing' : undefined}
                    role="radio"
                    selected={worn}
                    tabIndex={index === tabStop ? 0 : -1}
                    title={pack.name}
                    onClick={() => onWear(pack)}
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
              data-testid="buddy-pack-remove"
              disabled={!wornPack || isBuddyShippedPack(wornPack.packId)}
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
      {allowance ? (
        <p className="text-xs tabular-nums text-muted-foreground" data-testid="buddy-create-hint">
          {allowance}
        </p>
      ) : null}
      {importError ? (
        <Alert data-testid="buddy-import-error" variant="destructive">
          <AlertTitle>Couldn&apos;t import those moves</AlertTitle>
          <AlertDescription>{importError}</AlertDescription>
        </Alert>
      ) : null}
    </>
  )
}
