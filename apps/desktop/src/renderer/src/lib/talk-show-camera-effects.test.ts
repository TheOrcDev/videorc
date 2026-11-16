// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  TalkShowCameraEffects,
  TalkShowKeyProcessor,
  type TalkShowCameraSettings
} from './talk-show-camera-effects'
import vectors from '../../../shared/chroma-key-vectors.json'

afterEach(() => vi.restoreAllMocks())

const settings: TalkShowCameraSettings = { layout: vectors[0].settings }
function fixture() {
  const processor = {
    name: 'test-key',
    init: vi.fn(),
    restart: vi.fn(),
    destroy: vi.fn(),
    update: vi.fn()
  }
  const track = { setProcessor: vi.fn(async () => {}), stopProcessor: vi.fn(async () => {}) }
  const create = vi.fn(() => processor)
  return { processor, track, create, effects: new TalkShowCameraEffects(track, create) }
}
describe('talk-show camera processing lifecycle', () => {
  it('attaches only with key on, updates in place, and detaches when off', async () => {
    const f = fixture()
    await f.effects.update(undefined)
    expect(f.track.setProcessor).not.toHaveBeenCalled()
    await f.effects.update(settings)
    expect(f.track.setProcessor).toHaveBeenCalledWith(f.processor, true)
    const changed = { layout: { ...settings.layout, cameraChromaKeySpillPct: 25 } }
    await f.effects.update(changed)
    expect(f.processor.update).toHaveBeenLastCalledWith(changed)
    expect(f.track.setProcessor).toHaveBeenCalledTimes(1)
    await f.effects.update({ layout: { ...settings.layout, cameraChromaKeyEnabled: false } })
    expect(f.track.stopProcessor).toHaveBeenCalledTimes(1)
  })
  it('serializes an off change arriving during initialization', async () => {
    const f = fixture()
    let finish!: () => void
    f.track.setProcessor.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve
        })
    )
    const opening = f.effects.update(settings)
    await vi.waitFor(() => expect(f.track.setProcessor).toHaveBeenCalled())
    const closing = f.effects.update({
      layout: { ...settings.layout, cameraChromaKeyEnabled: false }
    })
    finish()
    await Promise.all([opening, closing])
    expect(f.track.stopProcessor).toHaveBeenCalledTimes(1)
  })
  it('destroys an init failure and propagates it, without a raw fallback', async () => {
    const f = fixture()
    f.track.setProcessor.mockRejectedValueOnce(new Error('no GPU'))
    await expect(f.effects.update(settings)).rejects.toThrow('no GPU')
    expect(f.processor.destroy).toHaveBeenCalledTimes(1)
  })
  it('does not attach after its room closes', async () => {
    const f = fixture()
    f.effects.close()
    await f.effects.update(settings)
    expect(f.track.setProcessor).not.toHaveBeenCalled()
  })
  it('renders new uniforms, restarts on device change, and releases outputs without stopping inputs', async () => {
    const gl = {
      VERTEX_SHADER: 1,
      FRAGMENT_SHADER: 2,
      COMPILE_STATUS: 3,
      LINK_STATUS: 4,
      TEXTURE0: 10,
      TEXTURE1: 11,
      TEXTURE_2D: 12,
      RGBA: 13,
      UNSIGNED_BYTE: 14,
      createShader: () => ({}),
      shaderSource: vi.fn(),
      compileShader: vi.fn(),
      getShaderParameter: () => true,
      createProgram: () => ({}),
      attachShader: vi.fn(),
      linkProgram: vi.fn(),
      getProgramParameter: () => true,
      useProgram: vi.fn(),
      createTexture: () => ({}),
      activeTexture: vi.fn(),
      bindTexture: vi.fn(),
      texParameteri: vi.fn(),
      getUniformLocation: (_program: unknown, name: string) => name,
      uniform1i: vi.fn(),
      uniform1f: vi.fn(),
      uniform2f: vi.fn(),
      uniform2fv: vi.fn(),
      uniform4fv: vi.fn(),
      clearColor: vi.fn(),
      clear: vi.fn(),
      texImage2D: vi.fn(),
      viewport: vi.fn(),
      drawArrays: vi.fn(),
      deleteShader: vi.fn(),
      deleteTexture: vi.fn(),
      deleteProgram: vi.fn(),
      getExtension: () => null
    }
    const output = { stop: vi.fn(), enabled: true }
    const createElement = document.createElement.bind(document)
    vi.spyOn(document, 'createElement').mockImplementation(((tag: string) => {
      const element = createElement(tag)
      if (tag === 'canvas') {
        Object.assign(element, {
          getContext: (kind: string) => (kind === 'webgl2' ? gl : { fillRect: vi.fn() }),
          captureStream: () => ({ getVideoTracks: () => [output] })
        })
      }
      return element
    }) as typeof document.createElement)
    const video = document.createElement('video')
    let frame!: VideoFrameRequestCallback
    Object.defineProperty(video, 'readyState', { value: 2 })
    video.requestVideoFrameCallback = vi.fn((callback) => {
      frame = callback
      return 1
    })
    video.cancelVideoFrameCallback = vi.fn()
    const raw = { stop: vi.fn() }
    const options = { kind: 'video', element: video, track: raw } as unknown as Parameters<
      TalkShowKeyProcessor['init']
    >[0]
    const onError = vi.fn()
    const processor = new TalkShowKeyProcessor(settings, onError)
    await processor.init(options)
    processor.update({ layout: { ...settings.layout, cameraChromaKeySpillPct: 25 } })
    frame(100, {} as VideoFrameCallbackMetadata)
    expect(gl.uniform1f).toHaveBeenCalledWith('spill', 0.25)
    expect(gl.drawArrays).toHaveBeenCalledOnce()
    await processor.restart(options)
    expect(output.stop).toHaveBeenCalledOnce()
    expect(video.cancelVideoFrameCallback).toHaveBeenCalled()
    await processor.destroy()
    expect(output.stop).toHaveBeenCalledTimes(2)
    expect(gl.deleteTexture).toHaveBeenCalledTimes(4)
    expect(raw.stop).not.toHaveBeenCalled()
    expect(onError).not.toHaveBeenCalled()
  })
})
