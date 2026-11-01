/*
 * Live background WebGL2 runner (plans 190 and 194).
 *
 * Plain JavaScript on purpose: the Electron preview surface inlines this file
 * as text (Windows idle preview, Linux preview), and the S1 cost probe loads
 * it as a file. It runs the generated GLSL from
 * `live-backgrounds.render.generated.json` with the same uniform packing and
 * size rules as the backend renderers (crates/videorc-backend/src/
 * live_background/), so a preview matches the recording.
 *
 * Plan 194 S5: the instanced pass kind (Ghost Fibers' dots and dust) is
 * `drawArraysInstanced` of a triangle strip from the pass's own vertex shader,
 * blended additively into a cleared scene; the new scratch is Beams'
 * mipmapped half-float field, Dither's cell field (fetched by texel),
 * Ferrofluid's grid and bound, and Ghost Fibers' scene and bloom chain.
 *
 * The shaders are ported from React Bits by David Haz (https://reactbits.dev)
 * and used in Videorc with the author's permission.
 *
 * Usage:
 *   const runner = VideorcLiveBackground.create(gl, renderJson)
 *   runner.draw({ id, look, phase, dim, width, height, level: 'full' | 'half' })
 *   runner.dispose()
 */
;(function (root) {
  'use strict'

  /** tan(19°): half of React Bits' Ferrofluid field of view (ferrofluid.frag). */
  var FERROFLUID_TAN_HALF = Math.tan((19 * Math.PI) / 180)

  /** The block every shader declares: `uniform vec4 u[N]` (`looks::UNIFORM_VEC4_COUNT`). */
  function uniformVec4Count(render) {
    return render.uniformVec4Count || 16
  }

  function presentFragment(render) {
    return (
      '#version 300 es\n' +
      'precision highp float;\n' +
      'uniform vec4 u[' +
      uniformVec4Count(render) +
      '];\n' +
      'uniform sampler2D t0;\n' +
      'out vec4 outColor;\n' +
      'void main() { outColor = texture(t0, gl_FragCoord.xy / u[0].xy); }\n'
    )
  }

  /** The backgrounds this runner draws: all ten since plan 194 S5. */
  var RUNNABLE = {
    silk: true,
    'side-rays': true,
    'plasma-wave': true,
    'liquid-chrome': true,
    'line-waves': true,
    beams: true,
    'color-bends': true,
    dither: true,
    ferrofluid: true,
    'ghost-fibers': true
  }

  function roundHalfUp(value) {
    return Math.round(value)
  }

  /** Mirrors `sizes::internal_size`. */
  function internalSize(render, id, output, level) {
    var background = findBackground(render, id)
    var width = Math.max(1, output[0])
    var height = Math.max(1, output[1])
    var maxShortSide = id === 'ferrofluid' ? render.ferrofluidMaxShortSide : render.softMaxShortSide
    var scale =
      background && background.soft ? Math.min(maxShortSide / Math.min(width, height), 1) : 1
    if (level === 'half') scale *= 0.5
    return [Math.max(16, roundHalfUp(width * scale)), Math.max(16, roundHalfUp(height * scale))]
  }

  /** Mirrors `sizes::silk_field_size`. */
  function silkFieldSize(view) {
    return [Math.max(1, roundHalfUp(view[0] / 4)), Math.max(1, roundHalfUp(view[1] / 4))]
  }

  /** Mirrors `sizes::plasma_sizes`. */
  function plasmaSizes(render, view) {
    var width = Math.max(1, view[0])
    var height = Math.max(1, view[1])
    var scale = 1
    if (width * height > render.plasmaMaxLightPixels) {
      scale = Math.sqrt(render.plasmaMaxLightPixels / (width * height))
    }
    var fine = [Math.max(1, roundHalfUp(width * scale)), Math.max(1, roundHalfUp(height * scale))]
    var coarse = [Math.max(1, roundHalfUp(fine[0] / 3)), Math.max(1, roundHalfUp(fine[1] / 3))]
    var down = [[Math.max(1, roundHalfUp(width / 2)), Math.max(1, roundHalfUp(height / 2))]]
    for (var level = 1; level < 5; level += 1) {
      down.push([Math.max(1, down[level - 1][0] >> 1), Math.max(1, down[level - 1][1] >> 1)])
    }
    return { coarse: coarse, fine: fine, down: down }
  }

  /** Mirrors `sizes::beams_field_size`. */
  function beamsFieldSize(render, view) {
    var width = Math.max(1, view[0])
    var height = Math.max(1, view[1])
    var scale = render.beamsFieldScale
    if (width * height * scale * scale > render.beamsMaxFieldPixels) {
      scale = Math.sqrt(render.beamsMaxFieldPixels / (width * height))
    }
    return [Math.max(1, roundHalfUp(width * scale)), Math.max(1, roundHalfUp(height * scale))]
  }

  /** Mirrors `sizes::dither_cell`. */
  function ditherCell(view, pixelSize) {
    var pixelScale = Math.max(1, Math.min(view[0], view[1])) / 1080
    return Math.max(1, roundHalfUp(pixelSize * pixelScale))
  }

  /** Mirrors `sizes::dither_field_size`. */
  function ditherFieldSize(view, pixelSize) {
    var cell = ditherCell(view, pixelSize)
    return [
      Math.max(1, Math.ceil(Math.max(1, view[0]) / cell)),
      Math.max(1, Math.ceil(Math.max(1, view[1]) / cell))
    ]
  }

  /**
   * Mirrors `sizes::ferrofluid_grid` for a look's packed camera (`u[4]` and
   * `u[5]`: statics rows 2 and 3).
   */
  function ferrofluidGrid(render, look, view) {
    var cameraY = look.statics[2][0]
    var cameraZ = look.statics[2][1]
    var far = look.statics[2][2]
    var forward = [look.statics[3][0], look.statics[3][1]]
    var upward = [look.statics[3][2], look.statics[3][3]]
    var aspect = Math.max(1, view[0]) / Math.max(1, view[1])
    var ground = function (x, y) {
      var dx = x * aspect * FERROFLUID_TAN_HALF
      var sy = y * FERROFLUID_TAN_HALF
      var dy = forward[0] + sy * upward[0]
      var dz = forward[1] + sy * upward[1]
      var length = Math.max(Math.hypot(dx, dy, dz), 1e-12)
      dx /= length
      dy /= length
      dz /= length
      var t = dz < -0.004 ? Math.min(-cameraZ / dz, far) : far
      return [dx * t, cameraY + dy * t]
    }
    var corners = [ground(-1, -1), ground(1, -1), ground(-1, 1), ground(1, 1), ground(0, 1)]
    var minX = Infinity
    var maxX = -Infinity
    var minY = Infinity
    var maxY = -Infinity
    corners.forEach(function (corner) {
      minX = Math.min(minX, corner[0])
      maxX = Math.max(maxX, corner[0])
      minY = Math.min(minY, corner[1])
      maxY = Math.max(maxY, corner[1])
    })
    minX -= 3
    maxX += 3
    minY -= 3
    maxY += 3
    var cell = render.ferrofluidCell
    var boundCell = render.ferrofluidBoundCell
    var width = Math.ceil((maxX - minX) / cell) + 2
    var height = Math.ceil((maxY - minY) / cell) + 2
    return {
      origin: [minX, minY],
      size: [width, height],
      bound: [Math.ceil((width * cell) / boundCell), Math.ceil((height * cell) / boundCell)]
    }
  }

  /** Mirrors `sizes::ghost_fibers_bloom_sizes`: five levels from half size. */
  function ghostFibersBloomSizes(view) {
    var levels = []
    for (var index = 0; index < 5; index += 1) {
      var divisor = Math.pow(2, index + 1)
      levels.push([
        Math.max(1, roundHalfUp(Math.max(1, view[0]) / divisor)),
        Math.max(1, roundHalfUp(Math.max(1, view[1]) / divisor))
      ])
    }
    return levels
  }

  function findBackground(render, id) {
    for (var index = 0; index < render.backgrounds.length; index += 1) {
      if (render.backgrounds[index].id === id) return render.backgrounds[index]
    }
    return null
  }

  function findLook(background, lookId) {
    for (var index = 0; index < background.looks.length; index += 1) {
      if (background.looks[index].id === lookId) return background.looks[index]
    }
    return background.looks[0]
  }

  /** The generated pass entry (its kind, blend, clear and vertex shader). */
  function findPass(background, key) {
    for (var index = 0; index < background.passes.length; index += 1) {
      if (background.passes[index].key === key) return background.passes[index]
    }
    throw new Error('live background ' + background.id + ' has no pass ' + key)
  }

  /** Mirrors `looks::uniforms`: two shared vec4s then the look's statics, flattened. */
  function packUniforms(look, target, view, phase, dim) {
    var out = new Float32Array(8 + look.statics.length * 4)
    out[0] = target[0]
    out[1] = target[1]
    out[2] = phase
    out[3] = Math.max(1, Math.min(view[0], view[1])) / 1080
    out[4] = view[0]
    out[5] = view[1]
    out[6] = Math.min(Math.max(dim || 0, 0), 0.8)
    out[7] = 0
    for (var row = 0; row < look.statics.length; row += 1) {
      for (var column = 0; column < 4; column += 1) {
        out[8 + row * 4 + column] = look.statics[row][column]
      }
    }
    return out
  }

  function create(gl, render) {
    var programs = {}
    var targets = {}
    var programsCompiled = 0
    var vao = gl.createVertexArray()
    var floatTargets = Boolean(gl.getExtension('EXT_color_buffer_float'))

    function compile(type, source) {
      var shader = gl.createShader(type)
      gl.shaderSource(shader, source)
      gl.compileShader(shader)
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
        var log = gl.getShaderInfoLog(shader)
        gl.deleteShader(shader)
        throw new Error('live background shader failed to compile: ' + log)
      }
      return shader
    }

    /** `vertexSource` is an instanced pass's own; the rest get the full-screen triangle. */
    function program(key, fragment, vertexSource) {
      if (programs[key]) return programs[key]
      var vertex = compile(gl.VERTEX_SHADER, vertexSource || render.vertex)
      var fragmentShader = compile(gl.FRAGMENT_SHADER, fragment)
      var linked = gl.createProgram()
      gl.attachShader(linked, vertex)
      gl.attachShader(linked, fragmentShader)
      gl.linkProgram(linked)
      gl.deleteShader(vertex)
      gl.deleteShader(fragmentShader)
      if (!gl.getProgramParameter(linked, gl.LINK_STATUS)) {
        var log = gl.getProgramInfoLog(linked)
        gl.deleteProgram(linked)
        throw new Error('live background program failed to link: ' + log)
      }
      programsCompiled += 1
      programs[key] = {
        program: linked,
        u: gl.getUniformLocation(linked, 'u'),
        t0: gl.getUniformLocation(linked, 't0'),
        t1: gl.getUniformLocation(linked, 't1')
      }
      return programs[key]
    }

    /**
     * A render target the passes also sample. `kind`: 'byte' (RGBA8), 'float'
     * (RGBA16F), 'mipmapped' (RGBA8 with a mip chain) or 'mipmapped-float';
     * `filter`: 'linear' (the default) or 'nearest' for a field fetched by
     * texel.
     */
    function target(key, size, kind, filter) {
      var existing = targets[key]
      if (existing && existing.width === size[0] && existing.height === size[1]) return existing
      if (existing) releaseTarget(key)
      var texture = gl.createTexture()
      gl.bindTexture(gl.TEXTURE_2D, texture)
      var half = kind === 'float' || kind === 'mipmapped-float'
      var mipmapped = kind === 'mipmapped' || kind === 'mipmapped-float'
      var nearest = filter === 'nearest'
      if (half && !floatTargets) {
        throw new Error('live background needs EXT_color_buffer_float')
      }
      gl.texImage2D(
        gl.TEXTURE_2D,
        0,
        half ? gl.RGBA16F : gl.RGBA8,
        size[0],
        size[1],
        0,
        gl.RGBA,
        half ? gl.HALF_FLOAT : gl.UNSIGNED_BYTE,
        null
      )
      gl.texParameteri(
        gl.TEXTURE_2D,
        gl.TEXTURE_MIN_FILTER,
        mipmapped ? gl.LINEAR_MIPMAP_LINEAR : nearest ? gl.NEAREST : gl.LINEAR
      )
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, nearest ? gl.NEAREST : gl.LINEAR)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
      var framebuffer = gl.createFramebuffer()
      gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer)
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0)
      var levels = mipmapped ? 1 + Math.floor(Math.log2(Math.max(size[0], size[1]))) : 1
      targets[key] = {
        texture: texture,
        framebuffer: framebuffer,
        width: size[0],
        height: size[1],
        bytes: Math.round(size[0] * size[1] * (half ? 8 : 4) * (levels > 1 ? 4 / 3 : 1))
      }
      return targets[key]
    }

    function releaseTarget(key) {
      var existing = targets[key]
      if (!existing) return
      gl.deleteFramebuffer(existing.framebuffer)
      gl.deleteTexture(existing.texture)
      delete targets[key]
    }

    /**
     * One pass into `destination` (null: the canvas). `geometry` is the
     * generated pass entry of an instanced pass with its instance count
     * (`{ vertices, instances, blend, clears }`); without one the pass is the
     * full-screen triangle.
     */
    function pass(entry, destination, size, uniforms, t0, t1, geometry) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, destination ? destination.framebuffer : null)
      gl.viewport(0, 0, size[0], size[1])
      gl.useProgram(entry.program)
      gl.uniform4fv(entry.u, uniforms)
      if (t0) {
        gl.activeTexture(gl.TEXTURE0)
        gl.bindTexture(gl.TEXTURE_2D, t0.texture)
        gl.uniform1i(entry.t0, 0)
      }
      if (t1) {
        gl.activeTexture(gl.TEXTURE1)
        gl.bindTexture(gl.TEXTURE_2D, t1.texture)
        gl.uniform1i(entry.t1, 1)
      }
      if (!geometry) {
        gl.drawArrays(gl.TRIANGLES, 0, 3)
        return
      }
      if (geometry.clears) {
        gl.clearColor(0, 0, 0, 0)
        gl.clear(gl.COLOR_BUFFER_BIT)
      }
      if (geometry.blend === 'additive') {
        gl.enable(gl.BLEND)
        gl.blendFunc(gl.ONE, gl.ONE)
      }
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, geometry.vertices, geometry.instances)
      gl.disable(gl.BLEND)
    }

    /** An instanced pass's program and geometry for a look. */
    function instanced(background, key, instances) {
      var entry = findPass(background, key)
      return {
        program: program(background.id + ':' + key, background.shaders[key], entry.vertexShader),
        geometry: {
          vertices: entry.vertices,
          instances: instances,
          blend: entry.blend,
          clears: entry.clears
        }
      }
    }

    /**
     * Draw one frame into the bound default framebuffer at width × height.
     * `phase` is the shader clock (React Bits time units), `dim` 0–0.8.
     */
    function draw(options) {
      var background = findBackground(render, options.id)
      if (!background) throw new Error('unknown live background ' + options.id)
      if (!RUNNABLE[background.id]) {
        throw new Error('live background ' + background.id + ' has no WebGL runner')
      }
      var look = findLook(background, options.look)
      var output = [options.width, options.height]
      var view = internalSize(render, background.id, output, options.level || 'full')
      var direct = view[0] === output[0] && view[1] === output[1]
      var frame = direct ? null : target('frame', view, 'byte')
      var phase = options.phase
      var dim = options.dim || 0
      var shaders = background.shaders
      var key = background.id + ':'
      gl.bindVertexArray(vao)
      gl.disable(gl.BLEND)

      if (background.id === 'silk') {
        var fieldSize = silkFieldSize(view)
        var field = target('silk-field', fieldSize, 'mipmapped')
        pass(
          program(key + 'field', shaders.field),
          field,
          fieldSize,
          packUniforms(look, fieldSize, view, phase, dim)
        )
        gl.bindTexture(gl.TEXTURE_2D, field.texture)
        gl.generateMipmap(gl.TEXTURE_2D)
        pass(
          program(key + 'composite', shaders.composite),
          frame,
          view,
          packUniforms(look, view, view, phase, dim),
          field
        )
      } else if (background.id === 'plasma-wave') {
        var sizes = plasmaSizes(render, view)
        var coarse = target('plasma-coarse', sizes.coarse, 'float')
        var fine = target('plasma-fine', sizes.fine, 'float')
        pass(
          program(key + 'coarse', shaders.coarse),
          coarse,
          sizes.coarse,
          packUniforms(look, sizes.coarse, view, phase, dim)
        )
        pass(
          program(key + 'fine', shaders.fine),
          fine,
          sizes.fine,
          packUniforms(look, sizes.fine, view, phase, dim),
          coarse
        )
        var down = []
        var source = fine
        for (var level = 0; level < 5; level += 1) {
          down.push(target('plasma-down-' + level, sizes.down[level], 'float'))
          pass(
            program(key + 'down', shaders.down),
            down[level],
            sizes.down[level],
            packUniforms(look, sizes.down[level], view, phase, dim),
            source
          )
          source = down[level]
        }
        var up = []
        for (var upLevel = 3; upLevel >= 1; upLevel -= 1) {
          var from = upLevel === 3 ? down[4] : up[upLevel + 1]
          up[upLevel] = target('plasma-up-' + upLevel, sizes.down[upLevel], 'float')
          pass(
            program(key + 'up', shaders.up),
            up[upLevel],
            sizes.down[upLevel],
            packUniforms(look, sizes.down[upLevel], view, phase, dim),
            from,
            down[upLevel]
          )
        }
        pass(
          program(key + 'composite', shaders.composite),
          frame,
          view,
          packUniforms(look, view, view, phase, dim),
          fine,
          up[1]
        )
      } else if (background.id === 'beams') {
        var beamsSize = beamsFieldSize(render, view)
        var beamsField = target('beams-field', beamsSize, 'mipmapped-float')
        pass(
          program(key + 'field', shaders.field),
          beamsField,
          beamsSize,
          packUniforms(look, beamsSize, view, phase, dim)
        )
        gl.bindTexture(gl.TEXTURE_2D, beamsField.texture)
        gl.generateMipmap(gl.TEXTURE_2D)
        pass(
          program(key + 'composite', shaders.composite),
          frame,
          view,
          packUniforms(look, view, view, phase, dim),
          beamsField
        )
      } else if (background.id === 'dither') {
        // One texel per cell; the cell comes from the look's pixel size
        // (`u[3].z`), as the shader derives it.
        var cells = ditherFieldSize(view, look.statics[1][2])
        var wave = target('dither-field', cells, 'byte', 'nearest')
        pass(
          program(key + 'wave', shaders.wave),
          wave,
          cells,
          packUniforms(look, cells, view, phase, dim)
        )
        pass(
          program(key + 'composite', shaders.composite),
          frame,
          view,
          packUniforms(look, view, view, phase, dim),
          wave
        )
      } else if (background.id === 'ferrofluid') {
        var grid = ferrofluidGrid(render, look, view)
        var state = target('ferrofluid-field', grid.size, 'float')
        var bound = target('ferrofluid-bound', grid.bound, 'float', 'nearest')
        pass(
          program(key + 'field', shaders.field),
          state,
          grid.size,
          packUniforms(look, grid.size, view, phase, dim)
        )
        pass(
          program(key + 'bound', shaders.bound),
          bound,
          grid.bound,
          packUniforms(look, grid.bound, view, phase, dim),
          state
        )
        pass(
          program(key + 'render', shaders.render),
          frame,
          view,
          packUniforms(look, view, view, phase, dim),
          state,
          bound
        )
      } else if (background.id === 'ghost-fibers') {
        // The dots clear the scene and add into it; the dust adds after them
        // (a look with none skips the draw).
        var sceneUniforms = packUniforms(look, view, view, phase, dim)
        var scene = target('ghost-scene', view, 'float')
        var dots = instanced(background, 'dots', look.instances.dots)
        pass(dots.program, scene, view, sceneUniforms, null, null, dots.geometry)
        if (look.instances.dust > 0) {
          var dust = instanced(background, 'dust', look.instances.dust)
          pass(dust.program, scene, view, sceneUniforms, null, null, dust.geometry)
        }
        // The bright level and four down levels, then the up chain back to
        // level 0: each up level adds the matching down level (React Bits
        // blends in place; separate targets give the same sum).
        var bloomSizes = ghostFibersBloomSizes(view)
        var chain = []
        for (var bloomLevel = 0; bloomLevel < bloomSizes.length; bloomLevel += 1) {
          chain.push(target('ghost-bloom-' + bloomLevel, bloomSizes[bloomLevel], 'float'))
        }
        pass(
          program(key + 'bright', shaders.bright),
          chain[0],
          bloomSizes[0],
          packUniforms(look, bloomSizes[0], view, phase, dim),
          scene
        )
        for (var downLevel = 1; downLevel < bloomSizes.length; downLevel += 1) {
          pass(
            program(key + 'down', shaders.down),
            chain[downLevel],
            bloomSizes[downLevel],
            packUniforms(look, bloomSizes[downLevel], view, phase, dim),
            chain[downLevel - 1]
          )
        }
        var risen = []
        for (var risenLevel = bloomSizes.length - 2; risenLevel >= 0; risenLevel -= 1) {
          var risenFrom =
            risenLevel === bloomSizes.length - 2
              ? chain[bloomSizes.length - 1]
              : risen[risenLevel + 1]
          risen[risenLevel] = target('ghost-up-' + risenLevel, bloomSizes[risenLevel], 'float')
          pass(
            program(key + 'up', shaders.up),
            risen[risenLevel],
            bloomSizes[risenLevel],
            packUniforms(look, bloomSizes[risenLevel], view, phase, dim),
            risenFrom,
            chain[risenLevel]
          )
        }
        pass(
          program(key + 'composite', shaders.composite),
          frame,
          view,
          sceneUniforms,
          scene,
          risen[0]
        )
      } else {
        pass(
          program(key + 'main', shaders.main),
          frame,
          view,
          packUniforms(look, view, view, phase, dim)
        )
      }

      if (!direct) {
        var present = program('present', presentFragment(render))
        var presentUniforms = new Float32Array(uniformVec4Count(render) * 4)
        presentUniforms[0] = output[0]
        presentUniforms[1] = output[1]
        pass(present, null, output, presentUniforms, frame)
      }
    }

    /** Drop scratch targets another background used (keeps the active one's). */
    function releaseExcept(id) {
      Object.keys(targets).forEach(function (name) {
        var keep =
          name === 'frame' ||
          (id === 'silk' && name.indexOf('silk-') === 0) ||
          (id === 'plasma-wave' && name.indexOf('plasma-') === 0) ||
          (id === 'beams' && name.indexOf('beams-') === 0) ||
          (id === 'dither' && name.indexOf('dither-') === 0) ||
          (id === 'ferrofluid' && name.indexOf('ferrofluid-') === 0) ||
          (id === 'ghost-fibers' && name.indexOf('ghost-') === 0)
        if (!keep) releaseTarget(name)
      })
    }

    function dispose() {
      Object.keys(targets).forEach(releaseTarget)
      Object.keys(programs).forEach(function (name) {
        gl.deleteProgram(programs[name].program)
      })
      programs = {}
      gl.deleteVertexArray(vao)
    }

    return {
      draw: draw,
      releaseExcept: releaseExcept,
      dispose: dispose,
      programsCompiled: function () {
        return programsCompiled
      },
      scratchBytes: function () {
        return Object.keys(targets).reduce(function (sum, name) {
          return sum + targets[name].bytes
        }, 0)
      }
    }
  }

  root.VideorcLiveBackground = {
    create: create,
    internalSize: internalSize,
    silkFieldSize: silkFieldSize,
    plasmaSizes: plasmaSizes,
    beamsFieldSize: beamsFieldSize,
    ditherCell: ditherCell,
    ditherFieldSize: ditherFieldSize,
    ferrofluidGrid: ferrofluidGrid,
    ghostFibersBloomSizes: ghostFibersBloomSizes,
    packUniforms: packUniforms,
    runnable: function (id) {
      return Boolean(RUNNABLE[id])
    }
  }
})(typeof globalThis !== 'undefined' ? globalThis : this)
