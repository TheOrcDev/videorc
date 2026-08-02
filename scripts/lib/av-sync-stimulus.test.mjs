import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { resolveAvSyncStimulusBrowser } from './av-sync-stimulus.mjs'

describe('resolveAvSyncStimulusBrowser', () => {
  it('uses the shared Windows resolver and reports the exact audible-stimulus executable', () => {
    const browser = 'C:/Program Files/Microsoft/Edge/Application/msedge.exe'
    assert.deepEqual(
      resolveAvSyncStimulusBrowser({
        platform: 'win32',
        env: { VIDEORC_STIMULUS_BROWSER: browser },
        exists: (path) => path === browser
      }),
      {
        executablePath: browser,
        source: 'VIDEORC_STIMULUS_BROWSER',
        searchedPaths: [browser]
      }
    )
  })

  it('does not inherit the macOS Chrome default when Windows has no browser', () => {
    const resolution = resolveAvSyncStimulusBrowser({
      platform: 'win32',
      env: {},
      exists: () => false
    })

    assert.equal(resolution.executablePath, null)
    assert.ok(
      resolution.searchedPaths.every(
        (path) => path !== '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
      )
    )
  })
})
