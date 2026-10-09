import {
  AlertIcon,
  ArrowLeftIcon,
  CheckIcon,
  CloseIcon,
  ImageIcon,
  InfoIcon,
  LockIcon,
  SparkleIcon,
  SpinnerIcon
} from '@/components/icons'
import {
  useRef,
  useState,
  type DragEvent,
  type KeyboardEvent,
  type ReactElement,
  type ReactNode
} from 'react'

import { GolemPoseTiles, type GolemPoseTilesCopy } from '@/components/golem-look-tiles'
import { LazyGolemPetPreview } from '@/components/golem-pet-preview-lazy'
import { GolemStreamDemo } from '@/components/golem-stream-demo'
import { Alert, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
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
import { Skeleton } from '@/components/ui/skeleton'
import { Textarea } from '@/components/ui/textarea'
import { useVideorcAccount } from '@/hooks/use-account'
import type { GolemLibraryController } from '@/hooks/use-golem-library'
import { useGolemLook, useGolemLookClient, type GolemLookClient } from '@/hooks/use-golem-look'
import { useStudioCore } from '@/hooks/use-studio'
import type { CohostPersona, GolemLibraryState } from '@/lib/backend'
import {
  EMPTY_GOLEM_ONBOARDING_INPUT,
  golemCreateFailureLine,
  golemCreateGate,
  golemLibraryLimit,
  golemLibraryView,
  golemOnboardingAllowanceLine,
  golemOnboardingCanAdvance,
  golemOnboardingCanSkip,
  golemOnboardingCreateParams,
  golemOnboardingHasLook,
  golemOnboardingName,
  golemOnboardingReachable,
  golemTextLength,
  type GolemCreateGate,
  type GolemLibraryCard,
  type GolemOnboardingInput,
  type GolemOnboardingStep
} from '@/lib/golem-library-view'
import {
  GOLEM_LOOK_PICTURE_TYPES,
  golemLookAvailability,
  golemLookDraftImages,
  prepareGolemLookPicture,
  type GolemLookPicture
} from '@/lib/golem-look-view'
import { GOLEM_OFFICIAL_ART } from '@/lib/golem-official-art'
import { GOLEM_STILL_PACK_ID } from '@/lib/golem-pet-view'
import {
  GOLEM_ONBOARDING_BUTTONS,
  GOLEM_ONBOARDING_GATES,
  GOLEM_ONBOARDING_STEP1,
  GOLEM_ONBOARDING_STEP2,
  GOLEM_ONBOARDING_STEP3,
  GOLEM_ONBOARDING_STEP4,
  GOLEM_ONBOARDING_STEP_COUNT,
  GOLEM_ONBOARDING_STEP_TITLES,
  GOLEM_LIBRARY_COPY,
  golemOnboardingCounter,
  golemOnboardingProgress
} from '@/lib/golem-onboarding-copy'
import { CLOUD_AI_KEEPS, CLOUD_AI_USES } from '@/lib/golem-tab-view'
import { displayKeyGlyph } from '@/lib/platform'
import { VIDEORC_PREMIUM_URL } from '@/lib/premium-upgrade'
import { cn } from '@/lib/utils'
import { openVideorcWebLink } from '@/lib/videorc-web-links'
import {
  GOLEM_LIBRARY_CONTEXT_MAX_CHARS,
  GOLEM_LIBRARY_DESCRIPTION_MAX_CHARS,
  GOLEM_LIBRARY_NAME_MAX_CHARS,
  GOLEM_LIBRARY_PERSONALITY_MAX_CHARS
} from '../../../shared/golem-library'

/** The result's living preview, like the look panel's draft preview. */
const RESULT_PREVIEW_PX = 112

/** Step 4's tiles in the shared copy: the pose names, Redo, and one line for a pose that failed. */
const ONBOARDING_TILES_COPY: GolemPoseTilesCopy = {
  labels: GOLEM_ONBOARDING_STEP4.poseLabels,
  redo: GOLEM_ONBOARDING_STEP4.redo,
  working: null,
  redrawing: null,
  failed: () => GOLEM_ONBOARDING_STEP4.poseFailed
}

interface ChosenPicture {
  name: string
  /** An object URL of the original file, for the thumbnail. */
  url: string
  prepared: GolemLookPicture
}

export interface GolemOnboardingProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Bumped by every open: the sheet starts again at `initialStep`, or at
   * step 4 while a Golem is being made or waits as a draft. */
  openNonce: number
  initialStep?: GolemOnboardingStep
  /** The library (My Golems owns it): "Use this one" and the full gate. */
  library: GolemLibraryState | null
  libraryController: GolemLibraryController | null
  /** Tests inject the backend; the app shares the Golem tab's client. */
  client?: GolemLookClient | null
  /** Tests inject the picture prep; the app downscales and re-encodes. */
  preparePicture?: (file: File) => Promise<GolemLookPicture>
}

/**
 * The four-step onboarding (plan 170 D14, D15), the same steps and words as
 * videorc.com/golem/create: meet the sidekick (a live demo, the official
 * five, what it does), describe it (and an optional picture), give it a
 * personality, then create it. Step 4 is plan 169's look flow on the
 * account library: the four poses fill in, Redo remakes talk, laugh or
 * think, and "Use as my Golem" keeps it. A full-height sheet over the Golem
 * tab; what was typed survives closing it until a Golem is used.
 */
export function GolemOnboarding({
  open,
  onOpenChange,
  openNonce,
  initialStep = 1,
  library,
  libraryController,
  client: injectedClient,
  preparePicture = prepareGolemLookPicture
}: GolemOnboardingProps): ReactElement {
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
  const { signIn } = useVideorcAccount()
  const connected = useGolemLookClient()
  const client = injectedClient !== undefined ? injectedClient : connected
  const { state: look, controller: lookController } = useGolemLook(client)
  const modKey = displayKeyGlyph('⌘', runtimeInfo?.platform)
  const sheetRef = useRef<HTMLDivElement>(null)

  const creating = look.pending === 'create' || look.running?.kind === 'create'
  const lookBusy = look.pending !== null || look.running !== null
  const inProgress = creating || look.draft !== null

  const [step, setStep] = useState<GolemOnboardingStep>(() => (inProgress ? 4 : initialStep))
  const [appliedNonce, setAppliedNonce] = useState(openNonce)
  if (openNonce !== appliedNonce) {
    setAppliedNonce(openNonce)
    setStep(inProgress ? 4 : initialStep)
  }
  // A Golem being made or waiting as a draft is step 4's: the sheet goes
  // there when one shows up (the backend's state arriving, a job picked up).
  const [wasInProgress, setWasInProgress] = useState(inProgress)
  if (inProgress !== wasInProgress) {
    setWasInProgress(inProgress)
    if (inProgress) setStep(4)
  }
  const [input, setInput] = useState<GolemOnboardingInput>(EMPTY_GOLEM_ONBOARDING_INPUT)
  const [picture, setPicture] = useState<ChosenPicture | null>(null)
  const [preparing, setPreparing] = useState(false)
  const [pictureError, setPictureError] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [consentOpen, setConsentOpen] = useState(false)

  const patch = (next: Partial<GolemOnboardingInput>): void =>
    setInput((current) => ({ ...current, ...next }))

  const capabilities = look.capabilities ?? aiCapabilities ?? null
  const gate = golemCreateGate({
    signedIn: account?.status === 'signed-in',
    gate: cohostGate,
    consented: aiConsent,
    capabilities,
    library
  })
  const redoAllowed = golemLookAvailability({
    signedIn: account?.status === 'signed-in',
    gate: cohostGate,
    consented: aiConsent,
    capabilities
  }).redoAllowed

  const goTo = (target: GolemOnboardingStep): void => {
    setActionError(null)
    setStep(golemOnboardingReachable(target, input))
  }
  const canAdvance = golemOnboardingCanAdvance(step, input)
  const next = (): void => {
    if (step < GOLEM_ONBOARDING_STEP_COUNT && canAdvance) {
      if (step === 3) patch({ skipDetails: false })
      goTo((step + 1) as GolemOnboardingStep)
    }
  }
  const skip = (): void => {
    if (!golemOnboardingCanSkip(step, input)) return
    patch({ skipDetails: true })
    setStep(4)
  }

  const canCreate =
    Boolean(lookController) &&
    gate === null &&
    !lookBusy &&
    !preparing &&
    golemOnboardingHasLook(input) &&
    golemOnboardingName(input.name) !== null
  const create = (): void => {
    if (!canCreate || !lookController) return
    setActionError(null)
    void lookController.create(golemOnboardingCreateParams(input, picture?.prepared.base64 ?? null))
  }
  const keepAsMyGolem = async (): Promise<void> => {
    if (!lookController || !look.draft || lookBusy) return
    setActionError(null)
    const settings = await lookController.keep()
    if (!settings) return
    try {
      // The provider's copy of the persona follows the backend's.
      await patchCohostSettings({ persona: settings.persona })
    } catch (error) {
      setActionError(error instanceof Error ? error.message : GOLEM_ONBOARDING_GATES.failed)
      return
    }
    void libraryController?.refresh()
    if (picture) URL.revokeObjectURL(picture.url)
    setPicture(null)
    setInput(EMPTY_GOLEM_ONBOARDING_INPUT)
    onOpenChange(false)
  }
  const pickOfficial = async (card: GolemLibraryCard): Promise<void> => {
    if (!libraryController) return
    setActionError(null)
    const accepted = await libraryController.use(card.id)
    if (accepted) onOpenChange(false)
    else setActionError(libraryController.getState().problem?.message ?? null)
  }

  const choose = async (file: File): Promise<void> => {
    setPictureError(null)
    if (!(GOLEM_LOOK_PICTURE_TYPES as readonly string[]).includes(file.type)) {
      setPictureError(GOLEM_ONBOARDING_STEP2.pictureTypeError)
      return
    }
    setPreparing(true)
    try {
      const prepared = await preparePicture(file)
      if (picture) URL.revokeObjectURL(picture.url)
      setPicture({ name: file.name, url: URL.createObjectURL(file), prepared })
      patch({ hasPicture: true })
    } catch {
      setPictureError(GOLEM_ONBOARDING_STEP2.pictureUnreadable)
    } finally {
      setPreparing(false)
    }
  }
  const clearPicture = (): void => {
    if (picture) URL.revokeObjectURL(picture.url)
    setPicture(null)
    setPictureError(null)
    patch({ hasPicture: false })
  }

  // ⌘↵ runs the step's primary action, as its key chip says.
  const primary = (): void => {
    if (step === 1) goTo(2)
    else if (step < 4) next()
    else if (look.draft && !creating) void keepAsMyGolem()
    else create()
  }
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key !== 'Enter' || !(event.metaKey || event.ctrlKey)) return
    event.preventDefault()
    primary()
  }

  const title = GOLEM_ONBOARDING_STEP_TITLES[step - 1]!

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        ref={sheetRef}
        aria-describedby={undefined}
        className="flex h-[min(48rem,calc(100vh-3rem))] flex-col gap-0 overflow-hidden p-0 sm:max-w-3xl"
        data-step={step}
        data-testid="golem-onboarding"
        onKeyDown={onKeyDown}
        onOpenAutoFocus={(event) => {
          // The sheet itself takes the focus (⌘↵ works at once), never the
          // first tile or card: a focused tile would show its R chip.
          event.preventDefault()
          sheetRef.current?.focus()
        }}
      >
        <DialogHeader className="shrink-0 gap-2 border-b border-border px-5 pt-4 pb-3.5">
          <div className="flex items-center gap-3 pr-8">
            <span
              className="text-xs text-muted-foreground tabular-nums"
              data-testid="golem-onboarding-progress"
            >
              {golemOnboardingProgress(step)}
            </span>
            <StepMeter step={step} />
          </div>
          <DialogTitle className="text-base font-semibold">{title}</DialogTitle>
        </DialogHeader>

        <div
          key={step}
          className="@container/onboarding min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 py-4"
          data-testid="golem-onboarding-body"
        >
          {step === 1 ? (
            <MeetStep
              busy={Boolean(library?.busy) || !libraryController}
              library={library}
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
              gate={gate}
              input={input}
              limit={golemLibraryLimit(capabilities, library)}
              persona={cohostSettings?.persona ?? null}
              look={look}
              lookController={lookController}
              picture={picture}
              redoAllowed={redoAllowed}
              onAllowCloudAi={() => setConsentOpen(true)}
              onSeePremium={() =>
                openVideorcWebLink(
                  !cohostGate.allowed && cohostGate.upgradeUrl
                    ? cohostGate.upgradeUrl
                    : VIDEORC_PREMIUM_URL
                )
              }
              onSignIn={signIn}
              onStartFromOurs={() => goTo(1)}
            />
          )}
          {actionError ? (
            <p className="mt-3 text-xs text-destructive" data-testid="golem-onboarding-error">
              {actionError}
            </p>
          ) : null}
        </div>

        <DialogFooter className="shrink-0 items-center gap-2 border-t border-border px-5 py-3 sm:justify-between">
          <div className="flex min-w-0 items-center gap-3">
            {step > 1 && !inProgress ? (
              <Button
                data-testid="golem-onboarding-back"
                type="button"
                variant="ghost"
                onClick={() => goTo((step - 1) as GolemOnboardingStep)}
              >
                <ArrowLeftIcon data-icon="inline-start" />
                {GOLEM_ONBOARDING_BUTTONS.back}
              </Button>
            ) : null}
            {step === 4 && look.draft && !creating ? (
              <Button
                data-testid="golem-onboarding-discard"
                disabled={!lookController || lookBusy}
                type="button"
                variant="ghost"
                onClick={() => void lookController?.discard()}
              >
                Discard
              </Button>
            ) : null}
            {step === 1 ? (
              <span className="text-xs text-subtle">{GOLEM_ONBOARDING_STEP1.premiumNote}</span>
            ) : null}
            {step === 2 && !canAdvance ? (
              <span className="text-xs text-subtle" data-testid="golem-onboarding-hint">
                {GOLEM_ONBOARDING_STEP2.nextHint}
              </span>
            ) : null}
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {step === 1 ? (
              <Button data-testid="golem-onboarding-create-own" type="button" onClick={primary}>
                <SparkleIcon data-icon="inline-start" />
                {GOLEM_ONBOARDING_STEP1.primary}
                <Kbd className="ml-0.5">{modKey}↵</Kbd>
              </Button>
            ) : step < 4 ? (
              <>
                {golemOnboardingCanSkip(step, input) ? (
                  <Button
                    data-testid="golem-onboarding-skip"
                    type="button"
                    variant="ghost"
                    onClick={skip}
                  >
                    {GOLEM_ONBOARDING_BUTTONS.skip}
                  </Button>
                ) : null}
                <Button
                  data-testid="golem-onboarding-next"
                  disabled={!canAdvance}
                  type="button"
                  onClick={next}
                >
                  {GOLEM_ONBOARDING_BUTTONS.next}
                  <Kbd className="ml-0.5">{modKey}↵</Kbd>
                </Button>
              </>
            ) : look.draft && !creating ? (
              <Button
                data-testid="golem-onboarding-use"
                disabled={!lookController || lookBusy}
                type="button"
                onClick={() => void keepAsMyGolem()}
              >
                {GOLEM_ONBOARDING_STEP4.use}
                <Kbd className="ml-0.5">{modKey}↵</Kbd>
              </Button>
            ) : (
              <Button
                data-testid="golem-onboarding-create"
                disabled={!canCreate}
                type="button"
                onClick={create}
              >
                {creating ? (
                  <SpinnerIcon className="animate-spin" data-icon="inline-start" />
                ) : (
                  <SparkleIcon data-icon="inline-start" />
                )}
                {GOLEM_ONBOARDING_STEP4.primary}
                <Kbd className="ml-0.5">{modKey}↵</Kbd>
              </Button>
            )}
          </div>
        </DialogFooter>
      </DialogContent>
      <CloudAiConsentDialog
        open={consentOpen}
        onAnswer={(accepted) => {
          setConsentOpen(false)
          if (accepted) setAiConsent(true)
        }}
      />
    </Dialog>
  )
}

export default GolemOnboarding

/** Four short bars: where the streamer is, monochrome. */
function StepMeter({ step }: { step: GolemOnboardingStep }): ReactElement {
  return (
    <div aria-hidden className="flex w-28 items-center gap-1" data-testid="golem-onboarding-meter">
      {GOLEM_ONBOARDING_STEP_TITLES.map((title, index) => (
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
  onUse
}: {
  library: GolemLibraryState | null
  busy: boolean
  onUse: (card: GolemLibraryCard) => void
}): ReactElement {
  const official = golemLibraryView({ library, persona: null }).official
  return (
    <div className="flex flex-col gap-5">
      <p className="text-sm text-muted-foreground">{GOLEM_ONBOARDING_STEP1.lead}</p>
      <div className="grid gap-5 @2xl/onboarding:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <section className="flex flex-col gap-2">
          <SubHeading>{GOLEM_ONBOARDING_STEP1.demoHeading}</SubHeading>
          <GolemStreamDemo poses={GOLEM_OFFICIAL_ART.golem} />
        </section>
        <section className="flex flex-col gap-2">
          <SubHeading>{GOLEM_ONBOARDING_STEP1.whatItDoesHeading}</SubHeading>
          <ul className="flex flex-col gap-2" data-testid="golem-onboarding-what">
            {GOLEM_ONBOARDING_STEP1.whatItDoes.map((line) => (
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
        <SubHeading note={GOLEM_ONBOARDING_STEP1.galleryNote}>
          {GOLEM_ONBOARDING_STEP1.galleryHeading}
        </SubHeading>
        <div
          className="grid grid-cols-2 gap-2 @lg/onboarding:grid-cols-3 @2xl/onboarding:grid-cols-5"
          data-testid="golem-onboarding-gallery"
        >
          {official.map((card) => (
            <div
              key={card.id}
              className={cn(
                'flex flex-col gap-1.5 rounded-row border border-border bg-foreground/[0.04] p-1.5',
                card.active && 'border-foreground/25 bg-accent'
              )}
              data-active={card.active || undefined}
              data-id={card.id}
              data-testid="golem-onboarding-official"
              title={card.hint}
            >
              <div className="aspect-square overflow-hidden rounded-chip bg-foreground/[0.04]">
                <img
                  alt={card.name}
                  className="size-full object-contain p-1.5"
                  decoding="async"
                  draggable={false}
                  src={card.slug ? GOLEM_OFFICIAL_ART[card.slug].idle : undefined}
                />
              </div>
              <div className="flex min-w-0 flex-col gap-0.5 px-0.5">
                <span className="truncate text-sm font-medium text-foreground">{card.name}</span>
                <span className="line-clamp-2 min-h-8 text-xs text-muted-foreground">
                  {card.subtitle}
                </span>
              </div>
              {card.active ? (
                <div className="flex h-6 items-center px-0.5">
                  <Badge variant="success">{GOLEM_LIBRARY_COPY.active}</Badge>
                </div>
              ) : (
                <Button
                  className="w-full"
                  data-testid="golem-onboarding-use-official"
                  disabled={busy}
                  size="xs"
                  type="button"
                  variant="outline"
                  onClick={() => onUse(card)}
                >
                  {GOLEM_ONBOARDING_STEP1.cardAction}
                </Button>
              )}
            </div>
          ))}
        </div>
      </section>
    </div>
  )
}

// --- Step 2: Describe it ------------------------------------------------------

function Counter({ value, max }: { value: string; max: number }): ReactElement {
  const count = golemTextLength(value)
  return (
    <span
      className={cn(
        'ml-auto shrink-0 text-xs tabular-nums',
        count > max ? 'text-destructive' : 'text-subtle'
      )}
    >
      {golemOnboardingCounter(count, max)}
    </span>
  )
}

function Chips({
  examples,
  onPick,
  disabled = false
}: {
  examples: readonly string[]
  onPick: (example: string) => void
  disabled?: boolean
}): ReactElement {
  return (
    <>
      {examples.map((example) => (
        <Button
          key={example}
          disabled={disabled}
          size="xs"
          type="button"
          variant="outline"
          onClick={() => onPick(example)}
        >
          {example}
        </Button>
      ))}
    </>
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
  input: GolemOnboardingInput
  picture: ChosenPicture | null
  preparing: boolean
  pictureError: string | null
  disabled: boolean
  onPatch: (next: Partial<GolemOnboardingInput>) => void
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
        <FieldLabel htmlFor="golem-onboarding-description">
          {GOLEM_ONBOARDING_STEP2.label}
        </FieldLabel>
        <Textarea
          autoFocus
          className="min-h-28"
          disabled={disabled}
          id="golem-onboarding-description"
          placeholder={GOLEM_ONBOARDING_STEP2.placeholder}
          value={input.description}
          onChange={(event) => onPatch({ description: event.target.value })}
        />
        <div className="flex flex-wrap items-center gap-2">
          <Chips
            disabled={disabled}
            examples={GOLEM_ONBOARDING_STEP2.examples}
            onPick={(example) => onPatch({ description: example })}
          />
          <Counter max={GOLEM_LIBRARY_DESCRIPTION_MAX_CHARS} value={input.description.trim()} />
        </div>
      </Field>
      <Field>
        <FieldLabel>{GOLEM_ONBOARDING_STEP2.pictureLabel}</FieldLabel>
        <FieldDescription className="text-xs">
          {GOLEM_ONBOARDING_STEP2.pictureHelp}
        </FieldDescription>
        <div
          className={cn(
            'flex items-center gap-3 rounded-row border border-border bg-foreground/[0.03] p-2',
            dragging && 'bg-accent'
          )}
          data-testid="golem-onboarding-picture"
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
              <SpinnerIcon aria-hidden className="size-4 animate-spin text-muted-foreground" />
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
                  data-testid="golem-onboarding-picture-remove"
                  disabled={disabled}
                  size="xs"
                  type="button"
                  variant="ghost"
                  onClick={onClear}
                >
                  <CloseIcon data-icon="inline-start" />
                  {GOLEM_ONBOARDING_STEP2.pictureRemove}
                </Button>
              </>
            ) : (
              <Button
                data-testid="golem-onboarding-picture-choose"
                disabled={disabled || preparing}
                size="sm"
                type="button"
                variant="outline"
                onClick={() => fileInput.current?.click()}
              >
                <ImageIcon data-icon="inline-start" />
                {GOLEM_ONBOARDING_STEP2.pictureChoose}
              </Button>
            )}
          </div>
          <input
            ref={fileInput}
            accept={GOLEM_LOOK_PICTURE_TYPES.join(',')}
            className="hidden"
            data-testid="golem-onboarding-picture-input"
            type="file"
            onChange={(event) => {
              const file = event.currentTarget.files?.[0]
              event.currentTarget.value = ''
              if (file) onChoose(file)
            }}
          />
        </div>
        {pictureError ? (
          <p className="text-xs text-destructive" data-testid="golem-onboarding-picture-error">
            {pictureError}
          </p>
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
  input: GolemOnboardingInput
  onPatch: (next: Partial<GolemOnboardingInput>) => void
  onEnter: () => void
}): ReactElement {
  return (
    <FieldGroup className="gap-6">
      <Field>
        <FieldLabel htmlFor="golem-onboarding-name">{GOLEM_ONBOARDING_STEP3.nameLabel}</FieldLabel>
        <Input
          autoFocus
          className="max-w-72"
          id="golem-onboarding-name"
          maxLength={GOLEM_LIBRARY_NAME_MAX_CHARS}
          placeholder={GOLEM_ONBOARDING_STEP3.namePlaceholder}
          value={input.name}
          onChange={(event) => onPatch({ name: event.target.value })}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.metaKey && !event.ctrlKey) {
              event.preventDefault()
              onEnter()
            }
          }}
        />
        <FieldDescription className="text-xs">{GOLEM_ONBOARDING_STEP3.nameHelp}</FieldDescription>
      </Field>
      <Field>
        <FieldLabel htmlFor="golem-onboarding-personality">
          {GOLEM_ONBOARDING_STEP3.personalityLabel}
        </FieldLabel>
        <Textarea
          className="min-h-20"
          id="golem-onboarding-personality"
          placeholder={GOLEM_ONBOARDING_STEP3.personalityPlaceholder}
          value={input.personality}
          onChange={(event) => onPatch({ personality: event.target.value })}
        />
        <div className="flex flex-wrap items-center gap-2">
          <Chips
            examples={GOLEM_ONBOARDING_STEP3.personalityExamples}
            onPick={(example) => onPatch({ personality: example })}
          />
          <Counter max={GOLEM_LIBRARY_PERSONALITY_MAX_CHARS} value={input.personality} />
        </div>
      </Field>
      <Field>
        <FieldLabel htmlFor="golem-onboarding-about">
          {GOLEM_ONBOARDING_STEP3.aboutLabel}
        </FieldLabel>
        <Textarea
          className="min-h-24"
          id="golem-onboarding-about"
          placeholder={GOLEM_ONBOARDING_STEP3.aboutPlaceholder}
          value={input.about}
          onChange={(event) => onPatch({ about: event.target.value })}
        />
        <div className="flex items-center gap-2">
          <FieldDescription className="text-xs">
            {GOLEM_ONBOARDING_STEP3.aboutHelp}
          </FieldDescription>
          <Counter max={GOLEM_LIBRARY_CONTEXT_MAX_CHARS} value={input.about} />
        </div>
      </Field>
    </FieldGroup>
  )
}

// --- Step 4: Create your Golem -------------------------------------------------

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
          {empty ? GOLEM_ONBOARDING_STEP4.notSet : value.trim()}
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
  creating,
  busy,
  redoAllowed,
  gate,
  capabilities,
  limit,
  onSignIn,
  onSeePremium,
  onStartFromOurs,
  onAllowCloudAi
}: {
  input: GolemOnboardingInput
  persona: CohostPersona | null
  picture: ChosenPicture | null
  look: ReturnType<typeof useGolemLook>['state']
  lookController: ReturnType<typeof useGolemLook>['controller']
  creating: boolean
  busy: boolean
  redoAllowed: boolean
  gate: GolemCreateGate | null
  capabilities: Parameters<typeof golemOnboardingAllowanceLine>[0]
  limit: number
  onSignIn: () => void
  onSeePremium: () => void
  onStartFromOurs: () => void
  onAllowCloudAi: () => void
}): ReactElement {
  const view = creating ? 'working' : look.draft ? 'draft' : 'empty'
  const failure = view === 'empty' ? golemCreateFailureLine(look.problem, limit) : null
  const allowance = golemOnboardingAllowanceLine(capabilities)
  const skipped = input.skipDetails
  // A job picked up after the sheet was closed (or the app restarted) has no
  // inputs here: its summary would only say "Not set".
  // The living preview is a bonus: a draft it cannot draw keeps the tiles
  // and the line, without an empty box.
  const previewKey = look.draft ? `${look.draft.requestId}:${look.revision}` : null
  const [previewFailed, setPreviewFailed] = useState<string | null>(null)
  const showPreview = Boolean(persona) && previewKey !== null && previewFailed !== previewKey
  const summary =
    view === 'empty' ||
    (view === 'working' && (golemOnboardingHasLook(input) || input.name.trim().length > 0))
  return (
    <div className="flex flex-col gap-4" data-view={view}>
      {summary ? (
        <div
          className="flex flex-col divide-y divide-border overflow-hidden rounded-row border border-border bg-foreground/[0.03]"
          data-testid="golem-onboarding-summary"
        >
          <SummaryRow
            label={GOLEM_ONBOARDING_STEP4.summaryLook}
            testId="golem-onboarding-summary-look"
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
            label={GOLEM_ONBOARDING_STEP4.summaryName}
            testId="golem-onboarding-summary-name"
            value={input.name}
          />
          <SummaryRow
            label={GOLEM_ONBOARDING_STEP4.summaryPersonality}
            testId="golem-onboarding-summary-personality"
            value={skipped ? '' : input.personality}
          />
          <SummaryRow
            label={GOLEM_ONBOARDING_STEP4.summaryAbout}
            testId="golem-onboarding-summary-about"
            value={skipped ? '' : input.about}
          />
        </div>
      ) : null}

      <GolemPoseTiles
        busy={busy}
        controller={lookController}
        copy={ONBOARDING_TILES_COPY}
        redoAllowed={redoAllowed}
        state={look}
        view={view}
      />

      {view === 'working' ? (
        <p
          className="flex items-center gap-2 text-sm text-muted-foreground"
          data-testid="golem-onboarding-working"
          role="status"
        >
          <SpinnerIcon aria-hidden className="size-4 animate-spin" />
          {GOLEM_ONBOARDING_STEP4.working}
        </p>
      ) : view === 'draft' && look.draft ? (
        <div className="flex items-center gap-4" data-testid="golem-onboarding-result">
          {persona && showPreview ? (
            <LazyGolemPetPreview
              className="rounded-row border border-border bg-foreground/[0.03]"
              label={`${persona.name}, new look`}
              onError={() => setPreviewFailed(previewKey)}
              motion={persona.motion}
              packId={GOLEM_STILL_PACK_ID}
              personaId={persona.id}
              placeholder={<Skeleton className="size-full rounded-row" />}
              size={RESULT_PREVIEW_PX}
              stillImages={golemLookDraftImages(look.draft, look.revision)}
            />
          ) : null}
          <div className="flex min-w-0 flex-col gap-1">
            {look.draft.libraryAvatarId ? (
              <p
                className="flex items-center gap-2 text-sm text-foreground"
                data-testid="golem-onboarding-saved"
              >
                <CheckIcon aria-hidden className="size-4 text-success" weight="bold" />
                {GOLEM_ONBOARDING_STEP4.done}
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
        <GateRow
          gate={gate}
          onAllowCloudAi={onAllowCloudAi}
          onSeePremium={onSeePremium}
          onSignIn={onSignIn}
          onStartFromOurs={onStartFromOurs}
        />
      ) : failure ? (
        <Alert data-testid="golem-onboarding-failed" variant="destructive">
          <AlertIcon />
          <AlertTitle className="font-normal">{failure}</AlertTitle>
        </Alert>
      ) : allowance ? (
        <p
          className="text-xs text-muted-foreground tabular-nums"
          data-testid="golem-onboarding-allowance"
        >
          {allowance}
        </p>
      ) : null}
    </div>
  )
}

const GATE_ACTION_LABELS = {
  'sign-in': GOLEM_ONBOARDING_GATES.signIn,
  'see-premium': GOLEM_ONBOARDING_GATES.seePremium,
  'start-from-ours': GOLEM_ONBOARDING_GATES.startFromOurs,
  // The Cloud AI switch's own label (Golem tab, Cloud AI section).
  'allow-cloud-ai': 'Allow cloud AI'
} as const

/** Why Create does not work now: the copy document's line and its actions. */
function GateRow({
  gate,
  onSignIn,
  onSeePremium,
  onStartFromOurs,
  onAllowCloudAi
}: {
  gate: GolemCreateGate
  onSignIn: () => void
  onSeePremium: () => void
  onStartFromOurs: () => void
  onAllowCloudAi: () => void
}): ReactElement {
  const run = {
    'sign-in': onSignIn,
    'see-premium': onSeePremium,
    'start-from-ours': onStartFromOurs,
    'allow-cloud-ai': onAllowCloudAi
  } as const
  const Icon = gate.kind === 'signed-out' || gate.kind === 'premium' ? LockIcon : InfoIcon
  return (
    <div
      className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-row bg-foreground/[0.04] px-3 py-2.5"
      data-gate={gate.kind}
      data-testid="golem-onboarding-gate"
      role="status"
    >
      <Icon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
      <span className="min-w-0 flex-1 text-sm text-foreground">{gate.line}</span>
      {gate.actions.length > 0 ? (
        <div className="flex shrink-0 items-center gap-2">
          {gate.actions.map((action, index) => (
            <Button
              key={action}
              data-action={action}
              data-testid="golem-onboarding-gate-action"
              size="xs"
              type="button"
              variant={index === 0 ? 'outline' : 'ghost'}
              onClick={run[action]}
            >
              {GATE_ACTION_LABELS[action]}
            </Button>
          ))}
        </div>
      ) : null}
    </div>
  )
}

/**
 * Cloud AI consent where creating needs it (plan 119 decision 3): the same
 * one flag and the same list of uses as the Golem tab's Cloud AI switch,
 * so nothing is granted that the list does not name. The safe choice has
 * the focus.
 */
function CloudAiConsentDialog({
  open,
  onAnswer
}: {
  open: boolean
  onAnswer: (accepted: boolean) => void
}): ReactElement {
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onAnswer(false)
      }}
    >
      <DialogContent data-testid="golem-onboarding-consent" showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>{GATE_ACTION_LABELS['allow-cloud-ai']}</DialogTitle>
          <DialogDescription>{CLOUD_AI_KEEPS}</DialogDescription>
        </DialogHeader>
        <ul className="flex list-disc flex-col gap-1 pl-4 text-sm text-muted-foreground">
          {CLOUD_AI_USES.map((use) => (
            <li key={use}>{use}</li>
          ))}
        </ul>
        <DialogFooter>
          <Button autoFocus type="button" variant="ghost" onClick={() => onAnswer(false)}>
            Not now
          </Button>
          <Button type="button" onClick={() => onAnswer(true)}>
            {GATE_ACTION_LABELS['allow-cloud-ai']}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
