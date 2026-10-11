import {
  CloseIcon,
  DeleteIcon,
  EditIcon,
  MoreIcon,
  NoteIcon,
  SignInIcon,
  SparkleIcon,
  SyncIcon,
  UploadIcon
} from '@/components/icons'
import { lazy, Suspense, useEffect, useState, type ReactElement } from 'react'

import { BuddyPictureCard } from '@/components/buddy-picture-card'
import { Gallery } from '@/components/page'
import { PanelSection } from '@/components/panel-section'
import { Alert, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/confirm-dialog'
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { Textarea } from '@/components/ui/textarea'
import { Spinner } from '@/components/ui/spinner'
import { useVideorcAccount } from '@/hooks/use-account'
import { useBuddyLibrary, type BuddyLibraryProblem } from '@/hooks/use-buddy-library'
import { useBuddyLookClient, type BuddyLookClient } from '@/hooks/use-buddy-look'
import { useStudioCore } from '@/hooks/use-studio'
import type { BuddyLookPicture } from '@/lib/buddy-look-view'
import {
  buddyAliveTagDistinguishes,
  buddyInvitationVisible,
  buddyLibraryBusyLine,
  buddyLibrarySaveOffer,
  buddyLibraryView,
  buddyOnboardingName,
  buddyTextLength,
  readBuddyInvitationDismissed,
  writeBuddyInvitationDismissed,
  type BuddyLibraryCard,
  type BuddyOnboardingStep
} from '@/lib/buddy-library-view'
import { BUDDY_OFFICIAL_ART } from '@/lib/buddy-official-art'
import { useBuddyOnboardingRequest } from '@/lib/buddy-onboarding-store'
import {
  BUDDY_LIBRARY_COPY,
  BUDDY_ONBOARDING_GATES,
  BUDDY_ONBOARDING_STEP3,
  buddyLibraryDeleteTitle,
  buddyLibraryLocalOnly,
  buddyLibraryPickedElsewhere,
  buddyOnboardingCounter
} from '@/lib/buddy-onboarding-copy'
import { openBuddyPetCreator } from '@/lib/buddy-pet-creator-nav'
import {
  BUDDY_LIBRARY_CONTEXT_MAX_CHARS,
  BUDDY_LIBRARY_NAME_MAX_CHARS,
  BUDDY_LIBRARY_PERSONALITY_MAX_CHARS
} from '../../../shared/buddy-library'

// The onboarding sheet is its own chunk: the demo backdrop, the steps and
// the picture prep load the first time it opens.
const BuddyOnboarding = lazy(() => import('@/components/buddy-onboarding'))

type EditTarget = { kind: 'rename' | 'personality' | 'delete'; card: BuddyLibraryCard }

/**
 * My Buddies (plan 170 D16): the account library above the look panel.
 * Videorc's official five (free, bundled, work signed out) and the Buddies
 * made by you on videorc.com or here, newest first, the active one badged.
 * Use makes one the Buddy (name, personality, about you and its four
 * poses, and its alive pack when it has one); Rename, Edit personality and
 * Delete act on your own; a Buddy that moves says "Alive" (plan 172 D12),
 * and Make it Alive on one that does not uses it, then opens the Alive
 * creator with it. A Buddy made only on this computer offers "Save to my
 * library" (D10). New Buddy opens the four-step onboarding. The first
 * launch with the untouched default Buddy leads with a one-line invitation
 * into it. Nothing toasts: the badge and the look are the confirmation; a
 * pack or Buddy on its way says so in one line.
 */
export function BuddyLibrarySection({
  client: injectedClient,
  preparePicture
}: {
  /** Tests inject the backend; the app shares the Buddy tab's client. */
  client?: BuddyLookClient | null
  /** Tests inject the onboarding's picture prep. */
  preparePicture?: (file: File) => Promise<BuddyLookPicture>
}): ReactElement {
  const { aiCapabilities, cohostSettings } = useStudioCore()
  const { signIn } = useVideorcAccount()
  const connected = useBuddyLookClient()
  const client = injectedClient !== undefined ? injectedClient : connected
  const { state, controller } = useBuddyLibrary(client)
  const persona = cohostSettings?.persona ?? null
  const library = state.library
  const view = buddyLibraryView({ library, persona })
  const busyLine = buddyLibraryBusyLine(library, persona?.name ?? null)
  const saveOffer = buddyLibrarySaveOffer({
    library,
    persona,
    capabilities: aiCapabilities ?? null
  })

  // Opening the Buddy tab syncs (window focus syncs from the shell, plan 170
  // D12). A refused automatic sync stays quiet.
  const [quietProblem, setQuietProblem] = useState<BuddyLibraryProblem | null>(null)
  useEffect(() => {
    if (!controller) return
    void controller.sync('tab').then((accepted) => {
      if (!accepted) setQuietProblem(controller.getState().problem)
    })
  }, [controller])
  const problem = state.problem && state.problem !== quietProblem ? state.problem.message : null

  const [dismissed, setDismissed] = useState(() => readBuddyInvitationDismissed())
  const invitation = buddyInvitationVisible({ library, persona, dismissed })

  const [onboarding, setOnboarding] = useState<{
    open: boolean
    nonce: number
    step: BuddyOnboardingStep
  } | null>(null)
  const openOnboarding = (step: BuddyOnboardingStep): void =>
    setOnboarding((current) => ({ open: true, nonce: (current?.nonce ?? 0) + 1, step }))
  // Another surface asked for the onboarding (the Alive creator's New Buddy…,
  // plan 174 G-4): this section hosts the sheet, so it opens it.
  const request = useBuddyOnboardingRequest()
  const [appliedRequest, setAppliedRequest] = useState<number | null>(null)
  if (request && request.nonce !== appliedRequest) {
    setAppliedRequest(request.nonce)
    openOnboarding(request.step)
  }

  const [edit, setEdit] = useState<EditTarget | null>(null)
  const [editOpen, setEditOpen] = useState(false)
  const openEdit = (target: EditTarget): void => {
    setEdit(target)
    setEditOpen(true)
  }

  // Make it Alive on a Buddy that is not the active one: use it first, then
  // open the creator once the backend says it is the Buddy.
  const [aliveFor, setAliveFor] = useState<string | null>(null)
  const aliveReady = aliveFor !== null && library?.activeAvatarId === aliveFor && !library.busy
  useEffect(() => {
    if (!aliveReady) return
    setAliveFor(null)
    openBuddyPetCreator({ reference: 'persona-idle' })
  }, [aliveReady])
  const makeAlive = async (card: BuddyLibraryCard): Promise<void> => {
    if (card.active) {
      openBuddyPetCreator({ reference: 'persona-idle' })
      return
    }
    if (!controller) return
    if (await controller.use(card.id)) setAliveFor(card.id)
  }

  const working = view.busy || state.pending !== null || !controller

  return (
    <PanelSection
      action={
        <>
          {view.syncing ? (
            <Spinner
              aria-label="Syncing"
              className="size-3.5 text-subtle"
              data-testid="buddy-library-syncing"
            />
          ) : null}
          <Button
            data-testid="buddy-library-new"
            size="xs"
            type="button"
            variant="outline"
            onClick={() => openOnboarding(1)}
          >
            <SparkleIcon data-icon="inline-start" />
            {BUDDY_LIBRARY_COPY.newBuddy}
          </Button>
        </>
      }
      title={BUDDY_LIBRARY_COPY.title}
    >
      <div className="flex flex-col gap-4" data-testid="buddy-library">
        {invitation ? (
          <Alert
            className="has-data-[slot=alert-action]:pr-3"
            data-testid="buddy-library-invitation"
            icon={SparkleIcon}
          >
            <div className="col-start-2 flex flex-wrap items-center gap-x-3 gap-y-1.5">
              <AlertTitle className="min-w-0 flex-1">{BUDDY_LIBRARY_COPY.invitation}</AlertTitle>
              <div className="flex items-center gap-1">
                <Button
                  data-testid="buddy-library-invitation-start"
                  size="xs"
                  type="button"
                  variant="outline"
                  onClick={() => openOnboarding(1)}
                >
                  {BUDDY_LIBRARY_COPY.invitationAction}
                </Button>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      aria-label="Dismiss"
                      data-testid="buddy-library-invitation-dismiss"
                      size="icon-xs"
                      type="button"
                      variant="ghost"
                      onClick={() => {
                        writeBuddyInvitationDismissed()
                        setDismissed(true)
                      }}
                    >
                      <CloseIcon />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>Dismiss</TooltipContent>
                </Tooltip>
              </div>
            </div>
          </Alert>
        ) : null}

        {saveOffer ? (
          <Alert data-testid="buddy-library-local-only" icon={UploadIcon}>
            <div className="col-start-2 flex flex-wrap items-center gap-x-3 gap-y-1.5">
              <AlertTitle className="min-w-0 flex-1">
                {buddyLibraryLocalOnly(saveOffer.name)}
              </AlertTitle>
              <Button
                data-testid="buddy-library-save-to-library"
                disabled={working}
                size="xs"
                type="button"
                variant="outline"
                onClick={() => void controller?.saveToLibrary()}
              >
                {BUDDY_LIBRARY_COPY.saveToLibrary}
              </Button>
            </div>
          </Alert>
        ) : null}

        {busyLine ? (
          <div
            className="flex items-center gap-2 text-xs text-muted-foreground"
            data-testid="buddy-library-busy"
            role="status"
          >
            <Spinner aria-hidden className="size-3.5 shrink-0" />
            <span className="min-w-0 truncate">{busyLine}</span>
          </div>
        ) : null}

        {view.pickedElsewhere ? (
          <Alert data-testid="buddy-library-picked-elsewhere" icon={SyncIcon}>
            <div className="col-start-2 flex flex-wrap items-center gap-x-3 gap-y-1.5">
              <AlertTitle className="min-w-0 flex-1">
                {buddyLibraryPickedElsewhere(view.pickedElsewhere.name)}
              </AlertTitle>
              <Button
                data-testid="buddy-library-picked-elsewhere-use"
                disabled={working}
                size="xs"
                type="button"
                variant="outline"
                onClick={() => {
                  if (view.pickedElsewhere) void controller?.use(view.pickedElsewhere.id)
                }}
              >
                {BUDDY_LIBRARY_COPY.use}
              </Button>
            </div>
          </Alert>
        ) : null}

        <LibraryGroup label={BUDDY_LIBRARY_COPY.official} testId="buddy-library-official">
          <Gallery>
            {view.official.map((card) => (
              <BuddyCard
                key={card.id}
                aliveTag={buddyAliveTagDistinguishes(view.official)}
                card={card}
                disabled={working}
                onAlive={() => void makeAlive(card)}
                onEdit={openEdit}
                onUse={() => void controller?.use(card.id)}
              />
            ))}
          </Gallery>
        </LibraryGroup>

        <LibraryGroup label={BUDDY_LIBRARY_COPY.mine} testId="buddy-library-mine">
          {state.loading ? null : !view.signedIn ? (
            <div
              className="flex flex-wrap items-center gap-x-3 gap-y-1.5"
              data-testid="buddy-library-signed-out"
            >
              <span className="text-xs text-muted-foreground">{BUDDY_LIBRARY_COPY.signedOut}</span>
              <Button size="xs" type="button" variant="outline" onClick={signIn}>
                <SignInIcon data-icon="inline-start" />
                {BUDDY_ONBOARDING_GATES.signIn}
              </Button>
            </div>
          ) : view.mine === null ? (
            view.syncing ? (
              <Gallery>
                <Skeleton className="aspect-[3/4] rounded-row" />
                <Skeleton className="aspect-[3/4] rounded-row" />
              </Gallery>
            ) : (
              <p className="text-xs text-subtle">{BUDDY_LIBRARY_COPY.emptyMine}</p>
            )
          ) : view.mine.length === 0 ? (
            <p className="text-xs text-subtle" data-testid="buddy-library-empty">
              {BUDDY_LIBRARY_COPY.emptyMine}
            </p>
          ) : (
            <Gallery>
              {view.mine.map((card) => (
                <BuddyCard
                  key={card.id}
                  aliveTag={buddyAliveTagDistinguishes(view.mine ?? [])}
                  card={card}
                  disabled={working}
                  onAlive={() => void makeAlive(card)}
                  onEdit={openEdit}
                  onUse={() => void controller?.use(card.id)}
                />
              ))}
            </Gallery>
          )}
        </LibraryGroup>

        {/* A failed sync or action is the section's (plan 174 G-7). */}
        {(problem ?? view.error) ? (
          <Alert data-testid="buddy-library-error" variant="destructive">
            <AlertTitle>{problem ?? view.error}</AlertTitle>
          </Alert>
        ) : null}
      </div>

      <EditDialog
        open={editOpen}
        target={edit}
        problem={state.problem?.message ?? null}
        onClose={() => setEditOpen(false)}
        onDelete={async (card) => {
          // Plan 174 G-24: the dialog closes only once the backend accepted.
          const accepted = (await controller?.remove(card.id)) ?? false
          if (accepted) setEditOpen(false)
          return accepted
        }}
        onUpdate={async (params) => {
          const accepted = (await controller?.update(params)) ?? false
          if (accepted) setEditOpen(false)
          return accepted
        }}
        context={library?.mine?.find((entry) => entry.id === edit?.card.id)?.context ?? ''}
        personality={library?.mine?.find((entry) => entry.id === edit?.card.id)?.personality ?? ''}
      />

      {onboarding ? (
        <Suspense fallback={null}>
          <BuddyOnboarding
            client={injectedClient}
            initialStep={onboarding.step}
            library={library}
            libraryController={controller}
            open={onboarding.open}
            openNonce={onboarding.nonce}
            preparePicture={preparePicture}
            onOpenChange={(open) =>
              setOnboarding((current) => (current ? { ...current, open } : current))
            }
          />
        </Suspense>
      ) : null}
    </PanelSection>
  )
}

function LibraryGroup({
  label,
  testId,
  children
}: {
  label: string
  testId: string
  children: ReactElement | null
}): ReactElement {
  return (
    <section className="flex flex-col gap-1.5" data-testid={testId}>
      <h4 className="px-0.5 text-[11px] font-semibold text-subtle">{label}</h4>
      {children}
    </section>
  )
}

/**
 * One Buddy: the one picture card (plan 174 G-17), its idle pose, name and
 * what it is like, then Use and a menu with the rest. The active one is
 * marked by the card itself; "Alive" shows only where it tells cards apart
 * (V-1).
 */
function BuddyCard({
  card,
  aliveTag,
  disabled,
  onUse,
  onAlive,
  onEdit
}: {
  card: BuddyLibraryCard
  /** The group holds both kinds, so the tag says something. */
  aliveTag: boolean
  disabled: boolean
  onUse: () => void
  onAlive: () => void
  onEdit: (target: EditTarget) => void
}): ReactElement {
  const picture = card.slug ? BUDDY_OFFICIAL_ART[card.slug].idle : card.idleUrl
  const menu = card.kind === 'mine' || card.canMakeAlive
  return (
    <BuddyPictureCard
      active={card.active}
      alive={aliveTag && card.alive}
      busy={card.busy}
      data-id={card.id}
      data-kind={card.kind}
      data-testid="buddy-library-card"
      detail={card.hint}
      name={card.name}
      picture={picture}
      subtitle={card.subtitle}
    >
      {card.active ? (
        menu ? (
          <span className="flex-1" />
        ) : null
      ) : (
        <Button
          className="flex-1"
          data-testid="buddy-library-use"
          disabled={disabled}
          size="xs"
          type="button"
          variant="outline"
          onClick={onUse}
        >
          {BUDDY_LIBRARY_COPY.use}
        </Button>
      )}
      {menu ? (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              aria-label={`More for ${card.name}`}
              data-testid="buddy-library-more"
              disabled={disabled}
              size="icon-xs"
              type="button"
              variant="ghost"
            >
              <MoreIcon className="size-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="min-w-44">
            {card.kind === 'mine' ? (
              <>
                <DropdownMenuItem
                  data-testid="buddy-library-rename"
                  onSelect={() => onEdit({ kind: 'rename', card })}
                >
                  <EditIcon />
                  {BUDDY_LIBRARY_COPY.rename}
                </DropdownMenuItem>
                <DropdownMenuItem
                  data-testid="buddy-library-edit-personality"
                  onSelect={() => onEdit({ kind: 'personality', card })}
                >
                  <NoteIcon />
                  {BUDDY_LIBRARY_COPY.editPersonality}
                </DropdownMenuItem>
              </>
            ) : null}
            {card.canMakeAlive ? (
              <DropdownMenuItem data-testid="buddy-library-alive" onSelect={onAlive}>
                <SparkleIcon />
                {BUDDY_LIBRARY_COPY.makeAlive}
              </DropdownMenuItem>
            ) : null}
            {card.kind === 'mine' ? (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  data-testid="buddy-library-delete"
                  variant="destructive"
                  onSelect={() => onEdit({ kind: 'delete', card })}
                >
                  <DeleteIcon />
                  {BUDDY_LIBRARY_COPY.delete}
                </DropdownMenuItem>
              </>
            ) : null}
          </DropdownMenuContent>
        </DropdownMenu>
      ) : null}
    </BuddyPictureCard>
  )
}

type EditParams = {
  avatarId: string
  name?: string
  personality?: string
  context?: string
}

/**
 * Rename, Edit personality (with About you) and the Delete confirm for one
 * of your own Buddies. The target stays set while the dialog fades out. A
 * dialog closes only when the backend accepted (plan 174 G-24); a refusal
 * shows inside it, with the fields still filled.
 */
function EditDialog({
  open,
  target,
  personality,
  context,
  problem,
  onClose,
  onUpdate,
  onDelete
}: {
  open: boolean
  target: EditTarget | null
  personality: string
  context: string
  /** The library's last refusal, in the backend's words. */
  problem: string | null
  onClose: () => void
  /** True when the backend accepted the change. */
  onUpdate: (params: EditParams) => Promise<boolean>
  onDelete: (card: BuddyLibraryCard) => Promise<boolean>
}): ReactElement {
  const deleting = target?.kind === 'delete' ? target : null
  const [deletePending, setDeletePending] = useState(false)
  return (
    <>
      <ConfirmDialog
        cancelDisabled={deletePending}
        cancelLabel={BUDDY_LIBRARY_COPY.cancel}
        confirmDisabled={deletePending}
        confirmLabel={deletePending ? 'Deleting…' : BUDDY_LIBRARY_COPY.delete}
        description={BUDDY_LIBRARY_COPY.deleteBody}
        open={open && deleting !== null}
        testId="buddy-library-delete"
        title={deleting ? buddyLibraryDeleteTitle(deleting.card.name) : ''}
        onCancel={onClose}
        onConfirm={() => {
          if (!deleting || deletePending) return
          setDeletePending(true)
          void onDelete(deleting.card).finally(() => setDeletePending(false))
        }}
      >
        {deleting && problem && !deletePending ? (
          <FieldError data-testid="buddy-library-delete-error">{problem}</FieldError>
        ) : null}
      </ConfirmDialog>
      <Dialog
        open={open && deleting === null}
        onOpenChange={(next) => {
          if (!next) onClose()
        }}
      >
        {target && target.kind !== 'delete' ? (
          <EditForm
            // A fresh form for every Buddy and every open.
            key={`${target.kind}:${target.card.id}:${String(open)}`}
            context={context}
            personality={personality}
            problem={problem}
            target={target}
            onClose={onClose}
            onUpdate={onUpdate}
          />
        ) : null}
      </Dialog>
    </>
  )
}

function EditForm({
  target,
  personality: savedPersonality,
  context: savedContext,
  problem,
  onClose,
  onUpdate
}: {
  target: EditTarget
  personality: string
  context: string
  problem: string | null
  onClose: () => void
  onUpdate: (params: EditParams) => Promise<boolean>
}): ReactElement {
  const [name, setName] = useState(target.card.name)
  const [personality, setPersonality] = useState(savedPersonality)
  const [context, setContext] = useState(savedContext)
  const [saving, setSaving] = useState(false)
  // The refusal shows only for a save asked from this form, never a stale one.
  const [refused, setRefused] = useState(false)
  const rename = target.kind === 'rename'
  const nameToSave = buddyOnboardingName(name)
  const changed = rename
    ? nameToSave !== null && nameToSave !== target.card.name
    : personality !== savedPersonality || context !== savedContext
  const valid = rename
    ? nameToSave !== null
    : buddyTextLength(personality) <= BUDDY_LIBRARY_PERSONALITY_MAX_CHARS &&
      buddyTextLength(context) <= BUDDY_LIBRARY_CONTEXT_MAX_CHARS
  const save = (): void => {
    if (!changed || !valid || saving) return
    setSaving(true)
    setRefused(false)
    void onUpdate(
      rename
        ? { avatarId: target.card.id, name: nameToSave ?? undefined }
        : {
            avatarId: target.card.id,
            ...(personality !== savedPersonality ? { personality: personality.trim() } : {}),
            ...(context !== savedContext ? { context: context.trim() } : {})
          }
    ).then((accepted) => {
      setSaving(false)
      if (!accepted) setRefused(true)
    })
  }
  return (
    <DialogContent
      aria-describedby={undefined}
      size={rename ? 'sm' : 'lg'}
      data-testid="buddy-library-edit-dialog"
    >
      <form
        className="flex flex-col gap-5"
        onSubmit={(event) => {
          event.preventDefault()
          save()
        }}
      >
        <DialogHeader>
          <DialogTitle>
            {rename ? BUDDY_LIBRARY_COPY.rename : BUDDY_LIBRARY_COPY.editPersonality}
          </DialogTitle>
        </DialogHeader>
        {rename ? (
          <Field>
            <FieldLabel htmlFor="buddy-library-name">{BUDDY_ONBOARDING_STEP3.nameLabel}</FieldLabel>
            <Input
              autoFocus
              id="buddy-library-name"
              maxLength={BUDDY_LIBRARY_NAME_MAX_CHARS}
              placeholder={BUDDY_ONBOARDING_STEP3.namePlaceholder}
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
            <FieldDescription>{BUDDY_ONBOARDING_STEP3.nameHelp}</FieldDescription>
          </Field>
        ) : (
          <FieldGroup className="gap-5">
            <Field>
              <FieldLabel htmlFor="buddy-library-personality">
                {BUDDY_ONBOARDING_STEP3.personalityLabel}
              </FieldLabel>
              <Textarea
                autoFocus
                className="min-h-20"
                id="buddy-library-personality"
                placeholder={BUDDY_ONBOARDING_STEP3.personalityPlaceholder}
                value={personality}
                onChange={(event) => setPersonality(event.target.value)}
              />
              <span className="self-end text-xs text-muted-foreground tabular-nums">
                {buddyOnboardingCounter(
                  buddyTextLength(personality),
                  BUDDY_LIBRARY_PERSONALITY_MAX_CHARS
                )}
              </span>
            </Field>
            <Field>
              <FieldLabel htmlFor="buddy-library-about">
                {BUDDY_ONBOARDING_STEP3.aboutLabel}
              </FieldLabel>
              <Textarea
                className="min-h-24"
                id="buddy-library-about"
                placeholder={BUDDY_ONBOARDING_STEP3.aboutPlaceholder}
                value={context}
                onChange={(event) => setContext(event.target.value)}
              />
              <div className="flex items-center gap-2">
                <FieldDescription>{BUDDY_ONBOARDING_STEP3.aboutHelp}</FieldDescription>
                <span className="ml-auto text-xs text-muted-foreground tabular-nums">
                  {buddyOnboardingCounter(
                    buddyTextLength(context),
                    BUDDY_LIBRARY_CONTEXT_MAX_CHARS
                  )}
                </span>
              </div>
            </Field>
          </FieldGroup>
        )}
        {refused && problem ? (
          <FieldError data-testid="buddy-library-edit-error">{problem}</FieldError>
        ) : null}
        <DialogFooter>
          <Button disabled={saving} type="button" variant="ghost" onClick={onClose}>
            {BUDDY_LIBRARY_COPY.cancel}
          </Button>
          <Button
            data-testid="buddy-library-save"
            disabled={!changed || !valid || saving}
            type="submit"
          >
            {saving ? 'Saving…' : 'Save'}
          </Button>
        </DialogFooter>
      </form>
    </DialogContent>
  )
}
