// @vitest-environment happy-dom
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createContext, runInContext } from 'node:vm'

import { describe, expect, it } from 'vitest'

// Run the proof document's own applyScene and upsertLayer against a DOM,
// without starting Electron: the regression is the stacking the DOM order
// produces, since every scene source layer shares one z-index.
// happy-dom swaps import.meta.url's scheme for URL, so the path goes through
// fileURLToPath.
const documentSource = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), 'index.ts'),
  'utf8'
)

function sceneCallbacksSource(): string {
  const from = documentSource.indexOf('function upsertLayer(')
  const to = documentSource.indexOf('window.__videorcSetPreviewScene = applyScene', from)
  if (from < 0 || to < from) throw new Error('Missing proof surface scene callbacks')
  return documentSource.slice(from, to)
}

function proofScene() {
  document.body.innerHTML = '<div id="scene-root"></div>'
  const root = document.getElementById('scene-root') as HTMLElement
  const noop = (): void => {}
  const context = createContext({
    document,
    window,
    root,
    layers: new Map(),
    overlayPollers: new Map(),
    scene: null,
    liveLayerCount: 0,
    nextScene: null,
    percent: (value: unknown) => `${Number(value ?? 0) * 100}%`,
    layerBorderRadius: () => '',
    cropStyle: () => ({ left: '0', top: '0', width: '100%', height: '100%' }),
    layoutSceneStage: noop,
    stopMissingPollers: noop,
    stopMissingOverlayPollers: noop,
    teardownLiveBackground: noop,
    stopLayerPoller: noop,
    stopOverlayPoller: noop,
    startOverlayPolling: noop,
    placeOverlayElement: noop,
    startFramePolling: noop,
    syncLiveBackgroundLayer: noop,
    liveBackgroundNow: () => 0,
    markLive: noop,
    updateProofReadout: noop
  })
  runInContext(sceneCallbacksSource(), context)
  return {
    apply(ids: string[]): void {
      context.nextScene = {
        revision: 1,
        sources: ids.map((id) => ({
          id,
          kind: id,
          visible: true,
          transform: { x: 0, y: 0, width: 1, height: 1 },
          frameUrl: `http://127.0.0.1/frames/${id}`
        }))
      }
      runInContext('applyScene(nextScene)', context)
    },
    order: (): Array<string | undefined> =>
      Array.from(root.children, (element) => (element as HTMLElement).dataset.layerId),
    element: (id: string): Element | null => root.querySelector(`[data-layer-id="${id}"]`)
  }
}

describe('proof surface scene layer order', () => {
  it('stacks a source the scene dropped and brought back where the scene lists it', () => {
    const surface = proofScene()
    surface.apply(['screen', 'camera'])
    // Screen only, then Camera only, then Screen + camera: the screen layer is
    // removed and re-created, and must not land over the camera inset.
    surface.apply(['screen'])
    surface.apply(['camera'])
    surface.apply(['screen', 'camera'])

    expect(surface.order()).toEqual(['screen', 'camera'])
  })

  it('restacks layers when the scene reorders its sources', () => {
    const surface = proofScene()
    surface.apply(['screen', 'camera', 'image'])
    surface.apply(['image', 'screen', 'camera'])

    expect(surface.order()).toEqual(['image', 'screen', 'camera'])
  })

  it('keeps the existing layer elements, so their frames are not reloaded', () => {
    const surface = proofScene()
    surface.apply(['screen', 'camera'])
    const screen = surface.element('screen')
    const camera = surface.element('camera')

    surface.apply(['camera', 'screen'])

    expect(surface.order()).toEqual(['camera', 'screen'])
    expect(surface.element('screen')).toBe(screen)
    expect(surface.element('camera')).toBe(camera)
  })
})
