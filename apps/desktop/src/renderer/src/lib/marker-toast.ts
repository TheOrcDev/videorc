import { TOAST_WITH_DESCRIPTION_MS, toast } from '@/lib/toast'
import type { BackendClient } from '@/backendClient'
import type { SessionMarker } from '@/lib/backend'
import { markerTime } from '../../../shared/session-markers'

export async function showMarkerToast(
  client: BackendClient,
  created: SessionMarker
): Promise<void> {
  // A delayed lazy import must not announce a marker already removed or renamed.
  const lookup = await client
    .requestTyped('session.marker.get', { sessionId: created.sessionId, markerId: created.id })
    .catch(() => null)
  if (lookup?.status !== 'found') return
  const marker = lookup.marker
  toast.success(`Marker saved · ${marker.label ?? 'Untitled marker'}`, {
    id: marker.id,
    description: markerTime(marker.atSeconds),
    // Undo is a convenience, not a step the streamer must take: it times out
    // like any toast with a description instead of staying (plan 174 S2.4).
    duration: TOAST_WITH_DESCRIPTION_MS,
    action: {
      label: 'Undo',
      onClick: () => {
        void client
          .requestTyped('session.marker.delete', {
            sessionId: marker.sessionId,
            markerId: marker.id
          })
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
