import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

// The runner is a plain script the preview surface inlines; evaluate it the
// same way, against a stand-in global.
type Look = { id: string; statics: number[][]; instances?: { dots: number; dust: number } }
type Pass = {
  key: string
  kind: 'full-screen' | 'instanced'
  clears: boolean
  vertices?: number
  blend?: string
  vertexShader?: string
}
type Background = {
  id: string
  soft: boolean
  looks: Look[]
  passes: Pass[]
  shaders: Record<string, string>
}
type Render = {
  uniformVec4Count: number
  vertex: string
  backgrounds: Background[]
  sizeCases: {
    internal: { id: string; output: number[]; level: string; view: number[] }[]
    plasma: { view: number[]; coarse: number[]; fine: number[]; down: number[][] }[]
    silkField: { view: number[]; field: number[] }[]
    beamsField: { view: number[]; field: number[] }[]
    dither: { view: number[]; look: string; cell: number; field: number[] }[]
    ferrofluid: {
      view: number[]
      look: string
      origin: number[]
      size: number[]
      bound: number[]
    }[]
    ghostFibersBloom: { view: number[]; bloom: number[][] }[]
  }
  uniformCases: {
    id: string
    look: string
    target: number[]
    view: number[]
    phase: number
    dim: number
    packed: number[][]
  }[]
}

type DrawOptions = {
  id: string
  look?: string
  phase: number
  dim?: number
  width: number
  height: number
  level?: 'full' | 'half'
}

type Runner = {
  create: (
    gl: unknown,
    render: Render
  ) => {
    draw: (options: DrawOptions) => void
    releaseExcept: (id: string) => void
    dispose: () => void
    programsCompiled: () => number
    scratchBytes: () => number
  }
  internalSize: (render: unknown, id: string, output: number[], level: string) => number[]
  silkFieldSize: (view: number[]) => number[]
  plasmaSizes: (
    render: unknown,
    view: number[]
  ) => { coarse: number[]; fine: number[]; down: number[][] }
  beamsFieldSize: (render: unknown, view: number[]) => number[]
  ditherCell: (view: number[], pixelSize: number) => number
  ditherFieldSize: (view: number[], pixelSize: number) => number[]
  ferrofluidGrid: (
    render: unknown,
    look: Look,
    view: number[]
  ) => { origin: number[]; size: number[]; bound: number[] }
  ghostFibersBloomSizes: (view: number[]) => number[][]
  packUniforms: (
    look: unknown,
    target: number[],
    view: number[],
    phase: number,
    dim: number
  ) => Float32Array
  runnable: (id: string) => boolean
}

const source = readFileSync(new URL('./live-background-webgl.js', import.meta.url), 'utf8')
const sandbox: { VideorcLiveBackground?: Runner } = {}
new Function('globalThis', source)(sandbox)
const runner = sandbox.VideorcLiveBackground!

const render = JSON.parse(
  readFileSync(new URL('./live-backgrounds.render.generated.json', import.meta.url), 'utf8')
) as Render

function background(id: string): Background {
  return render.backgrounds.find((candidate) => candidate.id === id)!
}

function look(id: string, lookId: string): Look {
  return background(id).looks.find((candidate) => candidate.id === lookId)!
}

/**
 * A WebGL2 stand-in that records every call the runner makes, with distinct
 * handles per texture so a call can be traced to its target. Compiles and
 * links everything.
 */
type Call = { name: string; args: unknown[] }
function fakeGl() {
  const calls: Call[] = []
  const constants: Record<string, number> = {
    TEXTURE_2D: 1,
    RGBA16F: 2,
    RGBA8: 3,
    RGBA: 4,
    HALF_FLOAT: 5,
    UNSIGNED_BYTE: 6,
    TEXTURE_MIN_FILTER: 7,
    TEXTURE_MAG_FILTER: 8,
    LINEAR: 9,
    NEAREST: 10,
    LINEAR_MIPMAP_LINEAR: 11,
    TEXTURE_WRAP_S: 12,
    TEXTURE_WRAP_T: 13,
    CLAMP_TO_EDGE: 14,
    FRAMEBUFFER: 15,
    COLOR_ATTACHMENT0: 16,
    VERTEX_SHADER: 17,
    FRAGMENT_SHADER: 18,
    COMPILE_STATUS: 19,
    LINK_STATUS: 20,
    TEXTURE0: 21,
    TEXTURE1: 22,
    TRIANGLES: 23,
    TRIANGLE_STRIP: 24,
    BLEND: 25,
    ONE: 26,
    COLOR_BUFFER_BIT: 27
  }
  let handles = 0
  const textures = new Map<object, { width: number; height: number; format: number }>()
  const shaders = new Map<object, { type: number; source: string }>()
  const programs = new Map<object, { vertex: string; fragment: string }>()
  let boundTexture: object | null = null
  const record =
    (name: string, result?: (...args: unknown[]) => unknown) =>
    (...args: unknown[]) => {
      calls.push({ name, args })
      return result ? result(...args) : undefined
    }
  const handle = () => ({ handle: (handles += 1) })
  const gl: Record<string, unknown> = {
    ...constants,
    createVertexArray: record('createVertexArray', handle),
    bindVertexArray: record('bindVertexArray'),
    deleteVertexArray: record('deleteVertexArray'),
    getExtension: record('getExtension', () => ({})),
    createShader: record('createShader', (type) => {
      const shader = handle()
      shaders.set(shader, { type: type as number, source: '' })
      return shader
    }),
    shaderSource: record('shaderSource', (shader, text) => {
      shaders.get(shader as object)!.source = text as string
    }),
    compileShader: record('compileShader'),
    getShaderParameter: record('getShaderParameter', () => true),
    getShaderInfoLog: record('getShaderInfoLog', () => ''),
    deleteShader: record('deleteShader'),
    createProgram: record('createProgram', () => {
      const program = handle()
      programs.set(program, { vertex: '', fragment: '' })
      return program
    }),
    attachShader: record('attachShader', (program, shader) => {
      const entry = programs.get(program as object)!
      const attached = shaders.get(shader as object)!
      if (attached.type === constants.VERTEX_SHADER) entry.vertex = attached.source
      else entry.fragment = attached.source
    }),
    linkProgram: record('linkProgram'),
    getProgramParameter: record('getProgramParameter', () => true),
    getProgramInfoLog: record('getProgramInfoLog', () => ''),
    deleteProgram: record('deleteProgram'),
    getUniformLocation: record('getUniformLocation', handle),
    createTexture: record('createTexture', () => {
      const texture = handle()
      textures.set(texture, { width: 0, height: 0, format: 0 })
      return texture
    }),
    bindTexture: record('bindTexture', (_target, texture) => {
      boundTexture = texture as object | null
    }),
    texImage2D: record('texImage2D', (_target, _level, format, width, height) => {
      const entry = textures.get(boundTexture!)!
      entry.format = format as number
      entry.width = width as number
      entry.height = height as number
    }),
    texParameteri: record('texParameteri'),
    createFramebuffer: record('createFramebuffer', handle),
    bindFramebuffer: record('bindFramebuffer'),
    framebufferTexture2D: record('framebufferTexture2D'),
    deleteFramebuffer: record('deleteFramebuffer'),
    deleteTexture: record('deleteTexture'),
    viewport: record('viewport'),
    useProgram: record('useProgram'),
    uniform4fv: record('uniform4fv'),
    uniform1i: record('uniform1i'),
    activeTexture: record('activeTexture'),
    drawArrays: record('drawArrays'),
    drawArraysInstanced: record('drawArraysInstanced'),
    enable: record('enable'),
    disable: record('disable'),
    blendFunc: record('blendFunc'),
    clearColor: record('clearColor'),
    clear: record('clear'),
    generateMipmap: record('generateMipmap')
  }
  return {
    gl,
    calls,
    constants,
    textures,
    programs,
    /** The recorded calls of one name, in order. */
    named: (name: string) => calls.filter((call) => call.name === name),
    /** The `texParameteri` values set while `texture` was bound. */
    filters: (texture: object) => {
      const set: Record<number, number> = {}
      let bound: object | null = null
      for (const call of calls) {
        if (call.name === 'bindTexture') bound = call.args[1] as object | null
        if (call.name === 'texParameteri' && bound === texture) {
          set[call.args[1] as number] = call.args[2] as number
        }
      }
      return set
    }
  }
}

describe('live background WebGL runner (plan 190)', () => {
  it('sizes every pass exactly like the backend', () => {
    for (const entry of render.sizeCases.internal) {
      expect(runner.internalSize(render, entry.id, entry.output, entry.level)).toStrictEqual(
        entry.view
      )
    }
    for (const entry of render.sizeCases.plasma) {
      expect(runner.plasmaSizes(render, entry.view)).toStrictEqual({
        coarse: entry.coarse,
        fine: entry.fine,
        down: entry.down
      })
    }
    for (const entry of render.sizeCases.silkField) {
      expect(runner.silkFieldSize(entry.view)).toStrictEqual(entry.field)
    }
  })

  it('packs uniforms exactly like the backend', () => {
    expect(render.uniformCases.length).toBeGreaterThan(0)
    for (const entry of render.uniformCases) {
      const packed = runner.packUniforms(
        look(entry.id, entry.look),
        entry.target,
        entry.view,
        entry.phase,
        entry.dim
      )
      expect(Array.from(packed)).toStrictEqual(Array.from(new Float32Array(entry.packed.flat())))
    }
  })

  it('carries the React Bits credit', () => {
    expect(source).toContain('React Bits by David Haz')
  })
})

describe('live background WebGL runner (plan 194 S5)', () => {
  it('runs all ten backgrounds', () => {
    expect(render.backgrounds).toHaveLength(10)
    for (const entry of render.backgrounds) {
      expect(runner.runnable(entry.id), entry.id).toBe(true)
    }
    expect(runner.runnable('aurora')).toBe(false)
  })

  it('sizes the new scratch exactly like the backend', () => {
    expect(render.sizeCases.beamsField.length).toBeGreaterThan(0)
    for (const entry of render.sizeCases.beamsField) {
      expect(runner.beamsFieldSize(render, entry.view)).toStrictEqual(entry.field)
    }
    expect(render.sizeCases.dither.length).toBeGreaterThan(0)
    for (const entry of render.sizeCases.dither) {
      const pixelSize = look('dither', entry.look).statics[1][2]
      expect(runner.ditherCell(entry.view, pixelSize)).toBe(entry.cell)
      expect(runner.ditherFieldSize(entry.view, pixelSize)).toStrictEqual(entry.field)
    }
    expect(render.sizeCases.ferrofluid.length).toBeGreaterThan(0)
    for (const entry of render.sizeCases.ferrofluid) {
      const grid = runner.ferrofluidGrid(render, look('ferrofluid', entry.look), entry.view)
      expect(grid.size).toStrictEqual(entry.size)
      expect(grid.bound).toStrictEqual(entry.bound)
      expect(grid.origin[0]).toBeCloseTo(entry.origin[0], 6)
      expect(grid.origin[1]).toBeCloseTo(entry.origin[1], 6)
    }
    expect(render.sizeCases.ghostFibersBloom.length).toBeGreaterThan(0)
    for (const entry of render.sizeCases.ghostFibersBloom) {
      expect(runner.ghostFibersBloomSizes(entry.view)).toStrictEqual(entry.bloom)
    }
  })

  it('draws Ghost Fibers as two instanced additive strips into a cleared scene, then the bloom chain', () => {
    const fake = fakeGl()
    const live = runner.create(fake.gl, render)
    const violet = look('ghost-fibers', 'violet')
    live.draw({ id: 'ghost-fibers', look: 'violet', phase: 9, width: 1920, height: 1080 })

    // The dots, then the dust: one strip of four vertices per instance.
    const instanced = fake.named('drawArraysInstanced')
    expect(instanced.map((call) => call.args)).toStrictEqual([
      [fake.constants.TRIANGLE_STRIP, 0, 4, violet.instances!.dots],
      [fake.constants.TRIANGLE_STRIP, 0, 4, violet.instances!.dust]
    ])
    expect(violet.instances!.dots).toBe(3 * 72 * 260)
    // Their programs link the pass's own vertex shader, which positions
    // every quad from the instance and vertex ids.
    const dotsPass = background('ghost-fibers').passes.find((pass) => pass.key === 'dots')!
    expect(dotsPass.kind).toBe('instanced')
    expect(dotsPass.blend).toBe('additive')
    expect(dotsPass.clears).toBe(true)
    const linked = Array.from(fake.programs.values())
    expect(linked.filter((program) => program.vertex === dotsPass.vertexShader)).toHaveLength(1)
    expect(linked.filter((program) => program.vertex.includes('gl_InstanceID'))).toHaveLength(2)
    expect(linked.filter((program) => program.vertex === render.vertex)).toHaveLength(4)

    // The scene is cleared to transparent black once, before the dots, and
    // both strips add with ONE, ONE; blending is off again for the chain.
    const order = fake.calls.map((call) => call.name)
    const clearAt = order.indexOf('clear')
    expect(fake.named('clear')).toHaveLength(1)
    expect(fake.named('clearColor')[0].args).toStrictEqual([0, 0, 0, 0])
    expect(clearAt).toBeLessThan(order.indexOf('drawArraysInstanced'))
    expect(fake.named('blendFunc').map((call) => call.args)).toStrictEqual([
      [fake.constants.ONE, fake.constants.ONE],
      [fake.constants.ONE, fake.constants.ONE]
    ])
    expect(fake.named('enable').map((call) => call.args[0])).toStrictEqual([
      fake.constants.BLEND,
      fake.constants.BLEND
    ])
    const lastInstanced = order.lastIndexOf('drawArraysInstanced')
    expect(order.lastIndexOf('disable')).toBeGreaterThan(lastInstanced)
    expect(order.slice(lastInstanced).includes('enable')).toBe(false)

    // Bright, four downs, four ups and the composite: ten full-screen
    // triangles, into the view directly (1920 × 1080 is the internal size).
    expect(fake.named('drawArrays')).toHaveLength(10)
    expect(live.programsCompiled()).toBe(6)
    const floatTargets = Array.from(fake.textures.values()).filter(
      (texture) => texture.format === fake.constants.RGBA16F
    )
    expect(floatTargets.map((texture) => [texture.width, texture.height])).toStrictEqual([
      [1920, 1080],
      [960, 540],
      [480, 270],
      [240, 135],
      [120, 68],
      [60, 34],
      [120, 68],
      [240, 135],
      [480, 270],
      [960, 540]
    ])
    // The scene at 8 bytes a texel, five down levels and four up levels.
    expect(live.scratchBytes()).toBe(
      (1920 * 1080 + 2 * (960 * 540 + 480 * 270 + 240 * 135 + 120 * 68) + 60 * 34) * 8
    )

    // Another background's scratch goes; Ghost Fibers' stays.
    live.releaseExcept('beams')
    expect(live.scratchBytes()).toBe(0)
    live.dispose()
  })

  it('skips the dust strip for a look with no dust', () => {
    const fake = fakeGl()
    const live = runner.create(fake.gl, render)
    const noDust = JSON.parse(JSON.stringify(render)) as Render
    noDust.backgrounds.find((entry) => entry.id === 'ghost-fibers')!.looks[0].instances = {
      dots: 12,
      dust: 0
    }
    runner
      .create(fake.gl, noDust)
      .draw({ id: 'ghost-fibers', look: 'violet', phase: 9, width: 640, height: 360 })
    expect(fake.named('drawArraysInstanced').map((call) => call.args[3])).toStrictEqual([12])
    live.dispose()
  })

  it('renders Beams through a mipmapped half-float field', () => {
    const fake = fakeGl()
    const live = runner.create(fake.gl, render)
    live.draw({ id: 'beams', look: 'studio', phase: 24, width: 1920, height: 1080 })
    const field = Array.from(fake.textures.entries()).find(
      ([, texture]) => texture.format === fake.constants.RGBA16F
    )!
    expect([field[1].width, field[1].height]).toStrictEqual([1440, 810])
    expect(fake.filters(field[0])[fake.constants.TEXTURE_MIN_FILTER]).toBe(
      fake.constants.LINEAR_MIPMAP_LINEAR
    )
    // The field renders, its mips are generated, then the composite reads it.
    const order = fake.calls.map((call) => call.name)
    const mips = order.indexOf('generateMipmap')
    expect(fake.named('generateMipmap')).toHaveLength(1)
    expect(order.slice(0, mips).filter((name) => name === 'drawArrays')).toHaveLength(1)
    expect(order.slice(mips).filter((name) => name === 'drawArrays')).toHaveLength(1)
    expect(live.programsCompiled()).toBe(2)
    expect(live.scratchBytes()).toBe(Math.round(1440 * 810 * 8 * (4 / 3)))
    live.dispose()
  })

  it('renders Dither at full size through a nearest cell field, and Color Bends in one pass', () => {
    const fake = fakeGl()
    const live = runner.create(fake.gl, render)
    live.draw({ id: 'dither', look: 'classic', phase: 12, width: 3840, height: 2160 })
    // Dither is not soft: 4K renders 4K, so no present pass; the cell is
    // round(2 × 2160 / 1080) = 4 pixels, one texel each.
    expect(fake.named('drawArrays')).toHaveLength(2)
    expect(live.programsCompiled()).toBe(2)
    const [cells] = Array.from(fake.textures.entries())
    expect([cells[1].width, cells[1].height, cells[1].format]).toStrictEqual([
      960,
      540,
      fake.constants.RGBA8
    ])
    const filters = fake.filters(cells[0])
    expect(filters[fake.constants.TEXTURE_MIN_FILTER]).toBe(fake.constants.NEAREST)
    expect(filters[fake.constants.TEXTURE_MAG_FILTER]).toBe(fake.constants.NEAREST)
    expect(live.scratchBytes()).toBe(960 * 540 * 4)

    live.draw({ id: 'color-bends', look: 'ember', phase: 3, width: 1920, height: 1080 })
    expect(fake.named('drawArrays')).toHaveLength(3)
    expect(live.programsCompiled()).toBe(3)
    expect(fake.named('drawArraysInstanced')).toHaveLength(0)
    live.dispose()
  })

  it('renders Ferrofluid through its grid and a nearest bound', () => {
    const fake = fakeGl()
    const live = runner.create(fake.gl, render)
    live.draw({ id: 'ferrofluid', look: 'studio', phase: 5, width: 1920, height: 1080 })
    const grid = runner.ferrofluidGrid(render, look('ferrofluid', 'studio'), [1920, 1080])
    expect(grid.size).toStrictEqual([139, 93])
    const [field, bound] = Array.from(fake.textures.entries())
    expect([field[1].width, field[1].height, field[1].format]).toStrictEqual([
      139,
      93,
      fake.constants.RGBA16F
    ])
    expect([bound[1].width, bound[1].height, bound[1].format]).toStrictEqual([
      47,
      31,
      fake.constants.RGBA16F
    ])
    expect(fake.filters(field[0])[fake.constants.TEXTURE_MIN_FILTER]).toBe(fake.constants.LINEAR)
    expect(fake.filters(bound[0])[fake.constants.TEXTURE_MIN_FILTER]).toBe(fake.constants.NEAREST)
    expect(fake.named('drawArrays')).toHaveLength(3)
    expect(live.programsCompiled()).toBe(3)
    expect(live.scratchBytes()).toBe((139 * 93 + 47 * 31) * 8)
    live.dispose()
  })

  it('draws a soft background up through the present pass at 4K', () => {
    const fake = fakeGl()
    const live = runner.create(fake.gl, render)
    live.draw({ id: 'ghost-fibers', look: 'ember', phase: 9, width: 3840, height: 2160 })
    // Rendered at 1920 × 1080 (the soft rule), then presented to the canvas.
    expect(fake.named('drawArraysInstanced').map((call) => call.args[3])).toStrictEqual([
      look('ghost-fibers', 'ember').instances!.dots,
      look('ghost-fibers', 'ember').instances!.dust
    ])
    expect(fake.named('drawArrays')).toHaveLength(11)
    expect(live.programsCompiled()).toBe(7)
    const viewports = fake.named('viewport').map((call) => [call.args[2], call.args[3]])
    expect(viewports[0]).toStrictEqual([1920, 1080])
    expect(viewports[viewports.length - 1]).toStrictEqual([3840, 2160])
    live.dispose()
  })
})
