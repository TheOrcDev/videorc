import { describe, expect, it } from 'vitest'

import type { CameraBackground, CameraBackgroundStatus } from '../../../shared/backend'
import { cameraFrameUrl } from '../components/camera-background/camera-background-viewer'
import { DEFAULT_CAMERA_BACKGROUND } from './camera-background'
import {
  CAMERA_BACKGROUND_BLUR_CAVEAT,
  CAMERA_BACKGROUND_DESCRIPTION,
  CAMERA_BACKGROUND_HINT,
  CAMERA_BACKGROUND_KEYWORDS,
  CAMERA_BACKGROUND_LOCK_LINE,
  cameraBackgroundChoiceId,
  cameraBackgroundChoices,
  cameraBackgroundCommand,
  cameraBackgroundForChoice,
  cameraBackgroundStageLine,
  cameraBackgroundValueLabel,
  imagesPickedFirst,
  platformBackgroundReason,
  ROOM_BACKGROUND_UNAVAILABLE
} from './camera-background-view'

const off = DEFAULT_CAMERA_BACKGROUND
const images = [
  { assetId: 'builtin-bg-01', name: 'Dusk', picture: '/assets/dusk.webp' },
  { assetId: 'builtin-bg-06', name: 'Loft' },
  { assetId: 'imported-1', name: 'My office' }
]

describe('Background choices (plan 258 S5, D5)', () => {
  it('turns each tile into one background, keeping the rest of the pick', () => {
    const tuned: CameraBackground = {
      ...off,
      blurPct: 55,
      key: { similarityPct: 44, smoothnessPct: 5, spillPct: 21 }
    }
    expect(cameraBackgroundForChoice(tuned, 'slight-blur')).toStrictEqual({
      ...tuned,
      mode: 'blur',
      blurPct: 30
    })
    expect(cameraBackgroundForChoice(tuned, 'strong-blur')).toMatchObject({
      mode: 'blur',
      blurPct: 70
    })
    // A screen keeps its tuning; Off keeps everything, so picks come back as they were.
    expect(cameraBackgroundForChoice(tuned, 'blue')).toStrictEqual({ ...tuned, mode: 'blue' })
    expect(cameraBackgroundForChoice({ ...tuned, mode: 'blue' }, 'off')).toStrictEqual({
      ...tuned,
      mode: 'off'
    })
    expect(cameraBackgroundForChoice(tuned, 'image:builtin-bg-06')).toStrictEqual({
      ...tuned,
      mode: 'image',
      assetId: 'builtin-bg-06'
    })
  })

  it('lights the tile of the pick, the nearer blur mark for a slider value, none for later slices', () => {
    expect(cameraBackgroundChoiceId(off)).toBe('off')
    expect(cameraBackgroundChoiceId({ ...off, mode: 'blur', blurPct: 30 })).toBe('slight-blur')
    expect(cameraBackgroundChoiceId({ ...off, mode: 'blur', blurPct: 50 })).toBe('slight-blur')
    expect(cameraBackgroundChoiceId({ ...off, mode: 'blur', blurPct: 51 })).toBe('strong-blur')
    expect(cameraBackgroundChoiceId({ ...off, mode: 'image', assetId: 'loft' })).toBe('image:loft')
    expect(cameraBackgroundChoiceId({ ...off, mode: 'image' })).toBeNull()
    expect(cameraBackgroundChoiceId({ ...off, mode: 'green' })).toBe('green')
    expect(cameraBackgroundChoiceId({ ...off, mode: 'video' })).toBeNull()
    expect(cameraBackgroundChoiceId({ ...off, mode: 'cutout' })).toBeNull()
  })

  it('names the pick in words', () => {
    const label = (background: Partial<CameraBackground>) =>
      cameraBackgroundValueLabel({ ...off, ...background }, images)
    expect(label({})).toBe('Off')
    expect(label({ mode: 'blur', blurPct: 30 })).toBe('Slight blur')
    expect(label({ mode: 'blur', blurPct: 70 })).toBe('Strong blur')
    expect(label({ mode: 'blur', blurPct: 64 })).toBe('Blur 64%')
    expect(label({ mode: 'image', assetId: 'imported-1' })).toBe('My office')
    expect(label({ mode: 'image', assetId: 'gone' })).toBe('Picture')
    expect(label({ mode: 'green' })).toBe('Green screen')
    expect(label({ mode: 'blue' })).toBe('Blue screen')
  })

  it('offers Off, the two blurs, the pictures and the two screens, in groups', () => {
    const choices = cameraBackgroundChoices({
      images,
      cameraSelected: true,
      roomOpen: false,
      platform: 'darwin',
      imageLimit: 2
    })
    expect(choices.map((choice) => [choice.group, choice.label])).toEqual([
      ['blur', 'Off'],
      ['blur', 'Slight blur'],
      ['blur', 'Strong blur'],
      ['images', 'Dusk'],
      ['images', 'Loft'],
      ['screens', 'Green screen'],
      ['screens', 'Blue screen']
    ])
    expect(choices.every((choice) => choice.disabledReason === null)).toBe(true)
    expect(choices[3]?.picture).toBe('/assets/dusk.webp')
  })

  it('before S8 an open room disables the effects only: Off and the screens stay', () => {
    const choices = cameraBackgroundChoices({
      images,
      cameraSelected: true,
      roomOpen: true,
      platform: 'darwin'
    })
    const reasons = Object.fromEntries(choices.map((choice) => [choice.id, choice.disabledReason]))
    expect(reasons).toStrictEqual({
      off: null,
      'slight-blur': ROOM_BACKGROUND_UNAVAILABLE,
      'strong-blur': ROOM_BACKGROUND_UNAVAILABLE,
      'image:builtin-bg-01': ROOM_BACKGROUND_UNAVAILABLE,
      'image:builtin-bg-06': ROOM_BACKGROUND_UNAVAILABLE,
      'image:imported-1': ROOM_BACKGROUND_UNAVAILABLE,
      green: null,
      blue: null
    })
    expect(ROOM_BACKGROUND_UNAVAILABLE).toBe('Background effects come to rooms in a later update.')
  })

  it('waits for the platform’s stage off macOS (D13), and for a camera everywhere', () => {
    expect(platformBackgroundReason('darwin')).toBeNull()
    expect(platformBackgroundReason('win32')).toBe(
      'Background effects come to Windows in a later update.'
    )
    expect(platformBackgroundReason('linux')).toBe(
      'Background effects come to Linux in a later update.'
    )
    const windows = cameraBackgroundChoices({
      images,
      cameraSelected: true,
      roomOpen: false,
      platform: 'win32'
    })
    expect(
      windows.filter((choice) => choice.disabledReason === null).map((choice) => choice.id)
    ).toEqual(['off', 'green', 'blue'])
    const noCamera = cameraBackgroundChoices({
      images,
      cameraSelected: false,
      roomOpen: false,
      platform: 'darwin'
    })
    expect(noCamera.every((choice) => choice.disabledReason === 'Choose a camera first.')).toBe(
      true
    )
  })

  it('puts the picked picture first, so it never hides behind Choose image…', () => {
    expect(imagesPickedFirst(images, 'imported-1').map((image) => image.name)).toEqual([
      'My office',
      'Dusk',
      'Loft'
    ])
    expect(imagesPickedFirst(images, undefined)).toEqual(images)
    expect(imagesPickedFirst(images, 'gone')).toEqual(images)
  })
})

describe('Background words (docs/ui-copy.md, the plan’s UX copy)', () => {
  it('says where the effect runs and what a blur can still show, never that the room is gone', () => {
    expect(CAMERA_BACKGROUND_DESCRIPTION).toBe(
      "Blurs or replaces what's behind you in the recording, the livestream, Clips, Videorc Camera and the room. This camera keeps it in every scene."
    )
    expect(CAMERA_BACKGROUND_HINT).toBe(
      'Works best with light on your face. Done on this Mac, before anything is recorded or sent.'
    )
    expect(CAMERA_BACKGROUND_LOCK_LINE).toBe(
      'Done on this Mac, before anything is recorded or sent.'
    )
    // American English per docs/ui-copy.md (the plan wrote "colours").
    expect(CAMERA_BACKGROUND_BLUR_CAVEAT).toBe(
      'A blur can still show large shapes and colors behind you. For full privacy, pick a picture.'
    )
  })

  it('offers Blur background or Turn off background effect by state in ⌘K', () => {
    expect(cameraBackgroundCommand(off)).toEqual({ label: 'Blur background', next: 'strong-blur' })
    expect(cameraBackgroundCommand({ ...off, mode: 'green' })).toEqual({
      label: 'Blur background',
      next: 'strong-blur'
    })
    for (const mode of ['blur', 'image', 'video', 'cutout'] as const)
      expect(cameraBackgroundCommand({ ...off, mode })).toEqual({
        label: 'Turn off background effect',
        next: 'off'
      })
    for (const word of ['blur', 'virtual background', 'background blur', 'replace background'])
      expect(CAMERA_BACKGROUND_KEYWORDS).toContain(word)
  })
})

describe('the stage line under the Camera row (mockup §3, D6)', () => {
  const status = (overrides: Partial<CameraBackgroundStatus>): CameraBackgroundStatus => ({
    mode: 'blur',
    state: 'running',
    processedFrames: 10,
    coverFrames: 0,
    ...overrides
  })

  it('says nothing while it runs, or for a cover shorter than 2 s', () => {
    expect(cameraBackgroundStageLine(undefined)).toBeNull()
    expect(cameraBackgroundStageLine(status({}))).toBeNull()
    expect(cameraBackgroundStageLine(status({ state: 'cover', coverForMs: 1999 }))).toBeNull()
    expect(cameraBackgroundStageLine(status({ state: 'cover' }))).toBeNull()
    // A screen key has no stage to report.
    expect(
      cameraBackgroundStageLine(status({ mode: 'green', state: 'cover', coverForMs: 9000 }))
    ).toBeNull()
  })

  it('says what viewers see while the cover stands in, never the room', () => {
    expect(cameraBackgroundStageLine(status({ state: 'cover', coverForMs: 2000 }))?.text).toBe(
      "Background is catching up. Viewers see your whole camera blurred until it's back."
    )
    expect(
      cameraBackgroundStageLine(status({ mode: 'image', state: 'cover', coverForMs: 5000 }))?.text
    ).toBe("Background is catching up. Viewers see only your picture until it's back.")
    expect(cameraBackgroundStageLine(status({ state: 'unavailable' }))).toEqual({
      tone: 'warning',
      text: "Background effects can't run on this Mac right now. Viewers see your whole camera blurred until you turn the effect off."
    })
  })
})

describe('What viewers see', () => {
  it('reads the camera store’s newest frame, with the token, a width and the last frame seen', () => {
    const connection = { host: '127.0.0.1', port: 4100, token: 'tok en' }
    expect(cameraFrameUrl(connection, null)).toBe(
      'http://127.0.0.1:4100/preview/camera/latest.bmp?token=tok+en&maxWidth=640'
    )
    expect(cameraFrameUrl(connection, { generation: 'run-1', sequence: 42 }, 320)).toBe(
      'http://127.0.0.1:4100/preview/camera/latest.bmp?token=tok+en&maxWidth=320&afterGeneration=run-1&afterSequence=42'
    )
  })
})
