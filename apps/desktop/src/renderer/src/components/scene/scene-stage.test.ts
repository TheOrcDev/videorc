// @vitest-environment happy-dom
import { act, createElement, type ComponentProps } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { Banner, OverlayLayout, Scene, SceneEditorDraftParams } from '@/lib/backend'
import { defaultCaptureConfig } from '@/lib/capture'
import { DEFAULT_OVERLAY_LAYOUT } from '@/lib/overlay-layout'

import { bannerStageId, bannerStageItems, overlayStageItems } from './overlay-stage'
import { SceneStage, stageDraftsEnabled } from './scene-stage'

// Plan 205 S3: on the live canvas (macOS, the Preview docked in the Scene
// tab) the stage is hit-only, so its own badges are invisible, and the
// Preview draws nothing for a hidden banner. The toolbar chips carry the
// state word instead. The owner's state on 2026-10-27: one hidden banner,
// placed and selected; Buddy on the stream only; captions in the recording
// only; the highlight card on both.

const owner: Banner = {
  id: 'logo-color-600',
  name: 'logo-color-600',
  imageFile: 'logo-color-600.png',
  thumbnailFile: 'logo-color-600.thumb.png',
  width: 600,
  height: 600,
  hasAlpha: true,
  sortOrder: 0,
  shown: false,
  horizontal: { x: 0.866, y: 0.764, w: 0.1, h: 0.1 },
  vertical: { x: 0.7, y: 0.8, w: 0.2, h: 0.1 },
  showOnStream: true,
  showInRecording: true,
  opacity: 1,
  createdAt: '2026-10-26T21:38:00Z',
  updatedAt: '2026-10-26T21:38:00Z'
}

const layout: OverlayLayout = {
  ...DEFAULT_OVERLAY_LAYOUT,
  highlight: { ...DEFAULT_OVERLAY_LAYOUT.highlight, showOnStream: true, showInRecording: true },
  captions: { ...DEFAULT_OVERLAY_LAYOUT.captions, showOnStream: false, showInRecording: true },
  buddy: { ...DEFAULT_OVERLAY_LAYOUT.buddy, showOnStream: true, showInRecording: false }
}

let root: Root
let container: HTMLDivElement

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  if (!('ResizeObserver' in globalThis))
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe(): void {}
        disconnect(): void {}
      }
    )
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  document.body.innerHTML = ''
  vi.unstubAllGlobals()
})

type StageProps = ComponentProps<typeof SceneStage>

function stageProps(overrides: Partial<StageProps> = {}): StageProps {
  return {
    scene: null,
    selectedSourceId: null,
    previewOpen: true,
    liveSurface: true,
    liveDocked: true,
    onSelectSource: vi.fn(),
    onTogglePreview: vi.fn(),
    overlays: {
      items: [
        ...bannerStageItems([owner], owner.id, 'horizontal', 16 / 9),
        ...overlayStageItems(layout, 'horizontal')
      ],
      selectedId: bannerStageId(owner.id),
      drafts: [],
      editable: true,
      onSelect: vi.fn(),
      onCommit: vi.fn()
    },
    ...overrides
  }
}

async function renderStage(props: StageProps): Promise<void> {
  await act(async () => root.render(createElement(SceneStage, props)))
}

const chip = (selector: string): HTMLButtonElement =>
  document.querySelector<HTMLButtonElement>(`[data-videorc-stage-toolbar] ${selector}`)!
const word = (element: Element): string | null =>
  element.querySelector('[data-videorc-stage-chip-badge]')?.textContent ?? null
/** Painted, as opposed to the live canvas's hit-only `invisible` elements. */
const painted = (element: Element): boolean => element.closest('.invisible') === null

describe('the stage toolbar chips carry the state word (plan 205 S3)', () => {
  it("says Hidden and Stream only on the live canvas, where the stage's own badge is invisible", async () => {
    await renderStage(stageProps())
    const banner = chip(`[data-videorc-stage-banner-chip="${owner.id}"]`)
    const buddy = chip('[data-videorc-stage-overlay-chip="buddy"]')
    expect(word(banner)).toBe('Hidden')
    expect(word(buddy)).toBe('Stream only')
    expect(word(chip('[data-videorc-stage-overlay-chip="captions"]'))).toBe('Recording only')
    // Both outputs: no word at all.
    expect(word(chip('[data-videorc-stage-overlay-chip="highlight"]'))).toBeNull()
    expect(painted(banner.querySelector('[data-videorc-stage-chip-badge]')!)).toBe(true)
    expect(painted(buddy.querySelector('[data-videorc-stage-chip-badge]')!)).toBe(true)
    // The schematic's badge is still there, hit-only under the live picture.
    const stageBadge = document.querySelector(
      `[data-videorc-stage-banner="${owner.id}"] [data-videorc-stage-overlay-badge]`
    )!
    expect(stageBadge.textContent).toBe('hidden')
    expect(painted(stageBadge)).toBe(false)
  })

  it('says the word after the name, quiet, and names it to a screen reader', async () => {
    await renderStage(stageProps())
    const buddy = chip('[data-videorc-stage-overlay-chip="buddy"]')
    expect(buddy.textContent).toBe('BuddyStream only')
    expect(buddy.getAttribute('aria-label')).toBe('Select Buddy, stream only')
    const badge = buddy.querySelector('[data-videorc-stage-chip-badge]')!
    expect(badge.getAttribute('data-videorc-stage-chip-badge')).toBe('stream only')
    // The muted tier: essential, so never text-subtle, and never a coloured word.
    expect(badge.className).toContain('text-muted-foreground')
    expect(badge.className).not.toMatch(/text-subtle|text-(warning|destructive|success|live)/)
    expect(chip('[data-videorc-stage-overlay-chip="highlight"]').getAttribute('aria-label')).toBe(
      'Select Highlight'
    )
    // The selected hidden banner's chip is the pressed one.
    expect(
      chip(`[data-videorc-stage-banner-chip="${owner.id}"]`).hasAttribute('data-pressed')
    ).toBe(true)
  })

  it('says Off for an item neither output shows, on the schematic too', async () => {
    const off = {
      ...layout,
      buddy: { ...layout.buddy, showOnStream: false, showInRecording: false }
    }
    const props = stageProps({ liveSurface: false, liveDocked: false })
    await renderStage({
      ...props,
      overlays: { ...props.overlays!, items: overlayStageItems(off, 'horizontal') }
    })
    expect(word(chip('[data-videorc-stage-overlay-chip="buddy"]'))).toBe('Off')
    const stageBadge = document.querySelector(
      '[data-videorc-stage-overlay="buddy"] [data-videorc-stage-overlay-badge]'
    )!
    expect(stageBadge.textContent).toBe('off')
    expect(painted(stageBadge)).toBe(true)
  })
})

// Plan 215 D1: while a recording or a livestream runs the compositor refuses
// every draft (plan 058 decision 4), so the stage sends none, not even the
// idle hold, and paints the selection frame over the live picture instead;
// the outputs move on release.
const box = { x: 0.6, y: 0.6, width: 0.3, height: 0.3 }
const transform = { ...box, cropLeft: 0, cropTop: 0, cropRight: 0, cropBottom: 0 }
const scene: Scene = {
  id: 'scene-live',
  name: 'Live',
  sources: [
    {
      id: 'source:camera',
      name: 'Camera',
      kind: 'camera',
      transform,
      defaultTransform: transform,
      visible: true,
      locked: false
    }
  ],
  outputs: []
}

describe('no draft while live (plan 215 D1)', () => {
  it('drafts only where the picture shows, with the RPCs wired, and never while a session runs', () => {
    const live = { liveSurface: true, previewFollowsGestures: false, draftRpc: true }
    expect(stageDraftsEnabled({ ...live, draftsRefused: false })).toBe(true)
    expect(stageDraftsEnabled({ ...live, draftsRefused: true })).toBe(false)
    const floating = { liveSurface: false, previewFollowsGestures: true, draftRpc: true }
    expect(stageDraftsEnabled({ ...floating, draftsRefused: false })).toBe(true)
    expect(stageDraftsEnabled({ ...floating, draftsRefused: true })).toBe(false)
    expect(stageDraftsEnabled({ ...live, draftRpc: false, draftsRefused: false })).toBe(false)
    expect(
      stageDraftsEnabled({
        liveSurface: false,
        previewFollowsGestures: false,
        draftRpc: true,
        draftsRefused: false
      })
    ).toBe(false)
  })

  it('holds the idle selection on the live canvas, as a chrome-only draft', async () => {
    const onDraft = vi.fn<(params: SceneEditorDraftParams) => Promise<unknown>>(() =>
      Promise.resolve()
    )
    const props = stageProps({ scene, selectedSourceId: 'source:camera', resizeEnabled: true })
    await renderStage({
      ...props,
      overlays: { ...props.overlays!, selectedId: null },
      onDraft,
      onDraftClear: vi.fn(() => Promise.resolve())
    })
    expect(onDraft).toHaveBeenCalled()
    const held = onDraft.mock.calls.at(-1)![0]
    expect(held.sourceId).toBe('source:camera')
    expect(held.transform).toBeUndefined()
    // The compositor draws the frame, so the stage's own is hit-only.
    expect(painted(document.querySelector('[data-videorc-stage-handles] rect')!)).toBe(false)
  })

  it('sends nothing while a session runs, and paints the frame over the picture', async () => {
    const onDraft = vi.fn(() => Promise.resolve())
    const onDraftClear = vi.fn(() => Promise.resolve())
    const props = stageProps({
      scene,
      selectedSourceId: 'source:camera',
      resizeEnabled: true,
      draftsRefused: true
    })
    await renderStage({
      ...props,
      overlays: { ...props.overlays!, selectedId: null },
      onDraft,
      onDraftClear
    })
    expect(onDraft).not.toHaveBeenCalled()
    expect(onDraftClear).not.toHaveBeenCalled()
    const frame = document.querySelector('[data-videorc-stage-handles] rect')!
    expect(painted(frame)).toBe(true)
    expect(frame.getAttribute('class')).not.toContain('invisible')
    // The sources themselves stay off the picture: it shows them.
    expect(
      painted(document.querySelector('[data-videorc-stage-source="source:camera"] rect + *')!)
    ).toBe(false)
  })
})

// Plan 216 B3 and B7: the stage draws, hits and holds the PICTURE, not the
// frame. The streamer's case from 2026-11-03: their MacBook display (captured
// 2228x1440) as the screen of a 2560x1440 canvas, in Freeform with Fit, in a
// 16:9 frame at 9.3% / 90.7%. The picture is about 2021 px wide, centred.
describe('the stage box is the picture (plan 216 B)', () => {
  const NO_CROP = { cropLeft: 0, cropTop: 0, cropRight: 0, cropBottom: 0 }
  const frame = { x: 0.0932, y: 0.0932, width: 0.9068, height: 0.9068 }
  const screenScene = (box = frame): Scene => ({
    id: 'scene',
    name: 'Scene',
    outputs: [],
    sources: [
      {
        id: 'screen',
        name: 'MacBook display',
        kind: 'screen',
        deviceId: 'display-1',
        locked: false,
        visible: true,
        transform: { ...box, ...NO_CROP },
        defaultTransform: { ...box, ...NO_CROP }
      }
    ]
  })
  const macbook = { width: 2228, height: 1440 }
  const ultrawide = { width: 3440, height: 1440 }
  const layout = { ...defaultCaptureConfig.layout, arrangementMode: 'freeform' as const }
  const pictureProps = (overrides: Partial<StageProps> = {}): StageProps =>
    stageProps({
      scene: screenScene(),
      selectedSourceId: 'screen',
      overlays: undefined,
      freeform: true,
      dragEnabled: true,
      resizeEnabled: true,
      cropEnabled: true,
      layout,
      sourceSizes: { screen: macbook },
      outputWidth: 2560,
      outputHeight: 1440,
      outputAspect: 16 / 9,
      onDraft: vi.fn(async () => ({})),
      onDraftClear: vi.fn(async () => ({})),
      onCommitTransform: vi.fn(async () => ({ ok: false as const })),
      ...overrides
    })
  const bounds = (): { x: number; y: number; width: number; height: number } => {
    const rect = document.querySelector(
      '[data-videorc-stage-source="screen"] [data-videorc-stage-bounds]'
    )!
    return {
      x: Number(rect.getAttribute('x')),
      y: Number(rect.getAttribute('y')),
      width: Number(rect.getAttribute('width')),
      height: Number(rect.getAttribute('height'))
    }
  }
  // The stage's viewBox is 160 wide; a 16:9 canvas is 90 tall.
  const stageX = (fraction: number): number => fraction * 160
  const stageY = (fraction: number): number => fraction * 90

  it("draws the bounds, the selection frame and the handles on the picture for the streamer's case", async () => {
    const props = pictureProps()
    await renderStage(props)
    const box = bounds()
    expect(box.x).toBeCloseTo(stageX(389 / 2560), 2)
    expect(box.width).toBeCloseTo(stageX(2021 / 2560), 2)
    expect(box.y).toBeCloseTo(stageY(134 / 1440), 2)
    expect(box.height).toBeCloseTo(stageY(1306 / 1440), 2)
    const selection = document.querySelector('[data-videorc-stage-handles] rect')!
    expect(Number(selection.getAttribute('x'))).toBeCloseTo(box.x, 6)
    expect(Number(selection.getAttribute('width'))).toBeCloseTo(box.width, 6)
    const east = document.querySelector('[data-videorc-stage-handle="e"]')!
    const eastCentre = Number(east.getAttribute('x')) + Number(east.getAttribute('width')) / 2
    expect(eastCentre).toBeCloseTo(box.x + box.width, 2)
    // The live canvas holds the selection chrome on the picture too.
    const onDraft = props.onDraft as ReturnType<typeof vi.fn>
    const held = onDraft.mock.calls.at(-1)?.[0] as SceneEditorDraftParams | undefined
    expect(held?.sourceId).toBe('screen')
    expect(held?.chrome.selected.x).toBeCloseTo(389 / 2560, 3)
    expect(held?.chrome.selected.width).toBeCloseTo(2021 / 2560, 3)
  })

  it('draws the frame when the size is unknown or the screen fills its box', async () => {
    // The frame rounds to canvas pixels, as the compositor's box does: one
    // canvas pixel is 160 / 2560 stage units.
    await renderStage(pictureProps({ sourceSizes: {} }))
    expect(bounds().x).toBeCloseTo(stageX(frame.x), 1)
    expect(bounds().width).toBeCloseTo(stageX(frame.width), 1)
    await renderStage(pictureProps({ layout: { ...layout, horizontalScreenFraming: 'fill' } }))
    expect(bounds().x).toBeCloseTo(stageX(frame.x), 1)
    expect(bounds().width).toBeCloseTo(stageX(frame.width), 1)
  })

  it('D3: a display swap moves the picture, writes nothing, and the swap back is exact', async () => {
    // The ultrawide's saved box: the shape of its own picture.
    const saved = { x: 0, y: 184 / 1440, width: 1, height: 1072 / 1440 }
    const props = pictureProps({ scene: screenScene(saved), sourceSizes: { screen: ultrawide } })
    await renderStage(props)
    expect(bounds().x).toBeCloseTo(0, 3)
    expect(bounds().width).toBeCloseTo(160, 3)
    // Their MacBook display stands in for it.
    await renderStage({ ...props, sourceSizes: { screen: macbook } })
    expect(bounds().x).toBeCloseTo(stageX(450 / 2560), 2)
    expect(bounds().width).toBeCloseTo(stageX(1659 / 2560), 2)
    expect(bounds().height).toBeCloseTo(stageY(1072 / 1440), 2)
    // The ultrawide is back: the box is its picture again.
    await renderStage({ ...props, sourceSizes: { screen: ultrawide } })
    expect(bounds().x).toBeCloseTo(0, 3)
    expect(bounds().width).toBeCloseTo(160, 3)
    expect(props.onCommitTransform).not.toHaveBeenCalled()
  })
})
