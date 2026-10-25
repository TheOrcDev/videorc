// Electron main for the live background probe (plan 190 S1, plan 194 S1). One
// hidden window runs the shared WebGL2 runner (apps/desktop/src/shared/
// live-background-webgl.js) over the generated GLSL, plus the probe's own
// runner for the plan 194 backgrounds the shared one cannot draw yet
// (probe-passes.js: new scratch and the instanced passes), writes its result
// JSON to VIDEORC_LIVE_PROBE_OUT, and quits.
//
// Chromium runs WebGL on Metal (macOS), D3D11 (Windows) and GL (Linux), so
// the cost numbers predict each native port's cost on that machine.
//
// Launched by scripts/live-backgrounds/cost-probe.mjs; never part of the app.

const { app, BrowserWindow } = require('electron')
const { readFileSync, writeFileSync, mkdtempSync, rmSync } = require('node:fs')
const { join } = require('node:path')
const { tmpdir } = require('node:os')

const repoRoot = join(__dirname, '..', '..')
const args = JSON.parse(process.env.VIDEORC_LIVE_PROBE_ARGS || '{}')
const runner = readFileSync(
  join(repoRoot, 'apps/desktop/src/shared/live-background-webgl.js'),
  'utf8'
)
const probeRunner = readFileSync(join(__dirname, 'probe-passes.js'), 'utf8')
// --render <file> (cost-probe.mjs) swaps in another render JSON, for timing a
// variant of a look without touching the generated one.
const render = readFileSync(
  args.render || join(repoRoot, 'apps/desktop/src/shared/live-backgrounds.render.generated.json'),
  'utf8'
)

const page = `<!doctype html><html><head><meta charset="utf-8"></head>
<body style="margin:0;background:#000">
<script>${runner}</script>
<script>${probeRunner}</script>
<script>
const RENDER = ${render};

// The shared runner for the backgrounds it draws, the probe's for the rest;
// one surface for the modes below.
function combinedRunner(gl) {
  const shared = VideorcLiveBackground.create(gl, RENDER);
  const probe = VideorcLiveBackgroundProbe.create(gl, RENDER, VideorcLiveBackground);
  const pick = (id) => (VideorcLiveBackground.runnable(id) ? shared : probe);
  return {
    draw: (options) => pick(options.id).draw(options),
    releaseExcept: (id) => {
      shared.releaseExcept(id);
      probe.releaseExcept(id);
    },
    dispose: () => {
      shared.dispose();
      probe.dispose();
    },
    programsCompiled: () => shared.programsCompiled() + probe.programsCompiled(),
    scratchBytes: () => shared.scratchBytes() + probe.scratchBytes()
  };
}

function selectedBackgrounds(options) {
  const ids = Array.isArray(options.ids) && options.ids.length ? options.ids : null;
  return RENDER.backgrounds.filter((background) => !ids || ids.includes(background.id));
}

function percentile(sorted, share) {
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * share) - 1));
  return sorted[index];
}

function boxGrid(gl, width, height, gridWidth, gridHeight) {
  const pixels = new Uint8Array(width * height * 4);
  gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
  const cellWidth = width / gridWidth;
  const cellHeight = height / gridHeight;
  const out = new Uint8Array(gridWidth * gridHeight * 3);
  for (let gy = 0; gy < gridHeight; gy += 1) {
    for (let gx = 0; gx < gridWidth; gx += 1) {
      const sum = [0, 0, 0];
      let count = 0;
      for (let y = Math.floor(gy * cellHeight); y < Math.floor((gy + 1) * cellHeight); y += 1) {
        // readPixels rows run bottom-up; the grid runs top-down.
        const row = height - 1 - y;
        for (let x = Math.floor(gx * cellWidth); x < Math.floor((gx + 1) * cellWidth); x += 1) {
          const at = (row * width + x) * 4;
          sum[0] += pixels[at];
          sum[1] += pixels[at + 1];
          sum[2] += pixels[at + 2];
          count += 1;
        }
      }
      for (let channel = 0; channel < 3; channel += 1) {
        out[(gy * gridWidth + gx) * 3 + channel] = Math.round(sum[channel] / count);
      }
    }
  }
  let binary = '';
  for (let index = 0; index < out.length; index += 1) binary += String.fromCharCode(out[index]);
  return btoa(binary);
}

async function blobBase64(canvas, type, quality) {
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, type, quality));
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  for (let index = 0; index < bytes.length; index += 1) binary += String.fromCharCode(bytes[index]);
  return btoa(binary);
}

async function runProbe(options) {
  const canvas = document.createElement('canvas');
  document.body.appendChild(canvas);
  const gl = canvas.getContext('webgl2', {
    antialias: false,
    alpha: false,
    depth: false,
    stencil: false,
    preserveDrawingBuffer: true,
    powerPreference: 'high-performance'
  });
  if (!gl) return { error: 'no webgl2' };
  const debugInfo = gl.getExtension('WEBGL_debug_renderer_info');
  const result = {
    renderer: debugInfo ? gl.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER),
    vendor: debugInfo ? gl.getParameter(debugInfo.UNMASKED_VENDOR_WEBGL) : gl.getParameter(gl.VENDOR),
    timerQuery: Boolean(gl.getExtension('EXT_disjoint_timer_query_webgl2')),
    cases: [],
    golden: [],
    posters: []
  };
  let runner = combinedRunner(gl);
  const backgrounds = selectedBackgrounds(options);
  const looksFor = (background) => (options.allLooks ? background.looks : background.looks.slice(0, 1));

  if (options.mode === 'cost') {
    // gl.finish() does not wait for Chromium's GPU process and page timers are
    // coarse. Two timings:
    //
    // - Live frame (the gate's number, plan 194 S1): the live frame alone at
    //   its internal size, as the guard and the Metal test time it (no
    //   upscale to the output: the compose draws that like a picture). The
    //   render pass ends after every frame (a 1 × 1 clear elsewhere), so a
    //   tile GPU can't hidden-surface-remove whole frames, and the frames
    //   run in 30 batches of 8, each closed by a 1-pixel readPixels (which
    //   must wait). A batch's wall time over 8 is a frame's cost: GPU-bound
    //   it is the GPU time, CPU-bound it is an over-estimate. p95 is over the
    //   batch means.
    // - Timer query (EXT_disjoint_timer_query_webgl2), as plan 190's probe:
    //   on ANGLE over Metal it carries a floor of about 1 ms and a cost per
    //   canvas pixel (calibrated against the Metal numbers, plan 194 S1), so
    //   it is reported, never gated on.
    const timer = gl.getExtension('EXT_disjoint_timer_query_webgl2');
    const pixel = new Uint8Array(4);
    const sizes = options.sizes || [[1920, 1080, 'full'], [1080, 1920, 'full'], [3840, 2160, 'full'], [1920, 1080, 'half']];
    const frames = options.frames || 240;
    const batchFrames = 8;
    const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
    const breakTexture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, breakTexture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    const breakTarget = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, breakTarget);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, breakTexture, 0);
    const breakPass = () => {
      gl.bindFramebuffer(gl.FRAMEBUFFER, breakTarget);
      gl.viewport(0, 0, 1, 1);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    };
    for (const background of backgrounds) {
      for (const look of looksFor(background)) {
        for (const [width, height, level] of sizes) {
          const view = VideorcLiveBackground.internalSize(RENDER, background.id, [width, height], level);
          // A fresh runner per case, so the scratch it reports is this
          // case's alone.
          runner.dispose();
          runner = combinedRunner(gl);
          // The live frame at its internal size: drawn at the view with level
          // full, which the size rules leave at the view (a soft view is at
          // most 1080 on its short side; the full-size ones are identity).
          canvas.width = view[0];
          canvas.height = view[1];
          const liveDraw = (index) =>
            runner.draw({ id: background.id, look: look.id, phase: look.posterPhase + index / 60, dim: 0, width: view[0], height: view[1], level: 'full' });
          for (let index = 0; index < 20; index += 1) {
            liveDraw(index);
            breakPass();
          }
          gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
          const liveTimes = [];
          for (let batch = 0; batch < Math.ceil(frames / batchFrames); batch += 1) {
            const start = performance.now();
            for (let index = 0; index < batchFrames; index += 1) {
              liveDraw(batch * batchFrames + index);
              breakPass();
            }
            gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
            liveTimes.push((performance.now() - start) / batchFrames);
          }
          liveTimes.sort((a, b) => a - b);
          const liveScratch = runner.scratchBytes();
          runner.releaseExcept('');

          canvas.width = width;
          canvas.height = height;
          const draw = (index) =>
            runner.draw({ id: background.id, look: look.id, phase: look.posterPhase + index / 60, dim: 0, width, height, level });
          for (let index = 0; index < 20; index += 1) draw(index);
          gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
          const gpuTimes = [];
          if (timer) {
            const queries = [];
            for (let index = 0; index < frames; index += 1) {
              const query = gl.createQuery();
              gl.beginQuery(timer.TIME_ELAPSED_EXT, query);
              draw(index);
              gl.endQuery(timer.TIME_ELAPSED_EXT);
              queries.push(query);
              if (index % 8 === 7) gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
            }
            for (const query of queries) {
              for (let tries = 0; tries < 2000 && !gl.getQueryParameter(query, gl.QUERY_RESULT_AVAILABLE); tries += 1) {
                await settle();
              }
              const disjoint = gl.getParameter(timer.GPU_DISJOINT_EXT);
              if (!disjoint && gl.getQueryParameter(query, gl.QUERY_RESULT_AVAILABLE)) {
                gpuTimes.push(gl.getQueryParameter(query, gl.QUERY_RESULT) / 1e6);
              }
              gl.deleteQuery(query);
            }
          }
          gpuTimes.sort((a, b) => a - b);
          result.cases.push({
            id: background.id,
            look: look.id,
            output: [width, height],
            level,
            view,
            liveFrameSamples: liveTimes.length * batchFrames,
            liveMedianMs: percentile(liveTimes, 0.5),
            liveP95Ms: percentile(liveTimes, 0.95),
            gpuSamples: gpuTimes.length,
            medianMs: gpuTimes.length ? percentile(gpuTimes, 0.5) : null,
            p95Ms: gpuTimes.length ? percentile(gpuTimes, 0.95) : null,
            scratchBytes: liveScratch
          });
          runner.releaseExcept('');
        }
      }
    }
    result.programsCompiled = runner.programsCompiled();
  }

  if (options.mode === 'golden') {
    const [width, height] = [640, 360];
    canvas.width = width;
    canvas.height = height;
    for (const background of backgrounds) {
      for (const look of background.looks) {
        for (const phase of [look.posterPhase, look.posterPhase + 5]) {
          runner.draw({ id: background.id, look: look.id, phase, dim: 0, width, height, level: 'full' });
          gl.finish();
          result.golden.push({ id: background.id, look: look.id, phase, rgb: boxGrid(gl, width, height, 64, 36) });
        }
      }
    }
  }

  if (options.mode === 'frames') {
    // Every look of the selected backgrounds at one size and phase offset, as
    // PNG (by-eye checks, picking poster phases and palettes).
    const [width, height] = options.size || [960, 540];
    result.frames = [];
    for (const background of backgrounds) {
      for (const look of looksFor(background)) {
        canvas.width = width;
        canvas.height = height;
        const phase = look.posterPhase + (options.phaseOffset || 0);
        runner.draw({ id: background.id, look: look.id, phase, dim: 0, width, height, level: options.level || 'full' });
        gl.finish();
        result.frames.push({ id: background.id, look: look.id, phase, level: options.level || 'full', png: await blobBase64(canvas, 'image/png') });
      }
    }
  }

  if (options.mode === 'posters') {
    for (const background of backgrounds) {
      for (const look of background.looks) {
        const draw = (width, height) => {
          canvas.width = width;
          canvas.height = height;
          runner.draw({ id: background.id, look: look.id, phase: look.posterPhase, dim: 0, width, height, level: 'full' });
          gl.finish();
        };
        draw(1672, 941);
        const poster = await blobBase64(canvas, 'image/webp', 0.92);
        // The thumbnail is the poster scaled down, so a tile shows exactly what
        // a click puts on the scene (Line Waves' thin lines vanish if rendered
        // at thumbnail size).
        const small = document.createElement('canvas');
        small.width = 384;
        small.height = 216;
        const context = small.getContext('2d');
        context.imageSmoothingEnabled = true;
        context.imageSmoothingQuality = 'high';
        context.drawImage(canvas, 0, 0, 384, 216);
        const thumb = await blobBase64(small, 'image/webp', 0.86);
        result.posters.push({ id: background.id, look: look.id, poster, thumb });
      }
    }
  }

  runner.dispose();
  return result;
}
</script></body></html>`

app.whenReady().then(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'videorc-live-probe-'))
  const htmlPath = join(dir, 'probe.html')
  writeFileSync(htmlPath, page)
  const window = new BrowserWindow({
    show: false,
    width: 320,
    height: 180,
    paintWhenInitiallyHidden: true,
    webPreferences: { backgroundThrottling: false, contextIsolation: true, sandbox: true }
  })
  // The result can be megabytes (posters as base64); a pipe can lose its tail
  // when the process quits, so it goes through a file the parent names.
  const resultPath = process.env.VIDEORC_LIVE_PROBE_OUT
  let result
  try {
    await window.loadFile(htmlPath)
    result = await window.webContents.executeJavaScript(`runProbe(${JSON.stringify(args)})`)
  } catch (error) {
    result = { error: String(error && error.stack ? error.stack : error) }
  } finally {
    writeFileSync(resultPath, JSON.stringify(result ?? { error: 'no result' }))
    rmSync(dir, { recursive: true, force: true })
    app.quit()
  }
})
