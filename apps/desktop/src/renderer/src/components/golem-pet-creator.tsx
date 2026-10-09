import {
  AlertIcon,
  ArrowLeftIcon,
  ArrowRightIcon,
  CheckIcon,
  CloseIcon,
  CrosshairIcon,
  ImageIcon,
  RefreshIcon,
  SpinnerIcon,
  UploadIcon
} from '@/components/icons'
import { useEffect, useRef, useState, type CSSProperties, type ReactElement } from 'react'

import { GroupedList, ListRow } from '@/components/list-row'
import { PanelSection } from '@/components/panel-section'
import { Alert, AlertAction, AlertTitle } from '@/components/ui/alert'
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
import { LazyGolemPetPreview } from '@/components/golem-pet-preview-lazy'
import {
  useGolemPetCreator,
  useGolemPetCreatorConnection,
  type GolemPetCreatorClient,
  type GolemPetCreatorController,
  type GolemPetCreatorState
} from '@/hooks/use-golem-pet-creator'
import { useStudioCore } from '@/hooks/use-studio'
import type { CohostPersona, GolemPetCreation, GolemPetReference } from '@/lib/backend'
import { golemStateImageUrl } from '@/lib/golem-default-pack'
import { useGolemPetCreatorOptions } from '@/lib/golem-pet-creator-nav'
import {
  GOLEM_PET_CREATOR_STEPS,
  GOLEM_PET_NONE_LEFT,
  GOLEM_PET_PILOT_POSES,
  GOLEM_PET_REVIEW_ROWS,
  GOLEM_PET_SHEET_LABELS,
  golemPetAllowanceCopy,
  golemPetCanSave,
  golemPetCreatorGate,
  golemPetCreatorStep,
  golemPetGazeArrow,
  golemPetMarkRow,
  golemPetMarkedCount,
  golemPetNameToSave,
  golemPetNeedsNewCreation,
  golemPetNextSheet,
  golemPetNotesDraft,
  golemPetNotesFromDraft,
  golemPetPilotsLeft,
  golemPetRowMarked,
  golemPetSheetPhase,
  type GolemPetCreatorStepId,
  type GolemPetNotesDraft,
  type GolemPetReviewMarks,
  type GolemPetReviewRow
} from '@/lib/golem-pet-creator-view'
import { displayKeyGlyph } from '@/lib/platform'
import { cn } from '@/lib/utils'
import {
  GOLEM_PET_ATLAS_SHEETS,
  GOLEM_PET_PACK_NAME_MAX_CHARS,
  GOLEM_PET_REFERENCE_UPLOAD_MAX_BYTES,
  type GolemPetSheetKey
} from '../../../shared/golem-pet-creator'

// The marks survive closing and reopening the wizard in one app session.
const reviewMarksByBuild = new Map<string, GolemPetReviewMarks>()

type ReferenceSource = 'persona' | 'upload'

interface PrimaryAction {
  label: string
  disabled: boolean
  run: () => void
  testId: string
}

/**
 * The Golem pet creator (plan 168 S-F5): a sub-view of the Golem tab that
 * turns one picture into an Alive Golem. Reference (the persona's idle image
 * or an upload; the identity notes as editable sentences),
 * Pilot (four poses, made again at most three times), Build (eight sheets,
 * one at a time, then the pack built on this computer), Review (every row
 * marked "Looks right"; a redo clears that row's mark) and Save (named; the
 * persona wears it). Everything lives in the backend's creation folder, so
 * closing the wizard or the app picks up where it was.
 *
 * Premium, cloud AI consent and a web that offers pet creation gate it;
 * when one is missing, one Alert names it and the controls are disabled.
 *
 * Plan 169 D11: the look panel's Make it Alive opens it with the kept look
 * as the reference (`persona-idle`, selected at the Reference step, its
 * "Read my Golem" focused) and the look's description shown beside it. The
 * identity call takes no description, so it is context for the streamer,
 * not sent.
 */
export function GolemPetCreator({
  onClose,
  client: injectedClient
}: {
  onClose: () => void
  /** Tests inject the backend; the app opens its own client. */
  client?: GolemPetCreatorClient | null
}): ReactElement {
  const {
    account,
    aiCapabilities,
    aiConsent,
    cohostGate,
    cohostSettings,
    patchCohostSettings,
    runtimeInfo
  } = useStudioCore()
  const connection = useGolemPetCreatorConnection()
  const client = injectedClient !== undefined ? injectedClient : connection.client
  const { state, controller } = useGolemPetCreator(client)
  const persona = cohostSettings?.persona ?? null
  const creation = state.creation
  const gate = golemPetCreatorGate({
    signedIn: account?.status === 'signed-in',
    gate: cohostGate,
    consented: aiConsent,
    capabilities: connection.capabilities ?? aiCapabilities
  })
  const modKey = displayKeyGlyph('⌘', runtimeInfo?.platform)

  const [naming, setNaming] = useState(false)
  const [cancelOpen, setCancelOpen] = useState(false)
  const [marksByBuild, setMarksByBuild] = useState<Record<string, GolemPetReviewMarks>>(() =>
    Object.fromEntries(reviewMarksByBuild)
  )
  const marks: GolemPetReviewMarks = creation ? (marksByBuild[creation.buildId] ?? {}) : {}
  const setMarks = (next: GolemPetReviewMarks): void => {
    if (!creation) return
    reviewMarksByBuild.set(creation.buildId, next)
    setMarksByBuild((current) => ({ ...current, [creation.buildId]: next }))
  }

  // The notes draft follows the backend's notes until the streamer edits.
  const notesKey = creation?.notes ? `${creation.buildId}:${JSON.stringify(creation.notes)}` : ''
  const [appliedNotesKey, setAppliedNotesKey] = useState('')
  const [draft, setDraft] = useState<GolemPetNotesDraft | null>(null)
  if (notesKey !== appliedNotesKey) {
    setAppliedNotesKey(notesKey)
    setDraft(creation?.notes ? golemPetNotesDraft(creation.notes) : null)
  }
  const parsedNotes = draft ? golemPetNotesFromDraft(draft) : null
  const notes = parsedNotes && 'notes' in parsedNotes ? parsedNotes.notes : null

  const openOptions = useGolemPetCreatorOptions()
  const [source, setSource] = useState<ReferenceSource>('persona')
  const [upload, setUpload] = useState<{ name: string; url: string; base64: string } | null>(null)
  const [choosingPicture, setChoosingPicture] = useState(false)
  // A row redone from Review keeps Review on screen while it is made and
  // the pack is built again; a failed build shows the Build step instead.
  const [redoKey, setRedoKey] = useState<GolemPetSheetKey | null>(null)
  const [name, setName] = useState(() => persona?.name ?? 'Golem')

  const working = state.pending !== null || Boolean(creation?.running)
  const rebuilding =
    redoKey !== null && creation?.step === 'build' && creation.build?.state === 'built'
  const step: GolemPetCreatorStepId =
    choosingPicture && creation && !creation.pilotAccepted
      ? 'reference'
      : rebuilding
        ? 'review'
        : golemPetCreatorStep(creation, naming)
  const showNotes = step === 'reference' && Boolean(creation?.notes) && !choosingPicture
  const controlsOff = !gate.allowed || !controller
  const reference: GolemPetReference | null =
    source === 'upload'
      ? upload
        ? { kind: 'upload', imageBase64: upload.base64 }
        : null
      : { kind: 'persona-idle' }

  const save = async (): Promise<void> => {
    const pack = golemPetNameToSave(name)
    if (!pack || !controller) return
    const saved = await controller.save(pack)
    if (!saved) return
    if (creation) reviewMarksByBuild.delete(creation.buildId)
    // The provider's copy of the persona follows the backend's (Alive now).
    await patchCohostSettings({ persona: saved.settings.persona }).catch(() => undefined)
    onClose()
  }

  const primary = primaryAction({
    step,
    creation,
    state,
    controller,
    gateOk: gate.allowed,
    canStart: gate.canStart,
    working,
    showNotes,
    reference,
    notesReady: notes !== null,
    allMarked: creation ? golemPetCanSave(marks, creation) : false,
    nameReady: golemPetNameToSave(name) !== null,
    onRead: () => {
      if (!controller || !reference) return
      setChoosingPicture(false)
      void controller.readReference(reference)
    },
    onPilot: () => {
      if (controller && notes) void controller.makePilot(notes)
    },
    onNaming: () => setNaming(true),
    onSave: () => void save()
  })

  // ⌘↵ continues, wherever the focus is inside the window.
  const primaryRef = useRef(primary)
  primaryRef.current = primary
  // Opened from the look (D11): the kept look is the reference, so its
  // "Read my Golem" takes the focus once it can run.
  const primaryButtonRef = useRef<HTMLButtonElement>(null)
  const focusedFromLook = useRef(false)
  const readyToRead =
    openOptions.reference === 'persona-idle' &&
    step === 'reference' &&
    !creation &&
    !state.loading &&
    primary?.testId === 'golem-pet-read' &&
    !primary.disabled
  useEffect(() => {
    if (!readyToRead || focusedFromLook.current) return
    focusedFromLook.current = true
    primaryButtonRef.current?.focus()
  }, [readyToRead])
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Enter' || !(event.metaKey || event.ctrlKey)) return
      const action = primaryRef.current
      if (!action || action.disabled) return
      event.preventDefault()
      action.run()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const problem = state.problem
  // An expired creation still builds and saves; only making pictures is over.
  const expired =
    Boolean(creation?.expired) &&
    (step === 'reference' ||
      step === 'pilot' ||
      (step === 'build' && creation !== null && golemPetNextSheet(creation) !== null))

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="golem-pet-creator">
      <div className="flex shrink-0 flex-col gap-2 border-b border-border px-gutter py-3">
        <div className="flex items-center gap-3">
          <Button size="sm" type="button" variant="ghost" onClick={onClose}>
            <ArrowLeftIcon data-icon="inline-start" />
            Golem
          </Button>
          <h2 className="text-sm font-semibold text-foreground">Create an Alive Golem</h2>
          {gate.allowance ? (
            <span
              className="ml-auto text-xs tabular-nums text-subtle"
              data-testid="golem-pet-allowance"
            >
              {golemPetAllowanceCopy(gate.allowance)}
            </span>
          ) : null}
        </div>
        <StepHeader current={step} />
      </div>

      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto overscroll-contain">
        {!gate.allowed ? (
          <div className="px-gutter pt-gutter">
            <Alert data-testid="golem-pet-gate">
              <AlertIcon />
              <AlertTitle>{gate.reason}</AlertTitle>
            </Alert>
          </div>
        ) : !creation && !state.loading && !gate.canStart ? (
          <div className="px-gutter pt-gutter">
            <Alert data-testid="golem-pet-gate">
              <AlertIcon />
              <AlertTitle>{GOLEM_PET_NONE_LEFT}</AlertTitle>
            </Alert>
          </div>
        ) : null}
        {expired || (problem && golemPetNeedsNewCreation(problem.code)) ? (
          <div className="px-gutter pt-gutter">
            <Alert variant="warning" data-testid="golem-pet-expired">
              <AlertIcon />
              <AlertTitle>
                {problem && golemPetNeedsNewCreation(problem.code)
                  ? problem.message
                  : 'This creation expired; start a new one.'}
              </AlertTitle>
              <AlertAction>
                <Button
                  disabled={controlsOff || working || !gate.canStart}
                  size="xs"
                  type="button"
                  variant="outline"
                  onClick={() => void controller?.startOver()}
                >
                  Start a new one
                </Button>
              </AlertAction>
            </Alert>
          </div>
        ) : problem && step !== 'build' ? (
          <div className="px-gutter pt-gutter">
            <Alert variant="destructive" data-testid="golem-pet-problem">
              <AlertIcon />
              <AlertTitle>{problem.message}</AlertTitle>
            </Alert>
          </div>
        ) : null}

        {state.loading && client ? (
          <div className="flex flex-col gap-3 p-gutter">
            <Skeleton className="h-6 w-48" />
            <Skeleton className="h-40 w-full max-w-md" />
          </div>
        ) : step === 'reference' && !showNotes ? (
          <ReferenceStep
            disabled={controlsOff || working}
            identityError={state.identityError}
            lookNotes={openOptions.reference === 'persona-idle' ? openOptions.notes : undefined}
            persona={persona}
            source={source}
            upload={upload}
            onSource={setSource}
            onUpload={setUpload}
          />
        ) : step === 'reference' && draft ? (
          <NotesStep
            disabled={controlsOff || working}
            draft={draft}
            error={parsedNotes && 'error' in parsedNotes ? parsedNotes.error : null}
            onChange={setDraft}
            onOtherPicture={() => setChoosingPicture(true)}
          />
        ) : step === 'pilot' && creation && persona && draft ? (
          <PilotStep
            creation={creation}
            disabled={controlsOff || working}
            draft={draft}
            notesError={parsedNotes && 'error' in parsedNotes ? parsedNotes.error : null}
            personaId={persona.id}
            onDraft={setDraft}
            onRedo={() => {
              if (controller && notes) void controller.makePilot(notes)
            }}
          />
        ) : step === 'build' && creation ? (
          <BuildStep
            controller={controller}
            creation={creation}
            disabled={controlsOff}
            state={state}
          />
        ) : step === 'review' && creation && persona ? (
          <ReviewStep
            controller={controller}
            creation={creation}
            disabled={controlsOff || working}
            busyRow={redoKey && (working || rebuilding) ? redoKey : null}
            marks={marks}
            personaId={persona.id}
            onMarks={setMarks}
            onRedo={setRedoKey}
          />
        ) : step === 'save' ? (
          <SaveStep
            disabled={controlsOff || working}
            name={name}
            onBack={() => setNaming(false)}
            onName={setName}
          />
        ) : null}
      </div>

      <div className="flex shrink-0 items-center gap-2 border-t border-border px-gutter py-3">
        {creation ? (
          <Button
            data-testid="golem-pet-cancel"
            disabled={!controller || state.pending === 'cancel' || state.pending === 'save'}
            size="sm"
            type="button"
            variant="ghost"
            onClick={() => setCancelOpen(true)}
          >
            Cancel creation
          </Button>
        ) : null}
        {primary ? (
          <Button
            ref={primaryButtonRef}
            className="ml-auto"
            data-testid={primary.testId}
            disabled={primary.disabled}
            type="button"
            onClick={primary.run}
          >
            {primary.label}
            <Kbd className="ml-0.5">{modKey}↵</Kbd>
          </Button>
        ) : null}
      </div>

      <Dialog open={cancelOpen} onOpenChange={setCancelOpen}>
        <DialogContent showCloseButton={false}>
          <DialogHeader>
            <DialogTitle>Cancel this creation?</DialogTitle>
            <DialogDescription>
              Its pictures and any built pack are deleted from this computer. Once a sheet after the
              pilot was made, it still counts against this month.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button autoFocus type="button" variant="ghost" onClick={() => setCancelOpen(false)}>
              Keep it
            </Button>
            <Button
              data-testid="golem-pet-cancel-confirm"
              type="button"
              variant="destructive"
              onClick={() => {
                setCancelOpen(false)
                setNaming(false)
                setRedoKey(null)
                if (creation) reviewMarksByBuild.delete(creation.buildId)
                void controller?.cancel()
              }}
            >
              Cancel creation
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

function primaryAction({
  step,
  creation,
  state,
  controller,
  gateOk,
  canStart,
  working,
  showNotes,
  reference,
  notesReady,
  allMarked,
  nameReady,
  onRead,
  onPilot,
  onNaming,
  onSave
}: {
  step: GolemPetCreatorStepId
  creation: GolemPetCreation | null
  state: GolemPetCreatorState
  controller: GolemPetCreatorController | null
  gateOk: boolean
  canStart: boolean
  working: boolean
  showNotes: boolean
  reference: GolemPetReference | null
  notesReady: boolean
  allMarked: boolean
  nameReady: boolean
  onRead: () => void
  onPilot: () => void
  onNaming: () => void
  onSave: () => void
}): PrimaryAction | null {
  const off = !gateOk || !controller || working
  const web = !creation?.expired
  switch (step) {
    case 'reference':
      if (showNotes) {
        return {
          label: state.pending === 'sheet' ? 'Making the pilot…' : 'Make the pilot',
          disabled: off || !notesReady || !web,
          run: onPilot,
          testId: 'golem-pet-make-pilot'
        }
      }
      return {
        label:
          state.pending === 'start' || state.pending === 'identity'
            ? 'Reading your Golem…'
            : 'Read my Golem',
        disabled: off || !reference || (!creation && !canStart) || !web,
        run: onRead,
        testId: 'golem-pet-read'
      }
    case 'pilot':
      return {
        label: 'Looks like my Golem',
        disabled: off || !web,
        run: () => void controller?.makeSheets(),
        testId: 'golem-pet-accept-pilot'
      }
    case 'build': {
      if (!creation) return null
      const missing = golemPetNextSheet(creation) !== null
      if (missing) {
        return {
          label: working ? 'Making the sheets…' : 'Make the sheets',
          disabled: off || !web,
          run: () => void controller?.makeSheets(),
          testId: 'golem-pet-make-sheets'
        }
      }
      return {
        label: working ? 'Building…' : creation.build ? 'Build again' : 'Build',
        disabled: off,
        run: () => void controller?.build(),
        testId: 'golem-pet-build'
      }
    }
    case 'review':
      return {
        label: 'Name it',
        disabled: off || !allMarked,
        run: onNaming,
        testId: 'golem-pet-continue'
      }
    case 'save':
      return {
        label: state.pending === 'save' ? 'Saving…' : 'Save and wear it',
        disabled: off || !nameReady || !allMarked,
        run: onSave,
        testId: 'golem-pet-save'
      }
  }
}

function StepHeader({ current }: { current: GolemPetCreatorStepId }): ReactElement {
  const index = GOLEM_PET_CREATOR_STEPS.findIndex((step) => step.id === current)
  return (
    <ol aria-label="Steps" className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
      {GOLEM_PET_CREATOR_STEPS.map((step, position) => (
        <li
          key={step.id}
          aria-current={position === index ? 'step' : undefined}
          className={cn(
            'flex items-center gap-1.5',
            position === index
              ? 'font-medium text-foreground'
              : position < index
                ? 'text-muted-foreground'
                : 'text-subtle'
          )}
          data-testid={`golem-pet-step-${step.id}`}
        >
          {position < index ? (
            <CheckIcon aria-hidden className="size-3" />
          ) : (
            <span className="tabular-nums">{position + 1}</span>
          )}
          {step.label}
        </li>
      ))}
    </ol>
  )
}

// --- Images from the creation folder (main IPC, never the network) ------------

/** A creation file as an object URL; null until it loads or when missing. */
function useCreationFileUrl(
  personaId: string | null,
  buildId: string | null,
  file: string | null,
  type: string
): string | null {
  const [loaded, setLoaded] = useState<{ key: string; url: string } | null>(null)
  const key = personaId && buildId && file ? `${personaId}/${buildId}/${file}` : null
  useEffect(() => {
    if (!key || !personaId || !buildId || !file) return
    let disposed = false
    let url: string | null = null
    void window.videorc
      ?.readGolemCreationFile?.(personaId, buildId, file)
      .then((bytes) => {
        if (disposed || !bytes) return
        url = URL.createObjectURL(new Blob([bytes as BlobPart], { type }))
        setLoaded({ key, url })
      })
      .catch(() => undefined)
    return () => {
      disposed = true
      if (url) URL.revokeObjectURL(url)
    }
  }, [buildId, file, key, personaId, type])
  return loaded && loaded.key === key ? loaded.url : null
}

interface CreationAtlas {
  url: string
  width: number
  height: number
  frames: Map<string, [number, number, number, number]>
  neutral: string
}

/** The built pack (`pack/manifest.json` and its atlas), reloaded per build. */
function useCreationAtlas(personaId: string, creation: GolemPetCreation): CreationAtlas | null {
  const stamp = creation.build?.state === 'built' ? creation.build.finishedAt : null
  const url = useCreationFileUrl(
    personaId,
    stamp ? creation.buildId : null,
    stamp ? 'pack/mascot.webp' : null,
    'image/webp'
  )
  const [manifest, setManifest] = useState<{
    stamp: string
    atlas: Omit<CreationAtlas, 'url'>
  } | null>(null)
  useEffect(() => {
    if (!stamp) return
    let disposed = false
    void window.videorc
      ?.readGolemCreationFile?.(personaId, creation.buildId, 'pack/manifest.json')
      .then((bytes) => {
        if (disposed || !bytes) return
        const parsed = JSON.parse(new TextDecoder().decode(bytes)) as {
          neutral: string
          frames: { id: string; rect: [number, number, number, number] }[]
        }
        const frames = new Map(parsed.frames.map((frame) => [frame.id, frame.rect] as const))
        const rects = [...frames.values()]
        setManifest({
          stamp,
          atlas: {
            frames,
            neutral: parsed.neutral,
            width: Math.max(...rects.map(([x, , w]) => x + w)),
            height: Math.max(...rects.map(([, y, , h]) => y + h))
          }
        })
      })
      .catch(() => undefined)
    return () => {
      disposed = true
    }
  }, [creation.buildId, personaId, stamp])
  if (!url || !manifest || manifest.stamp !== stamp) return null
  return { url, ...manifest.atlas }
}

/** One atlas cell, drawn from the atlas with CSS (no decode per cell). */
function AtlasCell({
  atlas,
  frame,
  size,
  className,
  label
}: {
  atlas: CreationAtlas
  frame: string
  size: number
  className?: string
  label: string
}): ReactElement {
  const rect = atlas.frames.get(frame)
  const style: CSSProperties = rect
    ? {
        width: size,
        height: size,
        backgroundImage: `url("${atlas.url}")`,
        backgroundRepeat: 'no-repeat',
        backgroundSize: `${(atlas.width / rect[2]) * size}px ${(atlas.height / rect[3]) * size}px`,
        backgroundPosition: `${(-rect[0] / rect[2]) * size}px ${(-rect[1] / rect[3]) * size}px`
      }
    : { width: size, height: size }
  return (
    <div
      aria-label={label}
      className={cn('shrink-0 rounded-chip bg-muted/30', className)}
      role="img"
      style={style}
    />
  )
}

// --- Steps ---------------------------------------------------------------------

function ReferenceStep({
  persona,
  source,
  upload,
  disabled,
  identityError,
  lookNotes,
  onSource,
  onUpload
}: {
  persona: CohostPersona | null
  source: ReferenceSource
  upload: { name: string; url: string; base64: string } | null
  disabled: boolean
  identityError: string | null
  /** The look's description when Make it Alive opened the creator (D11). */
  lookNotes?: string
  onSource: (source: ReferenceSource) => void
  onUpload: (upload: { name: string; url: string; base64: string } | null) => void
}): ReactElement {
  const fileInput = useRef<HTMLInputElement>(null)
  const [uploadError, setUploadError] = useState<string | null>(null)
  const preview =
    source === 'upload'
      ? (upload?.url ?? null)
      : persona
        ? golemStateImageUrl(persona, 'idle')
        : null

  const pick = async (file: File): Promise<void> => {
    setUploadError(null)
    if (file.size > GOLEM_PET_REFERENCE_UPLOAD_MAX_BYTES) {
      setUploadError('Choose a picture smaller than 8 MB.')
      return
    }
    if (!['image/png', 'image/webp'].includes(file.type)) {
      setUploadError('Choose a PNG or WebP with a transparent background.')
      return
    }
    const base64 = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => resolve(String(reader.result).replace(/^data:[^,]*,/, ''))
      reader.onerror = () => reject(reader.error ?? new Error('The picture could not be read.'))
      reader.readAsDataURL(file)
    })
    if (upload) URL.revokeObjectURL(upload.url)
    onUpload({ name: file.name, url: URL.createObjectURL(file), base64 })
  }

  return (
    <PanelSection
      description="One picture of the whole body, facing you, on a transparent background. Golem reads its colours, materials and proportions from it, and every pose is drawn from it."
      title="Start from one picture"
    >
      <div className="flex flex-wrap items-start gap-4">
        <div className="flex size-40 shrink-0 items-center justify-center overflow-hidden rounded-row border border-border bg-muted/30">
          {preview ? (
            <img
              alt="Reference"
              className="size-full object-contain"
              data-testid="golem-pet-reference-preview"
              draggable={false}
              src={preview}
            />
          ) : (
            <ImageIcon aria-hidden className="size-6 text-subtle" />
          )}
        </div>
        <div className="flex min-w-60 flex-1 flex-col gap-3">
          <ToggleGroup
            aria-label="Picture"
            className="w-fit"
            disabled={disabled}
            size="sm"
            type="single"
            value={source}
            onValueChange={(next) => {
              if (next) onSource(next as ReferenceSource)
            }}
          >
            <ToggleGroupItem className="px-3 text-xs" value="persona">
              My Golem&apos;s picture
            </ToggleGroupItem>
            <ToggleGroupItem className="px-3 text-xs" value="upload">
              Upload
            </ToggleGroupItem>
          </ToggleGroup>
          {source === 'persona' ? (
            <div className="flex flex-col gap-1">
              <p className="text-xs text-muted-foreground">
                The idle picture from your Golem&apos;s look. To make a new look, use Create my
                Golem in the Avatar section first.
              </p>
              {lookNotes ? (
                <p
                  className="text-xs text-muted-foreground select-text"
                  data-testid="golem-pet-look-notes"
                >
                  Your look: &ldquo;{lookNotes}&rdquo;
                </p>
              ) : null}
            </div>
          ) : null}
          {source === 'upload' ? (
            <div className="flex flex-wrap items-center gap-2">
              <Button
                disabled={disabled}
                size="sm"
                type="button"
                variant="outline"
                onClick={() => fileInput.current?.click()}
              >
                <UploadIcon data-icon="inline-start" />
                Choose a picture…
              </Button>
              {upload ? (
                <span className="truncate text-xs text-muted-foreground">{upload.name}</span>
              ) : null}
              <input
                ref={fileInput}
                accept="image/png,image/webp"
                className="hidden"
                data-testid="golem-pet-upload-input"
                type="file"
                onChange={(event) => {
                  const file = event.currentTarget.files?.[0]
                  event.currentTarget.value = ''
                  if (file) {
                    void pick(file).catch((error: unknown) =>
                      setUploadError(
                        error instanceof Error ? error.message : 'The picture could not be read.'
                      )
                    )
                  }
                }}
              />
            </div>
          ) : null}
          {uploadError || identityError ? (
            <p className="text-xs text-destructive" data-testid="golem-pet-reference-error">
              {uploadError ?? identityError}
            </p>
          ) : null}
        </div>
      </div>
    </PanelSection>
  )
}

function NotesEditor({
  draft,
  disabled,
  error,
  onChange
}: {
  draft: GolemPetNotesDraft
  disabled: boolean
  error: string | null
  onChange: (draft: GolemPetNotesDraft) => void
}): ReactElement {
  return (
    <FieldGroup data-testid="golem-pet-notes" variant="grouped">
      <Field>
        <FieldLabel htmlFor="golem-pet-palette">Its colours are</FieldLabel>
        <Input
          disabled={disabled}
          id="golem-pet-palette"
          value={draft.palette}
          onChange={(event) => onChange({ ...draft, palette: event.target.value })}
        />
      </Field>
      <Field>
        <FieldLabel htmlFor="golem-pet-materials">It is made of</FieldLabel>
        <Input
          disabled={disabled}
          id="golem-pet-materials"
          value={draft.materials}
          onChange={(event) => onChange({ ...draft, materials: event.target.value })}
        />
      </Field>
      <Field>
        <FieldLabel htmlFor="golem-pet-proportions">Its proportions</FieldLabel>
        <Textarea
          className="min-h-16"
          disabled={disabled}
          id="golem-pet-proportions"
          value={draft.proportions}
          onChange={(event) => onChange({ ...draft, proportions: event.target.value })}
        />
      </Field>
      <Field>
        <FieldLabel>On one side only</FieldLabel>
        <FieldDescription>
          Its own side, as it faces you: its left is on your right.
        </FieldDescription>
        <div className="flex flex-col gap-2">
          {draft.asymmetric.map((item, index) => (
            <div key={index} className="flex items-center gap-2">
              <Input
                aria-label={`Feature ${index + 1}`}
                className="flex-1"
                disabled={disabled}
                value={item.feature}
                onChange={(event) =>
                  onChange({
                    ...draft,
                    asymmetric: draft.asymmetric.map((other, at) =>
                      at === index ? { ...other, feature: event.target.value } : other
                    )
                  })
                }
              />
              <Select
                disabled={disabled}
                value={item.side}
                onValueChange={(side) =>
                  onChange({
                    ...draft,
                    asymmetric: draft.asymmetric.map((other, at) =>
                      at === index ? { ...other, side: side as 'left' | 'right' } : other
                    )
                  })
                }
              >
                <SelectTrigger aria-label={`Side of feature ${index + 1}`} className="w-28">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    <SelectItem value="left">Its left</SelectItem>
                    <SelectItem value="right">Its right</SelectItem>
                  </SelectGroup>
                </SelectContent>
              </Select>
              <Button
                aria-label={`Remove feature ${index + 1}`}
                disabled={disabled}
                size="icon-sm"
                type="button"
                variant="ghost"
                onClick={() =>
                  onChange({
                    ...draft,
                    asymmetric: draft.asymmetric.filter((_, at) => at !== index)
                  })
                }
              >
                <CloseIcon />
              </Button>
            </div>
          ))}
          <Button
            className="w-fit"
            disabled={disabled}
            size="xs"
            type="button"
            variant="ghost"
            onClick={() =>
              onChange({
                ...draft,
                asymmetric: [...draft.asymmetric, { feature: '', side: 'left' }]
              })
            }
          >
            Add a feature
          </Button>
        </div>
      </Field>
      {error ? (
        <p className="px-3 pb-2.5 text-xs text-destructive" data-testid="golem-pet-notes-error">
          {error}
        </p>
      ) : null}
    </FieldGroup>
  )
}

function NotesStep({
  draft,
  disabled,
  error,
  onChange,
  onOtherPicture
}: {
  draft: GolemPetNotesDraft
  disabled: boolean
  error: string | null
  onChange: (draft: GolemPetNotesDraft) => void
  onOtherPicture: () => void
}): ReactElement {
  return (
    <PanelSection
      action={
        <Button
          disabled={disabled}
          size="xs"
          type="button"
          variant="ghost"
          onClick={onOtherPicture}
        >
          Use another picture
        </Button>
      }
      description="What Golem read from your picture. Correct anything it got wrong: these words go with every pose it draws."
      title="What Golem sees"
    >
      <NotesEditor disabled={disabled} draft={draft} error={error} onChange={onChange} />
    </PanelSection>
  )
}

function PilotStep({
  creation,
  personaId,
  draft,
  disabled,
  notesError,
  onDraft,
  onRedo
}: {
  creation: GolemPetCreation
  personaId: string
  draft: GolemPetNotesDraft
  disabled: boolean
  notesError: string | null
  onDraft: (draft: GolemPetNotesDraft) => void
  onRedo: () => void
}): ReactElement {
  const pilot = creation.pilot ?? null
  const url = useCreationFileUrl(personaId, creation.buildId, pilot?.file ?? null, 'image/png')
  const left = golemPetPilotsLeft(creation)
  const making = creation.running?.job === 'sheet' && creation.running.sheet === 'pilot'
  return (
    <>
      <PanelSection
        action={
          <Button
            data-testid="golem-pet-redo-pilot"
            disabled={disabled || left === 0 || notesError !== null || creation.expired}
            size="xs"
            type="button"
            variant="ghost"
            onClick={onRedo}
          >
            <RefreshIcon data-icon="inline-start" />
            Make another pilot ({left} left)
          </Button>
        }
        description="Four poses before the rest: neutral, turned left, turned right and laughing. If this looks like your Golem, every other sheet follows it."
        title="Pilot"
      >
        {making ? (
          <Skeleton className="aspect-square w-full max-w-80 rounded-row" />
        ) : url ? (
          <img
            alt={`Pilot: ${GOLEM_PET_PILOT_POSES.join(', ')}`}
            className="aspect-square w-full max-w-80 rounded-row border border-border bg-muted/30 object-contain"
            data-testid="golem-pet-pilot"
            draggable={false}
            src={url}
          />
        ) : (
          <Skeleton className="aspect-square w-full max-w-80 rounded-row" />
        )}
        {pilot?.opaque ? (
          <p className="text-xs text-muted-foreground">
            This pilot came back without transparency. Make another one.
          </p>
        ) : null}
      </PanelSection>
      <PanelSection
        description="A new pilot uses these words. They are fixed once the pilot looks right."
        title="What Golem sees"
      >
        <NotesEditor disabled={disabled} draft={draft} error={notesError} onChange={onDraft} />
      </PanelSection>
    </>
  )
}

function BuildStep({
  creation,
  state,
  controller,
  disabled
}: {
  creation: GolemPetCreation
  state: GolemPetCreatorState
  controller: GolemPetCreatorController | null
  disabled: boolean
}): ReactElement {
  const building = creation.running?.job === 'build' || state.pending === 'build'
  const progress =
    state.build && state.build.step !== 'done' && state.build.step !== 'failed' ? state.build : null
  const failure = creation.build?.state === 'failed' && !building ? creation.build.error : null
  const failedSheet = failure?.sheet
    ? (GOLEM_PET_ATLAS_SHEETS.find((sheet) => sheet.key === failure.sheet) ?? null)
    : null
  const working = state.pending !== null || Boolean(creation.running)
  return (
    <>
      <PanelSection
        description={`Eight sheets, one at a time; each takes up to two minutes. ${creation.sheetsRemaining} sheets and ${creation.redosRemaining} redos left in this creation.`}
        title="Sheets"
      >
        <GroupedList>
          {GOLEM_PET_ATLAS_SHEETS.map((sheet) => {
            const row = golemPetSheetPhase(creation, sheet.key, state.sheetErrors)
            return (
              <ListRow
                key={sheet.key}
                context={
                  row.phase === 'failed'
                    ? row.error
                    : row.opaque
                      ? 'No transparency; redo it'
                      : undefined
                }
                data-testid={`golem-pet-sheet-${sheet.key}`}
                icon={
                  row.phase === 'making' ? (
                    <SpinnerIcon className="animate-spin text-muted-foreground" />
                  ) : row.phase === 'done' ? (
                    <CheckIcon className="text-muted-foreground" />
                  ) : row.phase === 'failed' ? (
                    <AlertIcon className="text-destructive" />
                  ) : (
                    <span className="size-1.5 rounded-full bg-subtle" />
                  )
                }
                interactive={false}
                meta={
                  row.phase === 'making'
                    ? 'Making…'
                    : row.phase === 'done'
                      ? row.version && row.version > 1
                        ? `Redone ${row.version - 1}×`
                        : 'Done'
                      : row.phase === 'failed'
                        ? 'Failed'
                        : 'Waiting'
                }
                title={GOLEM_PET_SHEET_LABELS[sheet.key]}
              >
                {row.phase === 'failed' || (row.phase === 'done' && row.opaque) ? (
                  <Button
                    disabled={disabled || working || creation.expired}
                    size="xs"
                    type="button"
                    variant="ghost"
                    onClick={() =>
                      void (row.version
                        ? controller?.redoSheet(sheet.key)
                        : controller?.makeSheets())
                    }
                  >
                    {row.version ? 'Redo' : 'Try again'}
                  </Button>
                ) : null}
              </ListRow>
            )
          })}
        </GroupedList>
      </PanelSection>
      <PanelSection
        description="Built on this computer from the sheets: each pose is cut out, stood on its feet and packed."
        title="Pack"
      >
        {building ? (
          <div className="flex flex-col gap-1.5" data-testid="golem-pet-build-progress">
            <div
              aria-label="Build progress"
              aria-valuemax={progress?.total ?? 1}
              aria-valuemin={0}
              aria-valuenow={progress?.done ?? 0}
              className="h-1.5 w-full max-w-md overflow-hidden rounded-full bg-muted"
              role="progressbar"
            >
              <div
                className="h-full rounded-full bg-primary transition-[width] duration-150"
                style={{
                  width: `${progress && progress.total > 0 ? (progress.done / progress.total) * 100 : 0}%`
                }}
              />
            </div>
            <span className="text-xs tabular-nums text-muted-foreground">
              {progress
                ? `${buildStepCopy(progress.step)}${progress.sheet ? ` ${GOLEM_PET_SHEET_LABELS[progress.sheet as GolemPetSheetKey] ?? progress.sheet}` : ''} · ${progress.done} of ${progress.total}`
                : 'Starting…'}
            </span>
          </div>
        ) : failure ? (
          <Alert data-testid="golem-pet-build-failure" variant="destructive">
            <AlertIcon />
            <AlertTitle>{failure.message}</AlertTitle>
            {failedSheet ? (
              <AlertAction>
                <Button
                  disabled={
                    disabled || working || creation.expired || creation.redosRemaining === 0
                  }
                  size="xs"
                  type="button"
                  variant="outline"
                  onClick={() => void controller?.redoSheet(failedSheet.key)}
                >
                  Redo {GOLEM_PET_SHEET_LABELS[failedSheet.key]}
                </Button>
              </AlertAction>
            ) : null}
          </Alert>
        ) : (
          <p className="text-xs text-muted-foreground">
            {golemPetNextSheet(creation)
              ? 'Builds once every sheet is made.'
              : 'Every sheet is made. Build the pack to review it.'}
          </p>
        )}
        {state.problem &&
        !failure &&
        !Object.values(state.sheetErrors).includes(state.problem.message) ? (
          <p className="text-xs text-destructive" data-testid="golem-pet-problem">
            {state.problem.message}
          </p>
        ) : null}
      </PanelSection>
    </>
  )
}

function buildStepCopy(step: string): string {
  switch (step) {
    case 'reading':
      return 'Reading'
    case 'cutting':
      return 'Cutting'
    case 'registering':
      return 'Lining up'
    case 'packing':
      return 'Packing'
    default:
      return 'Writing'
  }
}

function ReviewStep({
  creation,
  personaId,
  controller,
  marks,
  disabled,
  busyRow,
  onMarks,
  onRedo
}: {
  creation: GolemPetCreation
  personaId: string
  controller: GolemPetCreatorController | null
  marks: GolemPetReviewMarks
  disabled: boolean
  /** The row being redone and built again. */
  busyRow: GolemPetSheetKey | null
  onMarks: (marks: GolemPetReviewMarks) => void
  onRedo: (key: GolemPetSheetKey) => void
}): ReactElement {
  const atlas = useCreationAtlas(personaId, creation)
  const marked = golemPetMarkedCount(marks, creation)
  const redoing =
    busyRow ??
    (creation.running?.job === 'sheet' ? (creation.running.sheet as GolemPetSheetKey) : null)
  return (
    <PanelSection
      description="Check every row: each pose looks where its arrow points, and every pose looks like the same Golem. Redo a row that is wrong; it counts against this creation's redos."
      title="Review"
    >
      <div className="flex flex-wrap items-start gap-6">
        <div className="flex min-w-0 flex-1 flex-col gap-4" data-testid="golem-pet-review">
          {GOLEM_PET_REVIEW_ROWS.map((row, index) => (
            <ReviewRow
              key={row.key}
              atlas={atlas}
              disabled={disabled || redoing !== null}
              gazeRow={index < 5 ? index : null}
              marked={golemPetRowMarked(marks, creation, row.key)}
              redoing={redoing === row.key}
              redosLeft={creation.redosRemaining}
              row={row}
              canRedo={!creation.expired}
              onMark={(next) => onMarks(golemPetMarkRow(marks, creation, row.key, next))}
              onRedo={() => {
                onMarks(golemPetMarkRow(marks, creation, row.key, false))
                onRedo(row.key)
                void controller?.redoSheet(row.key)
              }}
            />
          ))}
        </div>
        <aside className="flex flex-col items-center gap-2">
          <LazyGolemPetPreview
            interactive
            packId={creation.buildId}
            personaId={personaId}
            reloadKey={creation.build?.finishedAt ?? ''}
            readFile={(file) =>
              window.videorc?.readGolemCreationFile?.(
                personaId,
                creation.buildId,
                `pack/${file}`
              ) ?? Promise.resolve(null)
            }
            size={160}
          />
          <span
            className="text-xs tabular-nums text-muted-foreground"
            data-testid="golem-pet-marked"
          >
            {marked} of {GOLEM_PET_REVIEW_ROWS.length} rows look right
          </span>
        </aside>
      </div>
    </PanelSection>
  )
}

function ReviewRow({
  row,
  gazeRow,
  atlas,
  marked,
  redoing,
  redosLeft,
  canRedo,
  disabled,
  onMark,
  onRedo
}: {
  row: GolemPetReviewRow
  gazeRow: number | null
  atlas: CreationAtlas | null
  marked: boolean
  redoing: boolean
  redosLeft: number
  canRedo: boolean
  disabled: boolean
  onMark: (marked: boolean) => void
  onRedo: () => void
}): ReactElement {
  const size = gazeRow !== null ? 72 : 60
  return (
    <div className="flex flex-wrap items-center gap-3" data-testid={`golem-pet-row-${row.key}`}>
      <div className="flex gap-1">
        {row.cells.map((frame, col) => {
          const arrow = gazeRow !== null ? golemPetGazeArrow(col, gazeRow) : null
          const label = arrow?.label ?? row.captions?.[col] ?? frame
          return (
            <div key={frame} className="flex flex-col items-center gap-1">
              <div className="relative">
                {atlas && !redoing ? (
                  <AtlasCell atlas={atlas} frame={frame} label={label} size={size} />
                ) : (
                  <Skeleton className="rounded-chip" style={{ width: size, height: size }} />
                )}
                {arrow ? (
                  <span
                    aria-hidden
                    className="absolute top-1 right-1 flex size-4 items-center justify-center rounded-full bg-background/70 text-muted-foreground"
                  >
                    {arrow.center ? (
                      <CrosshairIcon className="size-3" />
                    ) : (
                      <ArrowRightIcon
                        className="size-3"
                        style={{ transform: `rotate(${arrow.degrees}deg)` }}
                      />
                    )}
                  </span>
                ) : null}
              </div>
              {row.captions ? (
                <span className="text-[11px] text-subtle">{row.captions[col]}</span>
              ) : null}
            </div>
          )
        })}
      </div>
      <div className="flex min-w-36 flex-col gap-1">
        <span className="text-xs font-medium text-foreground">{row.label}</span>
        <div className="flex items-center gap-1">
          <Button
            aria-pressed={marked}
            data-testid={`golem-pet-mark-${row.key}`}
            disabled={disabled || redoing || !atlas}
            size="xs"
            type="button"
            variant={marked ? 'secondary' : 'outline'}
            onClick={() => onMark(!marked)}
          >
            <CheckIcon data-icon="inline-start" />
            Looks right
          </Button>
          <Button
            data-testid={`golem-pet-redo-${row.key}`}
            disabled={disabled || redoing || redosLeft === 0 || !canRedo}
            size="xs"
            type="button"
            variant="ghost"
            onClick={onRedo}
          >
            {redoing ? (
              <SpinnerIcon className="animate-spin" data-icon="inline-start" />
            ) : (
              <RefreshIcon data-icon="inline-start" />
            )}
            {redoing ? 'Redoing…' : 'Redo row'}
          </Button>
        </div>
      </div>
    </div>
  )
}

function SaveStep({
  name,
  disabled,
  onName,
  onBack
}: {
  name: string
  disabled: boolean
  onName: (name: string) => void
  onBack: () => void
}): ReactElement {
  const invalid = golemPetNameToSave(name) === null
  return (
    <PanelSection
      action={
        <Button disabled={disabled} size="xs" type="button" variant="ghost" onClick={onBack}>
          Back to review
        </Button>
      }
      description="Kept on this computer. Your Golem wears it right away; switch back to Still any time."
      title="Name it"
    >
      <div className="flex flex-col gap-1">
        <Input
          aria-invalid={invalid || undefined}
          aria-label="Pack name"
          className="max-w-72"
          data-testid="golem-pet-name"
          disabled={disabled}
          maxLength={GOLEM_PET_PACK_NAME_MAX_CHARS}
          value={name}
          onChange={(event) => onName(event.target.value)}
        />
        {invalid ? <span className="text-xs text-destructive">The pack needs a name.</span> : null}
      </div>
    </PanelSection>
  )
}
