import { describe, expect, it } from 'vitest'

import { DEFAULT_OVERLAY_LAYOUT } from '@/lib/overlay-layout'
import {
  GOLEM_TEST_BUBBLE_CANVAS,
  GOLEM_TEST_STATES,
  golemTestBubbleBox,
  golemTestReactions,
  golemTestStateForKey,
  golemTestStatePlan,
  type GolemTestPack
} from './golem-test-view'

const STILL: GolemTestPack = {
  neutral: 'idle',
  reactions: ['talk', 'laugh', 'think'],
  gazes: [{ id: 'idle', gaze: [0, 0] }]
}

const STEPS = [-1, -0.5, 0, 0.5, 1] as const
/** A made-in-Videorc pack: the 5 × 5 gaze grid, laugh, sleep and the talk strip. */
const ALIVE: GolemTestPack = {
  neutral: 'gaze-0-0',
  reactions: ['laugh', 'sleep', 'talk-a', 'talk-b', 'wave'],
  gazes: STEPS.flatMap((y) => STEPS.map((x) => ({ id: `gaze-${x}-${y}`, gaze: [x, y] as const })))
}

/** An imported page-pet pack: no talk strip, no laugh, one gaze cell. */
const BARE: GolemTestPack = {
  neutral: 'ahead',
  reactions: ['wink', 'blink'],
  gazes: [{ id: 'ahead', gaze: [0, 0] }]
}

describe('the States row', () => {
  it('lists Idle, Talking, Laughing, Thinking on keys 1 to 4', () => {
    expect(GOLEM_TEST_STATES.map((state) => `${state.key} ${state.label}`)).toEqual([
      '1 Idle',
      '2 Talking',
      '3 Laughing',
      '4 Thinking'
    ])
    expect(golemTestStateForKey('3')).toBe('laugh')
    expect(golemTestStateForKey('5')).toBeNull()
  })

  it('holds the Still pictures, bobbing the talk one and laughing into the laugh one', () => {
    expect(golemTestStatePlan('idle', STILL)).toEqual({
      pose: null,
      talking: false,
      react: null,
      note: null
    })
    expect(golemTestStatePlan('talk', STILL)).toMatchObject({ pose: 'talk', talking: true })
    expect(golemTestStatePlan('laugh', STILL)).toMatchObject({ pose: 'laugh', react: 'laugh' })
    expect(golemTestStatePlan('think', STILL)).toMatchObject({ pose: 'think', note: null })
  })

  it("cycles an Alive pack's talk frames and looks up-left to think", () => {
    expect(golemTestStatePlan('talk', ALIVE)).toEqual({
      pose: null,
      talking: true,
      react: null,
      note: null
    })
    expect(golemTestStatePlan('laugh', ALIVE)).toMatchObject({ pose: 'laugh', react: 'laugh' })
    expect(golemTestStatePlan('think', ALIVE)).toMatchObject({ pose: 'gaze--0.5--1', note: null })
  })

  it('falls back like the stream and names what the pack lacks', () => {
    expect(golemTestStatePlan('talk', BARE)).toMatchObject({
      pose: null,
      talking: true,
      note: 'This pack has no talking drawings, so it bobs while it talks.'
    })
    expect(golemTestStatePlan('laugh', BARE)).toMatchObject({
      pose: null,
      react: 'laugh',
      note: 'This pack has no laugh drawing, so it hops instead.'
    })
    expect(golemTestStatePlan('think', BARE)).toMatchObject({
      pose: null,
      note: 'This pack has no thinking drawing.'
    })
    // Before the pack loads every state lives as Idle.
    expect(golemTestStatePlan('laugh', null).pose).toBeNull()
  })
})

describe('the Reactions row', () => {
  it('is every reaction the pack has, then Hop once', () => {
    expect(golemTestReactions(STILL.reactions)).toEqual(['talk', 'laugh', 'think', 'hop'])
    expect(golemTestReactions(['hop', 'wave'])).toEqual(['hop', 'wave'])
  })
})

describe('the sample bubble', () => {
  it("keeps the stream's proportions and puts the tail tip on the head top", () => {
    const rect = DEFAULT_OVERLAY_LAYOUT.golem.horizontal
    const cellPx = Math.round(rect.w * GOLEM_TEST_BUBBLE_CANVAS.width)
    // A bitmap one cell wide shows as wide as the drawn Golem.
    const box = golemTestBubbleBox({
      raster: { width: cellPx, height: cellPx / 4 },
      rect,
      previewPx: 340,
      headTop: 0.2
    })
    expect(box.width).toBeCloseTo(340)
    expect(box.height).toBeCloseTo(85)
    expect(box.left).toBeCloseTo(0)
    expect(box.top).toBeCloseTo(0.2 * 340 - 85)
    // An out-of-range head top anchors on the box's top edge.
    const top = golemTestBubbleBox({
      raster: { width: 100, height: 50 },
      rect,
      previewPx: 340,
      headTop: -1
    }).top
    expect(top).toBeCloseTo((-50 * 340) / cellPx)
  })
})
