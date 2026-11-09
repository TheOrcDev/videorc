import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  MAIN_WINDOW_DEFAULT_SIZE,
  MAIN_WINDOW_MINIMUM_SIZE,
  formatWindowSize,
  mainWindowSizeVerdict,
  parseWindowSize,
  viewportChange
} from './main-window-size.mjs'

describe('main window size', () => {
  it('parses a requested size and falls back to the default', () => {
    assert.deepEqual(parseWindowSize('960x660'), { width: 960, height: 660 })
    assert.deepEqual(parseWindowSize(' 1180×780 '), { width: 1180, height: 780 })
    assert.deepEqual(parseWindowSize(undefined), MAIN_WINDOW_DEFAULT_SIZE)
    assert.deepEqual(parseWindowSize(''), MAIN_WINDOW_DEFAULT_SIZE)
    assert.throws(() => parseWindowSize('1180'), /WIDTHxHEIGHT/)
    assert.throws(() => parseWindowSize('wide'), /got wide/)
  })

  it('formats a size and says none for a missing one', () => {
    assert.equal(formatWindowSize({ width: 1180, height: 750.6 }), '1180x751')
    assert.equal(formatWindowSize(null), 'none')
    assert.equal(formatWindowSize({ width: 701 }), 'none')
  })

  it('accepts the requested size, within a setBounds rounding', () => {
    for (const bounds of [
      { width: 1180, height: 780 },
      { width: 1182, height: 778 }
    ]) {
      const verdict = mainWindowSizeVerdict({ requested: { width: 1180, height: 780 }, bounds })
      assert.equal(verdict.ok, true, JSON.stringify(bounds))
      assert.equal(verdict.message, null)
    }
    assert.equal(
      mainWindowSizeVerdict({
        requested: MAIN_WINDOW_MINIMUM_SIZE,
        bounds: MAIN_WINDOW_MINIMUM_SIZE
      }).ok,
      true
    )
  })

  it('names the sizes when a tiling window manager put the window below the minimum', () => {
    // The QA run on Hyprland: 1180x780 asked, the tile was 701x821.
    const verdict = mainWindowSizeVerdict({
      requested: { width: 1180, height: 780 },
      bounds: { width: 701, height: 821 },
      viewport: { width: 701, height: 821 }
    })
    assert.equal(verdict.ok, false)
    assert.match(verdict.message, /below the app's 960x660 minimum/)
    assert.match(verdict.message, /asked for 1180x780, the window is 701x821 \(viewport 701x821\)/)
    assert.match(verdict.message, /not a layout result/)
  })

  it('names the sizes when the window manager kept another supported size', () => {
    const verdict = mainWindowSizeVerdict({
      requested: { width: 1180, height: 780 },
      bounds: { width: 1424, height: 868 },
      viewport: { width: 1424, height: 868 }
    })
    assert.equal(verdict.ok, false)
    assert.match(verdict.message, /did not apply the requested main window size/)
    assert.match(verdict.message, /asked for 1180x780, the window is 1424x868/)
  })

  it('holds a request below the minimum to the minimum, as the app does', () => {
    const atMinimum = mainWindowSizeVerdict({
      requested: { width: 800, height: 560 },
      bounds: { width: 960, height: 660 }
    })
    assert.equal(atMinimum.ok, true)
    assert.deepEqual(atMinimum.expected, MAIN_WINDOW_MINIMUM_SIZE)

    const honoured = mainWindowSizeVerdict({
      requested: { width: 800, height: 560 },
      bounds: { width: 800, height: 560 }
    })
    assert.equal(honoured.ok, false)
    assert.match(honoured.message, /asked for 800x560 \(the app's minimum makes that 960x660\)/)
  })

  it('fails a window that reported no size', () => {
    const verdict = mainWindowSizeVerdict({ requested: MAIN_WINDOW_DEFAULT_SIZE, bounds: null })
    assert.equal(verdict.ok, false)
    assert.match(verdict.message, /reported no size/)
  })

  it('names a viewport that changed between two compared measurements', () => {
    assert.equal(viewportChange({ width: 1180, height: 780 }, { width: 1180, height: 780 }), null)
    assert.equal(viewportChange(null, { width: 701, height: 821 }), null)
    assert.match(
      viewportChange({ width: 1180, height: 780 }, { width: 701, height: 821 }),
      /from 1180x780 to 701x821/
    )
  })
})
