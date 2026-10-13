// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { ResourceSelection, StreamScreen } from '@/lib/backend'

import { TakeoverScreensSection } from './takeover-screens-section'

// Plan 174 S0.3 (C-1): deleting a takeover removes its image file, so it asks.

const mocked = vi.hoisted(() => ({ core: {} as Record<string, unknown> }))
vi.mock('@/hooks/use-studio', () => ({ useStudioCore: () => mocked.core }))

const screen: StreamScreen = {
  id: 'screen-1',
  name: 'Intro card',
  imagePath: '/screens/intro.png',
  sortOrder: 0,
  status: 'ready' as never,
  createdAt: '2026-10-10T00:00:00Z',
  updatedAt: '2026-10-10T00:00:00Z'
}

let root: Root
let container: HTMLDivElement

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  mocked.core = {
    activeScreen: null,
    deleteScreen: vi.fn(async () => undefined),
    importDroppedScreenImages: vi.fn(async () => undefined),
    importScreenImages: vi.fn(async () => undefined),
    isSessionActive: false,
    reorderScreen: vi.fn(async () => undefined),
    pendingScreenImports: [],
    renameScreen: vi.fn(async () => undefined),
    screenImportPending: false,
    screenImportPhase: 'idle',
    runtimeInfo: { platform: 'darwin' },
    screens: [screen],
    screensLoaded: true,
    wsStatus: 'connected'
  }
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  document.body.innerHTML = ''
  vi.unstubAllGlobals()
})

const byTestId = (id: string): HTMLElement | null =>
  document.querySelector<HTMLElement>(`[data-testid="${id}"]`)

describe('TakeoverScreensSection delete', () => {
  it('asks before deleting, keeps the takeover on Cancel, and deletes on confirm', async () => {
    await act(async () => root.render(createElement(TakeoverScreensSection)))
    const trigger = document.querySelector<HTMLButtonElement>('[aria-label="Delete takeover"]')
    expect(trigger).not.toBeNull()
    await act(async () => trigger!.click())
    const dialog = byTestId('takeover-delete-dialog')
    expect(dialog?.textContent).toContain('Delete Intro card?')
    expect(dialog?.textContent).toContain('Its image file is deleted from this computer.')
    expect(byTestId('takeover-delete-confirm')?.textContent).toBe('Delete takeover')
    await act(async () => byTestId('takeover-delete-cancel')!.click())
    expect(mocked.core.deleteScreen).not.toHaveBeenCalled()
    expect(byTestId('takeover-delete-dialog')).toBeNull()

    await act(async () => trigger!.click())
    await act(async () => byTestId('takeover-delete-confirm')!.click())
    expect(mocked.core.deleteScreen).toHaveBeenCalledExactlyOnceWith('screen-1')
    expect(byTestId('takeover-delete-dialog')).toBeNull()
  })
})

const second: StreamScreen = { ...screen, id: 'screen-2', name: 'Outro card', sortOrder: 1 }

describe('TakeoverScreensSection tiles (plan 174 S3.10)', () => {
  it('moves a takeover from the keyboard: buttons, and Alt+arrow on the tile (C-17)', async () => {
    mocked.core = { ...mocked.core, screens: [screen, second] }
    await act(async () => root.render(createElement(TakeoverScreensSection)))
    const earlier = document.querySelectorAll<HTMLButtonElement>('[aria-label="Move earlier"]')
    const later = document.querySelectorAll<HTMLButtonElement>('[aria-label="Move later"]')
    expect(earlier[0]?.disabled).toBe(true)
    expect(later[1]?.disabled).toBe(true)
    expect(later[0]?.getAttribute('aria-keyshortcuts')).toBe('Alt+ArrowRight')
    await act(async () => later[0]!.click())
    expect(mocked.core.reorderScreen).toHaveBeenLastCalledWith('screen-1', 1)
    await act(async () => {
      later[1]!.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'ArrowLeft', altKey: true, bubbles: true })
      )
    })
    expect(mocked.core.reorderScreen).toHaveBeenLastCalledWith('screen-2', 0)
  })

  it('shows no badge on a healthy tile, no file path, and one in-use chip (C-25)', async () => {
    mocked.core = { ...mocked.core, activeScreen: screen }
    await act(async () => root.render(createElement(TakeoverScreensSection)))
    expect(document.body.textContent).not.toContain('Ready')
    expect(document.body.textContent).not.toContain('/screens/intro.png')
    expect(document.querySelectorAll('[data-videorc-in-use]')).toHaveLength(1)
    expect(document.body.textContent).toContain('Import images…')
    expect(document.body.textContent).toContain(
      'Turning one on mutes your microphone until you turn it off.'
    )
  })

  it('never says "No takeovers yet" before the list is known (J2-8)', async () => {
    mocked.core = { ...mocked.core, screens: [], screensLoaded: false }
    await act(async () => root.render(createElement(TakeoverScreensSection)))
    expect(document.body.textContent).toContain('Loading takeovers…')
    expect(document.body.textContent).not.toContain('No takeovers yet')
    mocked.core = { ...mocked.core, wsStatus: 'failed' }
    await act(async () => root.render(createElement(TakeoverScreensSection)))
    expect(document.body.textContent).not.toContain('Loading takeovers…')
    expect(document.body.textContent).not.toContain('No takeovers yet')
    mocked.core = { ...mocked.core, wsStatus: 'connected', screensLoaded: true }
    await act(async () => root.render(createElement(TakeoverScreensSection)))
    expect(document.body.textContent).toContain('No takeovers yet')
  })
})

function dragEvent(type: string, files: File[], types = files.length > 0 ? ['Files'] : []): Event {
  const event = new Event(type, { bubbles: true, cancelable: true })
  Object.defineProperty(event, 'dataTransfer', {
    value: { types, files, dropEffect: 'none' }
  })
  return event
}

const section = (): HTMLElement =>
  document.querySelector<HTMLElement>('[data-slot="panel-section"]')!

describe('TakeoverScreensSection file drop', () => {
  const photo = new File(['png'], 'photo.png', { type: 'image/png' })
  const slide = new File(['jpg'], 'slide.jpg', { type: 'image/jpeg' })

  it('hands every file dropped from the file manager to the import', async () => {
    await act(async () => root.render(createElement(TakeoverScreensSection)))
    await act(async () => section().dispatchEvent(dragEvent('dragenter', [photo, slide])))
    expect(section().hasAttribute('data-videorc-file-drop-active')).toBe(true)
    const over = dragEvent('dragover', [photo, slide])
    await act(async () => section().dispatchEvent(over))
    expect(over.defaultPrevented).toBe(true)
    await act(async () => section().dispatchEvent(dragEvent('drop', [photo, slide])))
    expect(mocked.core.importDroppedScreenImages).toHaveBeenCalledExactlyOnceWith([photo, slide])
    expect(section().hasAttribute('data-videorc-file-drop-active')).toBe(false)
  })

  it('hands files dropped on a tile to the import, without reordering', async () => {
    await act(async () => root.render(createElement(TakeoverScreensSection)))
    const tile = document.querySelector<HTMLElement>('[data-videorc-takeover-tile="screen-1"]')!
    await act(async () => tile.dispatchEvent(dragEvent('drop', [photo])))
    expect(mocked.core.importDroppedScreenImages).toHaveBeenCalledExactlyOnceWith([photo])
    expect(mocked.core.reorderScreen).not.toHaveBeenCalled()
  })

  it('ignores tile reorder drags, which carry no files', async () => {
    await act(async () => root.render(createElement(TakeoverScreensSection)))
    await act(async () => section().dispatchEvent(dragEvent('dragenter', [])))
    expect(section().hasAttribute('data-videorc-file-drop-active')).toBe(false)
    await act(async () => section().dispatchEvent(dragEvent('drop', [])))
    expect(mocked.core.importDroppedScreenImages).not.toHaveBeenCalled()
  })

  it('takes drops during a session, as the import button does', async () => {
    mocked.core = { ...mocked.core, isSessionActive: true }
    await act(async () => root.render(createElement(TakeoverScreensSection)))
    await act(async () => section().dispatchEvent(dragEvent('drop', [photo])))
    expect(mocked.core.importDroppedScreenImages).toHaveBeenCalledExactlyOnceWith([photo])
  })

  it('forgets drag enters counted before an import, whose leaves may never come', async () => {
    await act(async () => root.render(createElement(TakeoverScreensSection)))
    await act(async () => section().dispatchEvent(dragEvent('dragenter', [photo])))
    const tile = document.querySelector<HTMLElement>('[data-videorc-takeover-tile]')!
    await act(async () => tile.dispatchEvent(dragEvent('dragenter', [photo])))
    mocked.core = { ...mocked.core, screenImportPending: true, screenImportPhase: 'importing' }
    await act(async () => root.render(createElement(TakeoverScreensSection)))
    mocked.core = { ...mocked.core, screenImportPending: false, screenImportPhase: 'idle' }
    await act(async () => root.render(createElement(TakeoverScreensSection)))
    await act(async () => section().dispatchEvent(dragEvent('dragleave', [photo])))
    expect(section().hasAttribute('data-videorc-file-drop-active')).toBe(false)
  })

  it.each([
    ['while reconnecting', { wsStatus: 'failed' }],
    ['while an import runs', { screenImportPending: true, screenImportPhase: 'importing' }]
  ])('refuses drops %s', async (_when, state) => {
    mocked.core = { ...mocked.core, ...state }
    await act(async () => root.render(createElement(TakeoverScreensSection)))
    await act(async () => section().dispatchEvent(dragEvent('dragenter', [photo])))
    expect(section().hasAttribute('data-videorc-file-drop-active')).toBe(false)
    const over = dragEvent('dragover', [photo])
    await act(async () => section().dispatchEvent(over))
    expect(over.defaultPrevented).toBe(false)
    const tile = document.querySelector<HTMLElement>('[data-videorc-takeover-tile="screen-1"]')!
    const overTile = dragEvent('dragover', [photo])
    await act(async () => tile.dispatchEvent(overTile))
    expect(overTile.defaultPrevented).toBe(false)
    await act(async () => section().dispatchEvent(dragEvent('drop', [photo])))
    expect(mocked.core.importDroppedScreenImages).not.toHaveBeenCalled()
  })
})

describe('TakeoverScreensSection pending imports', () => {
  const importing = (displayName: string): ResourceSelection => ({
    capabilityId: `capability-${displayName}`,
    kind: 'input-file',
    displayName
  })
  const tileNames = (): (string | null)[] =>
    [
      ...document.querySelectorAll(
        '[data-videorc-takeover-tile], [data-videorc-takeover-importing]'
      )
    ].map((tile) => tile.getAttribute('data-videorc-takeover-tile') ?? tile.textContent)

  it('holds a placeholder after the takeovers for each image still importing', async () => {
    mocked.core = {
      ...mocked.core,
      pendingScreenImports: [importing('photo.png'), importing('slide.jpg')]
    }
    await act(async () => root.render(createElement(TakeoverScreensSection)))
    expect(tileNames()).toEqual(['screen-1', 'photo.png', 'slide.jpg'])
  })

  it('shows the placeholders, not the empty state, while the first takeovers import', async () => {
    mocked.core = { ...mocked.core, screens: [], pendingScreenImports: [importing('photo.png')] }
    await act(async () => root.render(createElement(TakeoverScreensSection)))
    expect(tileNames()).toEqual(['photo.png'])
    expect(document.body.textContent).not.toContain('No takeovers yet')
  })
})

describe('takeover import during a session', () => {
  it('allows importing during a session but keeps management locked', async () => {
    mocked.core = { ...mocked.core, isSessionActive: true, screenImportPhase: 'idle' }
    await act(async () => root.render(createElement(TakeoverScreensSection)))
    const button = byTestId('takeover-import') as HTMLButtonElement
    expect(button.disabled).toBe(false)
    await act(async () => button.click())
    expect(mocked.core.importScreenImages).toHaveBeenCalledTimes(1)
    expect(document.body.textContent).toContain('You can import images now.')
    expect(document.querySelector<HTMLInputElement>('[aria-label="Takeover name"]')?.disabled).toBe(
      true
    )
    expect(
      document.querySelector<HTMLButtonElement>('[aria-label="Delete takeover"]')?.disabled
    ).toBe(true)
    expect(document.querySelector('[data-videorc-takeover-tile]')?.getAttribute('draggable')).toBe(
      'false'
    )
  })
  it.each(['choosing', 'importing'])('prevents another import while %s', async (phase) => {
    mocked.core = {
      ...mocked.core,
      isSessionActive: true,
      screenImportPending: true,
      screenImportPhase: phase
    }
    await act(async () => root.render(createElement(TakeoverScreensSection)))
    expect((byTestId('takeover-import') as HTMLButtonElement).disabled).toBe(true)
    expect(byTestId('takeover-import')?.textContent).toBe(
      phase === 'choosing' ? 'Choosing images…' : 'Importing…'
    )
  })
  it('disables import while reconnecting and prioritizes the offline explanation', async () => {
    mocked.core = { ...mocked.core, isSessionActive: true, wsStatus: 'failed' }
    await act(async () => root.render(createElement(TakeoverScreensSection)))
    expect((byTestId('takeover-import') as HTMLButtonElement).disabled).toBe(true)
    expect(document.body.textContent).not.toContain('You can import images now.')
  })
})
