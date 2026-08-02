// Run: node --test scripts/lib/screen-motion-stimulus.test.mjs

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  macApplicationNameFromPath,
  resolveWindowsStimulusBrowser,
  stimulusVisibilityFromRgb,
  stimulusWindowOptionsFromDisplayBounds
} from './screen-motion-stimulus.mjs'

describe('resolveWindowsStimulusBrowser', () => {
  it('prefers the explicit shared browser over installed Edge and Chrome', () => {
    const explicit = 'D:/Browsers/Chromium/chrome.exe'
    const installed = 'C:/Program Files/Microsoft/Edge/Application/msedge.exe'
    const result = resolveWindowsStimulusBrowser({
      env: {
        VIDEORC_STIMULUS_BROWSER: explicit,
        ProgramFiles: 'C:/Program Files',
        LOCALAPPDATA: 'C:/Users/test/AppData/Local'
      },
      exists: (path) => path === explicit || path === installed
    })

    assert.equal(result.executablePath, explicit)
    assert.equal(result.source, 'VIDEORC_STIMULUS_BROWSER')
  })

  it('discovers Edge and Chrome under Program Files and Local AppData in order', () => {
    const edge = 'C:/Program Files/Microsoft/Edge/Application/msedge.exe'
    assert.equal(
      resolveWindowsStimulusBrowser({
        env: {
          ProgramFiles: 'C:/Program Files',
          'ProgramFiles(x86)': 'C:/Program Files (x86)',
          LOCALAPPDATA: 'C:/Users/test/AppData/Local'
        },
        exists: (path) => path === edge
      }).executablePath,
      edge
    )

    const localChrome = 'C:/Users/test/AppData/Local/Google/Chrome/Application/chrome.exe'
    assert.equal(
      resolveWindowsStimulusBrowser({
        env: {
          ProgramFiles: 'C:/Program Files',
          'ProgramFiles(x86)': 'C:/Program Files (x86)',
          LOCALAPPDATA: 'C:/Users/test/AppData/Local'
        },
        exists: (path) => path === localChrome
      }).executablePath,
      localChrome
    )
  })

  it('returns a deterministic missing-browser result instead of a macOS Chrome default', () => {
    const result = resolveWindowsStimulusBrowser({
      env: {
        ProgramFiles: 'C:/Program Files',
        LOCALAPPDATA: 'C:/Users/test/AppData/Local'
      },
      exists: () => false
    })

    assert.equal(result.executablePath, null)
    assert.equal(result.source, null)
    assert.ok(result.searchedPaths.every((path) => !path.startsWith('/Applications/')))
    assert.ok(result.searchedPaths.some((path) => path.endsWith('msedge.exe')))
    assert.ok(result.searchedPaths.some((path) => path.endsWith('chrome.exe')))
  })
})

describe('stimulusWindowOptionsFromDisplayBounds', () => {
  it('places the stimulus inside a non-primary display with negative y bounds', () => {
    assert.deepEqual(
      stimulusWindowOptionsFromDisplayBounds({ x: 1512, y: -56, width: 1920, height: 1080 }),
      { x: 1528, y: -40, width: 1888, height: 1048 }
    )
  })

  it('keeps a usable minimum window for small or odd display bounds', () => {
    assert.deepEqual(
      stimulusWindowOptionsFromDisplayBounds({ x: 0, y: 0, width: 400, height: 300 }),
      { x: 16, y: 16, width: 640, height: 480 }
    )
  })
})

describe('macApplicationNameFromPath', () => {
  it('extracts the macOS app bundle name from a browser executable path', () => {
    assert.equal(
      macApplicationNameFromPath('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'),
      'Google Chrome'
    )
  })

  it('returns null for non-app paths', () => {
    assert.equal(macApplicationNameFromPath('/usr/bin/chromium'), null)
  })
})

describe('stimulusVisibilityFromRgb', () => {
  it('passes when the screenshot contains the full stimulus color signature', () => {
    const verdict = stimulusVisibilityFromRgb(
      rgbPixels([
        [0, 0, 0],
        [255, 255, 255],
        [255, 43, 43],
        [49, 255, 116],
        [29, 111, 255],
        [0, 229, 255],
        [255, 43, 214],
        [255, 232, 74]
      ]),
      { minimumColorPixels: 2, minimumColorRatio: 0 }
    )

    assert.equal(verdict.visible, true)
    assert.deepEqual(verdict.missingColors, [])
  })

  it('fails when key stimulus colors are missing', () => {
    const verdict = stimulusVisibilityFromRgb(
      rgbPixels([
        [0, 0, 0],
        [255, 255, 255],
        [29, 111, 255]
      ]),
      { minimumColorPixels: 2, minimumColorRatio: 0 }
    )

    assert.equal(verdict.visible, false)
    assert.match(verdict.reason, /missing required stimulus color signature/)
    assert.ok(verdict.missingColors.includes('cyan'))
    assert.ok(verdict.missingColors.includes('magenta'))
    assert.ok(verdict.missingColors.includes('yellow'))
  })

  it('passes when one supporting patch color is lost to screenshot color management', () => {
    const verdict = stimulusVisibilityFromRgb(
      rgbPixels([
        [0, 0, 0],
        [255, 255, 255],
        [255, 43, 43],
        [29, 111, 255],
        [0, 229, 255],
        [255, 43, 214],
        [255, 232, 74]
      ]),
      { minimumColorPixels: 2, minimumColorRatio: 0 }
    )

    assert.equal(verdict.visible, true)
    assert.deepEqual(verdict.missingColors, ['green'])
  })
})

function rgbPixels(colors) {
  const bytes = []
  for (const color of colors) {
    for (let index = 0; index < 3; index += 1) bytes.push(...color)
  }
  return Buffer.from(bytes)
}
