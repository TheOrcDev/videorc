import { describe, expect, it } from 'vitest'

import {
  BuddyAnimator,
  ANIMATOR_DEFAULT_SETTINGS,
  SplitMix64,
  type AnimatorAvatarState,
  type AnimatorEvent,
  type AnimatorLeg,
  type AnimatorPack
} from './buddy-animator'

/**
 * Parity with `crates/videorc-backend/src/buddy_animator/tests.rs`: the same
 * synthetic packs, boxes, cards and seed, so the Rust module's pinned
 * scripted session is the local reference this port must reproduce.
 */
const SEED = 0x5eed168cn
const GAZE_STEPS = [-1.0, -0.5, 0.0, 0.5, 1.0]
const ALL_REACTIONS = [
  'laugh',
  'surprised',
  'wink',
  'kiss',
  'blink',
  'sleep',
  'worried',
  'annoyed',
  'proud',
  'confused',
  'excited',
  'calm',
  'talk-a',
  'talk-b',
  'wave'
]
const PRIMARY_BOX = [1600, 820, 240, 240] as const
const AUX_BOX = [60, 1620, 240, 240] as const
const LEFT_CARD = [80, 760, 560, 200] as const
const AUX_CARD = [560, 1100, 440, 200] as const

const look = (x: number, y: number): string =>
  `look-${GAZE_STEPS.indexOf(x)}${GAZE_STEPS.indexOf(y)}`

export function fixturePack(grid: boolean, reactions: string[], talk: string[]): AnimatorPack {
  const cells: AnimatorPack['cells'][number][] = []
  for (const y of GAZE_STEPS) {
    for (const x of GAZE_STEPS) {
      if (grid || (x === 0 && y === 0)) cells.push({ id: look(x, y), kind: 'gaze', gaze: [x, y] })
    }
  }
  for (const id of reactions) cells.push({ id, kind: 'reaction', gaze: null })
  return { neutral: 'look-22', pivot: [0.5, 0.9], headTop: 0.2, talk, cells }
}
const alive = (): AnimatorPack => fixturePack(true, ALL_REACTIONS, ['talk-a', 'talk-b'])

class Session {
  animator = new BuddyAnimator(ANIMATOR_DEFAULT_SETTINGS, SEED)
  avatar: AnimatorAvatarState = 'idle'
  cards: [
    readonly [number, number, number, number] | null,
    readonly [number, number, number, number] | null
  ] = [null, null]
  constructor(readonly pack: AnimatorPack) {}
  handle(event: AnimatorEvent, at: number): void {
    this.animator.handle(event, at)
  }
  frame(now: number) {
    const draw = (leg: AnimatorLeg, box: readonly [number, number, number, number]) =>
      this.animator.draw({
        leg,
        now,
        buddyBox: box,
        highlightRect: this.cards[leg as 0 | 1],
        avatarState: this.avatar,
        pack: this.pack
      })!
    return [draw(0, PRIMARY_BOX), draw(1, AUX_BOX)] as const
  }
}

const follow: AnimatorEvent = { kind: 'reaction', chain: ['wave', 'proud'], activity: true }
const talk = (chars: number, bubbleSeconds: number): AnimatorEvent => ({
  kind: 'utterance',
  mood: 'talk',
  chars,
  bubbleSeconds
})

/** Rust `SCRIPTED_PRIMARY`, verbatim. */
const SCRIPTED_PRIMARY: [number, string][] = [
  [0, 'look-22'],
  [30, 'wave'],
  [63, 'look-22'],
  [90, 'look-02'],
  [135, 'look-22'],
  [180, 'talk-a'],
  [184, 'talk-b'],
  [188, 'look-22'],
  [192, 'talk-a'],
  [196, 'talk-b'],
  [200, 'look-22'],
  [204, 'talk-a'],
  [207, 'talk-b'],
  [211, 'look-22'],
  [215, 'talk-a'],
  [219, 'talk-b'],
  [224, 'look-22'],
  [227, 'talk-a'],
  [231, 'talk-b'],
  [234, 'look-22'],
  [255, 'look-02'],
  [276, 'look-22'],
  [373, 'blink'],
  [378, 'look-22'],
  [414, 'look-13'],
  [441, 'look-22'],
  [511, 'blink'],
  [516, 'look-22'],
  [637, 'blink'],
  [642, 'look-22'],
  [643, 'look-32'],
  [682, 'look-22'],
  [749, 'blink'],
  [754, 'look-22'],
  [860, 'look-23'],
  [899, 'look-22'],
  [1042, 'blink'],
  [1047, 'look-22'],
  [1221, 'blink'],
  [1226, 'look-22'],
  [1265, 'look-23'],
  [1293, 'look-22'],
  [1362, 'blink'],
  [1367, 'look-22'],
  [1510, 'blink'],
  [1515, 'look-22'],
  [1588, 'look-11'],
  [1622, 'look-22'],
  [1771, 'blink'],
  [1776, 'look-22'],
  [1915, 'blink'],
  [1920, 'look-22'],
  [1938, 'look-33'],
  [1964, 'look-22'],
  [2049, 'blink'],
  [2054, 'look-22'],
  [2180, 'blink'],
  [2185, 'look-22'],
  [2260, 'look-12'],
  [2294, 'look-22'],
  [2310, 'blink'],
  [2315, 'look-22'],
  [2475, 'blink'],
  [2480, 'look-22'],
  [2548, 'look-32'],
  [2595, 'look-22'],
  [2614, 'blink'],
  [2619, 'look-22'],
  [2785, 'blink'],
  [2790, 'look-13'],
  [2835, 'look-22'],
  [2960, 'blink'],
  [2965, 'look-22'],
  [3078, 'blink'],
  [3083, 'look-22'],
  [3115, 'look-32'],
  [3155, 'look-22'],
  [3212, 'blink'],
  [3217, 'look-22'],
  [3357, 'blink'],
  [3362, 'look-22'],
  [3415, 'look-11'],
  [3440, 'look-22'],
  [3463, 'blink'],
  [3468, 'look-22'],
  [3614, 'blink'],
  [3619, 'look-22'],
  [3675, 'look-12'],
  [3716, 'look-22'],
  [3737, 'blink'],
  [3742, 'look-22'],
  [3882, 'blink'],
  [3887, 'look-22'],
  [3987, 'look-33'],
  [4025, 'look-22'],
  [4055, 'blink'],
  [4060, 'look-22'],
  [4165, 'blink'],
  [4170, 'look-22'],
  [4271, 'blink'],
  [4276, 'look-22'],
  [4280, 'look-31'],
  [4321, 'look-22'],
  [4441, 'blink'],
  [4446, 'look-22'],
  [4499, 'look-23'],
  [4529, 'look-22'],
  [4594, 'blink'],
  [4599, 'look-22'],
  [4721, 'blink'],
  [4726, 'look-22'],
  [4874, 'blink'],
  [4879, 'look-22'],
  [4915, 'look-13'],
  [4953, 'look-22'],
  [4991, 'blink'],
  [4996, 'look-22'],
  [5128, 'blink'],
  [5133, 'look-22'],
  [5180, 'look-31'],
  [5227, 'look-22'],
  [5257, 'blink'],
  [5262, 'look-22'],
  [5427, 'blink'],
  [5432, 'look-22'],
  [5469, 'look-21'],
  [5499, 'look-22'],
  [5580, 'sleep']
]

function scripted(onFrame?: (frame: number, session: Session) => void) {
  const session = new Session(alive())
  const fps = 30
  const primary: string[] = []
  const aux: string[] = []
  const snapshots: [number, number[], number[]][] = []
  for (let frame = 0; frame < 210 * 30; frame += 1) {
    const now = frame / fps
    if (frame === 30) session.handle(follow, now)
    if (frame === 90) {
      session.handle({ kind: 'highlight', ttlSeconds: 10 }, now)
      session.cards = [LEFT_CARD, AUX_CARD]
    }
    if (frame === 180) {
      session.handle(talk(30, 2.5), now)
      session.avatar = 'talk'
    }
    if (frame === 255) {
      session.handle({ kind: 'utterance-end' }, now)
      session.avatar = 'idle'
    }
    if (frame === 390) {
      session.handle({ kind: 'highlight-idle' }, now)
      session.cards = [null, null]
    }
    const [p, a] = session.frame(now)
    primary.push(p.cell)
    aux.push(a.cell)
    if ([36, 100, 190, 600, 6200].includes(frame)) snapshots.push([frame, p.affine, p.translate])
    onFrame?.(frame, session)
  }
  return { primary, aux, snapshots }
}

const runsOf = (cells: string[]): [number, string][] => {
  const out: [number, string][] = []
  cells.forEach((id, frame) => {
    if (out.at(-1)?.[1] !== id) out.push([frame, id])
  })
  return out
}
const round4 = (values: number[]) => values.map((v) => Math.round(v * 1e4) / 1e4 + 0)

describe('BuddyAnimator TypeScript twin', () => {
  it('SplitMix64 matches the reference sequence bit for bit', () => {
    // SplitMix64 published reference outputs for seed 0.
    const rng = new SplitMix64(0n)
    expect(rng.nextU64()).toBe(0xe220a8397b1dcdafn)
    expect(rng.nextU64()).toBe(0x6e789e6aa1b965f4n)
    expect(rng.nextU64()).toBe(0x06c45d188009454fn)
  })

  it('replays the Rust scripted session cell by cell, with the same transforms', () => {
    const { primary, aux, snapshots } = scripted()
    expect(runsOf(primary)).toEqual(SCRIPTED_PRIMARY)
    primary.forEach((p, frame) => {
      const cardFrames = (frame >= 90 && frame < 135) || (frame >= 255 && frame < 276)
      if (cardFrames) {
        expect([frame, p, aux[frame]]).toEqual([frame, 'look-02', 'look-40'])
      } else {
        expect([frame, aux[frame]]).toEqual([frame, p])
      }
    })
    expect(snapshots.map(([f, a, t]) => [f, round4(a), round4(t)])).toEqual([
      [36, [0.9976, 0.0269, -0.027, 1.0017], [0, -2.3277]],
      [100, [0.9948, 0, 0, 1.0053], [0, 0]],
      [190, [1.0012, 0, 0, 0.9988], [0, 0]],
      [600, [1.0032, 0, 0, 0.9968], [0, 0]],
      [6200, [1, 0, 0, 1], [0, 0]]
    ])
  })

  it('continues identically from a saved state (late join)', () => {
    const full = scripted().primary
    let restored: BuddyAnimator | null = null
    let restoredAt = -1
    const tail: string[] = []
    scripted((frame, session) => {
      if (frame === 1000) {
        restored = BuddyAnimator.fromState(JSON.parse(JSON.stringify(session.animator.saveState())))
        restoredAt = frame
      }
    })
    expect(restored).not.toBeNull()
    const resumed = new Session(alive())
    resumed.animator = restored!
    for (let frame = restoredAt + 1; frame < 210 * 30; frame += 1) {
      tail.push(resumed.frame(frame / 30)[0].cell)
    }
    expect(tail).toEqual(full.slice(restoredAt + 1))
  })

  it('a reaction never interrupts another: two wait, at most 6 s', () => {
    const session = new Session(alive())
    session.frame(0)
    const react = (id: string): AnimatorEvent => ({ kind: 'reaction', chain: [id], activity: true })
    for (const id of ['wink', 'kiss', 'proud', 'calm']) session.handle(react(id), 0.5)
    const seen: string[] = []
    for (let frame = 16; frame < 300; frame += 1) {
      const cell = session.frame(frame / 30)[0].cell
      if (['wink', 'kiss', 'proud', 'calm'].includes(cell) && seen.at(-1) !== cell) seen.push(cell)
    }
    // The fourth found no room; nothing plays twice.
    expect(seen).toEqual(['wink', 'kiss', 'proud'])
  })

  it('a still pack shows plan 164 state images; no talk frames bob instead', () => {
    const still: AnimatorPack = fixturePack(false, ['talk', 'laugh', 'think'], [])
    const session = new Session({ ...still, neutral: 'look-22' })
    session.frame(0)
    session.handle(talk(20, 2), 0.1)
    session.avatar = 'talk'
    expect(session.frame(0.2)[0].cell).toBe('talk')
    session.handle({ kind: 'utterance-end' }, 2.2)
    session.avatar = 'think'
    session.handle({ kind: 'think' }, 2.2)
    expect(session.frame(2.3)[0].cell).toBe('think')
  })
})
