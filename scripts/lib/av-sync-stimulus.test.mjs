import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { resolveAvSyncStimulusBrowser, stopAvSyncStimulus } from './av-sync-stimulus.mjs'

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

describe('stopAvSyncStimulus', () => {
  it('returns the shared graceful Windows browser-tree teardown proof', async () => {
    let alive = true
    const calls = []
    const result = await stopAvSyncStimulus(
      { child: { pid: 7654 }, dir: 'C:/temp/av-stimulus' },
      {
        platform: 'win32',
        isTreeAlive: () => alive,
        taskkill: (pid, { force }) => {
          calls.push({ pid, force })
          alive = false
          return { succeeded: true }
        },
        waitForTreeExit: async ({ isTreeAlive }) => !isTreeAlive(),
        removeDirectory: () => {}
      }
    )

    assert.deepEqual(calls, [{ pid: 7654, force: false }])
    assert.equal(result.state, 'terminated')
    assert.equal(result.forced, false)
    assert.equal(result.treeExited, true)
    assert.equal(result.directoryRemoved, true)
  })
})
