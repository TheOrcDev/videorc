import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react'
import { BackendClient } from '@/backendClient'
import { useStudioCore } from '@/hooks/use-studio'
import { SessionPlayer, type SessionPlayerHandle } from '@/components/media/session-player'
import { MarkerPins } from '@/components/media/marker-pins'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { ScrollArea } from '@/components/ui/scroll-area'
import { DeleteIcon, EditIcon } from '@/components/icons'
import type { SessionMarker, SessionSummary } from '@/lib/backend'
import { markerLabel, markerTime } from '../../../shared/session-markers'

export function SessionMarkersDialog({
  session,
  onClose
}: {
  session: SessionSummary
  onClose: () => void
}): ReactElement {
  const { connection, wsStatus } = useStudioCore()
  const [client, setClient] = useState<BackendClient | null>(null)
  const [markers, setMarkers] = useState<SessionMarker[]>([])
  const [cursor, setCursor] = useState<string | undefined>()
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [pending, setPending] = useState(false)
  const [attempt, setAttempt] = useState(0)
  const [editing, setEditing] = useState<SessionMarker | null>(null)
  const [draft, setDraft] = useState('')
  const [selected, setSelected] = useState<string | null>(null)
  const player = useRef<SessionPlayerHandle>(null)
  const requestGeneration = useRef(0)
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
        setMarkers((previous) => (after ? [...previous, ...page.markers] : page.markers))
        setCursor(page.nextCursor)
        setError(null)
      } catch (error) {
        if (generation === requestGeneration.current)
          setError(error instanceof Error ? error.message : 'Could not read markers.')
      } finally {
        if (generation === requestGeneration.current) setLoading(false)
      }
    },
    [session.id]
  )
  useEffect(() => {
    const requests = requestGeneration
    if (!connection || wsStatus !== 'connected') {
      setError('Reconnect Videorc to read markers.')
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
          setError('Could not connect. Try again.')
          setLoading(false)
        }
      })
    return () => {
      disposed = true
      ++requests.current
      offCreated()
      offChanged()
      next.close()
      setClient(null)
    }
  }, [connection, wsStatus, session.id, attempt, load])
  const select = (marker: SessionMarker): void => {
    setSelected(marker.id)
    player.current?.seekTo(marker.atSeconds * 1000)
  }
  const mutate = async (action: 'rename' | 'delete', marker: SessionMarker): Promise<void> => {
    if (!client || pending) return
    setPending(true)
    try {
      if (action === 'rename')
        await client.requestTyped('session.marker.rename', {
          sessionId: session.id,
          markerId: marker.id,
          label: markerLabel(draft)
        })
      else
        await client.requestTyped('session.marker.delete', {
          sessionId: session.id,
          markerId: marker.id
        })
      setEditing(null)
      await load(client)
    } catch (error) {
      setError(error instanceof Error ? error.message : 'Could not update marker.')
    } finally {
      setPending(false)
    }
  }
  const durationMs = session.durationMs
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
    >
      <DialogContent className="max-h-[90vh] sm:max-w-3xl" data-testid="session-markers-dialog">
        <DialogHeader>
          <DialogTitle>Markers · {session.title || 'Untitled session'}</DialogTitle>
          <DialogDescription>
            Points on the original capture timeline. Select a marker to jump to its start.
          </DialogDescription>
        </DialogHeader>
        {canPlay ? (
          <SessionPlayer sessionId={session.id} handleRef={player} markers={markers} />
        ) : (
          <>
            <p className="text-xs text-muted-foreground">
              {session.status === 'running'
                ? 'Capture is still running. Playback becomes available after the recording finishes.'
                : 'This session has no local video. Marker times are still saved.'}
            </p>
            {durationMs !== undefined && durationMs > 0 ? (
              <MarkerPins markers={markers} durationMs={durationMs} onSelect={select} />
            ) : null}
          </>
        )}
        {error ? (
          <div role="alert" className="flex items-center gap-2 text-xs text-destructive">
            {error}
            <Button size="sm" variant="ghost" onClick={() => setAttempt((value) => value + 1)}>
              Try again
            </Button>
          </div>
        ) : null}
        <ScrollArea className="max-h-64">
          <div className="space-y-1" aria-label="Saved markers">
            {markers.map((marker) => (
              <div
                key={marker.id}
                className="flex items-center gap-2 rounded-row px-2 py-1 hover:bg-muted/50"
                data-selected={selected === marker.id}
              >
                <Button
                  variant="ghost"
                  className="min-w-0 flex-1 justify-start gap-3"
                  onClick={() => select(marker)}
                >
                  <span className="font-mono text-xs tabular-nums">
                    {markerTime(marker.atSeconds)}
                  </span>
                  <span className="truncate">{marker.label ?? 'Untitled marker'}</span>
                </Button>
                <span className="text-xs text-muted-foreground">{marker.source}</span>
                <Button
                  size="icon-sm"
                  variant="ghost"
                  aria-label={`Rename ${marker.label ?? 'marker'}`}
                  disabled={pending}
                  onClick={() => {
                    setEditing(marker)
                    setDraft(marker.label ?? '')
                  }}
                >
                  <EditIcon />
                </Button>
                <Button
                  size="icon-sm"
                  variant="ghost"
                  aria-label={`Delete ${marker.label ?? 'marker'}`}
                  disabled={pending}
                  onClick={() => void mutate('delete', marker)}
                >
                  <DeleteIcon />
                </Button>
              </div>
            ))}
            {!markers.length && !loading && !error ? (
              <p className="py-5 text-center text-xs text-muted-foreground">
                No markers yet. During capture, type /marker [title] in Stream Manager or say
                “Golem, make a marker here for [title]”.
              </p>
            ) : null}
          </div>
        </ScrollArea>
        {editing ? (
          <form
            className="flex gap-2"
            onSubmit={(event) => {
              event.preventDefault()
              void mutate('rename', editing)
            }}
          >
            <Input
              aria-label="Marker title"
              autoFocus
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
            />
            <Button type="submit" size="sm" disabled={pending}>
              Save ↵
            </Button>
            <Button type="button" size="sm" variant="ghost" onClick={() => setEditing(null)}>
              Cancel
            </Button>
          </form>
        ) : null}
        {loading ? (
          <p role="status" className="text-xs text-muted-foreground">
            Loading markers…
          </p>
        ) : cursor && client ? (
          <Button variant="ghost" size="sm" onClick={() => void load(client, cursor)}>
            Load more markers
          </Button>
        ) : null}
      </DialogContent>
    </Dialog>
  )
}
