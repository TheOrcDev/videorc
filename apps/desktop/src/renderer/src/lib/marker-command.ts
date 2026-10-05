import type { CreateMarkerParams, MarkerLookup, SessionMarker, VideorcApi } from '@/lib/backend'
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
      throw new Error('This marker was removed. Submit a new command to make another.', {
        cause: error
      })
    throw error
  }
}
