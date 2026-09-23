import { useRef, useState, type ReactElement, type ReactNode } from 'react'
import { toast } from 'sonner'
import { CopyIcon, DeleteIcon, EditIcon, ExternalLinkIcon, LinkIcon } from '@/components/icons'
import { useScheduledStreams } from '@/hooks/use-scheduled-streams'
import { useStudioCore } from '@/hooks/use-studio'
import { ScheduleStreamDialog } from '@/components/schedule-stream-dialog'
import { KebabMenu, type KebabMenuItem } from '@/components/kebab-menu'
import { PageHeader } from '@/components/page'
import { PlatformGlyph } from '@/components/platform-glyph'
import { StatusBadge } from '@/components/status-badge'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Alert, AlertDescription } from '@/components/ui/alert'
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
  const [history, setHistory] = useState(false)
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
    await state.reload(true)
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
      toast.error(error instanceof Error ? error.message : String(error))
    }
  }
  const sections = scheduledProviderSections(state.events, state.capabilities, history)
  return (
    <div className="flex flex-col">
      <PageHeader
        action={
          <>
            <Button
              size="sm"
              variant="ghost"
              disabled={state.busy}
              onClick={() => {
                void refresh().catch(() => undefined)
              }}
            >
              Refresh
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setHistory(!history)}>
              {history ? 'Upcoming' : 'History'}
            </Button>
          </>
        }
        description={
          history
            ? 'Streams that ended or were canceled.'
            : 'You choose when each stream goes live. Nothing starts on its own.'
        }
        title={history ? 'Past streams' : 'Upcoming streams'}
      />
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
      <Dialog
        open={Boolean(canceling)}
        onOpenChange={(open) => {
          if (!open) setCanceling(null)
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {canceling?.providerEventId
                ? `Cancel this ${scheduledProviderLabel(canceling.provider)} ${scheduledProviderNoun(canceling.provider)}?`
                : 'Delete local draft?'}
            </DialogTitle>
            <DialogDescription>
              {canceling?.providerEventId
                ? `The upcoming broadcast will be deleted from ${scheduledProviderLabel(canceling.provider)} and its link will stop working.`
                : 'This draft moves to history. No platform event is deleted.'}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setCanceling(null)}>
              Keep event
            </Button>
            <Button
              variant="destructive"
              disabled={state.busy}
              onClick={() => {
                if (canceling)
                  void perform('cancel', canceling).then((ok) => {
                    if (ok) setCanceling(null)
                  })
              }}
            >
              Confirm cancellation
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
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
                ? 'Recover an unknown ingest stream'
                : 'Recover an unknown create'}
            </DialogTitle>
            <DialogDescription>
              {recovering?.preparation?.phase === 'creating-stream'
                ? 'Choose the exact inactive encoder stream after checking it in YouTube Studio. Only compatible streams owned by this channel are listed. Your saved event keeps its link.'
                : `${scheduledProviderLabel(recovering?.provider ?? 'youtube')} may already have created the event. Choose the exact owned upcoming event after checking it on ${scheduledProviderSite(recovering?.provider ?? 'youtube')}. No new event will be created.`}
            </DialogDescription>
          </DialogHeader>
          <Select value={candidateId} onValueChange={setCandidateId}>
            <SelectTrigger
              aria-label={
                recovering?.preparation?.phase === 'creating-stream'
                  ? 'Ingest stream to recover'
                  : 'Event to recover'
              }
            >
              <SelectValue placeholder="Select matching candidate" />
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
              Go live with this {scheduledProviderLabel(starting?.provider ?? 'youtube')}{' '}
              {scheduledProviderNoun(starting?.provider ?? 'youtube')}
            </DialogTitle>
            <DialogDescription>
              {starting?.requested.title} · {starting?.accountLabel}. Choose its destination, then
              click Go Live in Studio to review every enabled destination and start manually.
            </DialogDescription>
          </DialogHeader>
          <Select value={targetId} onValueChange={setTargetId}>
            <SelectTrigger aria-label="Livestream destination">
              <SelectValue
                placeholder={`Choose ${scheduledProviderLabel(starting?.provider ?? 'youtube')} destination`}
              />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                {captureConfig.streaming.targets
                  .filter(
                    (target) =>
                      target.platform === (starting?.provider ?? 'youtube') &&
                      target.authMode === 'oauth' &&
                      target.accountId === starting?.accountId
                  )
                  .map((target) => (
                    <SelectItem key={target.id} value={target.id}>
                      {target.label}
                    </SelectItem>
                  ))}
              </SelectGroup>
            </SelectContent>
          </Select>
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
                  setStarting(null)
                  toast.success('Saved event selected. Click Go Live in Studio when ready.')
                }
              }}
            >
              Use saved event
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
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
        <h3 className="text-[13px] font-semibold text-foreground" id={headingId}>
          {label}
        </h3>
        {section.events.length > 0 ? (
          <span className="text-xs text-muted-foreground">{section.events.length}</span>
        ) : null}
        {history ? null : (
          <Button
            className="ml-auto"
            size="sm"
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
        <p className="text-xs text-subtle">
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
        onSelect: () => {
          void navigator.clipboard.writeText(url).then(() => toast.success('Event link copied.'))
        }
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
    menu.push({
      id: 'cancel',
      label: event.providerEventId ? `Cancel ${noun}` : 'Delete draft',
      icon: DeleteIcon,
      destructive: true,
      disabled: pending,
      onSelect: onCancel
    })
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
        <span
          className="truncate text-xs text-muted-foreground"
          title={
            event.lastSyncedAt
              ? `Last checked ${new Date(event.lastSyncedAt).toLocaleString()}`
              : undefined
          }
        >
          {event.accountLabel} · {scheduledWhenLabel(event)}
        </span>
        {event.error ? (
          <Alert>
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
          <Button disabled={pending} size="sm" variant="ghost" onClick={onSchedule}>
            Retry thumbnail
          </Button>
        ) : null}
        {needsRecovery ? (
          <Button disabled={pending} size="sm" variant="outline" onClick={onRecover}>
            Recover
          </Button>
        ) : event.lifecycle === 'scheduled' ? (
          <Button
            disabled={sessionActive || pending || Boolean(event.preparation)}
            size="sm"
            variant="secondary"
            onClick={onGoLive}
          >
            Go Live…
          </Button>
        ) : event.lifecycle === 'draft' ? (
          <Button
            aria-label={`Schedule this draft on ${label}`}
            disabled={!providerAvailable || pending}
            size="sm"
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
