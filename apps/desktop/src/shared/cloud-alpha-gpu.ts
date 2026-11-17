import {
  ALPHA_LIMITS,
  ALPHA_PATCHES,
  alphaDimensions,
  packedSize,
  stampLatency
} from './cloud-alpha'

export type AlphaGpuStats = {
  firstDrawAt: number | null
  frames: number
  drawMs: number
  maxDrawMs: number
  textureBytes: number
  queuePeak: number
  contextLost: boolean
  closed: boolean
}
const vertex = `#version 300 es
in vec2 p; out vec2 uv;
void main(){ uv=(p+1.0)*0.5; gl_Position=vec4(p,0,1); }`
const fragment = (pack: boolean) => `#version 300 es
precision highp float;
uniform sampler2D source; uniform vec2 logical;
in vec2 uv; out vec4 outColor;
void main(){
 float w=logical.x; float total=w*2.0+${ALPHA_LIMITS.gutter}.0;
 ${
   pack
     ? `float x=uv.x*total;
 if(x>=w && x<w+${ALPHA_LIMITS.gutter}.0){outColor=vec4(0,0,0,1);return;}
 bool mask=x>=w+${ALPHA_LIMITS.gutter}.0;
 float sx=mask?x-w-${ALPHA_LIMITS.gutter}.0:x;
 vec2 q=vec2(clamp(sx,0.5,w-0.5)/w,clamp(uv.y,0.5/logical.y,1.0-0.5/logical.y));
 vec4 pixel=texture(source,q);
 outColor=mask?vec4(vec3(pixel.a),1):vec4(pixel.rgb,1);`
     : `float x=clamp(uv.x*w,0.5,w-0.5);
 float y=clamp(uv.y,0.5/logical.y,1.0-0.5/logical.y);
 vec3 rgb=texture(source,vec2(x/total,y)).rgb;
 float a=texture(source,vec2((x+w+${ALPHA_LIMITS.gutter}.0)/total,y)).r;
 outColor=vec4(rgb,a);`
 }
}`

/** One reusable texture/program; no readback in the frame loop, no frame queue.
 * A lost GPU context is terminal for this owner. Caller must create a new generation. */
export function createAlphaGpu(
  canvas: HTMLCanvasElement,
  width: number,
  height: number,
  mode: 'pack' | 'unpack'
) {
  if (!alphaDimensions(width, height)) throw new Error('alpha dimensions refused')
  const packed = packedSize(width, height),
    pack = mode === 'pack'
  const output = pack ? packed : { width, height }
  canvas.width = output.width
  canvas.height = output.height
  const gl = canvas.getContext('webgl2', {
    alpha: !pack,
    premultipliedAlpha: false,
    antialias: false,
    depth: false,
    stencil: false,
    preserveDrawingBuffer: true
  })
  if (!gl) throw new Error('alpha requires WebGL2')
  const stats: AlphaGpuStats = {
    firstDrawAt: null,
    frames: 0,
    drawMs: 0,
    maxDrawMs: 0,
    textureBytes:
      ((pack ? width * height : packed.width * height) + output.width * output.height) * 4,
    queuePeak: 0,
    contextLost: false,
    closed: false
  }
  const shaders: WebGLShader[] = []
  let program: WebGLProgram | null = null,
    texture: WebGLTexture | null = null,
    buffer: WebGLBuffer | null = null
  const release = () => {
    if (buffer) gl.deleteBuffer(buffer)
    if (texture) gl.deleteTexture(texture)
    if (program) gl.deleteProgram(program)
    shaders.forEach((shader) => gl.deleteShader(shader))
    buffer = null
    texture = null
    program = null
  }
  const lose = (event: Event) => {
    event.preventDefault()
    stats.contextLost = true
    close()
  }
  function close() {
    if (stats.closed) return
    stats.closed = true
    canvas.removeEventListener('webglcontextlost', lose)
    release()
    canvas.width = 1
    canvas.height = 1
  }
  try {
    for (const [type, source] of [
      [gl.VERTEX_SHADER, vertex],
      [gl.FRAGMENT_SHADER, fragment(pack)]
    ] as const) {
      const shader = gl.createShader(type)
      if (!shader) throw new Error('alpha shader allocation failed')
      shaders.push(shader)
      gl.shaderSource(shader, source)
      gl.compileShader(shader)
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS))
        throw new Error('alpha shader compilation failed')
    }
    program = gl.createProgram()
    if (!program) throw new Error('alpha program allocation failed')
    shaders.forEach((shader) => gl.attachShader(program!, shader))
    gl.linkProgram(program)
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error('alpha GPU link failed')
    gl.useProgram(program)
    buffer = gl.createBuffer()
    texture = gl.createTexture()
    if (!buffer || !texture) throw new Error('alpha GPU allocation failed')
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer)
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW)
    const location = gl.getAttribLocation(program, 'p')
    gl.enableVertexAttribArray(location)
    gl.vertexAttribPointer(location, 2, gl.FLOAT, false, 0, 0)
    gl.uniform2f(gl.getUniformLocation(program, 'logical'), width, height)
    gl.uniform1i(gl.getUniformLocation(program, 'source'), 0)
    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, texture)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true)
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false)
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.RGBA,
      pack ? width : packed.width,
      height,
      0,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      null
    )
    gl.viewport(0, 0, output.width, output.height)
    gl.disable(gl.BLEND)
    canvas.addEventListener('webglcontextlost', lose)
  } catch (error) {
    close()
    throw error
  }
  const draw = (source: HTMLVideoElement | HTMLCanvasElement) => {
    if (stats.closed || stats.contextLost) return false
    const w = 'videoWidth' in source ? source.videoWidth : source.width
    const h = 'videoHeight' in source ? source.videoHeight : source.height
    if (w !== (pack ? width : packed.width) || h !== height) return false
    const start = performance.now()
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, gl.RGBA, gl.UNSIGNED_BYTE, source)
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)
    if (gl.getError() !== gl.NO_ERROR) {
      close()
      return false
    }
    const took = performance.now() - start
    stats.firstDrawAt ??= Date.now()
    stats.frames++
    stats.drawMs += took
    stats.maxDrawMs = Math.max(stats.maxDrawMs, took)
    stats.queuePeak = 1
    return true
  }
  /** Sparse diagnostic readback only, sampled by acquisition once/second. */
  const pixel = (x: number, y: number) => {
    const out = new Uint8Array(4)
    if (!stats.closed)
      gl.readPixels(
        Math.floor(x),
        output.height - 1 - Math.floor(y),
        1,
        1,
        gl.RGBA,
        gl.UNSIGNED_BYTE,
        out
      )
    return Array.from(out)
  }
  return {
    draw,
    close,
    stats,
    renderer: String(gl.getParameter(gl.RENDERER)),
    measure(now: number) {
      if (pack || stats.closed || !stats.frames) return null
      const patches = ALPHA_PATCHES.map((p) => ({
        expected: [...p.rgba],
        actual: pixel(p.x * width, p.y * height)
      }))
      const bits = Array.from(
        { length: 32 },
        (_, i) => pixel(((i + 0.5) * width) / 32, height - 6)[0]!
      )
      return { patches, latencyMs: stampLatency(bits, now) }
    }
  }
}
