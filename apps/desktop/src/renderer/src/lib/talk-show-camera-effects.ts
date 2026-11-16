import type { LocalVideoTrack, Track, TrackProcessor, VideoProcessorOptions } from 'livekit-client'
import type { EffectiveSceneBackground } from '@/lib/backend'
import { backgroundAssetDisplayUrl } from '@/lib/background-library'
import { clamp, keySpec, type KeySettings } from '@/lib/chroma-key-reference'
import { KEY_FRAGMENT, KEY_VERTEX } from '@/lib/talk-show-key-shader'

export type TalkShowCameraSettings = {
  layout: KeySettings
  background?: EffectiveSceneBackground | null
}
type KeyProcessor = TrackProcessor<Track.Kind.Video, VideoProcessorOptions> & {
  update(settings: TalkShowCameraSettings): void
}

/** Serializes SDK track replacement; changing uniforms never republishes. */
export class TalkShowCameraEffects {
  #processor: KeyProcessor | null = null
  #pending = Promise.resolve()
  #closed = false
  #settings: TalkShowCameraSettings | undefined
  constructor(
    private track: Pick<LocalVideoTrack, 'setProcessor' | 'stopProcessor'>,
    private create: (settings: TalkShowCameraSettings) => KeyProcessor
  ) {}
  update(settings: TalkShowCameraSettings | undefined): Promise<void> {
    this.#settings = settings
    if (settings) this.#processor?.update(settings)
    this.#pending = this.#pending
      .catch(() => {})
      .then(async () => {
        if (this.#closed) return
        const latest = this.#settings
        if (latest?.layout.cameraChromaKeyEnabled) {
          if (this.#processor) {
            this.#processor.update(latest)
            return
          }
          const processor = this.create(latest)
          try {
            await this.track.setProcessor(processor, true)
            if (this.#closed) {
              await this.track.stopProcessor()
              return
            }
            this.#processor = processor
            // A settings change can arrive while init decodes a background.
            if (this.#settings) processor.update(this.#settings)
          } catch (error) {
            await processor.destroy()
            throw error
          }
        } else if (this.#processor) {
          await this.track.stopProcessor()
          this.#processor = null
        }
      })
    return this.#pending
  }
  close(): void {
    this.#closed = true
  }
}

/**
 * VP8 has no alpha: key before publication onto the scene picture. Live
 * backgrounds use their bundled poster: the existing welcome player owns
 * its own WebGL context/clock and cannot render into this processor's target.
 * No CPU readback and no silent raw-camera fallback when WebGL fails.
 */
export class TalkShowKeyProcessor implements KeyProcessor {
  readonly name = 'videorc-talk-show-chroma-key'
  processedTrack?: MediaStreamTrack
  #settings: TalkShowCameraSettings
  #canvas: HTMLCanvasElement | null = null
  #video: HTMLVideoElement | null = null
  #gl: WebGL2RenderingContext | null = null
  #program: WebGLProgram | null = null
  #textures: WebGLTexture[] = []
  #frame = 0
  #lastFrame = -Infinity
  #backgroundKey = ''
  #backgroundRevision = 0
  #stopped = true
  #failed = false
  constructor(
    settings: TalkShowCameraSettings,
    private onError: (error: Error) => void
  ) {
    this.#settings = settings
  }
  update(settings: TalkShowCameraSettings): void {
    this.#settings = settings
    void this.#loadBackground().catch((error: unknown) => this.#fail(error))
  }
  async init(options: VideoProcessorOptions): Promise<void> {
    this.#stopped = false
    this.#failed = false
    this.#video = (options.element ?? document.createElement('video')) as HTMLVideoElement
    this.#video.muted = true
    this.#video.playsInline = true
    const canvas = document.createElement('canvas')
    canvas.width = 1280
    canvas.height = 720
    this.#canvas = canvas
    const gl = canvas.getContext('webgl2', {
      alpha: false,
      antialias: false,
      preserveDrawingBuffer: true
    })
    if (!gl) throw new Error('Green screen needs WebGL2. The camera was paused.')
    this.#gl = gl
    canvas.addEventListener('webglcontextlost', this.#contextLost)
    const shaders: WebGLShader[] = []
    try {
      for (const [type, source] of [
        [gl.VERTEX_SHADER, KEY_VERTEX],
        [gl.FRAGMENT_SHADER, KEY_FRAGMENT]
      ] as const) {
        const shader = gl.createShader(type)
        if (!shader) throw new Error('Could not create the green-screen shader.')
        shaders.push(shader)
        gl.shaderSource(shader, source)
        gl.compileShader(shader)
        if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS))
          throw new Error('Could not compile the green-screen shader.')
      }
      const program = gl.createProgram()
      if (!program) throw new Error('Could not create the green-screen program.')
      this.#program = program
      for (const shader of shaders) gl.attachShader(program, shader)
      gl.linkProgram(program)
      if (!gl.getProgramParameter(program, gl.LINK_STATUS))
        throw new Error('Could not link the green-screen program.')
      gl.useProgram(program)
      for (let i = 0; i < 2; i++) {
        const texture = gl.createTexture()
        if (!texture) throw new Error('Could not create the green-screen texture.')
        this.#textures.push(texture)
        gl.activeTexture(gl.TEXTURE0 + i)
        gl.bindTexture(gl.TEXTURE_2D, texture)
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
      }
      gl.uniform1i(gl.getUniformLocation(program, 'camera'), 0)
      gl.uniform1i(gl.getUniformLocation(program, 'background'), 1)
      gl.clearColor(0.028, 0.028, 0.028, 1)
      gl.clear(gl.COLOR_BUFFER_BIT)
      await this.#loadBackground()
      if (this.#stopped) return
      this.processedTrack = canvas.captureStream(30).getVideoTracks()[0]
      if (!this.processedTrack) throw new Error('Could not capture the green-screen picture.')
      this.#schedule()
    } finally {
      for (const shader of shaders) gl.deleteShader(shader)
    }
  }
  async restart(options: VideoProcessorOptions): Promise<void> {
    await this.destroy()
    await this.init(options)
  }
  async destroy(): Promise<void> {
    this.#stopped = true
    this.#backgroundRevision++
    if (this.#video && this.#frame) this.#video.cancelVideoFrameCallback(this.#frame)
    this.#frame = 0
    this.processedTrack?.stop()
    this.processedTrack = undefined
    this.#canvas?.removeEventListener('webglcontextlost', this.#contextLost)
    const gl = this.#gl
    if (gl) {
      for (const texture of this.#textures) gl.deleteTexture(texture)
      if (this.#program) gl.deleteProgram(this.#program)
      gl.getExtension('WEBGL_lose_context')?.loseContext()
    }
    this.#textures = []
    this.#gl = null
    this.#program = null
    this.#canvas = null
    this.#video = null
    this.#backgroundKey = ''
    this.#lastFrame = -Infinity
  }
  #contextLost = (event: Event): void => {
    event.preventDefault()
    this.#fail(new Error('Green screen lost its graphics context. The camera was paused.'))
  }
  #fail(error: unknown): void {
    if (this.#stopped || this.#failed) return
    this.#failed = true
    if (this.processedTrack) this.processedTrack.enabled = false
    this.onError(error instanceof Error ? error : new Error(String(error)))
  }
  #schedule(): void {
    if (this.#stopped || this.#failed || !this.#video) return
    this.#frame = this.#video.requestVideoFrameCallback((now) => {
      try {
        if (now - this.#lastFrame >= 1000 / 30 - 2) {
          this.#draw()
          this.#lastFrame = now
        }
      } catch (error) {
        this.#fail(error)
      }
      this.#schedule()
    })
  }
  #draw(): void {
    const gl = this.#gl,
      program = this.#program,
      video = this.#video
    if (!gl || !program || !video || video.readyState < 2) return
    const spec = keySpec(this.#settings.layout)
    gl.useProgram(program)
    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, this.#textures[0])
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, video)
    gl.uniform2fv(gl.getUniformLocation(program, 'direction'), spec.direction)
    gl.uniform2f(gl.getUniformLocation(program, 'cone'), spec.angle, spec.band)
    gl.uniform4fv(gl.getUniformLocation(program, 'edges'), spec.edges)
    gl.uniform1f(gl.getUniformLocation(program, 'spill'), spec.spill)
    gl.uniform1i(gl.getUniformLocation(program, 'blue'), Number(spec.blue))
    gl.viewport(0, 0, 1280, 720)
    gl.drawArrays(gl.TRIANGLES, 0, 3)
  }
  async #loadBackground(): Promise<void> {
    const gl = this.#gl
    if (!gl || this.#stopped) return
    const background = this.#settings.background
    const key = JSON.stringify(background ?? null)
    if (key === this.#backgroundKey) return
    this.#backgroundKey = key
    const revision = ++this.#backgroundRevision
    const canvas = document.createElement('canvas')
    canvas.width = 1280
    canvas.height = 720
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('Could not draw the green-screen background.')
    // --video-ground: oklch(0.13 0 0), stable across light/dark themes.
    ctx.fillStyle = 'rgb(7, 7, 7)'
    ctx.fillRect(0, 0, 1280, 720)
    if (background) {
      const image = new Image()
      image.crossOrigin = 'anonymous'
      image.src = backgroundAssetDisplayUrl(background.managedAssetPath)
      try {
        await image.decode()
      } catch (error) {
        if (this.#stopped || revision !== this.#backgroundRevision) return
        throw error
      }
      if (this.#stopped || revision !== this.#backgroundRevision) return
      const scale = clamp(background.scale, 100, 200) / 100
      const sw = image.naturalWidth / scale,
        sh = image.naturalHeight / scale
      const sx = (image.naturalWidth - sw) * (0.5 + clamp(background.offsetX, -100, 100) / 200)
      const sy = (image.naturalHeight - sh) * (0.5 + clamp(background.offsetY, -100, 100) / 200)
      const ratio =
        background.fit === 'fit' ? Math.min(1280 / sw, 720 / sh) : Math.max(1280 / sw, 720 / sh)
      const width = background.fit === 'stretch' ? 1280 : sw * ratio
      const height = background.fit === 'stretch' ? 720 : sh * ratio
      ctx.filter = `blur(${clamp(background.blurPx, 0, 64)}px) saturate(${clamp(background.saturationPercent, 0, 200)}%) brightness(${100 - clamp(background.dimPercent, 0, 100)}%)`
      ctx.drawImage(image, sx, sy, sw, sh, (1280 - width) / 2, (720 - height) / 2, width, height)
      ctx.filter = 'none'
      const vignette = clamp(background.vignettePercent, 0, 100) / 100
      if (vignette) {
        const gradient = ctx.createRadialGradient(640, 360, 180, 640, 360, 735)
        gradient.addColorStop(0, 'transparent')
        gradient.addColorStop(1, `rgba(0,0,0,${vignette})`)
        ctx.fillStyle = gradient
        ctx.fillRect(0, 0, 1280, 720)
      }
    }
    if (this.#stopped || revision !== this.#backgroundRevision) return
    gl.activeTexture(gl.TEXTURE1)
    gl.bindTexture(gl.TEXTURE_2D, this.#textures[1])
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, canvas)
  }
}
