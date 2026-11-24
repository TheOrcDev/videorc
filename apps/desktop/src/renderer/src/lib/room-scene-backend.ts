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
  // Every scene entry from before the answer is kept: the backend reports
  // this commit as soon as it has it, possibly before the RPC returns. Only
  // an entry of this commit's generation settles it.
  const heard: RoomPresentationStatus[] = []
  let generation: number | null = null
  let settle: (() => void) | null = null
  const off = client.on('cloud.room.presentation', (event: CloudRoomPresentationEvent) => {
    if (event.showId !== showId || !event.scene) return
    heard.push(event.scene)
    if (event.scene.revision === generation && event.scene.state !== 'waiting') settle?.()
  })
  const mine = (): RoomPresentationStatus | null => {
    for (let index = heard.length - 1; index >= 0; index -= 1)
      if (heard[index].revision === generation) return heard[index]
    return null
  }
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
    generation = answer.generation ?? null
    // An unchanged commit answers with its standing result.
    if (answer.status && answer.status.revision === generation) heard.push(answer.status)
    const settled = mine()
    if (generation !== null && (!settled || settled.state === 'waiting'))
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, waitMs)
        settle = () => {
          clearTimeout(timer)
          resolve()
        }
      })
    const status = mine()
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
