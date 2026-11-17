/**
 * Plan 249 S5: the atlas meta an S4 avatar layer may carry, validated
 * against its PNG. Dependency-free (types only) so S4's `cloud-avatar.ts`
 * can check an atlas layer without loading the animator. Mirrored in the
 * program client (`lib/cloud/program/cloud-avatar-atlas-meta.ts`): the same
 * source reformatted by that repo's Prettier, nothing else.
 */

import type { AnimatorPack } from './buddy-animator'

/** Atlas limits, inside S4's static limits (<= 1024 x 1024 PNG, 256 KiB base64). */
export const AVATAR_ATLAS_MAX_CELLS = 64
export const AVATAR_ATLAS_MIN_CELL_PX = 32
export const AVATAR_ATLAS_MAX_TALK = 4

const isObject = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v)
const finite = (v: unknown, min: number, max: number): v is number =>
  typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max
const int = (v: unknown, min: number, max: number): v is number =>
  Number.isSafeInteger(v) && finite(v, min, max)
const pair = (v: unknown, min: number, max: number): v is [number, number] =>
  Array.isArray(v) && v.length === 2 && finite(v[0], min, max) && finite(v[1], min, max)
const REACTION_ID = /^[a-z0-9-]{1,40}$/

/** S4 avatar layer extension: what each cell of the atlas PNG is. */
export interface AvatarAtlasMeta extends AnimatorPack {
  cells: (AnimatorPack['cells'][number] & { rect: [number, number, number, number] })[]
}

export function parseAnimatorPack(v: unknown): AnimatorPack | null {
  if (
    !isObject(v) ||
    !Array.isArray(v.cells) ||
    v.cells.length < 1 ||
    v.cells.length > AVATAR_ATLAS_MAX_CELLS
  )
    return null
  if (!pair(v.pivot, 0, 1) || !finite(v.headTop, 0, 1) || typeof v.neutral !== 'string') return null
  if (!Array.isArray(v.talk) || v.talk.length > AVATAR_ATLAS_MAX_TALK) return null
  const cells: AnimatorPack['cells'][number][] = []
  for (const c of v.cells) {
    if (
      !isObject(c) ||
      typeof c.id !== 'string' ||
      !REACTION_ID.test(c.id) ||
      cells.some((k) => k.id === c.id)
    )
      return null
    if (c.kind === 'gaze') {
      if (!pair(c.gaze, -1, 1)) return null
      cells.push({ id: c.id, kind: 'gaze', gaze: [c.gaze[0], c.gaze[1]] })
    } else if (c.kind === 'reaction') {
      if (c.gaze !== null) return null
      cells.push({ id: c.id, kind: 'reaction', gaze: null })
    } else return null
  }
  const neutral = cells.find((c) => c.id === v.neutral)
  if (!neutral || neutral.kind !== 'gaze') return null
  const talk: string[] = []
  for (const id of v.talk) {
    if (typeof id !== 'string' || !cells.some((c) => c.id === id) || talk.includes(id)) return null
    talk.push(id)
  }
  return { neutral: neutral.id, pivot: [v.pivot[0], v.pivot[1]], headTop: v.headTop, talk, cells }
}

/** The atlas meta of an S4 avatar layer, against its PNG's decoded size. */
export function parseAvatarAtlasMeta(
  v: unknown,
  png: { width: number; height: number }
): AvatarAtlasMeta | null {
  const pack = parseAnimatorPack(v)
  if (!pack || !isObject(v) || !Array.isArray(v.cells)) return null
  const cells: AvatarAtlasMeta['cells'] = []
  for (const [i, cell] of pack.cells.entries()) {
    const raw: unknown = v.cells[i]
    const rect = isObject(raw) ? raw.rect : null
    if (!Array.isArray(rect) || rect.length !== 4 || !rect.every((n) => int(n, 0, 1024)))
      return null
    const [x, y, w, h] = rect as [number, number, number, number]
    if (w < AVATAR_ATLAS_MIN_CELL_PX || h !== w || x + w > png.width || y + h > png.height)
      return null
    cells.push({ ...cell, rect: [x, y, w, h] })
  }
  return { ...pack, cells }
}
