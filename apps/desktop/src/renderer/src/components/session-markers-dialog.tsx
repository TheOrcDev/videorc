import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react'
import { BackendClient } from '@/backendClient'
import { useStudioCore } from '@/hooks/use-studio'
import { SessionPlayer, type SessionPlayerHandle } from '@/components/media/session-player'
import { MarkerPins } from '@/components/media/marker-pins'
import { GroupedList, ListRow, ListRowButton } from '@/components/list-row'
import { OfflineAlert } from '@/components/lock-alert'
import { Alert, AlertAction, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '@/components/ui/empty'
import { Input } from '@/components/ui/input'
import { ShortcutKeys } from '@/components/ui/shortcut-keys'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { DeleteIcon, EditIcon } from '@/components/icons'
import type { SessionMarker, SessionSummary } from '@/lib/backend'
import { libraryTitle } from '@/lib/library-view'
import { markerSourceLabel } from '@/lib/session-player-view'
import { toast } from '@/lib/toast'
import { holdUndoableAction, type UndoableAction } from '@/lib/undoable-action'
import { MARKER_LABEL_MAX_CHARS, markerLabel, markerTime } from '../../../shared/session-markers'

/** How long the Undo toast for a deleted marker shows (plan 174 S0.3, E-8). */
export const MARKER_DELETE_UNDO_MS = 5000

export function markerDeleteToastId(markerId: string): string {
  return `marker-delete-${markerId}`
}

/** A failed step, in words, and the step again (plan 174 S3.12, E-9). */
type MarkerFailure = { title: string; detail: string; retry: () => void }

/** The unknown-cause line (docs/ui-copy.md, "Errors"). */
export const MARKER_FAILURE_FALLBACK =
  'Try again. If it keeps happening, export a support bundle from Health.'

/** Refusals whose message is already Videorc's own words about the marker. */
const MARKER_REFUSAL_CODES: ReadonlySet<string> = new Set(['marker-not-found', 'marker-deleted'])

/**
 * Why a marker step failed, in words fit for the line under the list: the
 * backend's own marker refusals ("That marker is no longer available."), and
 * the unknown-cause line for anything else, whose raw text goes to the
 * console (plan 174 S3.12, E-9).
 */
export function markerFailureDetail(error: unknown): string {
  const code =
    typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined
  if (typeof code === 'string' && MARKER_REFUSAL_CODES.has(code) && error instanceof Error) {
    return error.message
  }
  console.warn('[markers] a marker step failed:', error)
  return MARKER_FAILURE_FALLBACK
}

function markerName(marker: SessionMarker): string {
  return marker.label ?? 'Untitled marker'
}

export function SessionMarkersDialog({
  session: snapshot,
  onClose
}: {
  session: SessionSummary
  onClose: () => void
}): ReactElement {
  const { connection, wsStatus, sessions } = useStudioCore()
  // The live row (E-11): whether the recording plays follows it while the
  // dialog is open; the snapshot covers a row that left the loaded pages.
  const session = sessions?.find((entry) => entry.id === snapshot.id) ?? snapshot
  const [client, setClient] = useState<BackendClient | null>(null)
  const [markers, setMarkers] = useState<SessionMarker[]>([])
  const [cursor, setCursor] = useState<string | undefined>()
  const [failure, setFailure] = useState<MarkerFailure | null>(null)
  const [loading, setLoading] = useState(true)
  const [pending, setPending] = useState(false)
  const [attempt, setAttempt] = useState(0)
  const [editing, setEditing] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [selected, setSelected] = useState<string | null>(null)
  const player = useRef<SessionPlayerHandle>(null)
  const requestGeneration = useRef(0)
  // Deletes waiting for their Undo toast to close, by marker id.
  const pendingDeletes = useRef(new Map<string, UndoableAction>())
  const offline = !connection || wsStatus !== 'connected'
  const canPlay = Boolean(session.mp4Path || session.outputPath) && session.status !== 'running'
  const load = useCallback(
    async (next: BackendClient, after?: string): Promise<void> => {
      const generation = ++requestGeneration.current
      setLoading(true)
      try {
        const page = await next.requestTyped('session.markers.list', {
          sessionId: session.id,
          ...(after ? { cursor: after } : {})
        })
        if (generation !== requestGeneration.current) return
        // A marker waiting out its Undo window stays hidden across a refresh.
        const fresh = page.markers.filter((entry) => !pendingDeletes.current.has(entry.id))
        setMarkers((previous) => (after ? [...previous, ...fresh] : fresh))
        setCursor(page.nextCursor)
        setFailure(null)
      } catch (error) {
        if (generation === requestGeneration.current)
          setFailure({
            title: "Couldn't load the markers",
            detail: markerFailureDetail(error),
            retry: () => void load(next, after)
          })
      } finally {
        if (generation === requestGeneration.current) setLoading(false)
      }
    },
    [session.id]
  )
  useEffect(() => {
    const requests = requestGeneration
    const deletes = pendingDeletes
    if (!connection || wsStatus !== 'connected') {
      setLoading(false)
      return
    }
    const next = new BackendClient(connection)
    let disposed = false
    const refresh = (value: { sessionId: string }): void => {
      if (!disposed && value.sessionId === session.id) void load(next)
    }
    const offCreated = next.on('session.marker.created', refresh)
    const offChanged = next.on('session.marker.changed', refresh)
    void next
      .connect()
      .then(() => {
        if (!disposed) {
          setClient(next)
          void load(next)
        }
      })
      .catch(() => {
        if (!disposed) {
          setFailure({
            title: "Couldn't load the markers",
            detail: "Videorc didn't answer. Try again in a moment.",
            retry: () => setAttempt((value) => value + 1)
          })
          setLoading(false)
        }
      })
    return () => {
      disposed = true
      ++requests.current
      offCreated()
      offChanged()
      // The client goes away with the dialog: a delete still waiting for its
      // Undo runs now, and its Undo toast goes with it.
      for (const [markerId, action] of deletes.current) {
        action.flush()
        toast.dismiss(markerDeleteToastId(markerId))
      }
      deletes.current.clear()
      next.close()
      setClient(null)
    }
  }, [connection, wsStatus, session.id, attempt, load])
  const select = (marker: SessionMarker): void => {
    setSelected(marker.id)
    player.current?.seekTo(marker.atSeconds * 1000)
  }
  const startRename = (marker: SessionMarker): void => {
    setEditing(marker.id)
    setDraft(marker.label ?? '')
  }
  const rename = async (marker: SessionMarker, value: string): Promise<void> => {
    if (!client || pending) return
    setPending(true)
    try {
      await client.requestTyped('session.marker.rename', {
        sessionId: session.id,
        markerId: marker.id,
        label: markerLabel(value)
      })
      setEditing(null)
      setFailure(null)
      await load(client)
    } catch (error) {
      setFailure({
        title: "Couldn't rename the marker",
        detail: markerFailureDetail(error),
        retry: () => void rename(marker, value)
      })
    } finally {
      setPending(false)
    }
  }
  const deleteNow = (backend: BackendClient, marker: SessionMarker): void => {
    void backend
      .requestTyped('session.marker.delete', { sessionId: session.id, markerId: marker.id })
      .then(() => {
        setFailure(null)
        // A retried delete removes the row the failed one put back.
        setMarkers((previous) => previous.filter((entry) => entry.id !== marker.id))
      })
      .catch((error: unknown) => {
        const failed: MarkerFailure = {
          title: "Couldn't delete the marker",
          detail: markerFailureDetail(error),
          retry: () => deleteNow(backend, marker)
        }
        // The reload puts the row back; the failure shows after it, so a
        // clean reload can't wipe it.
        void load(backend).finally(() => setFailure(failed))
      })
  }
  // A marker cannot be made again, so a delete hides it now and runs when its
  // Undo toast closes (plan 174 S0.3, E-8). The toast's own lifecycle drives
  // it, never a clock beside the toast: Sonner pauses the toast while the
  // pointer rests on it or the window is hidden, and Undo must never be on
  // screen for a delete that already ran (S3.12, the Phase 0 review's P1).
  const remove = (marker: SessionMarker): void => {
    if (!client || pendingDeletes.current.has(marker.id)) return
    const backend = client
    const toastId = markerDeleteToastId(marker.id)
    setMarkers((previous) => previous.filter((entry) => entry.id !== marker.id))
    if (editing === marker.id) setEditing(null)
    const action = holdUndoableAction(() => {
      pendingDeletes.current.delete(marker.id)
      deleteNow(backend, marker)
    })
    pendingDeletes.current.set(marker.id, action)
    toast.message(`Marker deleted · ${markerName(marker)}`, {
      id: toastId,
      description: markerTime(marker.atSeconds),
      duration: MARKER_DELETE_UNDO_MS,
      onAutoClose: () => action.flush(),
      onDismiss: () => action.flush(),
      action: {
        label: 'Undo',
        onClick: () => {
          action.undo()
          pendingDeletes.current.delete(marker.id)
          toast.dismiss(toastId)
          void load(backend)
        }
      }
    })
  }
  const durationMs = session.durationMs
  const title = libraryTitle(session)
  return (
    <Dialog
      open
      onOpenChange={(open, { reason }) => {
        if (open) return
        // Escape leaves a rename first, then the dialog.
        if (reason === 'escape-key' && editing !== null) {
          setEditing(null)
          return
        }
        onClose()
      }}
    >
      <DialogContent data-testid="session-markers-dialog" size="xl">
        <DialogHeader>
          <DialogTitle>Markers · {title}</DialogTitle>
          <DialogDescription>
            Points on the recording&apos;s timeline. Choose one to jump to it.
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="flex flex-col gap-4">
          {canPlay ? (
            <SessionPlayer sessionId={session.id} handleRef={player} markers={markers} />
          ) : (
            <>
              <p className="text-meta text-muted-foreground">
                {session.status === 'running'
                  ? 'Still recording. Playback opens when the recording ends.'
                  : 'This recording has no video file. Its marker times are still saved.'}
              </p>
              {durationMs !== undefined && durationMs > 0 ? (
                <MarkerPins markers={markers} durationMs={durationMs} onSelect={select} />
              ) : null}
            </>
          )}
          {offline ? <OfflineAlert /> : null}
          {failure ? (
            <Alert variant="destructive">
              <AlertTitle>{failure.title}</AlertTitle>
              <AlertDescription>{failure.detail}</AlertDescription>
              <AlertAction>
                <Button size="xs" type="button" variant="outline" onClick={failure.retry}>
                  Retry
                </Button>
              </AlertAction>
            </Alert>
          ) : null}
          {markers.length > 0 ? (
            <GroupedList aria-label="Saved markers">
              {markers.map((marker) =>
                editing === marker.id ? (
                  <form
                    key={marker.id}
                    className="flex h-row items-center gap-2 px-3"
                    onSubmit={(event) => {
                      event.preventDefault()
                      void rename(marker, draft)
                    }}
                  >
                    <span className="text-meta text-muted-foreground tabular-nums">
                      {markerTime(marker.atSeconds)}
                    </span>
                    <Input
                      aria-label="Marker title"
                      autoFocus
                      className="flex-1"
                      maxLength={MARKER_LABEL_MAX_CHARS}
                      value={draft}
                      onChange={(event) => setDraft(event.target.value)}
                    />
                    <Button disabled={pending} type="submit">
                      Save
                      <ShortcutKeys accelerator="Enter" />
                    </Button>
                    <Button type="button" variant="ghost" onClick={() => setEditing(null)}>
                      Cancel
                    </Button>
                  </form>
                ) : (
                  <ListRow
                    key={marker.id}
                    compact
                    interactive
                    className="relative"
                    context={markerSourceLabel(marker.source)}
                    selected={selected === marker.id}
                    title={
                      <ListRowButton
                        aria-current={selected === marker.id ? 'true' : undefined}
                        onClick={() => select(marker)}
                      >
                        <span className="mr-2 text-meta text-muted-foreground tabular-nums">
                          {markerTime(marker.atSeconds)}
                        </span>
                        {markerName(marker)}
                      </ListRowButton>
                    }
                  >
                    <Tooltip>
                      <TooltipTrigger
                        render={
                          <Button
                            aria-label={`Rename ${marker.label ?? 'marker'}`}
                            className="relative"
                            disabled={pending || !client}
                            size="icon-xs"
                            variant="ghost"
                            onClick={() => startRename(marker)}
                          />
                        }
                      >
                        <EditIcon />
                      </TooltipTrigger>
                      <TooltipContent>Rename…</TooltipContent>
                    </Tooltip>
                    <Tooltip>
                      <TooltipTrigger
                        render={
                          <Button
                            aria-label={`Delete ${marker.label ?? 'marker'}`}
                            className="relative"
                            disabled={pending || !client}
                            size="icon-xs"
                            variant="ghost"
                            onClick={() => remove(marker)}
                          />
                        }
                      >
                        <DeleteIcon />
                      </TooltipTrigger>
                      <TooltipContent>Delete</TooltipContent>
                    </Tooltip>
                  </ListRow>
                )
              )}
            </GroupedList>
          ) : loading ? (
            <p role="status" className="text-meta text-muted-foreground">
              Loading markers…
            </p>
          ) : !failure && !offline ? (
            <Empty className="py-6">
              <EmptyHeader>
                <EmptyTitle>No markers yet</EmptyTitle>
                <EmptyDescription>
                  While you record, type /marker and a title in Stream Manager, or say “Buddy, make
                  a marker here for” and the title.
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : null}
          {cursor && client ? (
            <Button
              className="self-start"
              disabled={loading}
              variant="ghost"
              onClick={() => void load(client, cursor)}
            >
              {loading ? 'Loading…' : 'Load more markers'}
            </Button>
          ) : null}
        </DialogBody>
      </DialogContent>
    </Dialog>
  )
}
