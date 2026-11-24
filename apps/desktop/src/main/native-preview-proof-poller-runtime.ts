/**
 * Browser-side helpers injected into the detached Windows proof surface.
 *
 * Keeping the state transitions in one executable snippet lets the Node test
 * run the same code that Electron evaluates inside the proof window.
 */
export const NATIVE_PREVIEW_PROOF_POLLER_RUNTIME_SCRIPT = String.raw`
function stopLayerPoller(id, options = {}) {
  const existingPoller = pollers.get(id);
  if (!existingPoller) {
    pollers.delete(id);
    return null;
  }

  existingPoller.cancelled = true;
  existingPoller.abortController?.abort();
  const preserveFrame = options.preserveFrame === true;
  const preservedFrame = preserveFrame
    ? {
        objectUrl: existingPoller.objectUrl,
        startedAt: existingPoller.startedAt,
        lastFrameAdvanceAt: existingPoller.lastFrameAdvanceAt,
        lastTransportSuccessAt: existingPoller.lastTransportSuccessAt
      }
    : null;

  if (!preserveFrame && existingPoller.image?.videorcI420Gl) {
    // A GL canvas keeps its last frame in the drawing buffer; hidden instead.
    existingPoller.image.dataset.live = '0';
  }
  if (!preserveFrame && existingPoller.bitmapContext) {
    // Plan 257 S3: a canvas source layer drops its last bitmap like an <img>
    // drops its src.
    try {
      existingPoller.bitmapContext.transferFromImageBitmap(null);
    } catch {
      // A context that cannot clear keeps its pixels; liveness says otherwise.
    }
    existingPoller.image.dataset.live = '0';
  }
  if (!preserveFrame && existingPoller.objectUrl) {
    if (existingPoller.image.src === existingPoller.objectUrl) {
      existingPoller.image.removeAttribute('src');
      existingPoller.image.dataset.live = '0';
    }
    URL.revokeObjectURL(existingPoller.objectUrl);
  }
  pollers.delete(id);
  return preservedFrame;
}

function markProofPollerTransportSuccess(poller, now) {
  poller.lastTransportSuccessAt = now;
}

function markProofPollerFrameAdvance(poller, now) {
  poller.lastTransportSuccessAt = now;
  poller.lastFrameAdvanceAt = now;
}

// Transport accounting (issue #157): the proof surface is a production
// preview transport on Windows, so its request rate, payload bytes, and
// decoded source dimensions must be observable instead of inferred.
function markProofPollerRequestStarted(poller) {
  poller.requestCount = (poller.requestCount ?? 0) + 1;
}

function markProofPollerNotModified(poller) {
  poller.notModifiedCount = (poller.notModifiedCount ?? 0) + 1;
}

function markProofPollerFrameDecoded(poller, byteLength, width, height, now) {
  poller.bytesReceived = (poller.bytesReceived ?? 0) +
    (Number.isFinite(byteLength) && byteLength > 0 ? byteLength : 0);
  poller.decodedFrames = (poller.decodedFrames ?? 0) + 1;
  if (Number.isFinite(width) && width > 0 && Number.isFinite(height) && height > 0) {
    poller.lastFrameWidth = width;
    poller.lastFrameHeight = height;
  }
  // A gap of over a second is a resume (a hidden Preview shown again; a real
  // stall is the watchdog's): the rate is measured from the resume on.
  if (poller.lastDecodeAt != null && now - poller.lastDecodeAt > PROOF_SOURCE_FPS_RESUME_GAP_MS) {
    poller.recentDecodeTimes = [];
    poller.firstDecodeAt = now;
  }
  poller.lastDecodeAt = now;
  poller.firstDecodeAt = poller.firstDecodeAt ?? now;
  // Plan 257 S3: the decode times of the last two seconds, for a steady
  // per-source presented rate (proofSourceFps).
  const recent = poller.recentDecodeTimes ?? [];
  recent.push(now);
  while (recent.length > 0 && now - recent[0] > PROOF_SOURCE_FPS_WINDOW_MS) {
    recent.shift();
  }
  poller.recentDecodeTimes = recent;
}

const PROOF_SOURCE_FPS_WINDOW_MS = 2000;

// A layer younger than this has too few frames to judge.
const PROOF_SOURCE_FPS_MIN_SPAN_MS = 500;
const PROOF_SOURCE_FPS_RESUME_GAP_MS = 1000;

// The slowest source layer's presented frames per second over the last two
// seconds (over its own life, while that is shorter), or null with no layer
// old enough to judge. Unlike the transport rates it does not depend on how
// often anything reads the metrics, and a restarted layer does not read slow.
function proofSourceFps(activePollers, now) {
  // A hidden page is throttled by Chromium; its rate says nothing.
  if (typeof document !== 'undefined' && document.visibilityState === 'hidden') {
    return null;
  }
  let slowest = null;
  for (const poller of activePollers.values()) {
    const span = Math.min(PROOF_SOURCE_FPS_WINDOW_MS, now - (poller.firstDecodeAt ?? now));
    if (span < PROOF_SOURCE_FPS_MIN_SPAN_MS) {
      continue;
    }
    const recent = (poller.recentDecodeTimes ?? []).filter((at) => now - at <= span);
    const fps = recent.length / (span / 1000);
    slowest = slowest === null ? fps : Math.min(slowest, fps);
  }
  return slowest;
}

function proofPollerTransportTotals(activePollers) {
  let requestCount = 0;
  let notModifiedCount = 0;
  let bytesReceived = 0;
  let decodedFrames = 0;
  const sourceDimensions = {};
  for (const [id, poller] of activePollers) {
    requestCount += poller.requestCount ?? 0;
    notModifiedCount += poller.notModifiedCount ?? 0;
    bytesReceived += poller.bytesReceived ?? 0;
    decodedFrames += poller.decodedFrames ?? 0;
    if (poller.lastFrameWidth != null && poller.lastFrameHeight != null) {
      sourceDimensions[id] = {
        width: poller.lastFrameWidth,
        height: poller.lastFrameHeight
      };
    }
  }
  return { requestCount, notModifiedCount, bytesReceived, decodedFrames, sourceDimensions };
}

function presentProofPollerFrame(poller, objectUrl) {
  const previousObjectUrl = poller.objectUrl;
  poller.image.src = objectUrl;
  poller.image.dataset.live = '1';
  poller.objectUrl = objectUrl;
  if (previousObjectUrl && previousObjectUrl !== objectUrl) {
    URL.revokeObjectURL(previousObjectUrl);
  }
}

// Plan 257 S3: a canvas source layer shows each decoded bitmap without a copy.
function presentProofPollerBitmap(poller, bitmap) {
  const canvas = poller.image;
  if (canvas.width !== bitmap.width) {
    canvas.width = bitmap.width;
  }
  if (canvas.height !== bitmap.height) {
    canvas.height = bitmap.height;
  }
  poller.bitmapContext = poller.bitmapContext ?? canvas.getContext('bitmaprenderer');
  poller.bitmapContext.transferFromImageBitmap(bitmap);
  canvas.dataset.live = '1';
}

// Plan 257 S3: with a pipelined request two frames of one layer can decode at
// once; only a frame newer than the one on screen may replace it. A new
// source run (generation) always replaces it.
function proofPollerCursorIsNewer(poller, cursor) {
  if (!cursor || poller.presentedGeneration !== cursor.generation) {
    return true;
  }
  return !Number.isSafeInteger(poller.presentedSequence) || cursor.sequence > poller.presentedSequence;
}

function markProofPollerPresentedCursor(poller, cursor) {
  if (cursor) {
    poller.presentedGeneration = cursor.generation;
    poller.presentedSequence = cursor.sequence;
  }
}

// The I420 blank check: a frame whose first luma row is all zero cannot be
// video-range BT.709 (its luma never goes under 16), so it was never a picture.
// Cheap, but checked on the first frame and then one a second, like the
// Windows path's readback.
const PROOF_I420_BLANK_CHECK_EVERY = 30;

function proofI420IsBlankSampled(poller, buffer) {
  const count = poller.blankCheckCount ?? 0;
  poller.blankCheckCount = count + 1;
  if (count % PROOF_I420_BLANK_CHECK_EVERY !== 0) {
    return false;
  }
  const luma = new Uint8Array(buffer, 0, Math.min(64, buffer.byteLength));
  return luma.length === 0 || luma.every((value) => value === 0);
}

// Plan 257 S3: the backend's I420 frame (Y, then U, then V; BT.709 video
// range, the recording colorimetry) as a bitmap the GPU converted.
async function proofBitmapFromI420(buffer, response) {
  const width = Number(response.headers.get('x-videorc-frame-width'));
  const height = Number(response.headers.get('x-videorc-frame-height'));
  if (!(width > 0) || !(height > 0) || buffer.byteLength < width * height * 1.5) {
    throw new Error('Preview frame is not an I420 frame of its stated size.');
  }
  const frame = new VideoFrame(new Uint8Array(buffer, 0, width * height * 1.5), {
    format: 'I420',
    codedWidth: width,
    codedHeight: height,
    timestamp: 0,
    colorSpace: { primaries: 'bt709', transfer: 'bt709', matrix: 'bt709', fullRange: false }
  });
  try {
    return await createImageBitmap(frame);
  } finally {
    frame.close();
  }
}

// Plan 257 S3: draw an I420 frame with WebGL: three single-channel textures
// and a BT.709 video-range shader, so the colour conversion runs on the GPU
// and the only CPU work is the texture upload.
const PROOF_I420_VERTEX = 'attribute vec2 p; varying vec2 t; void main() { t = vec2((p.x + 1.0) * 0.5, (1.0 - p.y) * 0.5); gl_Position = vec4(p, 0.0, 1.0); }';
const PROOF_I420_FRAGMENT = 'precision mediump float; varying vec2 t; uniform sampler2D y; uniform sampler2D u; uniform sampler2D v; void main() { float Y = 1.16438 * (texture2D(y, t).r - 0.0627451); float U = texture2D(u, t).r - 0.501961; float V = texture2D(v, t).r - 0.501961; gl_FragColor = vec4(Y + 1.79274 * V, Y - 0.21325 * U - 0.53291 * V, Y + 2.11240 * U, 1.0); }';

// The canvas keeps its GL state (a restarted poller draws into the same
// canvas, and a canvas has one context for life). Null when WebGL is
// unavailable: the frame then goes through createImageBitmap instead.
function proofI420GlContext(canvas) {
  if (canvas.videorcI420Gl !== undefined) {
    return canvas.videorcI420Gl;
  }
  const gl = canvas.getContext('webgl', { alpha: false, antialias: false, depth: false, preserveDrawingBuffer: false });
  if (!gl) {
    canvas.videorcI420Gl = null;
    return null;
  }
  const shader = (type, source) => {
    const compiled = gl.createShader(type);
    gl.shaderSource(compiled, source);
    gl.compileShader(compiled);
    return compiled;
  };
  const program = gl.createProgram();
  gl.attachShader(program, shader(gl.VERTEX_SHADER, PROOF_I420_VERTEX));
  gl.attachShader(program, shader(gl.FRAGMENT_SHADER, PROOF_I420_FRAGMENT));
  gl.linkProgram(program);
  gl.useProgram(program);
  const quad = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, quad);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
  const position = gl.getAttribLocation(program, 'p');
  gl.enableVertexAttribArray(position);
  gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
  const textures = ['y', 'u', 'v'].map((name, unit) => {
    const texture = gl.createTexture();
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.uniform1i(gl.getUniformLocation(program, name), unit);
    return texture;
  });
  canvas.videorcI420Gl = { gl, textures };
  return canvas.videorcI420Gl;
}

// Plan 257 S3: show one I420 frame in a source layer's canvas, through WebGL
// when the page has it, else as a bitmap (the GPU converts either way).
async function presentProofPollerI420(poller, buffer, response) {
  const width = Number(response.headers.get('x-videorc-frame-width'));
  const height = Number(response.headers.get('x-videorc-frame-height'));
  if (!(width > 0) || !(height > 0) || buffer.byteLength < width * height * 1.5) {
    throw new Error('Preview frame is not an I420 frame of its stated size.');
  }
  const canvas = poller.image;
  const gl = proofI420GlContext(canvas);
  if (!gl) {
    presentProofPollerBitmap(poller, await proofBitmapFromI420(buffer, response));
    return;
  }
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }
  drawProofI420Gl(gl, buffer, width, height);
  canvas.dataset.live = '1';
}

function drawProofI420Gl({ gl, textures }, buffer, width, height) {
  gl.viewport(0, 0, width, height);
  const planes = [
    [new Uint8Array(buffer, 0, width * height), width, height],
    [new Uint8Array(buffer, width * height, (width * height) / 4), width / 2, height / 2],
    [new Uint8Array(buffer, width * height * 1.25, (width * height) / 4), width / 2, height / 2]
  ];
  planes.forEach(([data, planeWidth, planeHeight], unit) => {
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, textures[unit]);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.LUMINANCE, planeWidth, planeHeight, 0, gl.LUMINANCE, gl.UNSIGNED_BYTE, data);
  });
  gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
}

// Capture-to-page latency of each presented frame: its age as the backend
// sent it plus the time since the response arrived. Expects
// \`proofFrameLatencies\` in scope; keeps the newest 300.
function recordProofFrameLatency(frameAgeMs, respondedAt) {
  if (!Number.isFinite(frameAgeMs) || frameAgeMs < 0) {
    return;
  }
  proofFrameLatencies.push(frameAgeMs + Math.max(0, performance.now() - respondedAt));
  if (proofFrameLatencies.length > 300) {
    proofFrameLatencies.splice(0, proofFrameLatencies.length - 300);
  }
}

function proofFrameLatencyPercentile(fraction) {
  if (proofFrameLatencies.length === 0) {
    return null;
  }
  const sorted = [...proofFrameLatencies].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(fraction * sorted.length))];
}

function proofImageIsBlank(image) {
  const width = image?.naturalWidth ?? image?.width ?? 0;
  const height = image?.naturalHeight ?? image?.height ?? 0;
  if (!image || width < 1 || height < 1) {
    return true;
  }
  try {
    const canvas = document.createElement('canvas');
    canvas.width = 8;
    canvas.height = 8;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) {
      return true;
    }
    context.clearRect(0, 0, 8, 8);
    context.drawImage(image, 0, 0, 8, 8);
    const pixels = context.getImageData(0, 0, 8, 8).data;
    for (let offset = 3; offset < pixels.length; offset += 4) {
      if (pixels[offset] > 0) {
        return false;
      }
    }
    return true;
  } catch {
    // An unreadable frame cannot prove that a visible picture was decoded.
    return true;
  }
}

function proofPollerFrameAgeMs(poller, now) {
  return Math.max(0, now - (poller.lastFrameAdvanceAt ?? poller.startedAt));
}

function proofPollerTransportAgeMs(poller, now) {
  return Math.max(0, now - (poller.lastTransportSuccessAt ?? poller.startedAt));
}

function proofPollerFrameIsFresh(poller, now, freshnessBudgetMs) {
  return poller.lastFrameAdvanceAt != null &&
    proofPollerFrameAgeMs(poller, now) <= freshnessBudgetMs;
}

function proofPollersHaveCompleteFrameHistory(activePollers) {
  return activePollers.size > 0 &&
    [...activePollers.values()].every((poller) => poller.lastFrameAdvanceAt != null);
}

function proofPollerTransportIsFresh(poller, now, freshnessBudgetMs) {
  return poller.lastTransportSuccessAt != null &&
    proofPollerTransportAgeMs(poller, now) <= freshnessBudgetMs;
}
`
