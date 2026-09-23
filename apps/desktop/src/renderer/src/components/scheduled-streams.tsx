import { useRef, useState, type ReactElement } from 'react'
import { toast } from 'sonner'
import { useScheduledStreams } from '@/hooks/use-scheduled-streams'
import { useStudioCore } from '@/hooks/use-studio'
import { ScheduleStreamDialog } from '@/components/schedule-stream-dialog'
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
import { Skeleton } from '@/components/ui/skeleton'
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '@/components/ui/empty'
import {
  eventCanEdit,
  scheduledProviderLabel,
  scheduledProviderSite,
  selectScheduledStreamForTarget
} from '@/lib/scheduled-streams'
import type { ScheduledStreamEvent, ScheduledStreamCandidate } from '@/lib/backend'

type Candidate = ScheduledStreamCandidate

export function ScheduledStreams(): ReactElement {
  const state = useScheduledStreams()
  const { captureConfig, setCaptureConfig, isSessionActive } = useStudioCore()
  const formTrigger = useRef<HTMLElement | null>(null)
  const [editing, setEditing] = useState<ScheduledStreamEvent | null | undefined>(undefined)
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
    setEditing(await state.request<ScheduledStreamEvent>('get', { eventId: event.id }))
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
  const visible = state.events.filter(
    (event) => history === ['completed', 'canceled'].includes(event.lifecycle)
  )
  const providerAvailable = (provider: ScheduledStreamEvent['provider']) =>
    state.capabilities?.providers?.find((item) => item.provider === provider)?.available ??
    state.capabilities?.available ??
    false
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex gap-2">
          <Button
            variant="ghost"
            disabled={state.busy}
            onClick={() => {
              void refresh().catch(() => undefined)
            }}
          >
            Refresh
          </Button>
          <Button variant="ghost" onClick={() => setHistory(!history)}>
            {history ? 'Upcoming' : 'History'}
          </Button>
        </div>
        <Button
          variant="outline"
          onClick={(event) => {
            formTrigger.current = event.currentTarget
            setEditing(null)
          }}
        >
          Schedule stream
        </Button>
      </div>
      {state.error && (
        <Alert variant="destructive">
          <AlertDescription>{state.error}</AlertDescription>
        </Alert>
      )}
      {state.capabilities?.reason && (
        <Alert>
          <AlertDescription>
            {state.capabilities.reason} Local drafts remain available for connected channels.
          </AlertDescription>
        </Alert>
      )}
      {state.loading ? (
        <Skeleton className="h-20 w-full" />
      ) : visible.length === 0 ? (
        <Empty>
          <EmptyHeader>
            <EmptyTitle>{history ? 'No past events' : 'No upcoming streams'}</EmptyTitle>
            <EmptyDescription>
              Schedule a YouTube or X broadcast and keep its link. You choose when to go live.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        visible.map((event) => (
          <div key={event.id} className="flex flex-col gap-2 rounded-lg border p-3">
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              {event.requested.thumbnailAssetId && (
                <img
                  src={`videorc-asset://scheduled-thumbnail/${event.requested.thumbnailAssetId}`}
                  alt="Stream thumbnail"
                  className="aspect-video h-12 rounded-md object-cover"
                />
              )}
              <span className="min-w-0 flex-1 truncate font-medium" title={event.requested.title}>
                {event.requested.title}
              </span>
              <Badge variant="secondary">{event.lifecycle}</Badge>
              {event.provider !== 'x' && <Badge variant="outline">{event.requested.privacy}</Badge>}
            </div>
            <p className="text-sm text-muted-foreground">
              {scheduledProviderLabel(event.provider)} · {event.accountLabel} ·{' '}
              {new Date(event.startUtc).toLocaleString(undefined, {
                timeZone: event.requested.timeZone
              })}{' '}
              · {event.requested.timeZone}
            </p>
            {event.lastSyncedAt && (
              <p className="text-xs text-muted-foreground">
                Last checked {new Date(event.lastSyncedAt).toLocaleString()}
              </p>
            )}
            {event.error && (
              <Alert>
                <AlertDescription>
                  {event.thumbnailState === 'error'
                    ? 'Event created; thumbnail upload failed. '
                    : ''}
                  {event.error.message}
                </AlertDescription>
              </Alert>
            )}
            {event.operationState === 'pending' && <p role="status">Updating event…</p>}
            <div className="flex flex-wrap gap-1">
              {event.lifecycle === 'scheduled' && (
                <Button
                  size="sm"
                  disabled={
                    isSessionActive ||
                    state.pendingIds.includes(event.id) ||
                    Boolean(event.preparation)
                  }
                  onClick={() => {
                    setStarting(event)
                    setTargetId('')
                  }}
                >
                  Go Live…
                </Button>
              )}
              {eventCanEdit(event) && (
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={state.pendingIds.includes(event.id)}
                  onClick={(click) => {
                    formTrigger.current = click.currentTarget
                    void edit(event).catch(() => undefined)
                  }}
                >
                  Edit
                </Button>
              )}
              {event.lifecycle === 'draft' && !event.createUncertain && (
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={
                    !providerAvailable(event.provider) || state.pendingIds.includes(event.id)
                  }
                  onClick={() => {
                    void perform('schedule', event)
                  }}
                >
                  Schedule on {scheduledProviderLabel(event.provider)}
                </Button>
              )}
              {event.thumbnailState === 'error' && (
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={state.pendingIds.includes(event.id)}
                  onClick={() => {
                    void perform('schedule', event)
                  }}
                >
                  Retry thumbnail
                </Button>
              )}
              {event.watchUrl && (
                <>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                      void navigator.clipboard
                        .writeText(event.watchUrl!)
                        .then(() => toast.success('Event link copied.'))
                    }}
                  >
                    Copy link
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                      void window.videorc.openOAuthUrl(event.watchUrl!)
                    }}
                  >
                    Open on {scheduledProviderLabel(event.provider)}
                  </Button>
                </>
              )}
              {eventCanEdit(event) && (
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={state.pendingIds.includes(event.id)}
                  onClick={() => {
                    void perform('duplicate', event)
                  }}
                >
                  Duplicate
                </Button>
              )}
              {(event.createUncertain ||
                event.preparation ||
                event.operationState === 'needs-reconciliation') && (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={state.pendingIds.includes(event.id)}
                  onClick={() => {
                    void recover(event)
                  }}
                >
                  Recover
                </Button>
              )}
              {eventCanEdit(event) && (
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={state.pendingIds.includes(event.id)}
                  onClick={() => setCanceling(event)}
                >
                  {event.providerEventId
                    ? event.provider === 'x'
                      ? 'Cancel broadcast'
                      : 'Cancel event'
                    : 'Delete draft'}
                </Button>
              )}
            </div>
          </div>
        ))
      )}
      {editing !== undefined && (
        <ScheduleStreamDialog
          key={editing?.id ?? 'new'}
          event={editing}
          state={state}
          onClose={() => {
            setEditing(undefined)
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
                ? `Cancel this ${scheduledProviderLabel(canceling.provider)} ${canceling.provider === 'x' ? 'broadcast' : 'event'}?`
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
            <DialogTitle>Use saved event for Go Live</DialogTitle>
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
