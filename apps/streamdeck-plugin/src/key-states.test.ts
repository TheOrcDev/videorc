import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  bannerKeyLit,
  buddyKeyIntent,
  buddyKeyLit,
  layoutKeyLit,
  micKeyLit,
  recordKeyIntent,
  recordKeyLit,
  soundKeyLit,
  streamKeyIntent,
  streamKeyLit,
  streamManagerFrontOrCloseIntent,
  streamManagerScreenKeyIntent,
  streamManagerScreenKeyLit,
  streamManagerScreenKeyTitle,
  systemAudioKeyLit,
  takeoverKeyIntent,
  takeoverKeyLit
} from './key-states.js'

test('the Record key lights while a session records', () => {
  assert.equal(recordKeyLit({ sessionActive: true, recordEnabled: true }), true)
  assert.equal(recordKeyLit({ sessionActive: true, recordEnabled: false }), false)
  assert.equal(recordKeyLit({ sessionActive: false, recordEnabled: true }), false)
  assert.equal(recordKeyLit(null), false)
})

test('the Go Live key lights while a session streams', () => {
  assert.equal(streamKeyLit({ sessionActive: true, streamEnabled: true }), true)
  assert.equal(streamKeyLit({ sessionActive: true, streamEnabled: false }), false)
  assert.equal(streamKeyLit({ sessionActive: false, streamEnabled: true }), false)
  assert.equal(streamKeyLit(null), false)
})

test('the Record key stops only the recording it shows and starts otherwise', () => {
  assert.deepEqual(recordKeyIntent({ sessionActive: true, recordEnabled: true }), {
    kind: 'recordStop'
  })
  assert.deepEqual(recordKeyIntent({ sessionActive: true, recordEnabled: false }), {
    kind: 'recordStart'
  })
  assert.deepEqual(recordKeyIntent(null), { kind: 'recordStart' })
})

test('the Go Live key ends only the livestream it shows and goes live otherwise', () => {
  assert.deepEqual(streamKeyIntent({ sessionActive: true, streamEnabled: true }), {
    kind: 'streamStop'
  })
  assert.deepEqual(streamKeyIntent({ sessionActive: true, streamEnabled: false }), {
    kind: 'streamStart'
  })
  assert.deepEqual(streamKeyIntent(null), { kind: 'streamStart' })
})

test('the Mic key lights while the mic is live', () => {
  assert.equal(micKeyLit({ micMuted: false }), true)
  assert.equal(micKeyLit({ micMuted: true }), false)
  assert.equal(micKeyLit({}), false)
  assert.equal(micKeyLit(null), false)
})

test('the System audio key lights while the session mixes system audio', () => {
  assert.equal(systemAudioKeyLit({ systemAudioAvailable: true, systemAudioOn: true }), true)
  assert.equal(systemAudioKeyLit({ systemAudioAvailable: true, systemAudioOn: false }), false)
  assert.equal(systemAudioKeyLit(null), false)
})

test('a Layout key lights while its layout is on screen', () => {
  assert.equal(layoutKeyLit({ layoutPreset: 'camera-only' }, 'camera-only'), true)
  assert.equal(layoutKeyLit({ layoutPreset: 'screen-only' }, 'camera-only'), false)
  assert.equal(layoutKeyLit({ layoutPreset: 'camera-only' }, undefined), false)
  assert.equal(layoutKeyLit(null, 'camera-only'), false)
})

test('a Takeover key lights while its own takeover shows', () => {
  assert.equal(takeoverKeyLit({ activeTakeoverId: 'brb' }, 'brb'), true)
  assert.equal(takeoverKeyLit({ activeTakeoverId: 'soon' }, 'brb'), false)
  assert.equal(takeoverKeyLit({ activeTakeoverId: null }, 'brb'), false)
  assert.equal(takeoverKeyLit({ activeTakeoverId: 'brb' }, undefined), false)
})

test('a Takeover key hides its own takeover and switches from any other', () => {
  assert.deepEqual(takeoverKeyIntent({ activeTakeoverId: 'brb' }, 'brb'), {
    kind: 'takeoverHide'
  })
  assert.deepEqual(takeoverKeyIntent({ activeTakeoverId: 'soon' }, 'brb'), {
    kind: 'takeoverShow',
    assetId: 'brb'
  })
  assert.deepEqual(takeoverKeyIntent({ activeTakeoverId: null }, 'brb'), {
    kind: 'takeoverShow',
    assetId: 'brb'
  })
  assert.equal(takeoverKeyIntent({ activeTakeoverId: null }, undefined), null)
})

test('a takeover key with none picked still hides the one that shows', () => {
  assert.deepEqual(takeoverKeyIntent({ activeTakeoverId: 'brb' }, undefined), {
    kind: 'takeoverHide'
  })
})

test('Banner and Sound keys light while theirs shows or plays', () => {
  const describe = {
    banners: [
      { id: 'b1', name: 'Sponsor', shown: true },
      { id: 'b2', name: 'Socials', shown: false }
    ],
    sounds: [
      { id: 's1', name: 'Airhorn', playing: true },
      { id: 's2', name: 'Applause', playing: false }
    ]
  }
  assert.equal(bannerKeyLit(describe, 'b1'), true)
  assert.equal(bannerKeyLit(describe, 'b2'), false)
  assert.equal(bannerKeyLit(describe, 'gone'), false)
  assert.equal(bannerKeyLit(null, 'b1'), false)
  assert.equal(soundKeyLit(describe, 's1'), true)
  assert.equal(soundKeyLit(describe, 's2'), false)
  assert.equal(soundKeyLit(describe, undefined), false)
})

test('the Buddy key lights while Buddy Live is on, and a press toggles it', () => {
  assert.equal(buddyKeyLit({ buddyLive: true }), true)
  assert.equal(buddyKeyLit({ buddyLive: false }), false)
  assert.equal(buddyKeyLit({}), false)
  assert.equal(buddyKeyLit(null), false)
  assert.deepEqual(buddyKeyIntent(), { kind: 'buddyLiveToggle' })
})

const SCREENS = { presentingScreen: '1', monitorScreen: '2' }
const on = (screenId: string | null, extra: Record<string, unknown> = {}) => ({
  windows: { comments: screenId !== null },
  streamManager: { screenId, visible: true, hiddenFromStream: false, ...extra }
})

test('the Stream Manager Screen key is on while viewers see the window (plan 230)', () => {
  assert.equal(streamManagerScreenKeyLit(on('1'), SCREENS), true)
  assert.equal(streamManagerScreenKeyLit(on('2'), SCREENS), false)
  assert.equal(streamManagerScreenKeyLit(on('3'), SCREENS), false)
  assert.equal(streamManagerScreenKeyLit(on('1', { hiddenFromStream: true }), SCREENS), false)
  assert.equal(streamManagerScreenKeyLit(on('1', { visible: false }), SCREENS), false)
  assert.equal(streamManagerScreenKeyLit(on(null), SCREENS), false)
  assert.equal(streamManagerScreenKeyLit(on('1'), {}), false)
  assert.equal(streamManagerScreenKeyLit(null, SCREENS), false)
})

test('the Stream Manager Screen key sends both screens, or alerts', () => {
  assert.deepEqual(streamManagerScreenKeyIntent(SCREENS), {
    kind: 'streamManagerScreenSwap',
    presentingScreen: '1',
    monitorScreen: '2'
  })
  assert.equal(streamManagerScreenKeyIntent({}), null)
  assert.equal(streamManagerScreenKeyIntent({ presentingScreen: '1' }), null)
  assert.equal(streamManagerScreenKeyIntent({ presentingScreen: '1', monitorScreen: '' }), null)
  assert.equal(streamManagerScreenKeyIntent({ presentingScreen: '1', monitorScreen: '1' }), null)
  assert.deepEqual(streamManagerFrontOrCloseIntent(), { kind: 'streamManagerFrontOrClose' })
})

test('the Stream Manager Screen key names where the window is', () => {
  const title = (state: Parameters<typeof streamManagerScreenKeyTitle>[0]) =>
    streamManagerScreenKeyTitle(state, true, SCREENS)
  assert.equal(title(on('1')), 'Present')
  assert.equal(title(on('1', { hiddenFromStream: true })), 'Hidden')
  assert.equal(title(on('2')), 'Monitor')
  assert.equal(title(on('2', { hiddenFromStream: true })), 'Monitor')
  assert.equal(title(on('3')), 'Away')
  assert.equal(title(on('3', { hiddenFromStream: true })), 'Away')
  for (const closed of [on(null), on('1', { visible: false }), on('2', { visible: false }), null]) {
    assert.equal(title(closed), 'Closed')
  }
  assert.equal(streamManagerScreenKeyTitle(on('1'), true, {}), 'Pick\nscreens')
  const connected = [{ id: '1' }, { id: '2' }]
  assert.equal(streamManagerScreenKeyTitle(on('1'), true, SCREENS, connected), 'Present')
  assert.equal(streamManagerScreenKeyTitle(on('1'), true, SCREENS, [{ id: '1' }]), 'Pick\nscreens')
  assert.equal(
    streamManagerScreenKeyTitle(on('1'), true, { presentingScreen: '1', monitorScreen: '1' }),
    'Pick\nscreens'
  )
  assert.equal(streamManagerScreenKeyTitle(on('1'), false, SCREENS), 'Videorc\noffline')
})
