// Run: node --test scripts/lib/screen-motion-stimulus.test.mjs

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  macApplicationNameFromPath,
  resolveWindowsStimulusBrowser,
  stopScreenMotionStimulus,
  stimulusTemporalVisibilityFromRgb,
  stimulusVisibilityFromRgb,
  stimulusWindowOptionsFromDisplayBounds,
  windowsStimulusTaskkillArgs
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
        exists: (path) => path.replaceAll('\\', '/') === edge
      }).executablePath.replaceAll('\\', '/'),
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
        exists: (path) => path.replaceAll('\\', '/') === localChrome
      }).executablePath.replaceAll('\\', '/'),
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

describe('stimulusTemporalVisibilityFromRgb', () => {
  const frameWidth = 8
  const frameHeight = 3
  const signatureColors = [
    [0, 0, 0],
    [255, 255, 255],
    [255, 43, 43],
    [49, 255, 116],
    [29, 111, 255],
    [0, 229, 255],
    [255, 43, 214],
    [255, 232, 74]
  ]
  const signatureFrame = (frame = 0) => {
    const offset = frame % signatureColors.length
    return rgbPixels([...signatureColors.slice(offset), ...signatureColors.slice(0, offset)])
  }
  const blackFrame = () => Buffer.alloc(frameWidth * frameHeight * 3)
  const options = {
    width: frameWidth,
    height: frameHeight,
    minimumColorPixels: 2,
    minimumColorRatio: 0
  }

  it('passes when the stimulus signature is visible throughout fixed-size RGB frames', () => {
    const verdict = stimulusTemporalVisibilityFromRgb(
      Buffer.concat(Array.from({ length: 20 }, (_, index) => signatureFrame(index))),
      { ...options, expectedFrames: 20 }
    )

    assert.equal(verdict.visible, true)
    assert.equal(verdict.visibleFrames, 20)
    assert.equal(verdict.visibleFrameRatio, 1)
    assert.equal(verdict.changedFramePairs, 19)
    assert.equal(verdict.changedFrameRatio, 1)
    assert.equal(verdict.frameCountMatches, true)
    assert.equal(verdict.aggregateVisibility.visible, true)
  })

  it('accepts exactly 95% visible frames and reports the failed frame index', () => {
    const frames = Array.from({ length: 20 }, (_, index) => signatureFrame(index))
    frames[7] = blackFrame()
    const verdict = stimulusTemporalVisibilityFromRgb(Buffer.concat(frames), {
      ...options,
      expectedFrames: 20
    })

    assert.equal(verdict.visible, true)
    assert.equal(verdict.visibleFrames, 19)
    assert.equal(verdict.visibleFrameRatio, 0.95)
    assert.deepEqual(verdict.invisibleFrameIndices, [7])
  })

  it('rejects identical signature-bearing frames because a frozen capture is not live', () => {
    const verdict = stimulusTemporalVisibilityFromRgb(
      Buffer.concat(Array.from({ length: 20 }, () => signatureFrame(0))),
      { ...options, expectedFrames: 20 }
    )

    assert.equal(verdict.aggregateVisibility.visible, true)
    assert.equal(verdict.visibleFrames, 20)
    assert.equal(verdict.changedFramePairs, 0)
    assert.equal(verdict.changedFrameRatio, 0)
    assert.equal(verdict.visible, false)
    assert.match(verdict.reason, /stimulus changed in 0\/19 adjacent frame pairs/)
  })

  it('accepts the documented 95% adjacent-frame motion threshold', () => {
    const frames = Array.from({ length: 21 }, (_, index) => signatureFrame(index))
    frames[10] = frames[9]
    const verdict = stimulusTemporalVisibilityFromRgb(Buffer.concat(frames), {
      ...options,
      expectedFrames: 21
    })

    assert.equal(verdict.changedFramePairs, 19)
    assert.equal(verdict.changedFrameRatio, 0.95)
    assert.deepEqual(verdict.staticTransitionIndices, [10])
    assert.equal(verdict.visible, true)
  })

  it('rejects a brief signature transient among mostly-black frames', () => {
    const frames = Array.from({ length: 20 }, blackFrame)
    frames[9] = signatureFrame()
    const verdict = stimulusTemporalVisibilityFromRgb(Buffer.concat(frames), {
      ...options,
      expectedFrames: 20
    })

    assert.equal(verdict.aggregateVisibility.visible, true)
    assert.equal(verdict.visible, false)
    assert.equal(verdict.visibleFrames, 1)
    assert.equal(verdict.visibleFrameRatio, 0.05)
    assert.match(verdict.reason, /requires at least 95\.00%/)
  })

  it('fails closed on a partial frame or an unexpected decoded frame count', () => {
    const partial = stimulusTemporalVisibilityFromRgb(
      Buffer.concat([signatureFrame(), Buffer.from([0, 0])]),
      { ...options, expectedFrames: 1 }
    )
    assert.equal(partial.visible, false)
    assert.equal(partial.trailingBytes, 2)
    assert.match(partial.reason, /trailing RGB bytes/)

    const missing = stimulusTemporalVisibilityFromRgb(signatureFrame(), {
      ...options,
      expectedFrames: 2
    })
    assert.equal(missing.visible, false)
    assert.equal(missing.frameCountMatches, false)
    assert.match(missing.reason, /decoded 1 frames, expected 2/)
  })

  it('does not allow qualification callers to lower temporal coverage below 95%', () => {
    const verdict = stimulusTemporalVisibilityFromRgb(signatureFrame(), {
      ...options,
      minimumVisibleFrameRatio: 0.5,
      minimumChangedFrameRatio: 0.5
    })

    assert.equal(verdict.visible, false)
    assert.match(verdict.reason, /minimumVisibleFrameRatio must be between 0\.95 and 1/)
    assert.match(verdict.reason, /minimumChangedFrameRatio must be between 0\.95 and 1/)
  })
})

describe('stopScreenMotionStimulus', () => {
  it('builds the exact graceful and forced Windows taskkill tree commands', () => {
    assert.deepEqual(windowsStimulusTaskkillArgs(4321), ['/PID', '4321', '/T'])
    assert.deepEqual(windowsStimulusTaskkillArgs(4321, { force: true }), [
      '/PID',
      '4321',
      '/T',
      '/F'
    ])
    assert.throws(() => windowsStimulusTaskkillArgs(0), /positive integer/)
  })

  it('attempts graceful Windows tree shutdown without /F and returns teardown proof', async () => {
    let alive = true
    const taskkillCalls = []
    const removed = []
    const result = await stopScreenMotionStimulus(
      { child: { pid: 4321 }, dir: 'C:/temp/stimulus' },
      {
        platform: 'win32',
        isTreeAlive: () => alive,
        taskkill: (pid, { force }) => {
          taskkillCalls.push({ pid, force })
          alive = false
          return { succeeded: true }
        },
        waitForTreeExit: async ({ isTreeAlive }) => !isTreeAlive(),
        removeDirectory: (directory) => removed.push(directory)
      }
    )

    assert.deepEqual(taskkillCalls, [{ pid: 4321, force: false }])
    assert.equal(result.state, 'terminated')
    assert.equal(result.forced, false)
    assert.equal(result.treeExited, true)
    assert.equal(result.graceful.method, 'taskkill-tree')
    assert.equal(result.graceful.succeeded, true)
    assert.equal(result.recovery.attempted, false)
    assert.equal(result.directoryRemoved, true)
    assert.deepEqual(removed, ['C:/temp/stimulus'])
  })

  it('uses Windows /F recovery only after the graceful tree remains live', async () => {
    let alive = true
    const taskkillCalls = []
    const result = await stopScreenMotionStimulus(
      { child: { pid: 5432 }, dir: 'C:/temp/stimulus' },
      {
        platform: 'win32',
        isTreeAlive: () => alive,
        taskkill: (pid, { force }) => {
          taskkillCalls.push({ pid, force })
          if (force) alive = false
          return { succeeded: true }
        },
        waitForTreeExit: async ({ isTreeAlive }) => !isTreeAlive(),
        removeDirectory: () => {}
      }
    )

    assert.deepEqual(taskkillCalls, [
      { pid: 5432, force: false },
      { pid: 5432, force: true }
    ])
    assert.equal(result.state, 'force-terminated')
    assert.equal(result.forced, true)
    assert.equal(result.treeExited, true)
    assert.equal(result.recovery.method, 'taskkill-tree-force')
    assert.equal(result.recovery.succeeded, true)
  })

  it('preserves POSIX process-group escalation and reports a leaked tree', async () => {
    const signals = []
    const result = await stopScreenMotionStimulus(
      { child: { pid: 6543 } },
      {
        platform: 'darwin',
        isTreeAlive: () => true,
        signalTree: (pid, signal) => {
          signals.push({ pid, signal })
          return true
        },
        waitForTreeExit: async () => false
      }
    )

    assert.deepEqual(signals, [
      { pid: 6543, signal: 'SIGTERM' },
      { pid: 6543, signal: 'SIGKILL' }
    ])
    assert.equal(result.state, 'leaked')
    assert.equal(result.forced, true)
    assert.equal(result.treeExited, false)
    assert.equal(result.livenessScope, 'posix-process-group')
  })
})

function rgbPixels(colors) {
  const bytes = []
  for (const color of colors) {
    for (let index = 0; index < 3; index += 1) bytes.push(...color)
  }
  return Buffer.from(bytes)
}
