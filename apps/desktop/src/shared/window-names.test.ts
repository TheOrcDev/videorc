import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { APP_MENU_WINDOWS } from './app-menu-items'
import { WINDOW_NAMES } from './window-names'

// Plan 174 S2.3a (A-11): one name per window on every surface. The HTML
// <title> wins over BrowserWindow's `title` once a page loads, so it must say
// the same; the main window stays "Videorc".

const RENDERER = join(__dirname, '..', 'renderer')

function htmlTitle(file: string): string | undefined {
  return /<title>([^<]*)<\/title>/.exec(readFileSync(join(RENDERER, file), 'utf8'))?.[1]
}

describe('window names', () => {
  it('are the glossary names, never "Videorc …" or "… window"', () => {
    expect(WINDOW_NAMES).toEqual({
      preview: 'Preview',
      notes: 'Notes',
      streamManager: 'Stream Manager',
      captions: 'Captions reader'
    })
  })

  it('title each window page the same way', () => {
    expect(htmlTitle('notes.html')).toBe(WINDOW_NAMES.notes)
    expect(htmlTitle('comments.html')).toBe(WINDOW_NAMES.streamManager)
    expect(htmlTitle('captions.html')).toBe(WINDOW_NAMES.captions)
    expect(htmlTitle('index.html')).toBe('Videorc')
  })

  it('name the Window menu items', () => {
    expect(APP_MENU_WINDOWS.map((window) => window.label)).toEqual([
      WINDOW_NAMES.preview,
      WINDOW_NAMES.notes,
      WINDOW_NAMES.streamManager,
      WINDOW_NAMES.captions
    ])
  })

  it('title the main-process windows', () => {
    const main = readFileSync(join(__dirname, '..', 'main', 'index.ts'), 'utf8')
    expect(main).not.toMatch(/title: 'Videorc (Notes|Stream Manager|Captions|Preview)'/)
    for (const key of ['notes', 'streamManager', 'captions', 'preview'] as const) {
      expect(main).toContain(`title: WINDOW_NAMES.${key},`)
    }
  })
})
