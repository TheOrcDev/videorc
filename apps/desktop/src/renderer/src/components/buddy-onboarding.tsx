import {
  AlertIcon,
  ArrowLeftIcon,
  CheckIcon,
  CloseIcon,
  DeleteIcon,
  ImageIcon,
  ResetIcon,
  SparkleIcon
} from '@/components/icons'
import {
  useEffect,
  useRef,
  useState,
  type DragEvent,
  type KeyboardEvent,
  type ReactElement,
  type ReactNode
} from 'react'

import { BuddyCreateGateAlert } from '@/components/buddy-create-gate-alert'
import { BuddyExampleChips } from '@/components/buddy-example-chips'
import {
  BUDDY_LOOK_TILES_COPY,
  BuddyLookWorkingLine,
  BuddyPoseTiles
} from '@/components/buddy-look-tiles'
import { LazyBuddyPetPreview } from '@/components/buddy-pet-preview-lazy'
import { BuddyPictureCard } from '@/components/buddy-picture-card'
import { BuddyStreamDemo } from '@/components/buddy-stream-demo'
import { CloudAiConsentDialog } from '@/components/cloud-ai-consent-dialog'
import { ConfirmDialog } from '@/components/confirm-dialog'
import { GroupedList } from '@/components/list-row'
import { Gallery } from '@/components/page'
import { Alert, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { ShortcutKeys } from '@/components/ui/shortcut-keys'
import { Skeleton } from '@/components/ui/skeleton'
import { Textarea } from '@/components/ui/textarea'
import { Spinner } from '@/components/ui/spinner'
import type { BuddyLibraryController } from '@/hooks/use-buddy-library'
import { useBuddyLook, useBuddyLookClient, type BuddyLookClient } from '@/hooks/use-buddy-look'
import { useStudioCore } from '@/hooks/use-studio'
import type { CohostPersona, BuddyLibraryState } from '@/lib/backend'
import {
  buddyImagesLeftLine,
  buddyLookCreateGate,
  buddyLookRedoGate,
  type BuddyCreateGate
} from '@/lib/buddy-create-gate'
import {
  EMPTY_BUDDY_ONBOARDING_INPUT,
  buddyCreateFailureLine,
  buddyLibraryLimit,
  buddyLibraryView,
  buddyOnboardingAllowanceLine,
  buddyOnboardingCanAdvance,
  buddyOnboardingCanSkip,
  buddyOnboardingCreateParams,
  buddyOnboardingHasLook,
  buddyOnboardingName,
  buddyOnboardingReachable,
  buddyTextLength,
  type BuddyLibraryCard,
  type BuddyOnboardingInput,
  type BuddyOnboardingStep
} from '@/lib/buddy-library-view'
import {
  BUDDY_LOOK_PICTURE_TYPES,
  buddyLookDraftImages,
  prepareBuddyLookPicture,
  type BuddyLookPicture
} from '@/lib/buddy-look-view'
import { BUDDY_OFFICIAL_ART } from '@/lib/buddy-official-art'
import {
  buddyOnboardingDraftDirty,
  clearBuddyOnboardingDraft,
  patchBuddyOnboardingDraft,
  patchBuddyOnboardingInput,
  readBuddyOnboardingDraft,
  useBuddyOnboardingDraft,
  type BuddyOnboardingPicture
} from '@/lib/buddy-onboarding-store'
import { openBuddyPetCreator } from '@/lib/buddy-pet-creator-nav'
import { BUDDY_STILL_PACK_ID } from '@/lib/buddy-pet-view'
import {
  BUDDY_ONBOARDING_BUTTONS,
  BUDDY_ONBOARDING_STEP1,
  BUDDY_ONBOARDING_STEP2,
  BUDDY_ONBOARDING_STEP3,
  BUDDY_ONBOARDING_STEP4,
  BUDDY_ONBOARDING_STEP_COUNT,
  BUDDY_ONBOARDING_STEP_TITLES,
  BUDDY_LIBRARY_COPY,
  buddyLibraryDeleteTitle,
  buddyOnboardingCounter,
  buddyOnboardingProgress
} from '@/lib/buddy-onboarding-copy'
import { cn } from '@/lib/utils'
import { inlineUserError } from '@/lib/user-error'
import {
  BUDDY_LIBRARY_CONTEXT_MAX_CHARS,
  BUDDY_LIBRARY_DESCRIPTION_MAX_CHARS,
  BUDDY_LIBRARY_NAME_MAX_CHARS,
  BUDDY_LIBRARY_PERSONALITY_MAX_CHARS
} from '../../../shared/buddy-library'

/** The result's living preview, like the look panel's draft preview. */
const RESULT_PREVIEW_PX = 112

/** "Start a new one" (plan 174 G-13): leave the waiting Buddy and begin again. */
const START_NEW_LABEL = 'Start a new one'

export interface BuddyOnboardingProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Bumped by every open: the sheet reopens where the streamer left it (as far
   * as what they typed allows), at `initialStep` when nothing was typed, or at
   * step 4 while a Buddy is being made or waits as a draft. */
  openNonce: number
  initialStep?: BuddyOnboardingStep
  /** The library (My Buddies owns it): "Use this one" and the full gate. */
  library: BuddyLibraryState | null
  libraryController: BuddyLibraryController | null
  /** Tests inject the backend; the app shares the Buddy tab's client. */
  client?: BuddyLookClient | null
  /** Tests inject the picture prep; the app downscales and re-encodes. */
  preparePicture?: (file: File) => Promise<BuddyLookPicture>
}

/** Where a fresh open lands: step 4 for a Buddy in progress, else where the typing left off. */
function reopenStep(inProgress: boolean, initialStep: BuddyOnboardingStep): BuddyOnboardingStep {
  if (inProgress) return 4
  const stored = readBuddyOnboardingDraft()
  return buddyOnboardingDraftDirty(stored)
    ? buddyOnboardingReachable(stored.step, stored.input)
    : initialStep
}

/**
 * The four-step onboarding (plan 170 D14, D15), the same steps and words as
 * videorc.com/buddy/create: meet the sidekick (a live demo, the official
 * five, what it does), describe it (and an optional picture), give it a
 * personality, then create it. Step 4 is plan 169's look flow on the
 * account library: the four poses fill in (Cancel stops waiting), Redo
 * remakes talk, laugh or think for one image, and "Use as my Buddy" keeps
 * it; "Make it Alive" (plan 172 D12) keeps it too, then opens the Alive
 * creator with it. A full-height sheet over the Buddy tab.
 *
 * Plan 174 S3.15a: what was typed lives in `buddy-onboarding-store` (G-12),
 * so a tab switch, a stray click outside the sheet or closing it loses
 * nothing until a Buddy is used; why creating is off shows at step 1 with
 * its one action (G-5); a waiting draft can be left for a new one (G-13).
 */
export function BuddyOnboarding({
  open,
  onOpenChange,
  openNonce,
  initialStep = 1,
  library,
  libraryController,
  client: injectedClient,
  preparePicture = prepareBuddyLookPicture
}: BuddyOnboardingProps): ReactElement {
  const {
    account,
    aiCapabilities,
    aiConsent,
    cohostGate,
    cohostSettings,
    patchCohostSettings,
    runtimeInfo,
    setAiConsent
  } = useStudioCore()
  const connected = useBuddyLookClient()
  const client = injectedClient !== undefined ? injectedClient : connected
  const { state: look, controller: lookController } = useBuddyLook(client)
  const platform = runtimeInfo?.platform
  const sheetRef = useRef<HTMLDivElement>(null)
  const stored = useBuddyOnboardingDraft()
  const input = stored.input
  const picture = stored.picture

  const creating = look.pending === 'create' || look.running?.kind === 'create'
  // A draft the streamer left for a new one (G-13) is the look panel's, not this sheet's.
  const draft = look.draft && look.draft.requestId !== stored.leftBehindDraftId ? look.draft : null
  const lookBusy = look.pending !== null || look.running !== null
  const inProgress = creating || draft !== null

  const [step, setStepState] = useState<BuddyOnboardingStep>(() =>
    reopenStep(inProgress, initialStep)
  )
  const [appliedNonce, setAppliedNonce] = useState(openNonce)
  if (openNonce !== appliedNonce) {
    setAppliedNonce(openNonce)
    setStepState(reopenStep(inProgress, initialStep))
  }
  // A Buddy being made or waiting as a draft is step 4's: the sheet goes
  // there when one shows up (the backend's state arriving, a job picked up).
  const [wasInProgress, setWasInProgress] = useState(inProgress)
  if (inProgress !== wasInProgress) {
    setWasInProgress(inProgress)
    if (inProgress) setStepState(4)
  }
  const setStep = (next: BuddyOnboardingStep): void => {
    setStepState(next)
    patchBuddyOnboardingDraft({ step: next })
  }

  const [preparing, setPreparing] = useState(false)
  const [pictureError, setPictureError] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [consentOpen, setConsentOpen] = useState(false)
  // Plan 174 S0.3 (G-1): a draft is already saved to the library, so
  // throwing it away is a delete, and it asks.
  const [deleteOpen, setDeleteOpen] = useState(false)
  const draftName =
    buddyOnboardingName(input.name) ??
    library?.mine?.find((entry) => entry.id === draft?.libraryAvatarId)?.name ??
    null

  const patch = (next: Partial<BuddyOnboardingInput>): void => patchBuddyOnboardingInput(next)

  const capabilities = look.capabilities ?? aiCapabilities ?? null
  const gateInput = {
    signedIn: account?.status === 'signed-in',
    gate: cohostGate,
    consented: aiConsent,
    capabilities
  }
  const gate = buddyLookCreateGate({ ...gateInput, library })
  const redoGate = buddyLookRedoGate(gateInput)

  const goTo = (target: BuddyOnboardingStep): void => {
    setActionError(null)
    setStep(buddyOnboardingReachable(target, input))
  }
  const canAdvance = buddyOnboardingCanAdvance(step, input)
  const next = (): void => {
    if (step < BUDDY_ONBOARDING_STEP_COUNT && canAdvance) {
      if (step === 3) patch({ skipDetails: false })
      goTo((step + 1) as BuddyOnboardingStep)
    }
  }
  const skip = (): void => {
    if (!buddyOnboardingCanSkip(step, input)) return
    patch({ skipDetails: true })
    setStep(4)
  }

  const canCreate =
    Boolean(lookController) &&
    gate === null &&
    !lookBusy &&
    !preparing &&
    buddyOnboardingHasLook(input) &&
    buddyOnboardingName(input.name) !== null
  const create = (): void => {
    if (!canCreate || !lookController) return
    setActionError(null)
    void lookController.create(buddyOnboardingCreateParams(input, picture?.prepared.base64 ?? null))
  }
  /** Keep the draft as the Buddy; with `alive`, then open the Alive creator
   * with its idle as the reference and the description as notes. */
  const keepAsMyBuddy = async (alive = false): Promise<void> => {
    if (!lookController || !draft || lookBusy) return
    setActionError(null)
    const description = input.description.trim()
    const settings = await lookController.keep()
    if (!settings) return
    try {
      // The provider's copy of the persona follows the backend's.
      await patchCohostSettings({ persona: settings.persona })
    } catch (error) {
      setActionError(
        inlineUserError(error, { action: 'save', object: 'your Buddy' }, 'buddy-onboarding')
      )
      return
    }
    void libraryController?.refresh()
    if (picture) URL.revokeObjectURL(picture.url)
    clearBuddyOnboardingDraft()
    onOpenChange(false)
    if (alive) {
      openBuddyPetCreator({
        reference: 'persona-idle',
        ...(description ? { notes: description } : {})
      })
    }
  }
  /** Leave the waiting Buddy where it is (the look panel still offers it) and begin again. */
  const startNew = (): void => {
    if (!draft) return
    if (picture) URL.revokeObjectURL(picture.url)
    setActionError(null)
    patchBuddyOnboardingDraft({
      input: EMPTY_BUDDY_ONBOARDING_INPUT,
      picture: null,
      leftBehindDraftId: draft.requestId
    })
    setStep(2)
  }
  const pickOfficial = async (card: BuddyLibraryCard): Promise<void> => {
    if (!libraryController) return
    setActionError(null)
    const accepted = await libraryController.use(card.id)
    if (accepted) onOpenChange(false)
    else setActionError(libraryController.getState().problem?.message ?? null)
  }

  const choose = async (file: File): Promise<void> => {
    setPictureError(null)
    if (!(BUDDY_LOOK_PICTURE_TYPES as readonly string[]).includes(file.type)) {
      setPictureError(BUDDY_ONBOARDING_STEP2.pictureTypeError)
      return
    }
    setPreparing(true)
    try {
      const prepared = await preparePicture(file)
      const previous = readBuddyOnboardingDraft().picture
      if (previous) URL.revokeObjectURL(previous.url)
      patchBuddyOnboardingDraft({
        picture: { name: file.name, url: URL.createObjectURL(file), prepared },
        input: { ...readBuddyOnboardingDraft().input, hasPicture: true }
      })
    } catch {
      setPictureError(BUDDY_ONBOARDING_STEP2.pictureUnreadable)
    } finally {
      setPreparing(false)
    }
  }
  const clearPicture = (): void => {
    if (picture) URL.revokeObjectURL(picture.url)
    setPictureError(null)
    patchBuddyOnboardingDraft({ picture: null, input: { ...input, hasPicture: false } })
  }

  // ⌘↵ runs the step's primary action, as its key chip says. Only from the
  // sheet itself: a confirm or a menu over it keeps its own keys (G-19).
  const primary = (): void => {
    if (step === 1) next()
    else if (step < 4) next()
    else if (draft && !creating) void keepAsMyBuddy()
    else create()
  }
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key !== 'Enter' || !(event.metaKey || event.ctrlKey)) return
    if (!event.currentTarget.contains(event.target as Node)) return
    event.preventDefault()
    primary()
  }

  const dirty = buddyOnboardingDraftDirty(stored)
  const title = BUDDY_ONBOARDING_STEP_TITLES[step - 1]!

  // A step with no field of its own (1, 4) would leave the focus on a button
  // that just went away; the body takes it, so reading goes on from there
  // (plan 174 G-21). Steps 2 and 3 focus their first field themselves.
  const bodyRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const focused = document.activeElement
    if (focused && focused !== document.body && sheetRef.current?.contains(focused)) return
    bodyRef.current?.focus()
  }, [step])

  return (
    <Dialog
      // A stray click outside never closes a sheet with typing in it, or one
      // drawing a Buddy (G-12); Escape and the close button still do.
      disablePointerDismissal={dirty || creating}
      open={open}
      onOpenChange={onOpenChange}
    >
      <DialogContent
        ref={sheetRef}
        aria-describedby={undefined}
        className="h-[min(48rem,calc(100vh-2rem))] gap-0 overflow-hidden p-0"
        size="xl"
        data-step={step}
        data-testid="buddy-onboarding"
        // The sheet itself takes the focus (⌘↵ works at once), never the
        // first tile or card: a focused tile would show its R chip.
        initialFocus={sheetRef}
        onKeyDown={onKeyDown}
      >
        <DialogHeader className="shrink-0 gap-2 border-b border-border px-5 pt-4 pb-3.5">
          <div className="flex items-center gap-3 pr-8">
            <span
              className="text-xs text-muted-foreground tabular-nums"
              data-testid="buddy-onboarding-progress"
            >
              {buddyOnboardingProgress(step)}
            </span>
            <StepMeter step={step} />
          </div>
          <DialogTitle className="text-base font-semibold">{title}</DialogTitle>
          {/* A step change is announced (plan 174 G-21); the region stays put across steps. */}
          <span
            aria-atomic="true"
            aria-live="polite"
            className="sr-only"
            data-testid="buddy-onboarding-announce"
          >
            {`${buddyOnboardingProgress(step)}: ${title}`}
          </span>
        </DialogHeader>

        <div
          key={step}
          ref={bodyRef}
          className="@container/onboarding min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 py-4 outline-none"
          data-testid="buddy-onboarding-body"
          tabIndex={-1}
        >
          {step === 1 ? (
            <MeetStep
              busy={Boolean(library?.busy) || !libraryController}
              gate={gate}
              library={library}
              onAllowCloudAi={() => setConsentOpen(true)}
              onUse={(card) => void pickOfficial(card)}
            />
          ) : step === 2 ? (
            <DescribeStep
              disabled={creating}
              input={input}
              picture={picture}
              pictureError={pictureError}
              preparing={preparing}
              onChoose={(file) => void choose(file)}
              onClear={clearPicture}
              onPatch={patch}
            />
          ) : step === 3 ? (
            <PersonalityStep input={input} onEnter={next} onPatch={patch} />
          ) : (
            <CreateStep
              busy={lookBusy}
              capabilities={capabilities}
              creating={creating}
              draft={draft}
              gate={gate}
              input={input}
              limit={buddyLibraryLimit(capabilities, library)}
              look={look}
              lookController={lookController}
              persona={cohostSettings?.persona ?? null}
              picture={picture}
              redoGate={redoGate}
              onAllowCloudAi={() => setConsentOpen(true)}
            />
          )}
          {actionError ? (
            <Alert className="mt-3" data-testid="buddy-onboarding-error" variant="destructive">
              <AlertTitle>{actionError}</AlertTitle>
            </Alert>
          ) : null}
        </div>

        <DialogFooter className="shrink-0 items-center gap-2 border-t border-border px-5 py-3 sm:justify-between">
          <div className="flex min-w-0 items-center gap-3">
            {/* Back keeps its slot while a draft waits (G-13); only a
                creation in flight hides it. */}
            {step > 1 && !creating ? (
              <Button
                data-testid="buddy-onboarding-back"
                type="button"
                variant="ghost"
                onClick={() => goTo((step - 1) as BuddyOnboardingStep)}
              >
                <ArrowLeftIcon data-icon="inline-start" />
                {BUDDY_ONBOARDING_BUTTONS.back}
              </Button>
            ) : null}
            {step === 4 && draft && !creating ? (
              <>
                <Button
                  data-testid="buddy-onboarding-discard"
                  disabled={!lookController || lookBusy}
                  type="button"
                  variant="ghost"
                  onClick={() => setDeleteOpen(true)}
                >
                  <DeleteIcon data-icon="inline-start" />
                  Delete…
                </Button>
                <Button
                  data-testid="buddy-onboarding-start-new"
                  disabled={lookBusy}
                  type="button"
                  variant="ghost"
                  onClick={startNew}
                >
                  <ResetIcon data-icon="inline-start" />
                  {START_NEW_LABEL}
                </Button>
              </>
            ) : null}
            <ConfirmDialog
              cancelLabel="Keep it"
              confirmLabel={draftName ? `Delete ${draftName}` : 'Delete Buddy'}
              description={BUDDY_LIBRARY_COPY.deleteBody}
              open={deleteOpen}
              testId="buddy-onboarding-delete"
              title={buddyLibraryDeleteTitle(draftName ?? 'this Buddy')}
              onCancel={() => setDeleteOpen(false)}
              onConfirm={() => {
                setDeleteOpen(false)
                void lookController?.discard()
              }}
            />
            {step === 2 && !canAdvance ? (
              <span className="text-xs text-muted-foreground" data-testid="buddy-onboarding-hint">
                {BUDDY_ONBOARDING_STEP2.nextHint}
              </span>
            ) : null}
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {step === 1 ? (
              <Button data-testid="buddy-onboarding-create-own" type="button" onClick={next}>
                <SparkleIcon data-icon="inline-start" />
                {BUDDY_ONBOARDING_STEP1.primary}
                <ShortcutKeys
                  accelerator="CmdOrCtrl+Enter"
                  className="ml-0.5"
                  platform={platform}
                />
              </Button>
            ) : step < 4 ? (
              <>
                {buddyOnboardingCanSkip(step, input) ? (
                  <Button
                    data-testid="buddy-onboarding-skip"
                    type="button"
                    variant="ghost"
                    onClick={skip}
                  >
                    {BUDDY_ONBOARDING_BUTTONS.skip}
                  </Button>
                ) : null}
                <Button
                  data-testid="buddy-onboarding-next"
                  disabled={!canAdvance}
                  type="button"
                  onClick={next}
                >
                  {BUDDY_ONBOARDING_BUTTONS.next}
                  <ShortcutKeys
                    accelerator="CmdOrCtrl+Enter"
                    className="ml-0.5"
                    platform={platform}
                  />
                </Button>
              </>
            ) : draft && !creating ? (
              <>
                {/* The primary action sits rightmost (the G owner item). */}
                <Button
                  data-testid="buddy-onboarding-make-alive"
                  disabled={!lookController || lookBusy}
                  type="button"
                  variant="outline"
                  onClick={() => void keepAsMyBuddy(true)}
                >
                  <SparkleIcon data-icon="inline-start" />
                  {BUDDY_ONBOARDING_STEP4.makeAlive}
                </Button>
                <Button
                  data-testid="buddy-onboarding-use"
                  disabled={!lookController || lookBusy}
                  type="button"
                  onClick={() => void keepAsMyBuddy()}
                >
                  {BUDDY_ONBOARDING_STEP4.use}
                  <ShortcutKeys
                    accelerator="CmdOrCtrl+Enter"
                    className="ml-0.5"
                    platform={platform}
                  />
                </Button>
              </>
            ) : (
              <Button
                data-testid="buddy-onboarding-create"
                disabled={!canCreate}
                type="button"
                onClick={create}
              >
                {creating ? (
                  <Spinner data-icon="inline-start" />
                ) : (
                  <SparkleIcon data-icon="inline-start" />
                )}
                {BUDDY_ONBOARDING_STEP4.primary}
                <ShortcutKeys
                  accelerator="CmdOrCtrl+Enter"
                  className="ml-0.5"
                  platform={platform}
                />
              </Button>
            )}
          </div>
        </DialogFooter>
      </DialogContent>
      <CloudAiConsentDialog
        open={consentOpen}
        testId="buddy-onboarding-consent"
        onAnswer={(accepted) => {
          setConsentOpen(false)
          if (accepted) setAiConsent(true)
        }}
      />
    </Dialog>
  )
}

export default BuddyOnboarding

/** Four short bars: where the streamer is, monochrome. */
function StepMeter({ step }: { step: BuddyOnboardingStep }): ReactElement {
  return (
    <div aria-hidden className="flex w-28 items-center gap-1" data-testid="buddy-onboarding-meter">
      {BUDDY_ONBOARDING_STEP_TITLES.map((title, index) => (
        <span
          key={title}
          className={cn(
            'h-1 flex-1 rounded-full',
            index < step ? 'bg-foreground/70' : 'bg-foreground/12'
          )}
        />
      ))}
    </div>
  )
}

function SubHeading({ children, note }: { children: ReactNode; note?: ReactNode }): ReactElement {
  return (
    <div className="flex items-baseline gap-2">
      <h3 className="text-[13px] leading-5 font-semibold text-foreground">{children}</h3>
      {note ? <span className="text-xs text-muted-foreground">{note}</span> : null}
    </div>
  )
}

// --- Step 1: Meet your sidekick -----------------------------------------------

function MeetStep({
  library,
  busy,
  gate,
  onUse,
  onAllowCloudAi
}: {
  library: BuddyLibraryState | null
  busy: boolean
  /** Why creating your own is off now (G-5): said here, before any typing. */
  gate: BuddyCreateGate | null
  onUse: (card: BuddyLibraryCard) => void
  onAllowCloudAi: () => void
}): ReactElement {
  const official = buddyLibraryView({ library, persona: null }).official
  return (
    <div className="flex flex-col gap-5">
      <p className="text-sm text-muted-foreground">{BUDDY_ONBOARDING_STEP1.lead}</p>
      <div className="grid gap-5 @2xl/onboarding:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <section className="flex flex-col gap-2">
          <SubHeading>{BUDDY_ONBOARDING_STEP1.demoHeading}</SubHeading>
          <BuddyStreamDemo poses={BUDDY_OFFICIAL_ART.golem} />
        </section>
        <section className="flex flex-col gap-2">
          <SubHeading>{BUDDY_ONBOARDING_STEP1.whatItDoesHeading}</SubHeading>
          <ul className="flex flex-col gap-2" data-testid="buddy-onboarding-what">
            {BUDDY_ONBOARDING_STEP1.whatItDoes.map((line) => (
              <li key={line} className="flex items-start gap-2 text-sm text-foreground">
                <CheckIcon
                  aria-hidden
                  className="mt-0.5 size-4 shrink-0 text-muted-foreground"
                  weight="bold"
                />
                {line}
              </li>
            ))}
          </ul>
        </section>
      </div>
      <section className="flex flex-col gap-2">
        <SubHeading note={BUDDY_ONBOARDING_STEP1.galleryNote}>
          {BUDDY_ONBOARDING_STEP1.galleryHeading}
        </SubHeading>
        <Gallery dense data-testid="buddy-onboarding-gallery">
          {official.map((card) => (
            <BuddyPictureCard
              key={card.id}
              active={card.active}
              data-id={card.id}
              data-testid="buddy-onboarding-official"
              detail={card.hint}
              name={card.name}
              picture={card.slug ? BUDDY_OFFICIAL_ART[card.slug].idle : null}
              subtitle={card.subtitle}
            >
              {card.active ? null : (
                <Button
                  className="flex-1"
                  data-testid="buddy-onboarding-use-official"
                  disabled={busy}
                  size="xs"
                  type="button"
                  variant="outline"
                  onClick={() => onUse(card)}
                >
                  {BUDDY_ONBOARDING_STEP1.cardAction}
                </Button>
              )}
            </BuddyPictureCard>
          ))}
        </Gallery>
      </section>
      {gate ? (
        <BuddyCreateGateAlert
          data-testid="buddy-onboarding-gate"
          gate={gate}
          onAllowCloudAi={onAllowCloudAi}
        />
      ) : null}
    </div>
  )
}

// --- Step 2: Describe it ------------------------------------------------------

function Counter({ value, max }: { value: string; max: number }): ReactElement {
  const count = buddyTextLength(value)
  return (
    // Over the limit, the icon carries the tone (plan 174 S1.8).
    <span
      className={cn(
        'ml-auto flex shrink-0 items-center gap-1 text-xs tabular-nums',
        count > max ? 'font-medium text-foreground' : 'text-muted-foreground'
      )}
    >
      {count > max ? (
        <AlertIcon aria-hidden className="size-3 text-destructive" weight="fill" />
      ) : null}
      {buddyOnboardingCounter(count, max)}
    </span>
  )
}

function DescribeStep({
  input,
  picture,
  preparing,
  pictureError,
  disabled,
  onPatch,
  onChoose,
  onClear
}: {
  input: BuddyOnboardingInput
  picture: BuddyOnboardingPicture | null
  preparing: boolean
  pictureError: string | null
  disabled: boolean
  onPatch: (next: Partial<BuddyOnboardingInput>) => void
  onChoose: (file: File) => void
  onClear: () => void
}): ReactElement {
  const fileInput = useRef<HTMLInputElement>(null)
  const [dragging, setDragging] = useState(false)
  const onDrop = (event: DragEvent<HTMLElement>): void => {
    event.preventDefault()
    setDragging(false)
    if (disabled) return
    const file = event.dataTransfer.files?.[0]
    if (file) onChoose(file)
  }
  return (
    <FieldGroup className="gap-6">
      <Field>
        <FieldLabel htmlFor="buddy-onboarding-description">
          {BUDDY_ONBOARDING_STEP2.label}
        </FieldLabel>
        <Textarea
          autoFocus
          className="min-h-28"
          disabled={disabled}
          id="buddy-onboarding-description"
          placeholder={BUDDY_ONBOARDING_STEP2.placeholder}
          value={input.description}
          onChange={(event) => onPatch({ description: event.target.value })}
        />
        <div className="flex flex-wrap items-center gap-2">
          <BuddyExampleChips
            disabled={disabled}
            examples={BUDDY_ONBOARDING_STEP2.examples}
            value={input.description}
            what="description"
            onFill={(example) => onPatch({ description: example })}
          />
          <Counter max={BUDDY_LIBRARY_DESCRIPTION_MAX_CHARS} value={input.description.trim()} />
        </div>
      </Field>
      <Field>
        <FieldLabel>{BUDDY_ONBOARDING_STEP2.pictureLabel}</FieldLabel>
        <FieldDescription>{BUDDY_ONBOARDING_STEP2.pictureHelp}</FieldDescription>
        <div
          className={cn(
            'flex items-center gap-3 rounded-row border border-border bg-inset p-2',
            dragging && 'bg-accent'
          )}
          data-testid="buddy-onboarding-picture"
          onDragLeave={() => setDragging(false)}
          onDragOver={(event) => {
            event.preventDefault()
            if (!disabled) setDragging(true)
          }}
          onDrop={onDrop}
        >
          <div className="flex size-16 shrink-0 items-center justify-center overflow-hidden rounded-chip bg-foreground/[0.04]">
            {picture ? (
              <img
                alt=""
                className="size-full object-contain"
                draggable={false}
                src={picture.url}
              />
            ) : preparing ? (
              <Spinner aria-hidden className="size-4 text-muted-foreground" />
            ) : (
              <ImageIcon aria-hidden className="size-5 text-subtle" />
            )}
          </div>
          <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
            {picture ? (
              <>
                <span className="min-w-0 flex-1 truncate text-sm text-foreground">
                  {picture.name}
                </span>
                <Button
                  data-testid="buddy-onboarding-picture-remove"
                  disabled={disabled}
                  size="xs"
                  type="button"
                  variant="ghost"
                  onClick={onClear}
                >
                  <CloseIcon data-icon="inline-start" />
                  {BUDDY_ONBOARDING_STEP2.pictureRemove}
                </Button>
              </>
            ) : (
              <Button
                data-testid="buddy-onboarding-picture-choose"
                disabled={disabled || preparing}
                type="button"
                variant="outline"
                onClick={() => fileInput.current?.click()}
              >
                <ImageIcon data-icon="inline-start" />
                {BUDDY_ONBOARDING_STEP2.pictureChoose}
              </Button>
            )}
          </div>
          <input
            ref={fileInput}
            accept={BUDDY_LOOK_PICTURE_TYPES.join(',')}
            className="hidden"
            data-testid="buddy-onboarding-picture-input"
            type="file"
            onChange={(event) => {
              const file = event.currentTarget.files?.[0]
              event.currentTarget.value = ''
              if (file) onChoose(file)
            }}
          />
        </div>
        {pictureError ? (
          <FieldError data-testid="buddy-onboarding-picture-error">{pictureError}</FieldError>
        ) : null}
      </Field>
    </FieldGroup>
  )
}

// --- Step 3: Give it a personality ---------------------------------------------

function PersonalityStep({
  input,
  onPatch,
  onEnter
}: {
  input: BuddyOnboardingInput
  onPatch: (next: Partial<BuddyOnboardingInput>) => void
  onEnter: () => void
}): ReactElement {
  return (
    <FieldGroup className="gap-6">
      <Field>
        <FieldLabel htmlFor="buddy-onboarding-name">{BUDDY_ONBOARDING_STEP3.nameLabel}</FieldLabel>
        <Input
          autoFocus
          className="max-w-72"
          id="buddy-onboarding-name"
          maxLength={BUDDY_LIBRARY_NAME_MAX_CHARS}
          placeholder={BUDDY_ONBOARDING_STEP3.namePlaceholder}
          value={input.name}
          onChange={(event) => onPatch({ name: event.target.value })}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.metaKey && !event.ctrlKey) {
              event.preventDefault()
              onEnter()
            }
          }}
        />
        <FieldDescription>{BUDDY_ONBOARDING_STEP3.nameHelp}</FieldDescription>
      </Field>
      <Field>
        <FieldLabel htmlFor="buddy-onboarding-personality">
          {BUDDY_ONBOARDING_STEP3.personalityLabel}
        </FieldLabel>
        <Textarea
          className="min-h-20"
          id="buddy-onboarding-personality"
          placeholder={BUDDY_ONBOARDING_STEP3.personalityPlaceholder}
          value={input.personality}
          onChange={(event) => onPatch({ personality: event.target.value })}
        />
        <div className="flex flex-wrap items-center gap-2">
          <BuddyExampleChips
            examples={BUDDY_ONBOARDING_STEP3.personalityExamples}
            value={input.personality}
            what="personality"
            onFill={(example) => onPatch({ personality: example })}
          />
          <Counter max={BUDDY_LIBRARY_PERSONALITY_MAX_CHARS} value={input.personality} />
        </div>
      </Field>
      <Field>
        <FieldLabel htmlFor="buddy-onboarding-about">
          {BUDDY_ONBOARDING_STEP3.aboutLabel}
        </FieldLabel>
        <Textarea
          className="min-h-24"
          id="buddy-onboarding-about"
          placeholder={BUDDY_ONBOARDING_STEP3.aboutPlaceholder}
          value={input.about}
          onChange={(event) => onPatch({ about: event.target.value })}
        />
        <div className="flex items-center gap-2">
          <FieldDescription>{BUDDY_ONBOARDING_STEP3.aboutHelp}</FieldDescription>
          <Counter max={BUDDY_LIBRARY_CONTEXT_MAX_CHARS} value={input.about} />
        </div>
      </Field>
    </FieldGroup>
  )
}

// --- Step 4: Create your Buddy -------------------------------------------------

function SummaryRow({
  label,
  value,
  testId,
  children
}: {
  label: string
  value: string
  testId: string
  children?: ReactNode
}): ReactElement {
  const empty = value.trim().length === 0 && !children
  return (
    <div className="flex items-start gap-3 px-3 py-2" data-testid={testId}>
      <span className="w-24 shrink-0 text-xs leading-5 text-muted-foreground">{label}</span>
      <div className="flex min-w-0 flex-1 items-start gap-2">
        {children}
        <span
          className={cn(
            'line-clamp-3 min-w-0 flex-1 text-sm whitespace-pre-line',
            empty ? 'text-subtle' : 'text-foreground'
          )}
        >
          {empty ? BUDDY_ONBOARDING_STEP4.notSet : value.trim()}
        </span>
      </div>
    </div>
  )
}

function CreateStep({
  input,
  persona,
  picture,
  look,
  lookController,
  draft,
  creating,
  busy,
  redoGate,
  gate,
  capabilities,
  limit,
  onAllowCloudAi
}: {
  input: BuddyOnboardingInput
  persona: CohostPersona | null
  picture: BuddyOnboardingPicture | null
  look: ReturnType<typeof useBuddyLook>['state']
  lookController: ReturnType<typeof useBuddyLook>['controller']
  /** The draft this sheet offers (not one the streamer left for a new one). */
  draft: ReturnType<typeof useBuddyLook>['state']['draft']
  creating: boolean
  busy: boolean
  redoGate: BuddyCreateGate | null
  gate: BuddyCreateGate | null
  capabilities: Parameters<typeof buddyOnboardingAllowanceLine>[0]
  limit: number
  onAllowCloudAi: () => void
}): ReactElement {
  const view = creating ? 'working' : draft ? 'draft' : 'empty'
  const failure = view === 'empty' ? buddyCreateFailureLine(look.problem, limit) : null
  const allowance = buddyOnboardingAllowanceLine(capabilities)
  const skipped = input.skipDetails
  // The living preview is a bonus: a draft it cannot draw keeps the tiles
  // and the line, without an empty box.
  const previewKey = draft ? `${draft.requestId}:${look.revision}` : null
  const [previewFailed, setPreviewFailed] = useState<string | null>(null)
  const showPreview = Boolean(persona) && previewKey !== null && previewFailed !== previewKey
  // A job picked up after the sheet was closed (or the app restarted) has no
  // inputs here: its summary would only say "Not set".
  const summary =
    view === 'empty' ||
    (view === 'working' && (buddyOnboardingHasLook(input) || input.name.trim().length > 0))
  return (
    <div className="flex flex-col gap-4" data-view={view}>
      {summary ? (
        <GroupedList data-testid="buddy-onboarding-summary">
          <SummaryRow
            label={BUDDY_ONBOARDING_STEP4.summaryLook}
            testId="buddy-onboarding-summary-look"
            value={input.description}
          >
            {picture ? (
              <img
                alt=""
                className="size-10 shrink-0 rounded-chip border border-border object-contain"
                draggable={false}
                src={picture.url}
              />
            ) : null}
          </SummaryRow>
          <SummaryRow
            label={BUDDY_ONBOARDING_STEP4.summaryName}
            testId="buddy-onboarding-summary-name"
            value={input.name}
          />
          <SummaryRow
            label={BUDDY_ONBOARDING_STEP4.summaryPersonality}
            testId="buddy-onboarding-summary-personality"
            value={skipped ? '' : input.personality}
          />
          <SummaryRow
            label={BUDDY_ONBOARDING_STEP4.summaryAbout}
            testId="buddy-onboarding-summary-about"
            value={skipped ? '' : input.about}
          />
        </GroupedList>
      ) : null}

      <BuddyPoseTiles
        busy={busy}
        controller={lookController}
        copy={BUDDY_LOOK_TILES_COPY}
        imagesLeft={buddyImagesLeftLine(capabilities)}
        redoAllowed={redoGate === null}
        redoReason={redoGate?.reason ?? null}
        state={look}
        view={view}
      />

      {view === 'working' ? (
        <BuddyLookWorkingLine
          cancelling={look.pending === 'cancel'}
          line={BUDDY_ONBOARDING_STEP4.working}
          startedAt={look.startedAt}
          testId="buddy-onboarding-working"
          onCancel={lookController ? () => void lookController.cancel() : undefined}
        />
      ) : view === 'draft' && draft ? (
        <div className="flex items-center gap-4" data-testid="buddy-onboarding-result">
          {persona && showPreview ? (
            <LazyBuddyPetPreview
              className="rounded-row border border-border bg-inset"
              label={`${persona.name}, new look`}
              onError={() => setPreviewFailed(previewKey)}
              motion={persona.motion}
              packId={BUDDY_STILL_PACK_ID}
              personaId={persona.id}
              placeholder={<Skeleton className="size-full rounded-row" />}
              size={RESULT_PREVIEW_PX}
              stillImages={buddyLookDraftImages(draft, look.revision)}
            />
          ) : null}
          <div className="flex min-w-0 flex-col gap-1">
            {draft.libraryAvatarId ? (
              <p
                className="flex items-center gap-2 text-sm text-foreground"
                data-testid="buddy-onboarding-saved"
              >
                <CheckIcon aria-hidden className="size-4 text-success" weight="bold" />
                {BUDDY_ONBOARDING_STEP4.done}
              </p>
            ) : null}
            {showPreview ? (
              <p className="text-xs text-muted-foreground">
                The new look, alive. Click it to react.
              </p>
            ) : null}
          </div>
        </div>
      ) : gate ? (
        // The gate is now; a failure was the last attempt.
        <BuddyCreateGateAlert
          data-testid="buddy-onboarding-gate"
          gate={gate}
          onAllowCloudAi={onAllowCloudAi}
        />
      ) : failure ? (
        <Alert data-testid="buddy-onboarding-failed" variant="destructive">
          <AlertTitle>{failure}</AlertTitle>
        </Alert>
      ) : allowance ? (
        <p
          className="text-xs text-muted-foreground tabular-nums"
          data-testid="buddy-onboarding-allowance"
        >
          {allowance}
        </p>
      ) : null}
    </div>
  )
}
