/*
 * Live background WebGL2 runner (plan 190).
 *
 * Plain JavaScript on purpose: the Electron preview surface inlines this file
 * as text (Windows idle preview, Linux preview), and the S1 cost probe loads
 * it as a file. It runs the generated GLSL from
 * `live-backgrounds.render.generated.json` with the same uniform packing and
 * size rules as the backend renderers (crates/videorc-backend/src/
 * live_background/), so a preview matches the recording.
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

  var PRESENT_FRAGMENT =
    '#version 300 es\n' +
    'precision highp float;\n' +
    'uniform vec4 u[9];\n' +
    'uniform sampler2D t0;\n' +
    'out vec4 outColor;\n' +
    'void main() { outColor = texture(t0, gl_FragCoord.xy / u[0].xy); }\n'

  function roundHalfUp(value) {
    return Math.round(value)
  }

  /** Mirrors `sizes::internal_size`. */
  function internalSize(render, id, output, level) {
    var background = findBackground(render, id)
    var width = Math.max(1, output[0])
    var height = Math.max(1, output[1])
    var scale =
      background && background.soft
        ? Math.min(render.softMaxShortSide / Math.min(width, height), 1)
        : 1
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

  /** Mirrors `looks::uniforms`: nine vec4s, flattened. */
  function packUniforms(look, target, view, phase, dim) {
    var out = new Float32Array(36)
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

    function program(key, fragment) {
      if (programs[key]) return programs[key]
      var vertex = compile(gl.VERTEX_SHADER, render.vertex)
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

    function target(key, size, kind) {
      var existing = targets[key]
      if (existing && existing.width === size[0] && existing.height === size[1]) return existing
      if (existing) releaseTarget(key)
      var texture = gl.createTexture()
      gl.bindTexture(gl.TEXTURE_2D, texture)
      var half = kind === 'float'
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
        kind === 'mipmapped' ? gl.LINEAR_MIPMAP_LINEAR : gl.LINEAR
      )
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
      var framebuffer = gl.createFramebuffer()
      gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer)
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0)
      var levels = kind === 'mipmapped' ? 1 + Math.floor(Math.log2(Math.max(size[0], size[1]))) : 1
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

    function pass(entry, destination, size, uniforms, t0, t1) {
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
      gl.drawArrays(gl.TRIANGLES, 0, 3)
    }

    /**
     * Draw one frame into the bound default framebuffer at width × height.
     * `phase` is the shader clock (React Bits time units), `dim` 0–0.8.
     */
    function draw(options) {
      var background = findBackground(render, options.id)
      if (!background) throw new Error('unknown live background ' + options.id)
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
      } else {
        pass(
          program(key + 'main', shaders.main),
          frame,
          view,
          packUniforms(look, view, view, phase, dim)
        )
      }

      if (!direct) {
        var present = program('present', PRESENT_FRAGMENT)
        var presentUniforms = new Float32Array(36)
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
          (id === 'plasma-wave' && name.indexOf('plasma-') === 0)
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
    packUniforms: packUniforms
  }
})(typeof globalThis !== 'undefined' ? globalThis : this)
