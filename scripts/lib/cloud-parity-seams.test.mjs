import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { fixtureIds, paritySeams, presentationPart, SeamNotOnGpui } from './cloud-parity-seams.mjs'

/** A harness double: records what each seam sent. */
function harness(isGpui, answers = {}) {
  const sent = []
  return {
    sent,
    h: {
      isGpui,
      async eval(code) {
        sent.push(['eval', code])
        return answers.eval ?? true
      },
      async command(name, params) {
        sent.push(['command', name, params])
        return answers[name] ?? {}
      },
      async rpc(method, params) {
        sent.push(['rpc', method, params])
        return answers[method] ?? null
      }
    }
  }
}

describe('cloud-parity seams', () => {
  it('sends Electron the same renderer source the cases sent', async () => {
    const { h, sent } = harness(false)
    const seams = paritySeams(h)
    await seams.studio.microphone('mute')
    await seams.studio.camera('cam')
    await seams.room.sounds(true)
    await seams.room.sounds()
    assert.deepEqual(
      sent.map(([, code]) => code),
      [
        "return await window.__videorcSmokeScenePresets.microphone('mute')",
        'return await window.__videorcSmokeScenePresets.camera("cam")',
        'return await window.__videorcSmokeScenePresets.roomSounds(true)',
        'return await window.__videorcSmokeScenePresets.roomSounds()'
      ]
    )
  })

  it('drives GPUI through its smoke commands and reads the backend room', async () => {
    const presentation = { media: { aux: { enabled: true }, screen: { status: 'confirmed' } } }
    const { h, sent } = harness(true, {
      'cloud.room.presentation.get': { held: true, presentation },
      'room-switch-set': { enabled: true },
      'studio-state': { microphoneMuted: true }
    })
    const seams = paritySeams(h)
    assert.equal(await seams.studio.microphone('mute'), true)
    assert.deepEqual(await seams.room.sounds(true), { enabled: true })
    assert.deepEqual(await seams.room.privacy(), { status: 'confirmed' })
    assert.deepEqual(await seams.studio.outputFacts(), { microphoneMuted: true })
    assert.deepEqual(sent.slice(0, 3), [
      ['command', 'studio-microphone-mute', { muted: true }],
      ['command', 'room-switch-set', { switch: 'sounds', enabled: true }],
      ['rpc', 'cloud.room.presentation.get', undefined]
    ])
  })

  it('remembers the scenes opt-in it set, and never flips it on a read', async () => {
    const { h, sent } = harness(true, {
      'cloud.room.presentation.get': { presentation: { scene: { state: 'applied' } } },
      'room-switch-set': { enabled: true }
    })
    const seams = paritySeams(h)
    assert.deepEqual(await seams.room.scenes(), { enabled: false, status: { state: 'applied' } })
    assert.deepEqual(await seams.room.scenes(true), { enabled: true, status: { state: 'applied' } })
    assert.equal(sent.filter(([, name]) => name === 'room-switch-set').length, 1)
  })

  it('names what GPUI cannot do yet instead of passing', async () => {
    const { h } = harness(true)
    await assert.rejects(paritySeams(h).room.avatarMotion(), SeamNotOnGpui)
    await assert.rejects(paritySeams(h).studio.click({ electron: '#x' }), SeamNotOnGpui)
  })

  it('seeds GPUI fixture devices and picks them as the renderer source does', async () => {
    const { h, sent } = harness(true, {
      'studio-room-fixture-devices': {
        seeded: [
          'parity-camera',
          'microphone:coreaudio:4294967295',
          'microphone:coreaudio:4294967294'
        ]
      }
    })
    assert.equal(await paritySeams(h).studio.fixtureDevices(true), 'parity-camera')
    assert.deepEqual(sent[1], [
      'command',
      'studio-capture-configure',
      {
        config: {
          sources: {
            cameraId: null,
            cameraOff: true,
            microphoneId: 'microphone:coreaudio:4294967295',
            microphoneName: 'Parity microphone'
          },
          audio: { microphoneMuted: true }
        }
      }
    ])
    assert.throws(() => fixtureIds({ seeded: [] }))
    assert.equal(presentationPart(null, 'sounds'), null)
  })
})
