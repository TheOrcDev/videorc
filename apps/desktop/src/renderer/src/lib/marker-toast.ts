import { TOAST_WITH_DESCRIPTION_MS, toast } from '@/lib/toast'
import type { BackendClient } from '@/backendClient'
import type { TimelineMarker } from '../../../shared/cloud-markers'
import { markerTime } from '../../../shared/session-markers'

export async function showMarkerToast(
  client: BackendClient,
  created: TimelineMarker
): Promise<void> {
  // A delayed lazy import must not announce a marker already removed or renamed.
  const lookup = await (
    'showId' in created
      ? client.requestTyped('cloud.marker.get', { showId: created.showId, markerId: created.id })
      : client.requestTyped('session.marker.get', {
          sessionId: created.sessionId,
          markerId: created.id
        })
  ).catch(() => null)
  if (lookup?.status !== 'found') return
  const marker = lookup.marker
  const clip =
    'showId' in marker && marker.kind === 'clip'
      ? await client
          .requestTyped('cloud.clips.jobs')
          .then((jobs) => jobs.find((j) => j.showId === marker.showId && j.markerId === marker.id))
          .catch(() => undefined)
      : undefined
  toast.success(`Marker saved · ${marker.label ?? 'Untitled marker'}`, {
    id: marker.id,
    description:
      'showId' in marker
        ? clip
          ? `${markerTime(marker.atSeconds)} on show timeline · Clip ${clip.state}. ${clip.reason}`
          : `${markerTime(marker.atSeconds)} on show timeline; no media to extract.`
        : markerTime(marker.atSeconds),
    // Undo is a convenience, not a step the streamer must take: it times out
    // like any toast with a description instead of staying (plan 174 S2.4).
    duration: TOAST_WITH_DESCRIPTION_MS,
    action: {
      label: 'Undo',
      onClick: () => {
        void (
          'showId' in marker
            ? client.requestTyped('cloud.marker.delete', {
                showId: marker.showId,
                markerId: marker.id
              })
            : client.requestTyped('session.marker.delete', {
                sessionId: marker.sessionId,
                markerId: marker.id
              })
        )
          .then(() => toast.dismiss(marker.id))
          .catch((error: unknown) => {
            console.warn('[markers] undo failed:', error)
            toast.error("Couldn't undo the marker", {
              id: marker.id,
              description: "Delete it from the recording's Markers in Library."
            })
          })
      }
    }
  })
}
