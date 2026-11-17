import type {
  TimelineMarker,
  TimelineMarkerCreate,
  CloudMarker
} from '../../../shared/cloud-markers'
import type { MarkerContext, MarkerLookup, SessionMarker, VideorcApi } from '@/lib/backend'
export class MarkerRemovedError extends Error {}
export function markerRetryAvailable(
  sessionId: string | null,
  context: MarkerContext | null
): boolean {
  // A stopped capture can still recover its saved receipt. A new capture
  // starts a new intent rather than replaying an older session's operation.
  const target = context?.cloudShowId ?? context?.sessionId
  return Boolean(sessionId && (!target || target === sessionId))
}
export function markerCreateParams(
  previous: TimelineMarkerCreate | null,
  context: MarkerContext | null,
  label?: string
): TimelineMarkerCreate {
  if (
    previous &&
    previous.label === label &&
    markerRetryAvailable('showId' in previous ? previous.showId : previous.sessionId, context)
  )
    return previous
  if (context?.cloudShowId && context.available)
    return {
      showId: context.cloudShowId,
      operationId: crypto.randomUUID(),
      ...(label ? { label } : {})
    }
  if (!context?.sessionId || !context.available) throw new Error('No active capture is available.')
  return {
    operationId: crypto.randomUUID(),
    sessionId: context.sessionId,
    ...(label ? { label } : {})
  }
}
export async function createCommentsMarker(
  api: Pick<VideorcApi, 'markerFromCommentsWindow'>,
  params: TimelineMarkerCreate
): Promise<TimelineMarker> {
  if ('showId' in params) {
    try {
      return (await api.markerFromCommentsWindow({
        requestId: crypto.randomUUID(),
        action: 'cloudCreate',
        params
      })) as CloudMarker
    } catch (error) {
      const lookup = (await api
        .markerFromCommentsWindow({
          requestId: crypto.randomUUID(),
          action: 'cloudGet',
          params: { showId: params.showId, markerId: params.operationId }
        })
        .catch(() => null)) as { status: string; marker?: CloudMarker } | null
      if (lookup?.status === 'found' && lookup.marker) return lookup.marker
      if (lookup?.status === 'deleted')
        throw new MarkerRemovedError(
          'This marker was removed. Submit a new command to make another.',
          { cause: error }
        )
      throw error
    }
  }
  try {
    return (await api.markerFromCommentsWindow({
      requestId: crypto.randomUUID(),
      action: 'create',
      params
    })) as SessionMarker
  } catch (error) {
    const lookup = (await api
      .markerFromCommentsWindow({
        requestId: crypto.randomUUID(),
        action: 'get',
        params: { sessionId: params.sessionId, markerId: params.operationId }
      })
      .catch(() => null)) as MarkerLookup | null
    if (lookup?.status === 'found') return lookup.marker
    if (lookup?.status === 'deleted')
      throw new MarkerRemovedError(
        'This marker was removed. Submit a new command to make another.',
        {
          cause: error
        }
      )
    throw error
  }
}
