import { useRef, useState, type ReactElement, type ReactNode } from 'react'
import { lastCheckedLabel } from '@/hooks/use-scheduled-streams'
import { openLivestreamView } from '@/lib/livestream-tabs'
import { SESSION_LOCK_REASON } from '@/lib/lock-view'
import { DisabledReason } from '@/components/ui/disabled-reason'
import { Spinner } from '@/components/ui/spinner'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { copyText } from '@/lib/copy-text'
import { toastUserError } from '@/lib/user-error'
import {
  CopyIcon,
  DeleteIcon,
  EditIcon,
  ExternalLinkIcon,
  LinkIcon,
  RefreshIcon
} from '@/components/icons'
import { useScheduledStreams } from '@/hooks/use-scheduled-streams'
import { useStudioCore } from '@/hooks/use-studio'
import { GO_LIVE_LABEL, USE_FOR_GO_LIVE_LABEL } from '@/lib/go-live-copy'
import { ScheduleStreamDialog } from '@/components/schedule-stream-dialog'
import { ConfirmDialog } from '@/components/confirm-dialog'
import { KebabMenu, type KebabMenuItem } from '@/components/kebab-menu'
import { PageHeader } from '@/components/page'
import { PlatformGlyph } from '@/components/platform-glyph'
import { StatusBadge } from '@/components/status-badge'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Alert, AlertAction, AlertDescription, AlertTitle } from '@/components/ui/alert'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { GroupedList } from '@/components/list-row'
import { Skeleton } from '@/components/ui/skeleton'
import {
  eventCanEdit,
  scheduledLifecycleChip,
  scheduledPrivacyLabel,
  scheduledProviderLabel,
  scheduledProviderNoun,
  scheduledProviderSections,
  scheduledProviderSite,
  scheduledThumbnailUrl,
  scheduledWhenLabel,
  selectScheduledStreamForTarget,
  type ScheduledLifecycleChip,
  type ScheduledProviderSection
} from '@/lib/scheduled-streams'
import type {
  ScheduledStreamEvent,
  ScheduledStreamCandidate,
  ScheduledStreamProvider
} from '@/lib/backend'

type Candidate = ScheduledStreamCandidate

/** The open schedule form: a saved event, or a new one for one platform. */
type Editing = { event: ScheduledStreamEvent | null; provider: ScheduledStreamProvider }

export function ScheduledStreams(): ReactElement {
  const state = useScheduledStreams()
  const { captureConfig, setCaptureConfig, isSessionActive } = useStudioCore()
  const formTrigger = useRef<HTMLElement | null>(null)
  const [editing, setEditing] = useState<Editing | null>(null)
  const [canceling, setCanceling] = useState<ScheduledStreamEvent | null>(null)
  // Upcoming and Past are two views of one list (plan 174 S3.5b, D-34).
  const [view, setView] = useState<'upcoming' | 'past'>('upcoming')
  const history = view === 'past'
  const [refreshing, setRefreshing] = useState(false)
  const [recovering, setRecovering] = useState<ScheduledStreamEvent | null>(null)
  const [candidates, setCandidates] = useState<Candidate[]>([])
  const [candidateId, setCandidateId] = useState('')
  const [starting, setStarting] = useState<ScheduledStreamEvent | null>(null)
  const [targetId, setTargetId] = useState('')
  const perform = async (action: string, event: ScheduledStreamEvent, fields = {}) => {
    try {
      await state.mutate(action, { eventId: event.id, expectedRevision: event.revision, ...fields })
      return true
    } catch {
      return false
    }
  }
  const refresh = async () => {
    setRefreshing(true)
    try {
      await state.reload(true)
    } finally {
      setRefreshing(false)
    }
  }
  const edit = async (event: ScheduledStreamEvent) => {
    if (event.providerEventId && !(await perform('refresh', event))) return
    setEditing({
      event: await state.request<ScheduledStreamEvent>('get', { eventId: event.id }),
      provider: event.provider
    })
  }
  const recover = async (event: ScheduledStreamEvent) => {
    if (event.providerEventId && event.preparation?.phase !== 'creating-stream') {
      await perform('recover', event)
      return
    }
    try {
      setCandidates(await state.request<Candidate[]>('candidates', { eventId: event.id }))
      setRecovering(event)
      setCandidateId('')
    } catch (error) {
      toastUserError(error, { action: 'recover', object: 'the event' })
    }
  }
  const sections = scheduledProviderSections(state.events, state.capabilities, history)
  const startTargets = captureConfig.streaming.targets.filter(
    (target) =>
      target.platform === (starting?.provider ?? 'youtube') &&
      target.authMode === 'oauth' &&
      target.accountId === starting?.accountId
  )
  const checked = lastCheckedLabel(state.lastCheckedAt, Date.now())
  const body = (
    <div className="flex flex-col gap-6 p-gutter">
      {state.error && (
        <Alert variant="destructive">
          <AlertDescription>{state.error}</AlertDescription>
        </Alert>
      )}
      {state.loading ? (
        <Skeleton className="h-20 w-full" />
      ) : (
        sections.map((section) => (
          <ProviderSection
            key={section.provider}
            history={history}
            section={section}
            onSchedule={(trigger) => {
              formTrigger.current = trigger
              setEditing({ event: null, provider: section.provider })
            }}
          >
            {section.events.map((event) => (
              <EventRow
                key={event.id}
                event={event}
                pending={state.pendingIds.includes(event.id)}
                providerAvailable={section.available}
                sessionActive={isSessionActive}
                onCancel={() => setCanceling(event)}
                onDuplicate={() => {
                  void perform('duplicate', event)
                }}
                onEdit={(trigger) => {
                  formTrigger.current = trigger
                  void edit(event).catch(() => undefined)
                }}
                onGoLive={() => {
                  setStarting(event)
                  setTargetId('')
                }}
                onRecover={() => {
                  void recover(event)
                }}
                onSchedule={() => {
                  void perform('schedule', event)
                }}
              />
            ))}
          </ProviderSection>
        ))
      )}
    </div>
  )
  return (
    <Tabs
      className="flex flex-col gap-0"
      value={view}
      onValueChange={(next) => setView(next === 'past' ? 'past' : 'upcoming')}
    >
      <PageHeader
        action={
          <>
            {checked ? (
              <span className="text-meta text-muted-foreground" data-testid="upcoming-last-checked">
                {checked}
              </span>
            ) : null}
            <Button
              variant="ghost"
              disabled={state.busy || refreshing}
              onClick={() => {
                void refresh().catch(() => undefined)
              }}
            >
              {refreshing ? (
                <Spinner aria-hidden data-icon="inline-start" />
              ) : (
                <RefreshIcon data-icon="inline-start" />
              )}
              {refreshing ? 'Refreshing…' : 'Refresh'}
            </Button>
            <TabsList aria-label="Which streams">
              <TabsTrigger value="upcoming">Upcoming</TabsTrigger>
              <TabsTrigger value="past">Past</TabsTrigger>
            </TabsList>
          </>
        }
        description={
          history
            ? 'Streams that ended, were canceled, or drafts you moved here.'
            : 'You choose when each stream goes live. Nothing starts on its own.'
        }
        title={history ? 'Past streams' : 'Upcoming streams'}
      />
      <TabsContent value="upcoming">{history ? null : body}</TabsContent>
      <TabsContent value="past">{history ? body : null}</TabsContent>
      {editing && (
        <ScheduleStreamDialog
          key={editing.event?.id ?? `new-${editing.provider}`}
          event={editing.event}
          provider={editing.provider}
          state={state}
          onClose={() => {
            setEditing(null)
            requestAnimationFrame(() => formTrigger.current?.focus())
          }}
        />
      )}
      <ConfirmDialog
        cancelLabel={canceling?.providerEventId ? 'Keep event' : 'Keep draft'}
        confirmDisabled={state.busy}
        confirmLabel={canceling?.providerEventId ? 'Cancel event' : 'Move to Past'}
        description={
          canceling?.providerEventId
            ? `The upcoming broadcast will be deleted from ${scheduledProviderLabel(canceling.provider)} and its link will stop working.`
            : `The draft moves to Past. Nothing on ${scheduledProviderLabel(canceling?.provider ?? 'youtube')} is deleted.`
        }
        open={Boolean(canceling)}
        testId="scheduled-cancel"
        title={
          canceling?.providerEventId
            ? `Cancel this ${scheduledProviderLabel(canceling.provider)} ${scheduledProviderNoun(canceling.provider)}?`
            : 'Move draft to Past?'
        }
        onCancel={() => setCanceling(null)}
        onConfirm={() => {
          if (canceling)
            void perform('cancel', canceling).then((ok) => {
              if (ok) setCanceling(null)
            })
        }}
      />
      <Dialog
        open={Boolean(recovering)}
        onOpenChange={(open) => {
          if (!open) setRecovering(null)
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {recovering?.preparation?.phase === 'creating-stream'
                ? `Find the stream ${scheduledProviderLabel(recovering.provider ?? 'youtube')} created`
                : `Find the ${scheduledProviderNoun(recovering?.provider ?? 'youtube')} ${scheduledProviderLabel(recovering?.provider ?? 'youtube')} created`}
            </DialogTitle>
            <DialogDescription>
              {recovering?.preparation?.phase === 'creating-stream'
                ? 'YouTube may already have made the stream this event uses. Check it in YouTube Studio, then choose it. Only unused streams on this channel are listed, and your saved event keeps its link.'
                : `${scheduledProviderLabel(recovering?.provider ?? 'youtube')} may already have created it. Check on ${scheduledProviderSite(recovering?.provider ?? 'youtube')}, then choose it. Videorc doesn't create another.`}
            </DialogDescription>
          </DialogHeader>
          <Select
            disabled={candidates.length === 0}
            value={candidateId}
            onValueChange={setCandidateId}
          >
            <SelectTrigger
              aria-label={
                recovering?.preparation?.phase === 'creating-stream'
                  ? 'Ingest stream to recover'
                  : 'Event to recover'
              }
            >
              <SelectValue
                placeholder={candidates.length ? 'Choose the matching one' : 'Nothing matches yet'}
              />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                {candidates.map((candidate) => (
                  <SelectItem key={candidate.id} value={candidate.id}>
                    {candidate.snippet.title} ·{' '}
                    {candidate.candidateKind === 'ingest'
                      ? `${candidate.profile.resolution} / ${candidate.profile.frameRate}`
                      : candidate.snippet.scheduledStartTime}{' '}
                    · {candidate.id}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setRecovering(null)}>
              Close
            </Button>
            <Button
              disabled={!candidateId || state.busy}
              onClick={() => {
                if (recovering)
                  void perform('recover', recovering, {
                    candidateId,
                    candidateKind: candidates.find((candidate) => candidate.id === candidateId)
                      ?.candidateKind
                  }).then((ok) => {
                    if (ok) setRecovering(null)
                  })
              }}
            >
              Use selected candidate
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog
        open={Boolean(starting)}
        onOpenChange={(open) => {
          if (!open) setStarting(null)
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              Use this {scheduledProviderLabel(starting?.provider ?? 'youtube')}{' '}
              {scheduledProviderNoun(starting?.provider ?? 'youtube')} for Go Live
            </DialogTitle>
            <DialogDescription>
              {starting?.requested.title} · {starting?.accountLabel}. Choose its destination. When
              you&apos;re ready, click {GO_LIVE_LABEL} in Studio to check every destination and
              start.
            </DialogDescription>
          </DialogHeader>
          {startTargets.length ? (
            <Select value={targetId} onValueChange={setTargetId}>
              <SelectTrigger aria-label="Livestream destination">
                <SelectValue
                  placeholder={`Choose ${scheduledProviderLabel(starting?.provider ?? 'youtube')} destination`}
                />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  {startTargets.map((target) => (
                    <SelectItem key={target.id} value={target.id}>
                      {target.label}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
          ) : (
            // The select used to open empty and say nothing (D-32).
            <Alert data-testid="upcoming-no-destination" variant="quiet">
              <AlertTitle>
                {`No ${scheduledProviderLabel(starting?.provider ?? 'youtube')} destination signs in as ${starting?.accountLabel ?? 'this account'}`}
              </AlertTitle>
              <AlertDescription>
                In Livestream → Setup, set a destination to Sign in with this account, then come
                back.
              </AlertDescription>
              <AlertAction>
                <Button
                  size="xs"
                  variant="outline"
                  onClick={() => {
                    setStarting(null)
                    openLivestreamView('setup')
                  }}
                >
                  Open Setup
                </Button>
              </AlertAction>
            </Alert>
          )}
          <DialogFooter>
            <Button variant="ghost" onClick={() => setStarting(null)}>
              Cancel
            </Button>
            <Button
              disabled={!targetId}
              onClick={() => {
                if (starting) {
                  setCaptureConfig((current) =>
                    selectScheduledStreamForTarget(current, targetId, starting)
                  )
                  // The Livestream alert shows the chosen event (plan 174 J2-11).
                  setStarting(null)
                }
              }}
            >
              Use saved event
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Tabs>
  )
}

/**
 * One platform's streams. YouTube and X never share a list: each section has
 * the platform's own tile, availability, and Schedule action.
 */
function ProviderSection({
  section,
  history,
  onSchedule,
  children
}: {
  section: ScheduledProviderSection
  history: boolean
  onSchedule: (trigger: HTMLElement) => void
  children: ReactNode
}): ReactElement {
  const label = scheduledProviderLabel(section.provider)
  const noun = scheduledProviderNoun(section.provider)
  const headingId = `scheduled-${section.provider}`
  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-2">
      <div className="flex min-h-7 items-center gap-2">
        <PlatformGlyph platform={section.provider} />
        <h3 className="text-section font-semibold text-foreground" id={headingId}>
          {label}
        </h3>
        {section.events.length > 0 ? (
          <span className="text-xs text-muted-foreground">{section.events.length}</span>
        ) : null}
        {history ? null : (
          <Button
            className="ml-auto"
            variant="outline"
            onClick={(event) => onSchedule(event.currentTarget)}
          >
            Schedule on {label}
          </Button>
        )}
      </div>
      {!history && !section.available && section.reason ? (
        <p className="text-xs text-muted-foreground">
          {section.reason} Drafts for connected accounts stay available.
        </p>
      ) : null}
      {section.events.length > 0 ? (
        <GroupedList>{children}</GroupedList>
      ) : (
        <p className="text-xs text-muted-foreground">
          {history ? `No past ${label} ${noun}s.` : `No upcoming ${label} ${noun}s.`}
        </p>
      )}
    </section>
  )
}

function LifecycleChip({ chip }: { chip: ScheduledLifecycleChip }): ReactElement {
  if (chip.kind === 'tag') return <Badge variant="outline">{chip.label}</Badge>
  if (chip.kind === 'live') return <Badge variant="live">{chip.label}</Badge>
  return <StatusBadge tone={chip.tone} value={chip.label} />
}

/**
 * One saved stream: its picture, title and state, where and when it airs, one
 * primary action, and the rest behind ⋯.
 */
function EventRow({
  event,
  pending,
  providerAvailable,
  sessionActive,
  onGoLive,
  onSchedule,
  onRecover,
  onEdit,
  onDuplicate,
  onCancel
}: {
  event: ScheduledStreamEvent
  pending: boolean
  providerAvailable: boolean
  sessionActive: boolean
  onGoLive: () => void
  onSchedule: () => void
  onRecover: () => void
  onEdit: (trigger: HTMLElement | null) => void
  onDuplicate: () => void
  onCancel: () => void
}): ReactElement {
  const menuAnchor = useRef<HTMLDivElement>(null)
  const label = scheduledProviderLabel(event.provider)
  const noun = scheduledProviderNoun(event.provider)
  const privacy = scheduledPrivacyLabel(event)
  const editable = eventCanEdit(event)
  const needsRecovery =
    event.createUncertain ||
    Boolean(event.preparation) ||
    event.operationState === 'needs-reconciliation'
  const menu: KebabMenuItem[] = []
  if (editable) {
    menu.push(
      {
        id: 'edit',
        label: 'Edit',
        icon: EditIcon,
        disabled: pending,
        onSelect: () =>
          onEdit(menuAnchor.current?.querySelector<HTMLElement>('[aria-haspopup="menu"]') ?? null)
      },
      {
        id: 'duplicate',
        label: 'Duplicate',
        icon: CopyIcon,
        disabled: pending,
        onSelect: onDuplicate
      }
    )
  }
  if (event.watchUrl) {
    const url = event.watchUrl
    menu.push(
      {
        id: 'copy-link',
        label: 'Copy link',
        icon: LinkIcon,
        // The menu closing is the confirmation; a failed copy says so.
        onSelect: () => void copyText(url, "Couldn't copy the event link.")
      },
      {
        id: 'open',
        label: `Open on ${label}`,
        icon: ExternalLinkIcon,
        onSelect: () => {
          void window.videorc.openOAuthUrl(url)
        }
      }
    )
  }
  if (editable) {
    // A draft only moves to Past (nothing is deleted), so it says so (D-32).
    menu.push(
      event.providerEventId
        ? {
            id: 'cancel',
            label: `Cancel ${noun}`,
            icon: DeleteIcon,
            destructive: true,
            disabled: pending,
            onSelect: onCancel
          }
        : { id: 'cancel', label: 'Move to Past', disabled: pending, onSelect: onCancel }
    )
  }
  return (
    <div className="flex items-center gap-3 px-3 py-2.5" data-slot="scheduled-event">
      {event.requested.thumbnailAssetId ? (
        <img
          alt=""
          className="aspect-video w-20 shrink-0 rounded-chip object-cover"
          src={scheduledThumbnailUrl(event.requested.thumbnailAssetId)}
        />
      ) : (
        <span className="flex aspect-video w-20 shrink-0 items-center justify-center rounded-chip bg-foreground/5">
          <PlatformGlyph platform={event.provider} />
        </span>
      )}
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div className="flex min-w-0 items-center gap-2">
          <span
            className="truncate text-sm font-medium text-foreground"
            title={event.requested.title}
          >
            {event.requested.title}
          </span>
          <LifecycleChip chip={scheduledLifecycleChip(event)} />
          {privacy ? <Badge variant="outline">{privacy}</Badge> : null}
        </div>
        {/* When Videorc last checked the platform: hover detail (plan 174 S1.10). */}
        <ScheduledMetaLine
          lastSyncedAt={event.lastSyncedAt}
          text={`${event.accountLabel} · ${scheduledWhenLabel(event)}`}
        />
        {event.error ? (
          <Alert variant="destructive">
            <AlertDescription>
              {event.thumbnailState === 'error' ? 'Event created; thumbnail upload failed. ' : ''}
              {event.error.message}
            </AlertDescription>
          </Alert>
        ) : null}
        {event.operationState === 'pending' ? (
          <p className="text-xs text-muted-foreground" role="status">
            Updating {noun}…
          </p>
        ) : null}
      </div>
      <div className="flex shrink-0 items-center gap-1" ref={menuAnchor}>
        {event.thumbnailState === 'error' ? (
          <Button disabled={pending} variant="ghost" onClick={onSchedule}>
            Retry thumbnail
          </Button>
        ) : null}
        {needsRecovery ? (
          <Button disabled={pending} variant="outline" onClick={onRecover}>
            Recover
          </Button>
        ) : event.lifecycle === 'scheduled' ? (
          // The session lock covers Upcoming too (D-13), and says so.
          <DisabledReason reason={sessionActive ? SESSION_LOCK_REASON : null}>
            <Button
              disabled={sessionActive || pending || Boolean(event.preparation)}
              variant="secondary"
              onClick={onGoLive}
            >
              {USE_FOR_GO_LIVE_LABEL}
            </Button>
          </DisabledReason>
        ) : event.lifecycle === 'draft' ? (
          <Button
            aria-label={`Schedule this draft on ${label}`}
            disabled={!providerAvailable || pending}
            variant="outline"
            onClick={onSchedule}
          >
            Schedule
          </Button>
        ) : null}
        {menu.length > 0 ? (
          <KebabMenu items={menu} label={`More actions for ${event.requested.title}`} />
        ) : null}
      </div>
    </div>
  )
}

/** The account and the time, with the last platform check on hover. */
function ScheduledMetaLine({
  text,
  lastSyncedAt
}: {
  text: string
  lastSyncedAt?: string | null
}): ReactElement {
  const line = <span className="truncate text-xs text-muted-foreground">{text}</span>
  if (!lastSyncedAt) return line
  return (
    <Tooltip>
      <TooltipTrigger asChild>{line}</TooltipTrigger>
      <TooltipContent align="start">
        Last checked {new Date(lastSyncedAt).toLocaleString()}
      </TooltipContent>
    </Tooltip>
  )
}
