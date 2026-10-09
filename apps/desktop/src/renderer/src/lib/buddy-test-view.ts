import type { BuddyPetPreviewInfo } from '@/components/buddy-pet-preview'
import type { OverlayRect } from '@/lib/backend'
import { BUDDY_HOP_REACTION_ID, BUDDY_PET_TALK_IDS, nearestGazeFrame } from '@/lib/buddy-pet-player'

// The "Test your Golem" dialog (plan 169 D14, narrowed by the owner on
// 2026-10-09 to the Golem's looks): which frame each state holds, the
// reactions it can play, and where the sample bubble sits. Pure, so the
// dialog's tests and this module's agree on every rule. The dialog is a
// sandbox: nothing here reaches the backend.

export type BuddyTestState = 'idle' | 'talk' | 'laugh' | 'think'

/** The States row, in order, with the key that picks each. */
export const BUDDY_TEST_STATES: readonly { id: BuddyTestState; label: string; key: string }[] = [
  { id: 'idle', label: 'Idle', key: '1' },
  { id: 'talk', label: 'Talking', key: '2' },
  { id: 'laugh', label: 'Laughing', key: '3' },
  { id: 'think', label: 'Thinking', key: '4' }
]

export function buddyTestStateForKey(key: string): BuddyTestState | null {
  return BUDDY_TEST_STATES.find((state) => state.key === key)?.id ?? null
}

/** Where a thinking Golem looks without a think drawing: up-left (Rust `THINK_GAZE`). */
export const BUDDY_THINK_GAZE = [-0.5, -1] as const

/** What the loaded pack offers, as the preview reports it. */
export type BuddyTestPack = Pick<BuddyPetPreviewInfo, 'neutral' | 'reactions' | 'gazes'>

export interface BuddyTestStatePlan {
  /** The frame the preview holds (`pose`); null lets it live (blink, breathe). */
  pose: string | null
  /** Run the on-stream talk cycle (talk frames, else a bob). */
  talking: boolean
  /** A reaction played once over the hold when the state is picked. */
  react: string | null
  /** What this pack lacks for the state, in one line; null when nothing is missing. */
  note: string | null
}

const IDLE_PLAN: BuddyTestStatePlan = { pose: null, talking: false, react: null, note: null }

/**
 * One state as the stream shows it (plan 168 D11, D12): Idle lives; Talking
 * cycles the pack's talk frames, else holds its `talk` picture (Still) and
 * bobs; Laughing holds `laugh` after its laugh; Thinking holds `think`,
 * else looks up-left. A pack missing a drawing falls back the way the
 * stream does, and the note says so.
 */
export function buddyTestStatePlan(
  state: BuddyTestState,
  pack: BuddyTestPack | null
): BuddyTestStatePlan {
  if (state === 'idle' || !pack) return IDLE_PLAN
  const has = (id: string): boolean => pack.reactions.includes(id)
  if (state === 'talk') {
    if (BUDDY_PET_TALK_IDS.some(has)) return { ...IDLE_PLAN, talking: true }
    if (has('talk')) return { ...IDLE_PLAN, pose: 'talk', talking: true }
    return {
      ...IDLE_PLAN,
      talking: true,
      note: 'This pack has no talking drawings, so it bobs while it talks.'
    }
  }
  if (state === 'laugh') {
    if (has('laugh')) return { ...IDLE_PLAN, pose: 'laugh', react: 'laugh' }
    return {
      ...IDLE_PLAN,
      react: 'laugh',
      note: 'This pack has no laugh drawing, so it hops instead.'
    }
  }
  if (has('think')) return { ...IDLE_PLAN, pose: 'think' }
  const upLeft = nearestGazeFrame(
    pack.gazes.map((cell) => ({ id: cell.id, kind: 'gaze' as const, gaze: cell.gaze })),
    BUDDY_THINK_GAZE[0],
    BUDDY_THINK_GAZE[1]
  )
  if (upLeft && upLeft.id !== pack.neutral) return { ...IDLE_PLAN, pose: upLeft.id }
  return { ...IDLE_PLAN, note: 'This pack has no thinking drawing.' }
}

/** The Reactions row: every reaction the pack has, then the motion-only hop. */
export function buddyTestReactions(reactions: readonly string[]): string[] {
  return reactions.includes(BUDDY_HOP_REACTION_ID)
    ? [...reactions]
    : [...reactions, BUDDY_HOP_REACTION_ID]
}

/** The sample line the bubble shows while Talking. */
export const BUDDY_TEST_BUBBLE_LINE = 'Welcome to the horde! Grab a seat.'

/**
 * The canvas the sample bubble is drawn for: a 1080p stream at twice its
 * size, so the bitmap stays crisp when the dialog shows it about 1:1 on a
 * Retina screen (the bubble sample's rule).
 */
export const BUDDY_TEST_BUBBLE_CANVAS = { width: 3840, height: 2160 } as const

/** Where the sample bubble goes, in CSS pixels from the preview box's top-left. */
export interface BuddyTestBubbleBox {
  left: number
  top: number
  width: number
  height: number
}

/**
 * D16 in the dialog: the bubble keeps its stream proportions to the Golem
 * (the bitmap scales by the drawn size over the Golem's cell on that canvas,
 * `buddy_cell_px`) and its bottom-centre, the tail's tip, sits on the top
 * of the neutral silhouette (`headTop`), centred on the box.
 */
export function buddyTestBubbleBox(params: {
  raster: { width: number; height: number }
  rect: OverlayRect
  previewPx: number
  headTop: number
}): BuddyTestBubbleBox {
  const cellPx = Math.max(1, Math.round(params.rect.w * BUDDY_TEST_BUBBLE_CANVAS.width))
  const scale = params.previewPx / cellPx
  const width = params.raster.width * scale
  const height = params.raster.height * scale
  const headTop = Math.min(1, Math.max(0, params.headTop))
  return {
    left: params.previewPx / 2 - width / 2,
    top: headTop * params.previewPx - height,
    width,
    height
  }
}
