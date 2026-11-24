import type { BackendClient } from '@/backendClient'
import type { CloudRoomPresentationEvent, RoomPresentationStatus } from '@/lib/backend'
import type {
  PreparedBackgroundAsset,
  RoomSceneCommit,
  SceneContent
} from '@/lib/room-scene-publisher'

// Plan 260 S1.8b: with the backend in the room (S1.8a's dev switch), a scene
// commit goes to it (`cloud.room.scene.commit`) and settles on the scene
// entry of `cloud.room.presentation`, with the same 5 s limit the renderer's
// publisher kept: each lane's rendered revision, `preview` with no output
// running, or `waiting`. Null when the backend does not hold the seat: the
// room client commits as before.

export const BACKEND_SCENE_COMMIT_WAIT_MS = 5_000

function base64(bytes: Uint8Array): string {
  let binary = ''
  for (let offset = 0; offset < bytes.length; offset += 0x8000)
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000))
  return btoa(binary)
}

/** The commit's answer from a scene status, as the renderer's publisher gave it. */
export function sceneCommitFrom(status: RoomPresentationStatus): RoomSceneCommit | null {
  if (status.state === 'waiting') return null
  return {
    state: status.state === 'off' ? 'applied' : status.state,
    reason: status.reason,
    observed: status.observed
  }
}

export async function commitSceneToBackend(
  client: BackendClient,
  showId: string,
  content: SceneContent | null,
  assets: readonly PreparedBackgroundAsset[],
  waitMs = BACKEND_SCENE_COMMIT_WAIT_MS
): Promise<RoomSceneCommit | null> {
  let latest: RoomPresentationStatus | null = null
  let settle: (() => void) | null = null
  let sinceRevision = Number.POSITIVE_INFINITY
  const off = client.on('cloud.room.presentation', (event: CloudRoomPresentationEvent) => {
    if (event.showId !== showId || !event.scene) return
    if (event.scene.revision <= sinceRevision) return
    latest = event.scene
    if (event.scene.state !== 'waiting') settle?.()
  })
  try {
    const answer = await client.requestTyped('cloud.room.scene.commit', {
      content,
      assets: content
        ? assets.map((asset) => ({
            hash: asset.hash,
            mime: asset.mime,
            width: asset.width,
            height: asset.height,
            base64: base64(asset.bytes)
          }))
        : []
    })
    if (!answer.held) return null
    // Only a status of this commit's generation or later settles it.
    sinceRevision = 0
    const settled = latest && (latest as RoomPresentationStatus).state !== 'waiting'
    if (!settled)
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, waitMs)
        settle = () => {
          clearTimeout(timer)
          resolve()
        }
      })
    const status = latest as RoomPresentationStatus | null
    if (!status)
      return {
        state: 'waiting',
        reason: 'Scene sent; waiting for each output to draw it.',
        observed: {}
      }
    return (
      sceneCommitFrom(status) ?? {
        state: 'waiting',
        reason: status.reason,
        observed: status.observed
      }
    )
  } finally {
    off()
  }
}
