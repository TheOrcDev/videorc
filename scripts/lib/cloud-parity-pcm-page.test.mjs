import { test } from 'node:test'
import assert from 'node:assert/strict'
import { installPcmRendererCollector, startPcmProgramRecorder } from './cloud-parity-pcm-page.mjs'

test('renderer collector keeps bounded raw events and reports drops without manufacturing samples', () => {
  const original = globalThis.window
  const window = new EventTarget()
  globalThis.window = window
  try {
    installPcmRendererCollector()
    for (let i = 0; i < 4100; i++)
      window.dispatchEvent(
        new CustomEvent('videorc:pcm-test-diagnostic', { detail: { sequence: i } })
      )
    const result = window.__parityPcmRenderer.drain()
    assert.equal(result.events.length, 4096)
    assert.equal(result.dropped, 4)
    assert.equal(result.events[0].sequence, 4)
    window.__parityPcmRenderer.close()
    window.dispatchEvent(
      new CustomEvent('videorc:pcm-test-diagnostic', { detail: { sequence: 9999 } })
    )
    assert.equal(window.__parityPcmRenderer.drain().events.length, 0)
  } finally {
    globalThis.window = original
  }
})
test('program acquisition records the real final tap, drains ordered chunks, and detaches its observer', async () => {
  const originals = Object.fromEntries(
    ['window', 'AudioWorkletNode', 'MediaRecorder'].map((key) => [key, globalThis[key]])
  )
  const links = [],
    disconnected = []
  let observer, recorder
  const fakeNode = (name) => ({
    connect(destination) {
      links.push([name, destination])
      return destination
    },
    disconnect(target) {
      disconnected.push([name, target])
    }
  })
  const sharedContext = {
    sampleRate: 48000,
    audioWorklet: {
      addModule: async (path) => assert.equal(path, '/__parity/cloud-parity-pcm-observer.mjs')
    },
    createGain: () => ({ ...fakeNode('muted'), gain: { value: 1 } })
  }
  const tap = { stream: { id: 'actual-final-program-stream' } }
  globalThis.window = {
    __parityProgramTaps: [{ node: { ...fakeNode('final'), context: sharedContext }, tap }]
  }
  globalThis.AudioWorkletNode = class {
    constructor() {
      observer = this
      Object.assign(this, fakeNode('observer'))
      this.port = {
        postMessage: () => {},
        close: () => {
          this.portClosed = true
        }
      }
    }
  }
  globalThis.MediaRecorder = class {
    state = 'inactive'
    constructor(stream) {
      assert.equal(stream, tap.stream)
      recorder = this
    }
    start(slice) {
      assert.equal(slice, 250)
      this.state = 'recording'
    }
    stop() {
      this.state = 'inactive'
      this.onstop()
    }
  }
  try {
    await startPcmProgramRecorder()
    recorder.ondataavailable({ data: new Blob([Uint8Array.of(1, 2, 3)]), timecode: 0 })
    recorder.ondataavailable({ data: new Blob([Uint8Array.of(4, 5)]), timecode: 250 })
    const result = await window.__parityPcmProgram.drain()
    assert.deepEqual(
      result.chunks.map((c) => [...Buffer.from(c.base64, 'base64')]),
      [
        [1, 2, 3],
        [4, 5]
      ]
    )
    assert.deepEqual(
      result.chunks.map((c) => c.timecodeMs),
      [0, 250]
    )
    const stopped = await window.__parityPcmProgram.close()
    assert.equal(stopped.recorderState, 'inactive')
    assert.equal(observer.portClosed, true)
    assert.deepEqual(
      disconnected.map((v) => v[0]),
      ['final', 'observer', 'muted']
    )
    assert.equal(links.at(-1)[1], tap)
  } finally {
    Object.assign(globalThis, originals)
  }
})
