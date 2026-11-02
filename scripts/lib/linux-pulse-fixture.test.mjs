import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { startLinuxPulseFixtures } from './linux-pulse-fixture.mjs'

function harness({ failLoad = null, failTone = null, failUnload = null, otherFrequency } = {}) {
  const actions = []
  let loads = 0
  const command = async (args) => {
    actions.push(args)
    if (args[0] === 'load-module') {
      loads++
      if (loads === failLoad) throw new Error('load failed')
      return String(100 + loads)
    }
    if (args[1] === failUnload) throw new Error('unload failed')
    return ''
  }
  const tone = async ({ sink, frequency }) => {
    actions.push(['tone', sink, frequency])
    if (frequency === failTone) throw new Error('tone failed')
    return {
      stop: async () => {
        actions.push(['stop-tone', frequency])
      }
    }
  }
  return {
    actions,
    start: () =>
      startLinuxPulseFixtures({
        ffmpegPath: '/fixture/ffmpeg',
        prefix: 'videorc_beta_test',
        command,
        tone,
        otherFrequency
      })
  }
}

describe('owned Linux Pulse fixtures', () => {
  it('supports an independent second tone and preserves its identity on reconnect', async () => {
    const fixture = harness({ otherFrequency: 997 })
    const started = await fixture.start()
    const source = started.sources[1]
    assert.equal(source.frequency, 997)
    assert.equal(source.source, 'videorc_beta_test_997_source')
    assert.ok(
      fixture.actions.some(
        ([kind, sink, hz]) => kind === 'tone' && sink.endsWith('_997') && hz === 997
      )
    )
    await source.disconnect()
    await source.reconnect()
    assert.ok(fixture.actions.at(-1).includes('source_name=videorc_beta_test_997_source'))
    await started.stop()
  })

  it('rejects invalid or indistinguishable frequencies before creating a module', async () => {
    for (const otherFrequency of [440, 0, 99, 10_001, 997.5, '997', NaN]) {
      const fixture = harness({ otherFrequency })
      await assert.rejects(fixture.start(), /distinct frequency/)
      assert.deepEqual(fixture.actions, [])
    }
  })

  it('creates distinct microphone IDs and plays each tone only into its null sink', async () => {
    const fixture = harness()
    const started = await fixture.start()
    assert.deepEqual(
      started.sources.map((source) => source.frequency),
      [440, 880]
    )
    for (const source of started.sources) {
      assert.equal(
        Buffer.from(source.deviceId.replace('microphone:linux-pulse:', ''), 'hex').toString(),
        source.source
      )
    }
    assert.deepEqual(fixture.actions, [
      [
        'load-module',
        'module-null-sink',
        'sink_name=videorc_beta_test_440',
        'rate=48000',
        'channels=2'
      ],
      [
        'load-module',
        'module-remap-source',
        'master=videorc_beta_test_440.monitor',
        'source_name=videorc_beta_test_440_source'
      ],
      ['tone', 'videorc_beta_test_440', 440],
      [
        'load-module',
        'module-null-sink',
        'sink_name=videorc_beta_test_880',
        'rate=48000',
        'channels=2'
      ],
      [
        'load-module',
        'module-remap-source',
        'master=videorc_beta_test_880.monitor',
        'source_name=videorc_beta_test_880_source'
      ],
      ['tone', 'videorc_beta_test_880', 880]
    ])
    await started.stop()
    const cleanup = fixture.actions.slice(6)
    assert.deepEqual(cleanup, [
      ['stop-tone', 880],
      ['stop-tone', 440],
      ['unload-module', '104'],
      ['unload-module', '103'],
      ['unload-module', '102'],
      ['unload-module', '101']
    ])
    await started.stop()
    assert.deepEqual(fixture.actions.slice(6), cleanup)
  })

  it('unwinds only acquired module IDs when setup fails halfway', async () => {
    const fixture = harness({ failLoad: 3 })
    await assert.rejects(fixture.start(), /load failed/)
    assert.deepEqual(fixture.actions.slice(-3), [
      ['stop-tone', 440],
      ['unload-module', '102'],
      ['unload-module', '101']
    ])
  })

  it('removes and restores only the selected source, keeping its identity and tone', async () => {
    const fixture = harness()
    const started = await fixture.start()
    const source = started.sources[0]
    const identity = source.deviceId
    await source.disconnect()
    await source.disconnect()
    assert.deepEqual(fixture.actions.slice(6), [['unload-module', '102']])
    await source.reconnect()
    await source.reconnect()
    assert.equal(source.deviceId, identity)
    assert.deepEqual(fixture.actions.slice(7), [
      [
        'load-module',
        'module-remap-source',
        'master=videorc_beta_test_440.monitor',
        'source_name=videorc_beta_test_440_source'
      ]
    ])
    await started.stop()
    assert.deepEqual(fixture.actions.slice(8), [
      ['stop-tone', 880],
      ['stop-tone', 440],
      ['unload-module', '105'],
      ['unload-module', '104'],
      ['unload-module', '103'],
      ['unload-module', '101']
    ])
    await assert.rejects(source.reconnect(), /stopped/)
    await assert.rejects(source.disconnect(), /stopped/)
  })

  it('does not unload an already disconnected source again during cleanup', async () => {
    const fixture = harness()
    const started = await fixture.start()
    await started.sources[0].disconnect()
    await started.stop()
    assert.equal(
      fixture.actions.filter(([action, id]) => action === 'unload-module' && id === '102').length,
      1
    )
  })

  it('stops the first player and unloads both pairs when the second tone fails', async () => {
    const fixture = harness({ failTone: 880 })
    await assert.rejects(fixture.start(), /tone failed/)
    assert.deepEqual(fixture.actions.slice(-5), [
      ['stop-tone', 440],
      ['unload-module', '104'],
      ['unload-module', '103'],
      ['unload-module', '102'],
      ['unload-module', '101']
    ])
  })

  it('attempts the remaining owned cleanup after one unload fails and reports failure', async () => {
    const fixture = harness({ failUnload: '104' })
    const started = await fixture.start()
    await assert.rejects(started.stop(), /cleanup failed/)
    assert.deepEqual(fixture.actions.at(-1), ['unload-module', '101'])
  })

  it('refuses an unparseable ownership receipt without guessing a module to unload', async () => {
    const actions = []
    await assert.rejects(
      startLinuxPulseFixtures({
        ffmpegPath: '/fixture/ffmpeg',
        command: async (args) => {
          actions.push(args)
          return 'not-an-id'
        },
        tone: async () => {
          throw new Error('must not start')
        }
      }),
      /owned module ID/
    )
    assert.equal(actions.length, 1)
    assert.equal(actions[0][0], 'load-module')
  })
})
