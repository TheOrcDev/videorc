import {
  CloseIcon,
  DeleteIcon,
  EditIcon,
  MoreIcon,
  NoteIcon,
  SignInIcon,
  SparkleIcon,
  SpinnerIcon,
  SyncIcon
} from '@/components/icons'
import { lazy, Suspense, useEffect, useState, type ReactElement } from 'react'

import { PanelSection } from '@/components/panel-section'
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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { Field, FieldDescription, FieldGroup, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { Textarea } from '@/components/ui/textarea'
import { useVideorcAccount } from '@/hooks/use-account'
import { useBuddyLibrary, type BuddyLibraryProblem } from '@/hooks/use-buddy-library'
import { useBuddyLookClient, type BuddyLookClient } from '@/hooks/use-buddy-look'
import { useStudioCore } from '@/hooks/use-studio'
import type { BuddyLookPicture } from '@/lib/buddy-look-view'
import {
  buddyInvitationVisible,
  buddyLibraryView,
  buddyOnboardingName,
  buddyTextLength,
  readBuddyInvitationDismissed,
  writeBuddyInvitationDismissed,
  type BuddyLibraryCard,
  type BuddyOnboardingStep
} from '@/lib/buddy-library-view'
import { BUDDY_OFFICIAL_ART } from '@/lib/buddy-official-art'
import {
  BUDDY_LIBRARY_COPY,
  BUDDY_ONBOARDING_GATES,
  BUDDY_ONBOARDING_STEP3,
  buddyLibraryDeleteTitle,
  buddyLibraryPickedElsewhere,
  buddyOnboardingCounter
} from '@/lib/buddy-onboarding-copy'
import { openBuddyPetCreator } from '@/lib/buddy-pet-creator-nav'
import { cn } from '@/lib/utils'
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
 * My Golems (plan 170 D16): the account library above the look panel.
 * Videorc's official five (free, bundled, work signed out) and the Golems
 * made by you on videorc.com or here, newest first, the active one badged.
 * Use makes one the Golem (name, personality, about you and its four
 * poses); Rename, Edit personality and Delete act on your own; Make it
 * Alive uses it, then opens the Alive creator with it. New Golem opens the
 * four-step onboarding. The first launch with the untouched default Golem
 * leads with a one-line invitation into it. Nothing toasts: the badge and
 * the look are the confirmation.
 */
export function BuddyLibrarySection({
  client: injectedClient,
  preparePicture
}: {
  /** Tests inject the backend; the app shares the Golem tab's client. */
  client?: BuddyLookClient | null
  /** Tests inject the onboarding's picture prep. */
  preparePicture?: (file: File) => Promise<BuddyLookPicture>
}): ReactElement {
  const { cohostSettings } = useStudioCore()
  const { signIn } = useVideorcAccount()
  const connected = useBuddyLookClient()
  const client = injectedClient !== undefined ? injectedClient : connected
  const { state, controller } = useBuddyLibrary(client)
  const persona = cohostSettings?.persona ?? null
  const library = state.library
  const view = buddyLibraryView({ library, persona })

  // Opening the Golem tab syncs (window focus syncs from the shell, plan 170
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

  const [edit, setEdit] = useState<EditTarget | null>(null)
  const [editOpen, setEditOpen] = useState(false)
  const openEdit = (target: EditTarget): void => {
    setEdit(target)
    setEditOpen(true)
  }

  // Make it Alive on a Golem that is not the active one: use it first, then
  // open the creator once the backend says it is the Golem.
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
            <SpinnerIcon
              aria-label="Syncing"
              className="size-3.5 animate-spin text-subtle"
              data-testid="buddy-library-syncing"
              role="status"
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
          >
            <SparkleIcon />
            <div className="col-start-2 flex flex-wrap items-center gap-x-3 gap-y-1.5">
              <AlertTitle className="min-w-0 flex-1 font-normal text-foreground">
                {BUDDY_LIBRARY_COPY.invitation}
              </AlertTitle>
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
                <Button
                  aria-label="Dismiss"
                  data-testid="buddy-library-invitation-dismiss"
                  size="icon-xs"
                  title="Dismiss"
                  type="button"
                  variant="ghost"
                  onClick={() => {
                    writeBuddyInvitationDismissed()
                    setDismissed(true)
                  }}
                >
                  <CloseIcon />
                </Button>
              </div>
            </div>
          </Alert>
        ) : null}

        {view.pickedElsewhere ? (
          <Alert data-testid="buddy-library-picked-elsewhere">
            <SyncIcon />
            <div className="col-start-2 flex flex-wrap items-center gap-x-3 gap-y-1.5">
              <AlertTitle className="min-w-0 flex-1 font-normal text-foreground">
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
          <CardGrid>
            {view.official.map((card) => (
              <BuddyCard
                key={card.id}
                card={card}
                disabled={working}
                onAlive={() => void makeAlive(card)}
                onEdit={openEdit}
                onUse={() => void controller?.use(card.id)}
              />
            ))}
          </CardGrid>
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
              <CardGrid>
                <Skeleton className="aspect-[3/4] rounded-row" />
                <Skeleton className="aspect-[3/4] rounded-row" />
              </CardGrid>
            ) : (
              <p className="text-xs text-subtle">{BUDDY_LIBRARY_COPY.emptyMine}</p>
            )
          ) : view.mine.length === 0 ? (
            <p className="text-xs text-subtle" data-testid="buddy-library-empty">
              {BUDDY_LIBRARY_COPY.emptyMine}
            </p>
          ) : (
            <CardGrid>
              {view.mine.map((card) => (
                <BuddyCard
                  key={card.id}
                  card={card}
                  disabled={working}
                  onAlive={() => void makeAlive(card)}
                  onEdit={openEdit}
                  onUse={() => void controller?.use(card.id)}
                />
              ))}
            </CardGrid>
          )}
        </LibraryGroup>

        {(problem ?? view.error) ? (
          <p className="text-xs text-destructive" data-testid="buddy-library-error">
            {problem ?? view.error}
          </p>
        ) : null}
      </div>

      <EditDialog
        open={editOpen}
        target={edit}
        onClose={() => setEditOpen(false)}
        onDelete={async (card) => {
          setEditOpen(false)
          await controller?.remove(card.id)
        }}
        onUpdate={async (params) => {
          setEditOpen(false)
          await controller?.update(params)
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

function CardGrid({ children }: { children: ReactElement | ReactElement[] }): ReactElement {
  return (
    <div className="grid gap-2 [grid-template-columns:repeat(auto-fill,minmax(8.25rem,1fr))]">
      {children}
    </div>
  )
}

/**
 * One Golem: its idle pose, name and a short line, then Use (or the
 * Active badge) and a menu with the rest. A card, because it is an object
 * with a picture (the design skill's rule).
 */
function BuddyCard({
  card,
  disabled,
  onUse,
  onAlive,
  onEdit
}: {
  card: BuddyLibraryCard
  disabled: boolean
  onUse: () => void
  onAlive: () => void
  onEdit: (target: EditTarget) => void
}): ReactElement {
  const picture = card.slug ? BUDDY_OFFICIAL_ART[card.slug].idle : card.idleUrl
  return (
    <div
      className={cn(
        'flex min-w-0 flex-col gap-1.5 rounded-row border border-border bg-foreground/[0.04] p-1.5',
        card.active && 'border-foreground/25 bg-accent',
        card.busy && 'opacity-70'
      )}
      data-active={card.active || undefined}
      data-busy={card.busy || undefined}
      data-id={card.id}
      data-kind={card.kind}
      data-testid="buddy-library-card"
      title={card.hint || undefined}
    >
      <div className="relative aspect-square overflow-hidden rounded-chip bg-foreground/[0.04]">
        {picture ? (
          <img
            alt={card.name}
            className="size-full object-contain p-1.5"
            decoding="async"
            draggable={false}
            src={picture}
          />
        ) : (
          <Skeleton className="size-full rounded-none" />
        )}
        {card.busy ? (
          <SpinnerIcon
            aria-hidden
            className="absolute top-1.5 right-1.5 size-3.5 animate-spin text-muted-foreground"
          />
        ) : null}
      </div>
      <div className="flex min-w-0 flex-col px-0.5">
        <span className="truncate text-sm font-medium text-foreground">{card.name}</span>
        <span className="line-clamp-2 min-h-8 text-xs text-muted-foreground">{card.subtitle}</span>
      </div>
      <div className="flex items-center gap-1">
        {card.active ? (
          <div className="flex h-6 flex-1 items-center px-0.5">
            <Badge data-testid="buddy-library-active" variant="success">
              {BUDDY_LIBRARY_COPY.active}
            </Badge>
          </div>
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
            <DropdownMenuItem data-testid="buddy-library-alive" onSelect={onAlive}>
              <SparkleIcon />
              {BUDDY_LIBRARY_COPY.makeAlive}
            </DropdownMenuItem>
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
      </div>
    </div>
  )
}

/**
 * Rename, Edit personality (with About you) and the Delete confirm for one
 * of your own Golems. The target stays set while the dialog fades out.
 */
function EditDialog({
  open,
  target,
  personality,
  context,
  onClose,
  onUpdate,
  onDelete
}: {
  open: boolean
  target: EditTarget | null
  personality: string
  context: string
  onClose: () => void
  onUpdate: (params: {
    avatarId: string
    name?: string
    personality?: string
    context?: string
  }) => Promise<void>
  onDelete: (card: BuddyLibraryCard) => Promise<void>
}): ReactElement {
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose()
      }}
    >
      {target?.kind === 'delete' ? (
        <DialogContent data-testid="buddy-library-delete-dialog" showCloseButton={false}>
          <DialogHeader>
            <DialogTitle>{buddyLibraryDeleteTitle(target.card.name)}</DialogTitle>
            <DialogDescription>{BUDDY_LIBRARY_COPY.deleteBody}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button autoFocus type="button" variant="ghost" onClick={onClose}>
              {BUDDY_LIBRARY_COPY.cancel}
            </Button>
            <Button
              data-testid="buddy-library-delete-confirm"
              type="button"
              variant="destructive"
              onClick={() => void onDelete(target.card)}
            >
              {BUDDY_LIBRARY_COPY.delete}
            </Button>
          </DialogFooter>
        </DialogContent>
      ) : target ? (
        <EditForm
          // A fresh form for every Golem and every open.
          key={`${target.kind}:${target.card.id}:${String(open)}`}
          context={context}
          personality={personality}
          target={target}
          onClose={onClose}
          onUpdate={onUpdate}
        />
      ) : null}
    </Dialog>
  )
}

function EditForm({
  target,
  personality: savedPersonality,
  context: savedContext,
  onClose,
  onUpdate
}: {
  target: EditTarget
  personality: string
  context: string
  onClose: () => void
  onUpdate: (params: {
    avatarId: string
    name?: string
    personality?: string
    context?: string
  }) => Promise<void>
}): ReactElement {
  const [name, setName] = useState(target.card.name)
  const [personality, setPersonality] = useState(savedPersonality)
  const [context, setContext] = useState(savedContext)
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
    if (!changed || !valid) return
    void onUpdate(
      rename
        ? { avatarId: target.card.id, name: nameToSave ?? undefined }
        : {
            avatarId: target.card.id,
            ...(personality !== savedPersonality ? { personality: personality.trim() } : {}),
            ...(context !== savedContext ? { context: context.trim() } : {})
          }
    )
  }
  return (
    <DialogContent
      aria-describedby={undefined}
      className={rename ? 'sm:max-w-sm' : 'sm:max-w-lg'}
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
            <FieldDescription className="text-xs">
              {BUDDY_ONBOARDING_STEP3.nameHelp}
            </FieldDescription>
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
              <span className="self-end text-xs text-subtle tabular-nums">
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
                <FieldDescription className="text-xs">
                  {BUDDY_ONBOARDING_STEP3.aboutHelp}
                </FieldDescription>
                <span className="ml-auto text-xs text-subtle tabular-nums">
                  {buddyOnboardingCounter(
                    buddyTextLength(context),
                    BUDDY_LIBRARY_CONTEXT_MAX_CHARS
                  )}
                </span>
              </div>
            </Field>
          </FieldGroup>
        )}
        <DialogFooter>
          <Button type="button" variant="ghost" onClick={onClose}>
            {BUDDY_LIBRARY_COPY.cancel}
          </Button>
          <Button data-testid="buddy-library-save" disabled={!changed || !valid} type="submit">
            Save
          </Button>
        </DialogFooter>
      </form>
    </DialogContent>
  )
}
