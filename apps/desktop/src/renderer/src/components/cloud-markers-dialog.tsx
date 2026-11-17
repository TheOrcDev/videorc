import { useCallback, useEffect, useState, type ReactElement } from 'react'
import { useStudioDiagnostics } from '@/hooks/use-studio'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { GroupedList, ListRow } from '@/components/list-row'
import { markerTime } from '../../../shared/session-markers'
import type { CloudClipsStatus } from '../../../shared/cloud-clips'
import type { CloudMarker } from '../../../shared/cloud-markers'
/** Show marks are shared metadata; this view never creates a Library session or an extraction range. */
export function CloudMarkersButton({
  showId,
  disabled = false
}: {
  showId: string
  disabled?: boolean
}): ReactElement {
  const [open, setOpen] = useState(false)
  return (
    <>
      <Button size="xs" variant="outline" disabled={disabled} onClick={() => setOpen(true)}>
        Show markers
      </Button>
      {open && <CloudMarkersDialog key={showId} showId={showId} onClose={() => setOpen(false)} />}
    </>
  )
}
function CloudMarkersDialog({
  showId,
  onClose
}: {
  showId: string
  onClose: () => void
}): ReactElement {
  const { client } = useStudioDiagnostics()
  const [clips, setClips] = useState<CloudClipsStatus | null>(null)
  const [marks, setMarks] = useState<CloudMarker[] | null>(null),
    [failure, setFailure] = useState<string | null>(null),
    [refresh, setRefresh] = useState(0),
    [pending, setPending] = useState(false)
  useEffect(() => {
    let active = true
    setFailure(null)
    if (!client) {
      setFailure('Reconnect to load show markers.')
      return
    }
    void client
      .requestTyped('cloud.clips.status', { showId })
      .then((value) => {
        if (active) setClips(value)
      })
      .catch(() => {
        if (active) setClips(null)
      })
    void client
      .requestTyped('cloud.markers.list', { showId })
      .then((page) => {
        if (active) setMarks(page.markers)
      })
      .catch(() => {
        if (active)
          setFailure(
            'Could not load show markers. The show may have expired. Try again after reconnecting.'
          )
      })
    const off = client.on('cloud.marker.created', (m) => {
      if (m.showId === showId) setRefresh((v) => v + 1)
    })
    return () => {
      active = false
      off()
    }
  }, [client, showId, refresh])
  const remove = useCallback(
    async (marker: CloudMarker) => {
      if (!client) return
      setPending(true)
      try {
        await client.requestTyped('cloud.marker.delete', { showId, markerId: marker.id })
        setRefresh((v) => v + 1)
      } catch {
        setFailure('Could not remove the marker. Try again.')
      } finally {
        setPending(false)
      }
    },
    [client, showId]
  )
  return (
    <Dialog
      open
      onOpenChange={(value) => {
        if (!value) onClose()
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Show markers</DialogTitle>
          <DialogDescription>
            Times show when the server saved each mark on this room’s timeline. No media to extract
            until a recording clock is confirmed.
          </DialogDescription>
        </DialogHeader>
        <DialogBody>
          {failure && (
            <Alert variant="destructive">
              <AlertDescription>{failure}</AlertDescription>
            </Alert>
          )}
          <Button size="xs" variant="ghost" onClick={() => setRefresh((v) => v + 1)}>
            Refresh
          </Button>
          {marks === null ? (
            <p className="text-muted-foreground text-sm">Loading markers…</p>
          ) : marks.length === 0 ? (
            <p className="text-muted-foreground text-sm">No markers saved on this show.</p>
          ) : (
            <GroupedList aria-label="Show moments">
              {marks.map((m) => (
                <ListRow
                  key={m.id}
                  title={m.label ?? (m.kind === 'clip' ? 'Clip marker' : 'Untitled marker')}
                  context={`${markerTime(m.atSeconds)} · ${m.source}`}
                  meta={
                    m.target.takeIds.length
                      ? 'Recording associated; clock unconfirmed'
                      : 'No recording associated'
                  }
                >
                  {m.kind === 'clip' && (
                    <Button
                      size="xs"
                      variant="outline"
                      disabled={pending || !clips?.enabled || !clips.generation}
                      onClick={() => {
                        if (!client || !clips?.generation) return
                        setPending(true)
                        setFailure(null)
                        void client
                          .requestTyped('cloud.clips.save', {
                            showId,
                            markerId: m.id,
                            generation: clips.generation
                          })
                          .then(() => setRefresh((v) => v + 1))
                          .catch(() =>
                            setFailure(
                              'No clip was saved. The marked window may have expired or its media clock is unconfirmed.'
                            )
                          )
                          .finally(() => setPending(false))
                      }}
                    >
                      Save clip
                    </Button>
                  )}
                  <Button
                    size="xs"
                    variant="ghost"
                    disabled={pending}
                    onClick={() => void remove(m)}
                  >
                    Remove
                  </Button>
                </ListRow>
              ))}
            </GroupedList>
          )}
        </DialogBody>
      </DialogContent>
    </Dialog>
  )
}
