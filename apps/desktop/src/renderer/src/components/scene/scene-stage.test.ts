// @vitest-environment happy-dom
import { act, createElement, type ComponentProps } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { Banner, OverlayLayout } from '@/lib/backend'
import { DEFAULT_OVERLAY_LAYOUT } from '@/lib/overlay-layout'

import { bannerStageId, bannerStageItems, overlayStageItems } from './overlay-stage'
import { SceneStage } from './scene-stage'

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
    expect(chip(`[data-videorc-stage-banner-chip="${owner.id}"]`).getAttribute('data-state')).toBe(
      'on'
    )
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
