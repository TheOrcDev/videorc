import { describe, expect, it, vi } from 'vitest'

import type { SceneSource } from './backend'
import { editScene, sceneEditTarget } from './edit-scene'

// Plan 215 D4 (B1): every Edit scene door opens the Scene page with the
// editor on and the camera selected.

const source = (id: string, kind: SceneSource['kind'], locked = false): SceneSource =>
  ({ id, kind, locked }) as SceneSource

function door(sources: SceneSource[] | null) {
  return {
    scene: sources ? { sources } : null,
    openScenePage: vi.fn(),
    selectBanner: vi.fn(),
    selectSource: vi.fn(),
    setEditMode: vi.fn()
  }
}

describe('Edit scene (plan 215 B1)', () => {
  it('opens the Scene page, selects the camera and turns the editor on', () => {
    const edit = door([source('screen', 'screen'), source('camera', 'camera')])
    editScene(edit)
    expect(edit.openScenePage).toHaveBeenCalledOnce()
    expect(edit.selectSource).toHaveBeenCalledExactlyOnceWith('camera')
    expect(edit.setEditMode).toHaveBeenCalledExactlyOnceWith(true)
    // A banner left selected would win the stage's one selection.
    expect(edit.selectBanner).toHaveBeenCalledExactlyOnceWith(null)
  })

  it('selects the first source that can move when there is no camera', () => {
    expect(sceneEditTarget({ sources: [source('screen', 'screen'), source('w', 'window')] })).toBe(
      'screen'
    )
    expect(
      sceneEditTarget({ sources: [source('screen', 'screen', true), source('w', 'window')] })
    ).toBe('w')
    expect(
      sceneEditTarget({ sources: [source('camera', 'camera', true), source('w', 'window')] })
    ).toBe('w')
  })

  it('still opens the editor with nothing to select, and keeps the selection', () => {
    for (const sources of [null, [], [source('screen', 'screen', true)]]) {
      const edit = door(sources)
      editScene(edit)
      expect(edit.openScenePage).toHaveBeenCalledOnce()
      expect(edit.selectSource).not.toHaveBeenCalled()
      expect(edit.selectBanner).not.toHaveBeenCalled()
      expect(edit.setEditMode).toHaveBeenCalledExactlyOnceWith(true)
    }
  })
})
