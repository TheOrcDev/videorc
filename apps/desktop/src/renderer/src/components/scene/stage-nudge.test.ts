import { describe, expect, it } from 'vitest'

import { stageNudgeForKey } from './stage-nudge'

// Plan 174 S3.9 (C-31): arrows nudge the selected source on the stage, Shift
// takes the larger step.

const key = (
  key: string,
  modifiers: Partial<Pick<KeyboardEvent, 'shiftKey' | 'altKey' | 'metaKey' | 'ctrlKey'>> = {}
) => ({ key, shiftKey: false, altKey: false, metaKey: false, ctrlKey: false, ...modifiers })

describe('stageNudgeForKey', () => {
  it('maps the four arrows to a direction, Shift to the large step', () => {
    expect(stageNudgeForKey(key('ArrowUp'))).toEqual({
      directionX: 0,
      directionY: -1,
      large: false
    })
    expect(stageNudgeForKey(key('ArrowDown'))).toEqual({
      directionX: 0,
      directionY: 1,
      large: false
    })
    expect(stageNudgeForKey(key('ArrowLeft'))).toEqual({
      directionX: -1,
      directionY: 0,
      large: false
    })
    expect(stageNudgeForKey(key('ArrowRight', { shiftKey: true }))).toEqual({
      directionX: 1,
      directionY: 0,
      large: true
    })
  })

  it('leaves every other key and every other chord alone', () => {
    expect(stageNudgeForKey(key('Enter'))).toBeNull()
    expect(stageNudgeForKey(key('a'))).toBeNull()
    expect(stageNudgeForKey(key('ArrowUp', { metaKey: true }))).toBeNull()
    expect(stageNudgeForKey(key('ArrowUp', { ctrlKey: true }))).toBeNull()
    expect(stageNudgeForKey(key('ArrowUp', { altKey: true }))).toBeNull()
  })
})
