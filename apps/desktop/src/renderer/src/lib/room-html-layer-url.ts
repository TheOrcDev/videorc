/**
 * The backend's latest frame of one HTML banner, with the renderer's token.
 *
 * Its own module on purpose: the talk-show room hook needs only this URL, and
 * the room host is mounted at every launch. Importing it from the publisher
 * pulled `livekit-client` (about 600 KB) into every launch with no room open
 * (performance finding PH-09). `renderer-launch-graph-guard.test.ts` keeps it
 * that way.
 */
export function htmlLayerFrameUrl(
  connection: { host: string; port: number; token: string },
  bannerId: string,
  after: { generation: string; sequence: number } | null
): string {
  const params = new URLSearchParams({ token: connection.token, id: bannerId })
  if (after) {
    params.set('afterGeneration', after.generation)
    params.set('afterSequence', String(after.sequence))
  }
  return `http://${connection.host}:${connection.port}/preview/html-overlay/latest.bmp?${params}`
}
