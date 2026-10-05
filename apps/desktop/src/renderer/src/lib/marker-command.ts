import type {
  CreateMarkerParams,
  MarkerContext,
  MarkerLookup,
  SessionMarker,
  VideorcApi
} from '@/lib/backend'
export class MarkerRemovedError extends Error {}
export function markerRetryAvailable(
  sessionId: string | null,
  context: MarkerContext | null
): boolean {
  // A stopped capture can still recover its saved receipt. A new capture
  // starts a new intent rather than replaying an older session's operation.
  return Boolean(sessionId && (!context?.sessionId || context.sessionId === sessionId))
}
export function markerCreateParams(
  previous: CreateMarkerParams | null,
  context: MarkerContext | null,
  label?: string
): CreateMarkerParams {
  if (previous && previous.label === label && markerRetryAvailable(previous.sessionId, context))
    return previous
  if (!context?.sessionId || !context.available) throw new Error('No active capture is available.')
  return {
    operationId: crypto.randomUUID(),
    sessionId: context.sessionId,
    ...(label ? { label } : {})
  }
}
export async function createCommentsMarker(
  api: Pick<VideorcApi, 'markerFromCommentsWindow'>,
  params: CreateMarkerParams
): Promise<SessionMarker> {
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
