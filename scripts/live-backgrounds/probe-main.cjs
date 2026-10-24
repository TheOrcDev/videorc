// Electron main for the live background probe (plan 190 S1). One hidden
// window runs the shared WebGL2 runner (apps/desktop/src/shared/
// live-background-webgl.js) over the generated GLSL, writes its result JSON to
// VIDEORC_LIVE_PROBE_OUT, and quits.
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
const render = readFileSync(
  join(repoRoot, 'apps/desktop/src/shared/live-backgrounds.render.generated.json'),
  'utf8'
)

const page = `<!doctype html><html><head><meta charset="utf-8"></head>
<body style="margin:0;background:#000">
<script>${runner}</script>
<script>
const RENDER = ${render};

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
  const runner = VideorcLiveBackground.create(gl, RENDER);
  const looksFor = (background) => (options.allLooks ? background.looks : background.looks.slice(0, 1));

  if (options.mode === 'cost') {
    // gl.finish() does not wait for Chromium's GPU process and page timers are
    // coarse, so time on the GPU (EXT_disjoint_timer_query_webgl2), and cross-
    // check with a batch closed by a 1-pixel readPixels (which must wait).
    const timer = gl.getExtension('EXT_disjoint_timer_query_webgl2');
    const pixel = new Uint8Array(4);
    const sizes = options.sizes || [[1920, 1080, 'full'], [1080, 1920, 'full'], [3840, 2160, 'full'], [1920, 1080, 'half']];
    const frames = options.frames || 240;
    const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
    for (const background of RENDER.backgrounds) {
      for (const look of looksFor(background)) {
        for (const [width, height, level] of sizes) {
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
          const batch = 60;
          const start = performance.now();
          for (let index = 0; index < batch; index += 1) draw(index);
          gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
          const batchMs = (performance.now() - start) / batch;
          gpuTimes.sort((a, b) => a - b);
          const view = VideorcLiveBackground.internalSize(RENDER, background.id, [width, height], level);
          result.cases.push({
            id: background.id,
            look: look.id,
            output: [width, height],
            level,
            view,
            gpuSamples: gpuTimes.length,
            medianMs: gpuTimes.length ? percentile(gpuTimes, 0.5) : null,
            p95Ms: gpuTimes.length ? percentile(gpuTimes, 0.95) : null,
            batchMeanMs: batchMs,
            scratchBytes: runner.scratchBytes()
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
    for (const background of RENDER.backgrounds) {
      for (const look of background.looks) {
        for (const phase of [look.posterPhase, look.posterPhase + 5]) {
          runner.draw({ id: background.id, look: look.id, phase, dim: 0, width, height, level: 'full' });
          gl.finish();
          result.golden.push({ id: background.id, look: look.id, phase, rgb: boxGrid(gl, width, height, 64, 36) });
        }
      }
    }
  }

  if (options.mode === 'posters') {
    for (const background of RENDER.backgrounds) {
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
