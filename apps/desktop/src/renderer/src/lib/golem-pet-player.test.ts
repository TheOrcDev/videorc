import { describe, expect, it } from 'vitest'

import { isIdentityTransform } from '../../../shared/golem-motion'
import {
  GOLEM_PREVIEW_BLINK_MS,
  GolemPetPlayer,
  nearestGazeFrame,
  pointerGaze,
  type GolemPetPlayerFrame,
  type GolemPetPlayerPack
} from './golem-pet-player'

const STEPS = [-1, -0.5, 0, 0.5, 1] as const

/** page-pet's 5 × 5 gaze grid and its twelve reactions. */
function pagePetPack(): GolemPetPlayerPack {
  const frames: GolemPetPlayerFrame[] = []
  for (const y of STEPS) {
    for (const x of STEPS) frames.push({ id: `gaze-${x}-${y}`, kind: 'gaze', gaze: [x, y] })
  }
  for (const id of [
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
    'calm'
  ]) {
    frames.push({ id, kind: 'reaction' })
  }
  return { neutral: 'gaze-0-0', pivot: [0.5, 0.9], frames }
}

const MOTION = { intensity: 0.45, sleepAfterSeconds: 180, breathing: true }
// A 160 px box at the window's origin: centre (80, 80), radius max(120, 208) = 208.
const RECT = { left: 0, top: 0, width: 160, height: 160 }

function player(
  overrides: Partial<ConstructorParameters<typeof GolemPetPlayer>[0]> = {}
): GolemPetPlayer {
  return new GolemPetPlayer({
    pack: pagePetPack(),
    size: 160,
    motion: MOTION,
    reducedMotion: false,
    now: 0,
    random: () => 0,
    ...overrides
  })
}

describe('nearest gaze cell (page-pet track)', () => {
  it('keeps a 16 px dead zone and scales by max(120, 1.3 × size)', () => {
    expect(pointerGaze(80 + 15, 80 - 15, RECT)).toEqual([0, 0])
    expect(pointerGaze(80 + 208, 80, RECT)).toEqual([1, 0])
    expect(pointerGaze(80 - 104, 80 + 52, RECT)).toEqual([-0.5, 0.25])
    expect(pointerGaze(80 + 4000, 80 - 4000, RECT)).toEqual([1, -1])
    // A small box tracks within page-pet's 120 px floor, not 1.3 × 32.
    expect(pointerGaze(16 + 60, 16, { left: 0, top: 0, width: 32, height: 32 })).toEqual([0.5, 0])
  })

  it('picks the closest gaze cell and keeps the first on a tie', () => {
    const frames = pagePetPack().frames
    expect(nearestGazeFrame(frames, 0.2, -0.2)?.id).toBe('gaze-0-0')
    expect(nearestGazeFrame(frames, 0.7, -0.9)?.id).toBe('gaze-0.5--1')
    expect(nearestGazeFrame(frames, 0.25, 0)?.id).toBe('gaze-0-0')
    expect(nearestGazeFrame(frames, 1, 1)?.id).toBe('gaze-1-1')
    expect(nearestGazeFrame([{ id: 'r', kind: 'reaction' }], 0, 0)).toBeNull()
  })

  it('follows the pointer anywhere in the window and turns the body a little', () => {
    const pet = player()
    pet.advance(0)
    expect(pet.track(80 + 300, 80 - 150, RECT, 10)).toBe(true)
    expect(pet.frame.id).toBe('gaze-1--0.5')
    const turned = pet.advance(0.11 * 1000)
    expect(turned.rotationDeg).not.toBe(0)
    // Back ahead when the pointer leaves the window.
    expect(pet.center()).toBe(true)
    expect(pet.frame.id).toBe('gaze-0-0')
  })
})

describe('reactions (page-pet clickReaction and react)', () => {
  it('cycles every reaction but blink and sleep, at most one per 250 ms', () => {
    const pet = player()
    const played: (string | null)[] = []
    let now = 0
    for (let i = 0; i < 11; i += 1) {
      played.push(pet.click(now))
      now += 300
    }
    expect(played).toEqual([
      'laugh',
      'surprised',
      'wink',
      'kiss',
      'worried',
      'annoyed',
      'proud',
      'confused',
      'excited',
      'calm',
      'laugh'
    ])
    expect(pet.click(now - 300 + 249)).toBeNull()
  })

  it('holds a reaction for max(1.1 s, its motion envelope), then looks back', () => {
    const pet = player()
    expect(pet.react('surprised', 1000)).toBe(true)
    expect(pet.frame.id).toBe('surprised')
    pet.advance(1000)
    pet.tick(2099)
    expect(pet.frame.id).toBe('surprised')
    // page-pet's envelope at 0.45 is 0.11 + 0.19 + 0.57 = 0.87 s: the 1.1 s hold wins.
    pet.tick(2101)
    expect(pet.frame.id).toBe('gaze-0-0')
    expect(pet.react('nope', 5000)).toBe(false)
    expect(pet.frame.id).toBe('gaze-0-0')
  })

  it('blinks only on the neutral cell, for 160 ms, every 3.5 to 6 s', () => {
    const pet = player({ random: () => 0.5 })
    pet.tick(3000)
    expect(pet.frame.id).toBe('gaze-0-0')
    pet.tick(3501)
    expect(pet.frame.id).toBe('blink')
    pet.tick(3501 + GOLEM_PREVIEW_BLINK_MS + 1)
    expect(pet.frame.id).toBe('gaze-0-0')
    // Turned away: the next blink time passes without a blink.
    pet.track(80 + 300, 80, RECT, 4000)
    pet.tick(3501 + 3500 + 1250 + 1)
    expect(pet.frame.id).toBe('gaze-1-0')
  })

  it('a blink and Try never move the body; a missing reaction can hop', () => {
    const pet = player()
    pet.advance(0)
    pet.react('blink', 100, GOLEM_PREVIEW_BLINK_MS, false)
    expect(pet.frame.id).toBe('blink')
    expect(pet.cadence(100)).not.toBe('frame')
    pet.tick(100 + GOLEM_PREVIEW_BLINK_MS + 1)
    expect(pet.hop('wave', 300)).toBe(true)
    expect(pet.frame.id).toBe('gaze-0-0')
    expect(pet.cadence(300)).toBe('frame')
    expect(isIdentityTransform(pet.advance(400))).toBe(false)
  })
})

describe('sleep (page-pet idle, the persona setting)', () => {
  it('sleeps after sleepAfterSeconds of no pointer activity and wakes on the next move', () => {
    const pet = player({ motion: { ...MOTION, sleepAfterSeconds: 30 } })
    pet.tick(29_000)
    expect(pet.frame.id).not.toBe('sleep')
    pet.tick(30_001)
    expect(pet.frame.id).toBe('sleep')
    expect(pet.track(80, 80, RECT, 31_000)).toBe(true)
    expect(pet.frame.id).toBe('gaze-0-0')
  })

  it('never sleeps when the setting is 0 or the pack has no sleep frame', () => {
    const never = player({ motion: { ...MOTION, sleepAfterSeconds: 0 } })
    never.tick(10 * 60_000)
    expect(never.frame.id).not.toBe('sleep')
    const pack = pagePetPack()
    const noSleep = player({
      pack: { ...pack, frames: pack.frames.filter((frame) => frame.id !== 'sleep') },
      motion: { ...MOTION, sleepAfterSeconds: 30 }
    })
    noSleep.tick(60_000)
    expect(noSleep.frame.id).not.toBe('sleep')
  })
})

describe('prefers-reduced-motion', () => {
  it('does not track, idle or move, but a click still shows its drawn reaction', () => {
    const pet = player({ reducedMotion: true, motion: { ...MOTION, sleepAfterSeconds: 30 } })
    expect(pet.track(80 + 300, 80, RECT, 10)).toBe(false)
    expect(pet.frame.id).toBe('gaze-0-0')
    expect(isIdentityTransform(pet.advance(20))).toBe(true)
    expect(pet.click(100)).toBe('laugh')
    expect(pet.frame.id).toBe('laugh')
    expect(isIdentityTransform(pet.advance(200))).toBe(true)
    // The drawn hold is page-pet's 1.1 s; no envelope extends it.
    pet.tick(1201)
    expect(pet.frame.id).toBe('gaze-0-0')
    pet.tick(60_000)
    expect(pet.frame.id).toBe('gaze-0-0')
    expect(pet.hop('wave', 60_100)).toBe(false)
    expect(pet.cadence(60_100)).toBe('tick')
  })

  it('switching it on mid-flight drops the motion and looks ahead', () => {
    const pet = player()
    pet.track(80 + 300, 80, RECT, 10)
    pet.react('excited', 20)
    expect(pet.setReducedMotion(true)).toBe(false)
    pet.tick(1200)
    expect(pet.frame.id).toBe('gaze-0-0')
    expect(isIdentityTransform(pet.advance(1210))).toBe(true)
  })
})

describe('Motion 0 and pose', () => {
  it('keeps frame changes and removes every transform at Motion 0', () => {
    const pet = player({ motion: { ...MOTION, intensity: 0 } })
    pet.track(80 + 300, 80, RECT, 10)
    pet.react('excited', 20)
    expect(pet.frame.id).toBe('excited')
    for (const at of [20, 100, 300, 600]) expect(isIdentityTransform(pet.advance(at))).toBe(true)
    expect(pet.cadence(600)).toBe('tick')
  })

  it('holds a posed frame until it is released', () => {
    const pet = player()
    expect(pet.pose('laugh', 0)).toBe(true)
    expect(pet.track(80 + 300, 80, RECT, 10)).toBe(false)
    pet.tick(5000)
    expect(pet.frame.id).toBe('laugh')
    expect(pet.pose('missing', 5000)).toBe(false)
    expect(pet.pose(null, 6000)).toBe(true)
    expect(pet.frame.id).toBe('gaze-0-0')
  })
})
