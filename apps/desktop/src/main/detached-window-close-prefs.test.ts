import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import {
  COMMENTS_WINDOW_HIDDEN_FROM_STREAM_PREFERENCE_VERSION,
  commentsWindowHiddenFromStreamPreference
} from './comments-window-prefs'

// Every detached window reopens at launch when its prefs say `open: true`
// (restore<Name>WindowOnLaunch), so its close handler must keep `open` as it
// was when quitting closes it: `previewWindowClosePrefs(frame, closingForQuit())`.
// The Preview got that rule first; Notes, the Stream Manager and Captions
// still wrote `open: false` on every close, so they never came back after a
// quit (E2E 2026-11-01, #978). Off macOS, closing the Studio is a quit too, but
// it closes these windows before `before-quit` sets `appIsQuitting`.
const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'index.ts'), 'utf8')

function closeHandlers(name: string): string {
  const from = source.indexOf(`async function open${name}Window(`)
  const to = source.indexOf(`window.on('closed'`, from)
  expect(from).toBeGreaterThan(-1)
  expect(to).toBeGreaterThan(from)
  return source.slice(from, to)
}

describe('detached window close prefs (main/index.ts)', () => {
  for (const name of ['Preview', 'Notes', 'Comments', 'Captions']) {
    it(`${name} keeps its open state when quitting closes it`, () => {
      const frame = `${name.toLowerCase()}WindowLastFrame`
      expect(source).toContain(`function restore${name}WindowOnLaunch(`)
      const handlers = closeHandlers(name)
      expect(handlers).toContain(
        `save${name}WindowPrefs(previewWindowClosePrefs(${frame}, closingForQuit()))`
      )
      expect(handlers).not.toContain('open: false')
    })
  }

  it('closing the Studio off macOS counts as quitting for the windows it closes', () => {
    expect(source).toMatch(
      /app\.on\('window-all-closed', \(\) => \{\s+if \(process\.platform !== 'darwin'\) \{\s+app\.quit\(\)/
    )
    expect(source).toContain('return appIsQuitting || studioClosedToQuit')
    const from = source.indexOf('previewLifecycleEvidence.bindMainWindow(mainWindow, () => {')
    expect(from).toBeGreaterThan(-1)
    const flag = source.indexOf("studioClosedToQuit = process.platform !== 'darwin'", from)
    expect(flag).toBeGreaterThan(from)
    for (const name of ['preview', 'notes', 'comments', 'captions']) {
      expect(source.indexOf(`${name}Window.close()`, from)).toBeGreaterThan(flag)
    }
  })
})

// Plan 215 C1: Hide from stream is remembered in comments-window.json with a
// version, like the pin. A file from before the switch (no field), a bare
// `true` without its version, or a forged value all load as off: the
// 2026-08-19 rule (the Stream Manager is on stream) stays the default.
describe('Stream Manager: Hide from stream preference (comments-window.json)', () => {
  it('loads as off from an old or forged file and on only under its version', () => {
    expect(commentsWindowHiddenFromStreamPreference({})).toBe(false)
    expect(commentsWindowHiddenFromStreamPreference({ hiddenFromStream: true })).toBe(false)
    expect(
      commentsWindowHiddenFromStreamPreference({
        hiddenFromStream: 'true',
        hiddenFromStreamPreferenceVersion: COMMENTS_WINDOW_HIDDEN_FROM_STREAM_PREFERENCE_VERSION
      })
    ).toBe(false)
    expect(
      commentsWindowHiddenFromStreamPreference({
        hiddenFromStream: true,
        hiddenFromStreamPreferenceVersion: COMMENTS_WINDOW_HIDDEN_FROM_STREAM_PREFERENCE_VERSION + 1
      })
    ).toBe(false)
    expect(
      commentsWindowHiddenFromStreamPreference({
        hiddenFromStream: true,
        hiddenFromStreamPreferenceVersion: COMMENTS_WINDOW_HIDDEN_FROM_STREAM_PREFERENCE_VERSION
      })
    ).toBe(true)
    expect(
      commentsWindowHiddenFromStreamPreference({
        hiddenFromStream: false,
        hiddenFromStreamPreferenceVersion: COMMENTS_WINDOW_HIDDEN_FROM_STREAM_PREFERENCE_VERSION
      })
    ).toBe(false)
  })

  it('is read through that rule and written with its version (main/index.ts)', () => {
    const reader = source.indexOf('function commentsHiddenFromStream(')
    expect(reader).toBeGreaterThan(-1)
    expect(source.slice(reader, reader + 400)).toContain(
      'commentsWindowHiddenFromStreamPreference('
    )
    const setter = source.indexOf('function setCommentsWindowHiddenFromStream(')
    expect(setter).toBeGreaterThan(-1)
    expect(source.slice(setter, setter + 800)).toContain(
      'hiddenFromStreamPreferenceVersion: COMMENTS_WINDOW_HIDDEN_FROM_STREAM_PREFERENCE_VERSION'
    )
    // The open path applies the remembered switch before the window shows.
    const open = closeHandlers('Comments')
    expect(open).toContain('applyCommentsWindowCaptureProtection()')
  })
})
