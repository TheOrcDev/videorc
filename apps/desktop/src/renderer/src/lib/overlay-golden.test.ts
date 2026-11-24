import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import type { BuddyBubbleRenderParams, CaptionPreviewRenderParams } from '@/lib/backend'
import { BUDDY_ONBOARDING_STEP1 } from './buddy-onboarding-copy'
import {
  BUDDY_BUBBLE_SAMPLE_CANVAS,
  BUDDY_BUBBLE_SAMPLE_ZOOM,
  buddyBubbleSampleLine
} from './buddy-persona-view'
import { BUDDY_DEMO_CANVAS, BUDDY_DEMO_RECT } from './buddy-stream-demo'
import { BUDDY_TEST_BUBBLE_CANVAS, BUDDY_TEST_BUBBLE_LINE } from './buddy-test-view'
import { CAPTION_PREVIEW_SAMPLE, captionPreviewCanvas } from './captions-ui'
import { DEFAULT_OVERLAY_LAYOUT } from './overlay-layout'

// Plan 260 S1.2e: the Captions page preview and the Buddy page's samples are
// drawn by the backend, and `cargo test -p videorc-backend overlay_raster`
// holds that drawing to the renderer's goldens. These are the states the
// pages ask for, so a sample that changes its line, canvas or rect fails
// here until its golden is made again (`pnpm overlay-raster:goldens`).

interface GoldenCase {
  id: string
  request: Record<string, unknown> & { overlay: string }
}

const CASES: GoldenCase[] = JSON.parse(
  readFileSync(
    join(
      __dirname,
      '../../../../../../crates/videorc-backend/tests/fixtures/overlay-raster/cases.json'
    ),
    'utf8'
  )
).cases

function golden(id: string): Record<string, unknown> {
  const found = CASES.find((entry) => entry.id === id)
  if (!found) throw new Error(`No golden case ${id}`)
  const { overlay: _overlay, ...state } = found.request
  return state
}

describe('the pages’ drawings are golden cases', () => {
  it('draws the stream demo’s three lines on its 4K canvas', () => {
    const ids = [
      'buddy-sample-demo-greeting',
      'buddy-sample-demo-answer',
      'buddy-sample-demo-laugh'
    ]
    BUDDY_ONBOARDING_STEP1.demoBubbles.forEach((text, index) => {
      const asked: BuddyBubbleRenderParams = {
        text,
        style: 'speech',
        canvasWidth: BUDDY_DEMO_CANVAS.width,
        canvasHeight: BUDDY_DEMO_CANVAS.height,
        rect: BUDDY_DEMO_RECT
      }
      expect(golden(ids[index]!)).toEqual(asked)
    })
  })

  it('draws the test dialog’s line and the settings sample at the default corner', () => {
    const rect = DEFAULT_OVERLAY_LAYOUT.buddy.horizontal
    expect(golden('buddy-sample-test-shout-4k')).toEqual({
      text: BUDDY_TEST_BUBBLE_LINE,
      style: 'shout',
      canvasWidth: BUDDY_TEST_BUBBLE_CANVAS.width,
      canvasHeight: BUDDY_TEST_BUBBLE_CANVAS.height,
      rect
    } satisfies BuddyBubbleRenderParams)
    expect(golden('buddy-sample-settings-thought')).toEqual({
      text: buddyBubbleSampleLine('Buddy'),
      style: 'thought',
      canvasWidth: BUDDY_BUBBLE_SAMPLE_CANVAS.width,
      canvasHeight: BUDDY_BUBBLE_SAMPLE_CANVAS.height,
      rect
    } satisfies BuddyBubbleRenderParams)
    expect(golden('buddy-sample-settings-speech-zoomed')).toEqual({
      text: buddyBubbleSampleLine('Buddy'),
      style: 'speech',
      canvasWidth: BUDDY_BUBBLE_SAMPLE_CANVAS.width * BUDDY_BUBBLE_SAMPLE_ZOOM,
      canvasHeight: BUDDY_BUBBLE_SAMPLE_CANVAS.height * BUDDY_BUBBLE_SAMPLE_ZOOM,
      rect
    } satisfies BuddyBubbleRenderParams)
  })

  it('draws the Captions page’s sample at a 1080p video’s preview size', () => {
    const canvas = captionPreviewCanvas({ width: 1920, height: 1080 })
    expect(golden('caption-preview-classic-m-960x540')).toEqual({
      text: CAPTION_PREVIEW_SAMPLE,
      canvasWidth: canvas.width,
      canvasHeight: canvas.height,
      position: 'bottom',
      textSize: 'm',
      styleId: 'classic'
    } satisfies CaptionPreviewRenderParams)
  })
})
