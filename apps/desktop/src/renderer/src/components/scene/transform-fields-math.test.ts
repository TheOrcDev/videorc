import { describe, expect, it } from 'vitest'

import { MIN_SOURCE_FRACTION } from './stage-transform'
import {
  clampTransformField,
  cropEditOnPicture,
  cropFieldPatch,
  formatPercentValue,
  parsePercentValue,
  pictureEditFramePatch,
  pictureEditToFrame,
  pixelReadout,
  transformFieldPatch
} from './transform-fields-math'

describe('formatPercentValue', () => {
  it('renders whole percents without a decimal', () => {
    expect(formatPercentValue(0.5)).toBe('50')
    expect(formatPercentValue(1)).toBe('100')
    expect(formatPercentValue(0)).toBe('0')
  })

  it('keeps one decimal for fractional percents', () => {
    expect(formatPercentValue(0.1234)).toBe('12.3')
    expect(formatPercentValue(0.0505)).toBe('5.1')
  })
})

describe('parsePercentValue', () => {
  it('parses plain numbers as percent', () => {
    expect(parsePercentValue('50')).toBeCloseTo(0.5)
    expect(parsePercentValue(' 12.3 ')).toBeCloseTo(0.123)
  })

  it('accepts a trailing percent sign and comma decimals', () => {
    expect(parsePercentValue('75%')).toBeCloseTo(0.75)
    expect(parsePercentValue('12,5')).toBeCloseTo(0.125)
  })

  it('rejects non-numbers', () => {
    expect(parsePercentValue('')).toBeNull()
    expect(parsePercentValue('abc')).toBeNull()
    expect(parsePercentValue('1/2')).toBeNull()
  })
})

describe('clampTransformField (plan 215 E3)', () => {
  it('mirrors the backend position range', () => {
    expect(clampTransformField('x', -5)).toBe(-3)
    expect(clampTransformField('y', 5)).toBe(4)
    expect(clampTransformField('x', 0.4)).toBe(0.4)
    expect(clampTransformField('x', -0.25)).toBe(-0.25)
  })

  it('keeps sizes between the stage minimum and 400% of the canvas', () => {
    expect(clampTransformField('width', 0)).toBe(MIN_SOURCE_FRACTION)
    expect(clampTransformField('height', 3)).toBe(3)
    expect(clampTransformField('height', 9)).toBe(4)
  })
})

describe('transformFieldPatch', () => {
  const committed = { x: 0.6, y: 0.6, width: 0.3, height: 0.2 }

  it('position edits patch only their own axis', () => {
    expect(transformFieldPatch('x', 0.25, committed, true)).toEqual({ x: 0.25 })
    expect(transformFieldPatch('y', 0.1, committed, false)).toEqual({ y: 0.1 })
  })

  it('a position edit may hang the box off the canvas, keeping 5% of it covered', () => {
    // The box (0.3 wide) may start 0.25 left of the canvas: 0.05 stays on.
    expect(transformFieldPatch('x', -0.25, committed, false)).toEqual({ x: -0.25 })
    expect(transformFieldPatch('x', -0.9, committed, false)).toEqual({ x: -0.25 })
    // And end 0.05 in from the right edge.
    expect(transformFieldPatch('y', 3, committed, false)).toEqual({ y: 0.95 })
    // A 400% box may sit anywhere its bounds allow.
    const huge = { x: -1.5, y: -1.5, width: 4, height: 4 }
    expect(transformFieldPatch('x', -3, huge, false)).toEqual({ x: -3 })
    expect(transformFieldPatch('x', -3.5, huge, false)).toEqual({ x: -3 })
    expect(transformFieldPatch('x', 0.95, huge, false)).toEqual({ x: 0.95 })
  })

  it('free size edits patch one axis', () => {
    expect(transformFieldPatch('width', 0.5, committed, false)).toEqual({ width: 0.5 })
    // Up to 400% of the canvas: the box grows to the right from its place.
    expect(transformFieldPatch('width', 4, committed, false)).toEqual({ width: 4 })
    expect(transformFieldPatch('width', 9, committed, false)).toEqual({ width: 4 })
  })

  it('a size edit that would leave less than 5% of the canvas covered moves the box back on', () => {
    // At x 0.97 a width of 0.3 keeps 0.03 on the canvas; shrinking to 0.1
    // would leave 0.03 still, so the box slides to 0.95.
    expect(transformFieldPatch('width', 0.1, { ...committed, x: 0.97 }, false)).toEqual({
      width: 0.1,
      x: 0.95
    })
  })

  it('locked size edits scale both axes around the committed aspect', () => {
    expect(transformFieldPatch('width', 0.6, committed, true)).toEqual({
      width: 0.6,
      height: 0.4
    })
    expect(transformFieldPatch('height', 0.1, committed, true)).toEqual({
      width: 0.15,
      height: 0.1
    })
  })

  it('locked edits clamp to the limiting axis and keep the aspect', () => {
    // Width 4 (the 400% ceiling) gives height 2.6667, which fits, so width
    // is the limiter here (plan 215 E3; before, the canvas was).
    expect(transformFieldPatch('width', 9, committed, true)).toEqual({
      width: 4,
      height: 2.6667
    })
    expect(transformFieldPatch('width', 2, committed, true)).toEqual({
      width: 2,
      height: 1.3333
    })
    // Shrinking: the height axis hits the 5% floor first (aspect 1.5).
    expect(transformFieldPatch('width', 0.01, committed, true)).toEqual({
      width: 0.075,
      height: 0.05
    })
  })
})

describe('pixelReadout', () => {
  it('projects the normalized box onto the output canvas', () => {
    expect(pixelReadout({ x: 0, y: 0, width: 0.2, height: 0.3 }, 1920, 1080)).toBe(
      '384 × 324 px on 1920 × 1080'
    )
  })
})

describe('cropFieldPatch (plan 213 G2)', () => {
  const none = { cropLeft: 0, cropTop: 0, cropRight: 0, cropBottom: 0 }

  it('commits the one side, as a share of the picture', () => {
    expect(cropFieldPatch('cropLeft', 0.125, none)).toEqual({ cropLeft: 0.125 })
    expect(cropFieldPatch('cropBottom', 0.33333, none)).toEqual({ cropBottom: 0.3333 })
  })

  it('never crops below nothing or past 5% of the picture beside the other side', () => {
    expect(cropFieldPatch('cropTop', -0.2, none)).toEqual({ cropTop: 0 })
    expect(cropFieldPatch('cropRight', 1.2, none)).toEqual({ cropRight: 0.95 })
    expect(cropFieldPatch('cropRight', 0.9, { ...none, cropLeft: 0.6 })).toEqual({
      cropRight: 0.35
    })
    // The other axis does not limit it.
    expect(cropFieldPatch('cropLeft', 0.5, { ...none, cropTop: 0.9 })).toEqual({ cropLeft: 0.5 })
  })
})

// Plan 216 B5: the fields describe the picture; a commit stores the frame.
describe('picture edits (plan 216 B5)', () => {
  // The streamer's picture on a 2560x1440 canvas: 2021x1306 px at (389, 134).
  const picture = { x: 389 / 2560, y: 134 / 1440, width: 2021 / 2560, height: 1306 / 1440 }

  it('W drives H for a screen whose box is its picture: the lock holds the shape', () => {
    const patch = transformFieldPatch('width', 0.5, picture, true)
    expect(patch.width).toBeCloseTo(0.5, 4)
    expect(patch.height).toBeCloseTo((0.5 * picture.height) / picture.width, 4)
    expect(pixelReadout(picture, 2560, 1440)).toBe('2021 × 1306 px on 2560 × 1440')
  })

  it('maps a picture edit back through the stage margin field by field, and leaves a camera alone', () => {
    // A 0.1 margin: the stage is 80% of the canvas, 10% in.
    expect(pictureEditToFrame({ x: 0.18 }, 'screen', 0.1)).toEqual({ x: 0.1 })
    expect(pictureEditToFrame({ width: 0.4, height: 0.48 }, 'window', 0.1)).toEqual({
      width: 0.5,
      height: 0.6
    })
    expect(
      pictureEditToFrame({ x: 0.18, y: 0.26, width: 0.4, height: 0.48 }, 'screen', 0.1)
    ).toEqual({
      x: 0.1,
      y: 0.2,
      width: 0.5,
      height: 0.6
    })
    expect(pictureEditToFrame({ x: 0.18 }, 'camera', 0.1)).toEqual({ x: 0.18 })
    expect(pictureEditToFrame({ x: 0.18, width: 0.4 }, 'screen', 0)).toEqual({
      x: 0.18,
      width: 0.4
    })
  })

  it('a typed crop keeps the uncropped picture in place and shrinks the box to what is kept', () => {
    const none = { cropLeft: 0, cropTop: 0, cropRight: 0, cropBottom: 0 }
    const left = cropEditOnPicture({ cropLeft: 0.25 }, picture, none)
    expect(left.cropLeft).toBe(0.25)
    expect(left.x).toBeCloseTo(picture.x + 0.25 * picture.width, 4)
    expect(left.width).toBeCloseTo(0.75 * picture.width, 4)
    expect(left.y).toBeCloseTo(picture.y, 4)
    expect(left.height).toBeCloseTo(picture.height, 4)
    // Cropping further from a cropped box: the full picture is recovered first.
    const cropped = { ...none, cropLeft: 0.25 }
    const box = { x: left.x, y: left.y, width: left.width, height: left.height }
    const more = cropEditOnPicture({ cropRight: 0.25 }, box, cropped)
    expect(more.x).toBeCloseTo(box.x, 4)
    expect(more.width).toBeCloseTo(0.5 * picture.width, 4)
    // Reset: the whole picture is back where it was.
    const reset = cropEditOnPicture(
      none,
      { x: more.x, y: more.y, width: more.width, height: more.height },
      { ...cropped, cropRight: 0.25 }
    )
    expect(reset.x).toBeCloseTo(picture.x, 3)
    expect(reset.width).toBeCloseTo(picture.width, 3)
  })
})

describe('pictureEditFramePatch (plan 216 B5)', () => {
  const canvas = { width: 2560, height: 1440 }
  const frame = { x: 0.0932, y: 0.0932, width: 0.9068, height: 0.9068 }
  const picture = { x: 389 / 2560, y: 134 / 1440, width: 2021 / 2560, height: 1306 / 1440 }

  it('sends the whole picture with the first edit, so the frame becomes the picture', () => {
    const patch = pictureEditFramePatch({ x: 0.2 }, picture, frame, 'screen', 0, canvas)
    expect(patch).toEqual({
      x: 0.2,
      y: 0.0931,
      width: 0.7895,
      height: 0.9069
    })
  })

  it('sends only the edited field while the box is the frame', () => {
    // An unknown size: the box is the frame rounded to canvas pixels.
    const rounded = { x: 239 / 2560, y: 134 / 1440, width: 2321 / 2560, height: 1306 / 1440 }
    expect(pictureEditFramePatch({ x: 0.2 }, rounded, frame, 'screen', 0, canvas)).toEqual({
      x: 0.2
    })
    // On the stage margin, the field goes back through it.
    const staged = {
      x: 0.1 + 0.0932 * 0.8,
      y: 0.1 + 0.0932 * 0.8,
      width: 0.9068 * 0.8,
      height: 0.9068 * 0.8
    }
    expect(pictureEditFramePatch({ width: 0.4 }, staged, frame, 'screen', 0.1, canvas)).toEqual({
      width: 0.5
    })
  })
})
