import { toast } from '@/lib/toast'
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
    action: {
      label: 'Undo',
      onClick: () => {
        void client
          .requestTyped('session.marker.delete', {
            sessionId: marker.sessionId,
            markerId: marker.id
          })
          .then(() => toast.dismiss(marker.id))
          .catch((error) =>
            toast.error(error instanceof Error ? error.message : 'Could not remove marker.')
          )
      }
    }
  })
}
