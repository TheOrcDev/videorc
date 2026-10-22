import type { Scene } from './backend'

/**
 * JSON with every object's keys sorted and undefined members dropped, so two
 * encodings of one value compare equal whatever order their producer wrote
 * the keys in. Arrays keep their order (a scene's sources are its z-order).
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, member: unknown) =>
    member !== null && typeof member === 'object' && !Array.isArray(member)
      ? Object.fromEntries(
          Object.keys(member)
            .sort()
            .map((key) => [key, (member as Record<string, unknown>)[key]])
        )
      : member
  )
}

/**
 * A scene as a visibility request sees it: everything but that one source's
 * `visible`, which the request itself changes. Its own `scene.changed` echo
 * may land before the ACK; any other difference means a newer edit won.
 *
 * Key order is not content: the backend writes `outputs` before `sources` in
 * one reply and after it in another, and a plain JSON.stringify comparison
 * dropped every acknowledged change that raced its echo (ogre 2026-10-13:
 * the Scene page's camera switch flipped, the layout never followed).
 */
export function sceneVisibilityIdentity(scene: Scene | null, sourceId: string): string {
  return canonicalJson(
    scene && {
      ...scene,
      sources: scene.sources.map((source) =>
        source.id === sourceId ? { ...source, visible: undefined } : source
      )
    }
  )
}
