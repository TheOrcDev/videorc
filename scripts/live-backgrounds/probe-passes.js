/*
 * The probe's own WebGL2 runner for the plan 194 backgrounds (Beams, Color
 * Bends, Dither, Ferrofluid, Ghost Fibers), which the shared runner
 * (apps/desktop/src/shared/live-background-webgl.js) does not draw yet: they
 * need new scratch targets and, for Ghost Fibers, instanced additive passes
 * (plan 194 N2). Plan 194 S5 moves this into the shared runner with its unit
 * tests; until then only scripts/live-backgrounds/probe-main.cjs inlines it.
 *
 * It mirrors the backend's size rules (crates/videorc-backend/src/
 * live_background/sizes.rs) and checks them against the generated size cases
 * on creation, and it packs uniforms with the shared runner's packUniforms.
 *
 * The shaders are ported from React Bits by David Haz (https://reactbits.dev)
 * and used in Videorc with the author's permission.
 */
;(function (root) {
  'use strict'

  var FERROFLUID_TAN_HALF = Math.tan((19 * Math.PI) / 180)

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

  function findPass(background, key) {
    for (var index = 0; index < background.passes.length; index += 1) {
      if (background.passes[index].key === key) return background.passes[index]
    }
    throw new Error('live background ' + background.id + ' has no pass ' + key)
  }

  /** Mirrors `sizes::beams_field_size`. */
  function beamsFieldSize(render, view) {
    var width = Math.max(1, view[0])
    var height = Math.max(1, view[1])
    var scale = render.beamsFieldScale
    if (width * height * scale * scale > render.beamsMaxFieldPixels) {
      scale = Math.sqrt(render.beamsMaxFieldPixels / (width * height))
    }
    return [Math.max(1, Math.round(width * scale)), Math.max(1, Math.round(height * scale))]
  }

  /** Mirrors `sizes::dither_cell`. */
  function ditherCell(view, pixelSize) {
    var pixelScale = Math.max(1, Math.min(view[0], view[1])) / 1080
    return Math.max(1, Math.round(pixelSize * pixelScale))
  }

  /** Mirrors `sizes::dither_field_size`. */
  function ditherFieldSize(view, pixelSize) {
    var cell = ditherCell(view, pixelSize)
    return [
      Math.max(1, Math.ceil(Math.max(1, view[0]) / cell)),
      Math.max(1, Math.ceil(Math.max(1, view[1]) / cell))
    ]
  }

  /** Mirrors `sizes::ferrofluid_grid` for a look's packed camera (`u[4]`, `u[5]`). */
  function ferrofluidGrid(render, look, view) {
    var cameraY = look.statics[2][0]
    var cameraZ = look.statics[2][1]
    var far = look.statics[2][2]
    var forward = [look.statics[3][0], look.statics[3][1]]
    var upward = [look.statics[3][2], look.statics[3][3]]
    var aspect = Math.max(1, view[0]) / Math.max(1, view[1])
    var ground = function (x, y) {
      var sx = x * aspect * FERROFLUID_TAN_HALF
      var sy = y * FERROFLUID_TAN_HALF
      var dx = sx
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

  /** Mirrors `sizes::ghost_fibers_bloom_sizes`. */
  function ghostFibersBloomSizes(view) {
    var levels = []
    for (var index = 0; index < 5; index += 1) {
      var divisor = Math.pow(2, index + 1)
      levels.push([
        Math.max(1, Math.round(Math.max(1, view[0]) / divisor)),
        Math.max(1, Math.round(Math.max(1, view[1]) / divisor))
      ])
    }
    return levels
  }

  function same(a, b) {
    return JSON.stringify(a) === JSON.stringify(b)
  }

  /** Throws when a mirrored size rule disagrees with the backend's cases. */
  function verifySizeCases(render) {
    var cases = render.sizeCases
    cases.beamsField.forEach(function (entry) {
      if (!same(beamsFieldSize(render, entry.view), entry.field)) {
        throw new Error('beams field size drifted at ' + entry.view)
      }
    })
    var dither = findBackground(render, 'dither')
    cases.dither.forEach(function (entry) {
      var pixelSize = findLook(dither, entry.look).statics[1][2]
      if (ditherCell(entry.view, pixelSize) !== entry.cell) {
        throw new Error('dither cell drifted at ' + entry.view)
      }
      if (!same(ditherFieldSize(entry.view, pixelSize), entry.field)) {
        throw new Error('dither field size drifted at ' + entry.view)
      }
    })
    var ferrofluid = findBackground(render, 'ferrofluid')
    cases.ferrofluid.forEach(function (entry) {
      var grid = ferrofluidGrid(render, findLook(ferrofluid, entry.look), entry.view)
      if (!same(grid.size, entry.size) || !same(grid.bound, entry.bound)) {
        throw new Error('ferrofluid grid drifted at ' + entry.view + ' ' + entry.look)
      }
      if (
        Math.abs(grid.origin[0] - entry.origin[0]) > 1e-6 ||
        Math.abs(grid.origin[1] - entry.origin[1]) > 1e-6
      ) {
        throw new Error('ferrofluid grid origin drifted at ' + entry.view + ' ' + entry.look)
      }
    })
    cases.ghostFibersBloom.forEach(function (entry) {
      if (!same(ghostFibersBloomSizes(entry.view), entry.bloom)) {
        throw new Error('ghost fibers bloom sizes drifted at ' + entry.view)
      }
    })
  }

  /**
   * `shared` is the shared runner's namespace (`VideorcLiveBackground`): its
   * packUniforms and internalSize are the backend's.
   */
  function create(gl, render, shared) {
    verifySizeCases(render)
    var programs = {}
    var targets = {}
    var programsCompiled = 0
    var vao = gl.createVertexArray()
    if (!gl.getExtension('EXT_color_buffer_float')) {
      throw new Error('the plan 194 backgrounds need EXT_color_buffer_float')
    }
    var count = render.uniformVec4Count
    var presentFragment =
      '#version 300 es\nprecision highp float;\nuniform vec4 u[' +
      count +
      '];\nuniform sampler2D t0;\nout vec4 outColor;\n' +
      'void main() { outColor = texture(t0, gl_FragCoord.xy / u[0].xy); }\n'

    function compile(type, source, label) {
      var shader = gl.createShader(type)
      gl.shaderSource(shader, source)
      gl.compileShader(shader)
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
        var log = gl.getShaderInfoLog(shader)
        gl.deleteShader(shader)
        throw new Error('live background shader ' + label + ' failed to compile: ' + log)
      }
      return shader
    }

    function program(key, vertexSource, fragmentSource) {
      if (programs[key]) return programs[key]
      var vertex = compile(gl.VERTEX_SHADER, vertexSource, key + ' (vertex)')
      var fragment = compile(gl.FRAGMENT_SHADER, fragmentSource, key)
      var linked = gl.createProgram()
      gl.attachShader(linked, vertex)
      gl.attachShader(linked, fragment)
      gl.linkProgram(linked)
      gl.deleteShader(vertex)
      gl.deleteShader(fragment)
      if (!gl.getProgramParameter(linked, gl.LINK_STATUS)) {
        var log = gl.getProgramInfoLog(linked)
        gl.deleteProgram(linked)
        throw new Error('live background program ' + key + ' failed to link: ' + log)
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

    /** kind: 'byte' | 'float' | 'mipmapped-float'; filter: 'linear' | 'nearest'. */
    function target(key, size, kind, filter) {
      var existing = targets[key]
      if (existing && existing.width === size[0] && existing.height === size[1]) return existing
      if (existing) releaseTarget(key)
      var texture = gl.createTexture()
      gl.bindTexture(gl.TEXTURE_2D, texture)
      var half = kind !== 'byte'
      var mipmapped = kind === 'mipmapped-float'
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
      var nearest = filter === 'nearest'
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
     * generated pass entry: full-screen, or instanced with its vertices,
     * instances, blend and whether the target is cleared first.
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
      if (geometry && geometry.clears) {
        gl.clearColor(0, 0, 0, 0)
        gl.clear(gl.COLOR_BUFFER_BIT)
      }
      if (geometry && geometry.kind === 'instanced') {
        if (geometry.blend === 'additive') {
          gl.enable(gl.BLEND)
          gl.blendFunc(gl.ONE, gl.ONE)
        }
        gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, geometry.vertices, geometry.instances)
        gl.disable(gl.BLEND)
      } else {
        gl.drawArrays(gl.TRIANGLES, 0, 3)
      }
    }

    function draw(options) {
      var background = findBackground(render, options.id)
      if (!background) throw new Error('unknown live background ' + options.id)
      var look = findLook(background, options.look)
      var output = [options.width, options.height]
      var view = shared.internalSize(render, background.id, output, options.level || 'full')
      var direct = view[0] === output[0] && view[1] === output[1]
      var frame = direct ? null : target('frame', view, 'byte', 'linear')
      var phase = options.phase
      var dim = options.dim || 0
      var shaders = background.shaders
      var key = background.id + ':'
      var pack = function (targetSize) {
        return shared.packUniforms(look, targetSize, view, phase, dim)
      }
      var fullScreen = function (passKey) {
        return program(key + passKey, render.vertex, shaders[passKey])
      }
      gl.bindVertexArray(vao)
      gl.disable(gl.BLEND)

      if (background.id === 'beams') {
        var fieldSize = beamsFieldSize(render, view)
        var field = target('beams-field', fieldSize, 'mipmapped-float', 'linear')
        pass(fullScreen('field'), field, fieldSize, pack(fieldSize))
        gl.bindTexture(gl.TEXTURE_2D, field.texture)
        gl.generateMipmap(gl.TEXTURE_2D)
        pass(fullScreen('composite'), frame, view, pack(view), field)
      } else if (background.id === 'color-bends') {
        pass(fullScreen('main'), frame, view, pack(view))
      } else if (background.id === 'dither') {
        var cells = ditherFieldSize(view, look.statics[1][2])
        var wave = target('dither-field', cells, 'byte', 'nearest')
        pass(fullScreen('wave'), wave, cells, pack(cells))
        pass(fullScreen('composite'), frame, view, pack(view), wave)
      } else if (background.id === 'ferrofluid') {
        var grid = ferrofluidGrid(render, look, view)
        var state = target('ferrofluid-field', grid.size, 'float', 'linear')
        var bound = target('ferrofluid-bound', grid.bound, 'float', 'nearest')
        pass(fullScreen('field'), state, grid.size, pack(grid.size))
        pass(fullScreen('bound'), bound, grid.bound, pack(grid.bound), state)
        pass(fullScreen('render'), frame, view, pack(view), state, bound)
      } else if (background.id === 'ghost-fibers') {
        var dots = findPass(background, 'dots')
        var dust = findPass(background, 'dust')
        var instances = look.instances
        var scene = target('ghost-scene', view, 'float', 'linear')
        pass(
          program(key + 'dots', dots.vertexShader, shaders.dots),
          scene,
          view,
          pack(view),
          null,
          null,
          {
            kind: 'instanced',
            vertices: dots.vertices,
            instances: instances.dots,
            blend: dots.blend,
            clears: dots.clears
          }
        )
        if (instances.dust > 0) {
          pass(
            program(key + 'dust', dust.vertexShader, shaders.dust),
            scene,
            view,
            pack(view),
            null,
            null,
            {
              kind: 'instanced',
              vertices: dust.vertices,
              instances: instances.dust,
              blend: dust.blend,
              clears: dust.clears
            }
          )
        }
        var sizes = ghostFibersBloomSizes(view)
        var chain = []
        for (var level = 0; level < sizes.length; level += 1) {
          chain.push(target('ghost-bloom-' + level, sizes[level], 'float', 'linear'))
        }
        pass(fullScreen('bright'), chain[0], sizes[0], pack(sizes[0]), scene)
        for (var down = 1; down < sizes.length; down += 1) {
          pass(fullScreen('down'), chain[down], sizes[down], pack(sizes[down]), chain[down - 1])
        }
        // Up: each level adds the matching down level (React Bits blends in
        // place; separate targets give the same sum).
        var up = []
        for (var upLevel = sizes.length - 2; upLevel >= 0; upLevel -= 1) {
          var from = upLevel === sizes.length - 2 ? chain[sizes.length - 1] : up[upLevel + 1]
          up[upLevel] = target('ghost-up-' + upLevel, sizes[upLevel], 'float', 'linear')
          pass(
            fullScreen('up'),
            up[upLevel],
            sizes[upLevel],
            pack(sizes[upLevel]),
            from,
            chain[upLevel]
          )
        }
        pass(fullScreen('composite'), frame, view, pack(view), scene, up[0])
      } else {
        throw new Error('the probe runner does not draw ' + background.id)
      }

      if (!direct) {
        var present = program('present', render.vertex, presentFragment)
        var presentUniforms = new Float32Array(count * 4)
        presentUniforms[0] = output[0]
        presentUniforms[1] = output[1]
        pass(present, null, output, presentUniforms, frame)
      }
    }

    function releaseExcept(id) {
      Object.keys(targets).forEach(function (name) {
        var keep =
          name === 'frame' ||
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

  root.VideorcLiveBackgroundProbe = {
    create: create,
    beamsFieldSize: beamsFieldSize,
    ditherCell: ditherCell,
    ditherFieldSize: ditherFieldSize,
    ferrofluidGrid: ferrofluidGrid,
    ghostFibersBloomSizes: ghostFibersBloomSizes
  }
})(typeof globalThis !== 'undefined' ? globalThis : this)
