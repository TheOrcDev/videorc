import assert from 'node:assert/strict'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'

import { compileCaptureModule } from './lib/compile-capture-module.mjs'

const require = createRequire(import.meta.url)

const tempDir = join(tmpdir(), `videorc-source-reconciliation-${Date.now()}`)

try {
  const tempModule = await compileCaptureModule(tempDir)

  const storage = new Map()
  globalThis.localStorage = {
    getItem: (key) => storage.get(key) ?? null,
    setItem: (key, value) => storage.set(key, String(value)),
    removeItem: (key) => storage.delete(key),
    clear: () => storage.clear()
  }

  const {
    defaultCaptureConfig,
    loadCaptureConfig,
    persistableCaptureConfig,
    reconcileSourceSelection,
    sourceSelectionChangeEvents,
    STORAGE_KEYS
  } = require(tempModule)
  assert.equal(typeof reconcileSourceSelection, 'function')

  const devices = [
    device('screen:screencapturekit:222', 'Built-in Display', 'screen'),
    device('screen:screencapturekit:333', 'Studio Monitor', 'screen'),
    device('window:screencapturekit:111', 'Editor', 'window'),
    device('camera:avfoundation-native:face-time', 'FaceTime HD Camera', 'camera'),
    device('camera:avfoundation-native:desk', 'Desk Camera', 'camera'),
    device('microphone:coreaudio:podcast', 'Podcast Mic', 'microphone'),
    device('microphone:coreaudio:laptop', 'Laptop Mic', 'microphone')
  ]

  localStorage.setItem(
    STORAGE_KEYS.captureConfig,
    JSON.stringify(
      persistableCaptureConfig({
        ...defaultCaptureConfig,
        sources: {
          screenId: 'screen-old',
          screenName: 'Built-in Display',
          cameraId: 'camera-old',
          cameraName: 'FaceTime HD Camera',
          microphoneId: 'mic-old',
          microphoneName: 'Podcast Mic'
        }
      })
    )
  )
  const loaded = loadCaptureConfig()
  assert.equal(loaded.audio.microphoneSyncOffsetMs, 0)
  assert.deepEqual(loaded.sources, {
    screenId: 'screen-old',
    screenName: 'Built-in Display',
    cameraId: 'camera-old',
    cameraName: 'FaceTime HD Camera',
    microphoneId: 'mic-old',
    microphoneName: 'Podcast Mic',
    testPattern: false
  })
  const reloadedSources = reconcileSourceSelection(loaded.sources, devices)
  assert.deepEqual(reloadedSources, {
    screenId: 'screen:screencapturekit:222',
    screenName: 'Built-in Display',
    windowId: undefined,
    windowName: undefined,
    cameraId: 'camera:avfoundation-native:face-time',
    cameraName: 'FaceTime HD Camera',
    microphoneId: 'microphone:coreaudio:podcast',
    microphoneName: 'Podcast Mic',
    testPattern: false
  })
  assert.deepEqual(
    sourceSelectionChangeEvents(loaded.sources, reloadedSources).map((event) => ({
      sourceKind: event.sourceKind,
      reason: event.reason
    })),
    [
      { sourceKind: 'capture', reason: 'restored-by-name' },
      { sourceKind: 'camera', reason: 'restored-by-name' },
      { sourceKind: 'microphone', reason: 'restored-by-name' }
    ]
  )

  localStorage.setItem(
    STORAGE_KEYS.captureConfig,
    JSON.stringify({
      ...defaultCaptureConfig,
      audio: {
        ...defaultCaptureConfig.audio,
        microphoneSyncOffsetMs: -250
      }
    })
  )
  assert.equal(loadCaptureConfig().audio.microphoneSyncOffsetMs, 0)

  localStorage.setItem(
    STORAGE_KEYS.captureConfig,
    JSON.stringify({
      ...defaultCaptureConfig,
      audio: {
        ...defaultCaptureConfig.audio,
        microphoneSyncOffsetMs: -250,
        microphoneSyncOffsetUserSet: true
      }
    })
  )
  assert.equal(loadCaptureConfig().audio.microphoneSyncOffsetMs, -250)

  assert.deepEqual(
    reconcileSourceSelection(
      {
        screenId: 'screen-old',
        screenName: 'Built-in Display',
        cameraId: 'camera-old',
        cameraName: 'FaceTime HD Camera',
        microphoneId: 'mic-old',
        microphoneName: 'Podcast Mic'
      },
      devices
    ),
    {
      screenId: 'screen:screencapturekit:222',
      screenName: 'Built-in Display',
      windowId: undefined,
      windowName: undefined,
      cameraId: 'camera:avfoundation-native:face-time',
      cameraName: 'FaceTime HD Camera',
      microphoneId: 'microphone:coreaudio:podcast',
      microphoneName: 'Podcast Mic'
    }
  )

  assert.deepEqual(
    reconcileSourceSelection(
      {
        windowId: 'window:screencapturekit:111',
        windowName: 'Editor',
        screenId: 'screen-old',
        screenName: 'Built-in Display',
        cameraId: 'camera:avfoundation-native:desk',
        cameraName: 'Desk Camera',
        microphoneId: 'microphone:coreaudio:laptop',
        microphoneName: 'Laptop Mic'
      },
      devices
    ),
    {
      screenId: undefined,
      screenName: undefined,
      windowId: 'window:screencapturekit:111',
      windowName: 'Editor',
      cameraId: 'camera:avfoundation-native:desk',
      cameraName: 'Desk Camera',
      microphoneId: 'microphone:coreaudio:laptop',
      microphoneName: 'Laptop Mic'
    }
  )

  const missingSources = {
    screenId: 'missing-screen',
    screenName: 'Missing Display',
    cameraId: 'missing-camera',
    cameraName: 'Missing Camera',
    microphoneId: 'missing-mic',
    microphoneName: 'Missing Mic'
  }
  assert.deepEqual(reconcileSourceSelection(missingSources, devices), {
    screenId: 'screen:screencapturekit:222',
    screenName: 'Built-in Display',
    windowId: undefined,
    windowName: undefined,
    cameraId: 'camera:avfoundation-native:face-time',
    cameraName: 'FaceTime HD Camera',
    microphoneId: 'microphone:coreaudio:podcast',
    microphoneName: 'Podcast Mic'
  })
  assert.deepEqual(
    sourceSelectionChangeEvents(
      missingSources,
      reconcileSourceSelection(missingSources, devices)
    ).map((event) => ({
      sourceKind: event.sourceKind,
      reason: event.reason,
      nextName: event.nextName
    })),
    [
      { sourceKind: 'capture', reason: 'unavailable-selected', nextName: 'Built-in Display' },
      { sourceKind: 'camera', reason: 'unavailable-selected', nextName: 'FaceTime HD Camera' },
      { sourceKind: 'microphone', reason: 'unavailable-selected', nextName: 'Podcast Mic' }
    ]
  )

  assert.deepEqual(
    reconcileSourceSelection(
      {
        screenId: 'screen:screencapturekit:222',
        screenName: 'Built-in Display',
        cameraId: 'camera:avfoundation-native:face-time',
        cameraName: 'FaceTime HD Camera',
        microphoneId: 'microphone:coreaudio:podcast',
        microphoneName: 'Podcast Mic'
      },
      devices.map((item) => (item.kind === 'camera' ? { ...item, status: 'unavailable' } : item))
    ),
    {
      screenId: 'screen:screencapturekit:222',
      screenName: 'Built-in Display',
      windowId: undefined,
      windowName: undefined,
      cameraId: undefined,
      cameraName: undefined,
      microphoneId: 'microphone:coreaudio:podcast',
      microphoneName: 'Podcast Mic'
    }
  )

  // Zombie "Fallback - X" avfoundation microphone rows (pre-0.9.27 backends)
  // must never win the default, and selections persisted onto them must
  // migrate to the matching native CoreAudio device by unprefixed name.
  const fallbackMicDevices = [
    device('microphone:avfoundation:2', 'Shure MV7+', 'microphone'),
    device('microphone:coreaudio:shure', 'Shure MV7+', 'microphone')
  ]
  const migratedFromFallback = reconcileSourceSelection(
    { microphoneId: 'microphone:avfoundation:2', microphoneName: 'Fallback - Shure MV7+' },
    fallbackMicDevices
  )
  assert.equal(migratedFromFallback.microphoneId, 'microphone:coreaudio:shure')
  assert.equal(migratedFromFallback.microphoneName, 'Shure MV7+')

  const freshDefaultMic = reconcileSourceSelection({}, fallbackMicDevices)
  assert.equal(freshDefaultMic.microphoneId, 'microphone:coreaudio:shure')

  const avfoundationOnly = reconcileSourceSelection(
    { microphoneId: 'microphone:avfoundation:2', microphoneName: 'Shure MV7+' },
    [device('microphone:avfoundation:2', 'Shure MV7+', 'microphone')]
  )
  assert.equal(avfoundationOnly.microphoneId, 'microphone:avfoundation:2')

  console.log(
    'Source reconciliation smoke OK - persisted IDs, name rematch, fallback behavior, and fallback-mic migration verified.'
  )
} finally {
  await rm(tempDir, { recursive: true, force: true })
}

function device(id, name, kind) {
  return { id, name, kind, status: 'available' }
}
