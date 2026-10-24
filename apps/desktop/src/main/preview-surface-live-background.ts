// Live backgrounds on the Electron proof surface (plan 190 S6): the Windows
// idle preview and the Linux preview. The background layer keeps the look's
// poster <img> (the fallback and the first frame) and, for a live background,
// carries the shader spec and the clock constants; the surface runs the
// shared WebGL2 runner over them in a canvas it creates only then. Pure:
// main/index.ts owns the surface window and interpolates the scripts.

import type {
  EffectiveSceneBackground,
  LiveBackgroundStillReason,
  PreviewSurfaceLiveBackground,
  PreviewSurfaceLiveBackgroundStatus,
  PreviewSurfaceSceneLayer,
  SceneTransform
} from '../shared/backend'
import liveBackgroundClockSource from '../shared/live-background-clock.js?raw'
import { isLiveBackgroundId, isLiveBackgroundLook } from '../shared/live-background-ids'
import liveBackgroundRunnerSource from '../shared/live-background-webgl.js?raw'
import liveBackgroundRenderJson from '../shared/live-backgrounds.render.generated.json?raw'

type RenderLook = { id: string; rate: number; posterPhase: number }

let renderLooks: Map<string, RenderLook[]> | null = null

/** The looks per background from the backend's export, parsed on first use. */
function looksFor(id: string): RenderLook[] {
  if (!renderLooks) {
    const parsed = JSON.parse(liveBackgroundRenderJson) as {
      backgrounds: { id: string; looks: RenderLook[] }[]
    }
    renderLooks = new Map(
      parsed.backgrounds.map((background) => [
        background.id,
        background.looks.map(({ id: lookId, rate, posterPhase }) => ({
          id: lookId,
          rate,
          posterPhase
        }))
      ])
    )
  }
  return renderLooks.get(id) ?? []
}

/** Dim as the shaders take it (`u[1].z`): dimPercent / 100, clamped to 0..0.8. */
export function liveBackgroundDim(dimPercent: unknown): number {
  const dim = Number(dimPercent) / 100
  return Number.isFinite(dim) ? Math.min(0.8, Math.max(0, dim)) : 0
}

/**
 * The live description a background layer carries, or undefined for a
 * picture. An unknown look renders as the first look, as the backend's
 * `look_or_first` does.
 */
export function previewSurfaceLiveBackground(
  background: EffectiveSceneBackground
): PreviewSurfaceLiveBackground | undefined {
  const live = background.live
  if (!live || !isLiveBackgroundId(live.id)) return undefined
  const looks = looksFor(live.id)
  const look = looks.find((candidate) => candidate.id === live.look) ?? looks[0]
  if (!look) return undefined
  return {
    id: live.id,
    look: look.id,
    motion: live.motion === 'normal' ? 'normal' : 'calm',
    dim: liveBackgroundDim(background.dimPercent),
    rate: look.rate,
    posterPhase: look.posterPhase
  }
}

const FULL_FRAME: SceneTransform = {
  x: 0,
  y: 0,
  width: 1,
  height: 1,
  cropLeft: 0,
  cropTop: 0,
  cropRight: 0,
  cropBottom: 0
}

/**
 * The proof surface's background layer: the managed picture (for a live
 * background, its poster) drawn by the surface's <img> path, plus the live
 * spec when there is one. A live layer's id names the background, not the
 * poster, so a look change keeps the layer, its canvas and its clock.
 */
export function previewSurfaceBackgroundLayer(
  background: EffectiveSceneBackground | undefined,
  imageUrl: (managedAssetPath: string) => string
): PreviewSurfaceSceneLayer | null {
  const managedAssetPath = background?.managedAssetPath?.trim()
  if (!background || !managedAssetPath) {
    return null
  }
  const live = previewSurfaceLiveBackground(background)
  return {
    id: live ? `background:live-${live.id}` : `background:${background.assetId}`,
    name: 'Scene background',
    kind: 'background',
    transform: { ...FULL_FRAME },
    visible: true,
    imageUrl: imageUrl(managedAssetPath),
    fit: background.fit === 'fit' ? 'contain' : background.fit === 'stretch' ? 'fill' : 'cover',
    mirror: false,
    ...(live ? { live } : {})
  }
}

const STILL_REASONS: readonly LiveBackgroundStillReason[] = [
  'forced',
  'legacy-graph',
  'cpu-fallback',
  'no-gpu',
  'software-gpu',
  'quarantined-node',
  'shader-compile-failed',
  'gpu-budget'
]

const MAX_DETAIL_LENGTH = 300

/** The prefix of the console line the surface prints on every status change. */
export const PREVIEW_SURFACE_LIVE_BACKGROUND_CONSOLE_PREFIX = '[live-background] '

/**
 * The surface's live background status as it arrives (a metrics field or the
 * JSON after the console prefix), validated. Undefined when there is none or
 * the shape is wrong.
 */
export function previewSurfaceLiveBackgroundStatusFrom(
  value: unknown
): PreviewSurfaceLiveBackgroundStatus | undefined {
  if (!value || typeof value !== 'object') return undefined
  const raw = value as Record<string, unknown>
  if (!isLiveBackgroundId(raw.id) || !isLiveBackgroundLook(raw.look)) return undefined
  const rendering = raw.rendering
  if (rendering !== 'starting' && rendering !== 'shader' && rendering !== 'still') {
    return undefined
  }
  const status: PreviewSurfaceLiveBackgroundStatus = { id: raw.id, look: raw.look, rendering }
  if ((STILL_REASONS as readonly unknown[]).includes(raw.reason)) {
    status.reason = raw.reason as LiveBackgroundStillReason
  }
  if (typeof raw.detail === 'string' && raw.detail.length > 0) {
    status.detail = raw.detail.slice(0, MAX_DETAIL_LENGTH)
  }
  if (typeof raw.renderer === 'string' && raw.renderer.length > 0) {
    status.renderer = raw.renderer.slice(0, MAX_DETAIL_LENGTH)
  }
  return status
}

/** The status after the console prefix, or undefined for `null` and garbage. */
export function previewSurfaceLiveBackgroundStatusFromConsoleLine(
  line: string
): { status: PreviewSurfaceLiveBackgroundStatus | undefined } | null {
  if (!line.startsWith(PREVIEW_SURFACE_LIVE_BACKGROUND_CONSOLE_PREFIX)) return null
  try {
    const parsed: unknown = JSON.parse(
      line.slice(PREVIEW_SURFACE_LIVE_BACKGROUND_CONSOLE_PREFIX.length)
    )
    return { status: previewSurfaceLiveBackgroundStatusFrom(parsed) }
  } catch {
    return { status: undefined }
  }
}

/** One line for the backend log when the surface's status changes. */
export function previewSurfaceLiveBackgroundLogLine(
  status: PreviewSurfaceLiveBackgroundStatus | undefined
): { level: 'info' | 'warn'; message: string } | null {
  if (!status || status.rendering === 'starting') return null
  const name = `${status.id} (${status.look})`
  if (status.rendering === 'still') {
    const detail = status.detail ? `: ${status.detail}` : ''
    return {
      level: 'warn',
      message: `[proof-preview] live background ${name} shows its poster, reason ${status.reason ?? 'unknown'}${detail}`
    }
  }
  const renderer = status.renderer ? ` on ${status.renderer}` : ''
  return { level: 'info', message: `[proof-preview] live background ${name} is moving${renderer}` }
}

/** A JS string literal of `text`, safe inside a <script> element. */
function stringLiteralForInlineScript(text: string): string {
  return JSON.stringify(text).replace(/</g, '\\u003c')
}

/**
 * The classic script the surface document inlines under its nonce: the
 * WebGL2 runner, the clock, and the render JSON as one string literal. Parsing
 * a string literal is all it costs; the JSON is decoded the first time a live
 * background shows, and the runner compiles nothing until it draws.
 */
export function previewSurfaceLiveBackgroundLibraryScript(): string {
  return `${liveBackgroundRunnerSource}\n${liveBackgroundClockSource}\nvar VIDEORC_LIVE_BACKGROUND_RENDER_JSON = ${stringLiteralForInlineScript(liveBackgroundRenderJson)};\n`
}

/**
 * Browser-side glue for the proof document, in the same scope as its layer
 * code. Nothing here allocates, listens or draws until a background layer
 * carries `live`: the per-frame and per-scene-update cost while off is one
 * Map size check and one property read.
 *
 * Expects in scope: `document`, `window`, `performance`, `console`, the
 * globals the library script defines (`VideorcLiveBackground`,
 * `VideorcLiveBackgroundClock`, `VIDEORC_LIVE_BACKGROUND_RENDER_JSON`), and
 * layer entries shaped `{ element, image }`.
 */
export const PREVIEW_SURFACE_LIVE_BACKGROUND_RUNTIME_SCRIPT = String.raw`
const liveBackgrounds = new Map();
let liveBackgroundRender = null;
let liveBackgroundsSuspended = false;
let liveBackgroundGpuRefusal = null;

function liveBackgroundNow() {
  return performance.now() / 1000;
}

function liveBackgroundRenderData() {
  if (!liveBackgroundRender) {
    liveBackgroundRender = JSON.parse(VIDEORC_LIVE_BACKGROUND_RENDER_JSON);
  }
  return liveBackgroundRender;
}

function liveBackgroundSpecsEqual(a, b) {
  return (
    a.id === b.id &&
    a.look === b.look &&
    a.motion === b.motion &&
    a.dim === b.dim &&
    a.rate === b.rate &&
    a.posterPhase === b.posterPhase
  );
}

function liveBackgroundsHeld() {
  return liveBackgroundsSuspended || document.hidden === true;
}

function refreshLiveBackgroundsHold(now) {
  const held = liveBackgroundsHeld();
  for (const live of liveBackgrounds.values()) {
    if (held) {
      VideorcLiveBackgroundClock.hold(live.clock, now);
    } else {
      VideorcLiveBackgroundClock.release(live.clock, now);
    }
  }
}

function onLiveBackgroundVisibilityChange() {
  refreshLiveBackgroundsHold(liveBackgroundNow());
}

/** The surface's own suspension (setProofSurfaceSuspended) also holds the clock. */
function setLiveBackgroundsSuspended(suspended, now) {
  liveBackgroundsSuspended = suspended === true;
  if (liveBackgrounds.size > 0) {
    refreshLiveBackgroundsHold(now);
  }
}

function liveBackgroundStatus(live) {
  return {
    id: live.spec.id,
    look: live.spec.look,
    rendering: live.rendering,
    reason: live.reason,
    detail: live.detail,
    renderer: live.renderer
  };
}

/** Every status change reaches main as one console line (and the DOM for probes). */
function publishLiveBackgroundStatus(live) {
  const status = live ? liveBackgroundStatus(live) : null;
  document.body.dataset.liveBackground = status
    ? status.rendering === 'still'
      ? 'still:' + (status.reason || 'unknown')
      : status.rendering
    : '';
  console.info('[live-background] ' + JSON.stringify(status));
}

function setLiveBackgroundRendering(live, rendering, reason, detail) {
  live.rendering = rendering;
  live.reason = reason;
  live.detail = detail;
  publishLiveBackgroundStatus(live);
}

function liveBackgroundErrorText(error) {
  const text = error && typeof error.message === 'string' ? error.message : String(error);
  return text.slice(0, 300);
}

function liveBackgroundRendererName(gl) {
  try {
    const info = gl.getExtension('WEBGL_debug_renderer_info');
    const name = info ? gl.getParameter(info.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
    return typeof name === 'string' ? name.slice(0, 300) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Chromium refused a context with failIfMajorPerformanceCaveat: either the GPU
 * would be software (SwiftShader) or there is none. One throwaway context
 * without the caveat tells which; it is lost again at once and the answer is
 * kept for the document's life.
 */
function liveBackgroundGpuRefusalReason() {
  if (liveBackgroundGpuRefusal) {
    return liveBackgroundGpuRefusal;
  }
  let reason = 'no-gpu';
  try {
    const probe = document.createElement('canvas');
    const gl = probe.getContext('webgl2', {
      failIfMajorPerformanceCaveat: false,
      powerPreference: 'default'
    });
    if (gl) {
      reason = 'software-gpu';
      const lose = gl.getExtension('WEBGL_lose_context');
      if (lose) {
        lose.loseContext();
      }
    }
  } catch {
    reason = 'no-gpu';
  }
  liveBackgroundGpuRefusal = reason;
  return reason;
}

function disposeLiveBackgroundGl(live, loseContext) {
  if (live.retryTimer !== null) {
    clearTimeout(live.retryTimer);
    live.retryTimer = null;
  }
  const gl = live.gl;
  live.gl = null;
  if (live.runner) {
    try {
      live.runner.dispose();
    } catch {
      // The context may already be gone; its objects went with it.
    }
    live.runner = null;
  }
  if (gl && loseContext) {
    try {
      const lose = gl.getExtension('WEBGL_lose_context');
      if (lose) {
        lose.loseContext();
      }
    } catch {
      // Already lost.
    }
  }
  if (live.canvas) {
    live.canvas.remove();
    live.canvas = null;
  }
}

function failLiveBackground(live, reason, error) {
  disposeLiveBackgroundGl(live, true);
  setLiveBackgroundRendering(live, 'still', reason, liveBackgroundErrorText(error));
}

/**
 * The GPU process went away (a reset or a crash). Drop everything and try
 * once more after a pause; a second loss keeps the poster until the scene
 * changes the background.
 */
function onLiveBackgroundContextLost(live, gl, statusMessage) {
  if (live.gl !== gl) {
    return;
  }
  const attempts = live.attempts + 1;
  live.attempts = attempts;
  disposeLiveBackgroundGl(live, false);
  setLiveBackgroundRendering(
    live,
    'still',
    'no-gpu',
    'WebGL context lost' + (statusMessage ? ': ' + statusMessage : '')
  );
  if (attempts < 2) {
    live.retryTimer = setTimeout(() => {
      live.retryTimer = null;
      if (liveBackgrounds.get(live.id) === live) {
        startLiveBackground(live);
      }
    }, 2000);
  }
}

function startLiveBackground(live) {
  const canvas = document.createElement('canvas');
  canvas.className = 'live-background';
  canvas.dataset.drawn = '0';
  let creationError = '';
  const onCreationError = (event) => {
    creationError = typeof event.statusMessage === 'string' ? event.statusMessage : '';
  };
  canvas.addEventListener('webglcontextcreationerror', onCreationError);
  let gl = null;
  try {
    gl = canvas.getContext('webgl2', {
      antialias: false,
      alpha: false,
      depth: false,
      stencil: false,
      preserveDrawingBuffer: false,
      powerPreference: 'default',
      failIfMajorPerformanceCaveat: true
    });
  } catch (error) {
    creationError = liveBackgroundErrorText(error);
  }
  canvas.removeEventListener('webglcontextcreationerror', onCreationError);
  if (!gl) {
    setLiveBackgroundRendering(
      live,
      'still',
      liveBackgroundGpuRefusalReason(),
      creationError.slice(0, 300) || undefined
    );
    return;
  }
  live.gl = gl;
  live.canvas = canvas;
  live.renderer = liveBackgroundRendererName(gl);
  canvas.addEventListener('webglcontextlost', (event) => {
    onLiveBackgroundContextLost(live, gl, event && event.statusMessage);
  });
  try {
    live.runner = VideorcLiveBackground.create(gl, liveBackgroundRenderData());
  } catch (error) {
    failLiveBackground(live, 'shader-compile-failed', error);
    return;
  }
  // Hidden (opacity 0) until its first frame: the poster shows meanwhile.
  live.entry.element.appendChild(canvas);
  setLiveBackgroundRendering(live, 'starting', undefined, undefined);
}

/**
 * Called from upsertLayer for every background layer. The spec is the layer's
 * live field; absent means a picture, which tears down any canvas left from
 * a live background that this layer id used to carry.
 */
function syncLiveBackgroundLayer(id, entry, spec, now) {
  if (!spec || typeof spec !== 'object') {
    if (liveBackgrounds.size > 0) {
      teardownLiveBackground(id);
    }
    return;
  }
  let live = liveBackgrounds.get(id);
  if (live && live.entry === entry) {
    if (!liveBackgroundSpecsEqual(live.spec, spec)) {
      // A look, motion or dim change on the same background: re-base, no jump.
      VideorcLiveBackgroundClock.update(live.clock, spec, now);
      const named = live.spec.id !== spec.id || live.spec.look !== spec.look;
      live.spec = spec;
      if (named) {
        publishLiveBackgroundStatus(live);
      }
    }
    return;
  }
  if (live) {
    teardownLiveBackground(id);
  }
  live = {
    id,
    entry,
    spec,
    clock: VideorcLiveBackgroundClock.start(spec, now),
    canvas: null,
    gl: null,
    runner: null,
    renderer: undefined,
    rendering: 'starting',
    reason: undefined,
    detail: undefined,
    frames: 0,
    attempts: 0,
    retryTimer: null
  };
  liveBackgrounds.set(id, live);
  if (liveBackgrounds.size === 1) {
    document.addEventListener('visibilitychange', onLiveBackgroundVisibilityChange);
  }
  if (liveBackgroundsHeld()) {
    VideorcLiveBackgroundClock.hold(live.clock, now);
  }
  startLiveBackground(live);
}

function teardownLiveBackground(id) {
  const live = liveBackgrounds.get(id);
  if (!live) {
    return;
  }
  disposeLiveBackgroundGl(live, true);
  liveBackgrounds.delete(id);
  if (liveBackgrounds.size === 0) {
    document.removeEventListener('visibilitychange', onLiveBackgroundVisibilityChange);
    publishLiveBackgroundStatus(null);
  }
}

/**
 * One frame per live background, from the surface's requestAnimationFrame
 * tick. The canvas covers its layer at device pixels, capped at the frame
 * width the surface already caps its source frames to; the runner applies
 * the internal-size rules itself.
 */
function drawLiveBackgrounds(now, maxWidth) {
  if (liveBackgrounds.size === 0 || liveBackgroundsHeld()) {
    return;
  }
  const seconds = now / 1000;
  const scale = Math.max(1, Number(window.devicePixelRatio) || 1);
  const cap = Math.max(1, Math.round(Number(maxWidth) || 1920));
  for (const live of liveBackgrounds.values()) {
    if (!live.gl || !live.runner) {
      continue;
    }
    const element = live.entry.element;
    const boxWidth = element.clientWidth;
    const boxHeight = element.clientHeight;
    if (!(boxWidth > 0) || !(boxHeight > 0)) {
      continue;
    }
    let width = Math.max(1, Math.round(boxWidth * scale));
    let height = Math.max(1, Math.round(boxHeight * scale));
    if (width > cap) {
      height = Math.max(1, Math.round((height * cap) / width));
      width = cap;
    }
    if (live.canvas.width !== width || live.canvas.height !== height) {
      live.canvas.width = width;
      live.canvas.height = height;
    }
    try {
      live.runner.draw({
        id: live.spec.id,
        look: live.spec.look,
        phase: VideorcLiveBackgroundClock.phaseAt(live.clock, seconds),
        dim: live.spec.dim,
        width,
        height,
        level: 'full'
      });
    } catch (error) {
      failLiveBackground(live, 'shader-compile-failed', error);
      continue;
    }
    live.frames += 1;
    if (live.canvas.dataset.drawn !== '1') {
      live.canvas.dataset.drawn = '1';
      setLiveBackgroundRendering(live, 'shader', undefined, undefined);
    }
  }
}

/** For the metrics readout: null while no background layer is live. */
function liveBackgroundMetrics() {
  if (liveBackgrounds.size === 0) {
    return null;
  }
  const live = liveBackgrounds.values().next().value;
  return Object.assign(liveBackgroundStatus(live), {
    frames: live.frames,
    canvas: Boolean(live.canvas),
    width: live.canvas ? live.canvas.width : 0,
    height: live.canvas ? live.canvas.height : 0
  });
}
`
