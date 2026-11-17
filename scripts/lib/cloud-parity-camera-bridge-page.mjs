/** Plan 249 S13a in-page observers. Each function is serialized into a page,
 * so it must stay self-contained. Observers are harness-only and bounded; they
 * read pixels from the real decoded program <video>, never from the publisher.
 */

/** Desktop renderer: bounded queue of `videorc:frame-test-diagnostic` events. */
export function installCameraRendererCollector() {
  if (window.__parityCameraRenderer) return
  const limit = 4096
  let events = [],
    dropped = 0
  window.addEventListener('videorc:frame-test-diagnostic', (event) => {
    if (events.length >= limit) {
      dropped++
      return
    }
    events.push(event.detail)
  })
  window.__parityCameraRenderer = {
    drain() {
      const out = events
      events = []
      const memory = performance.memory
      return {
        performanceMs: performance.now(),
        events: out,
        dropped,
        heapBytes: memory ? memory.usedJSHeapSize : null
      }
    }
  }
}

/** Program or guest page: rVFC on each video whose aspect is the packed camera
 * role. Decodes the transport stamp every presented frame. When the page's
 * camera-frame adapter drew the unpacked canvas beside that video, samples the
 * adapter's output (logical coordinates, real alpha channel) on a subset.
 * Metadata timestamps come from the browser, as is. */
export function installCameraProgramObserver(spec) {
  const limit = 8192
  let events = [],
    dropped = 0
  const watched = new WeakSet()
  const push = (value) => {
    if (events.length >= limit) dropped++
    else events.push(value)
  }
  const decode = (samples) => {
    if (samples.some((v) => v > 96 && v < 160)) return null
    let n = 0,
      check = 0
    for (let i = 0; i < 32; i++)
      if (samples[i] >= 160) {
        if (i < 24) n |= 1 << i
        else check |= 1 << (i - 24)
      }
    return (((n >>> 16) ^ (n >>> 8) ^ n) & 255) === check ? n : null
  }
  const luma = (d, i) => 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]
  const logical = new OffscreenCanvas(spec.logicalWidth, spec.height)
  const logicalContext = logical.getContext('2d', { willReadFrequently: true })
  const sampleUnpacked = (canvas) => {
    if (!canvas || canvas.width !== spec.logicalWidth || canvas.height !== spec.height) return null
    logicalContext.clearRect(0, 0, spec.logicalWidth, spec.height)
    logicalContext.drawImage(canvas, 0, 0)
    const stampRow = logicalContext.getImageData(0, spec.stampRow, spec.logicalWidth, 1).data
    const row = logicalContext.getImageData(0, spec.patchRow, spec.logicalWidth, 1).data
    const color = {},
      alpha = {}
    for (const x of spec.patches) {
      color[x] = [row[x * 4], row[x * 4 + 1], row[x * 4 + 2]]
      alpha[x] = row[x * 4 + 3]
    }
    return {
      sequence: decode(spec.cells.map((x) => luma(stampRow, x * 4))),
      color,
      alpha,
      flashLuma: luma(row, spec.flashX * 4)
    }
  }
  let videoKeys = 0
  // Decode health for EVERY video (bridge and matched baseline alike): unique
  // presented media times per fixed 1 s window, zero-frame windows included.
  const counters = new Map()
  let rateAt = performance.now()
  const rateTimer = setInterval(() => {
    const at = performance.now()
    for (const [key, counter] of counters) {
      if (!counter.video.isConnected) {
        counters.delete(key)
        continue
      }
      const w = counter.video.videoWidth,
        h = counter.video.videoHeight
      push({
        phase: 'rate',
        surface: spec.surface,
        key,
        width: w,
        height: h,
        frames: counter.frames,
        windowMs: at - rateAt,
        packed: Math.abs(w / (h || 1) - spec.packedWidth / spec.height) <= 0.02
      })
      counter.frames = 0
    }
    rateAt = at
  }, 1000)
  const watch = (video) => {
    if (watched.has(video) || typeof video.requestVideoFrameCallback !== 'function') return
    watched.add(video)
    const canvas = new OffscreenCanvas(spec.packedWidth, spec.height)
    const ctx = canvas.getContext('2d', { willReadFrequently: true })
    const counter = { video, frames: 0 }
    counters.set(++videoKeys, counter)
    let lastMedia = -1
    const onFrame = (_now, meta) => {
      if (!video.isConnected) return
      video.requestVideoFrameCallback(onFrame)
      const w = video.videoWidth,
        h = video.videoHeight
      if (meta.mediaTime !== lastMedia) {
        lastMedia = meta.mediaTime
        counter.frames++
      }
      // Only the packed camera role: color + gutter + alpha side by side.
      if (!w || !h || Math.abs(w / h - spec.packedWidth / spec.height) > 0.02) return
      ctx.drawImage(video, 0, 0, spec.packedWidth, spec.height)
      const stamp = ctx.getImageData(0, spec.stampRow, spec.packedWidth, 1).data
      const sequence = decode(spec.cells.map((x) => luma(stamp, x * 4)))
      const unpacked = video.parentElement?.querySelector('canvas[data-camera-frame]') ?? null
      push({
        phase: 'decoded',
        surface: spec.surface,
        sequence,
        presentationTimeMs: meta.presentationTime,
        expectedDisplayTimeMs: meta.expectedDisplayTime,
        mediaTime: meta.mediaTime,
        presentedFrames: meta.presentedFrames,
        rtpTimestamp: meta.rtpTimestamp ?? null,
        receiveTimeMs: meta.receiveTime ?? null,
        captureTimeMs: meta.captureTime ?? null,
        width: w,
        height: h,
        packedVideoVisible: getComputedStyle(video).opacity !== '0',
        adapter: unpacked !== null
      })
      if (sequence === null || sequence % 15 !== 0) return
      const row = ctx.getImageData(0, spec.patchRow, spec.packedWidth, 1).data
      const color = {},
        alpha = {}
      for (const x of spec.patches) {
        color[x] = [row[x * 4], row[x * 4 + 1], row[x * 4 + 2]]
        alpha[x] = row[(x + spec.alphaOffset) * 4]
      }
      push({
        phase: 'patch',
        surface: spec.surface,
        sequence,
        color,
        alpha,
        flashLuma: luma(row, spec.flashX * 4)
      })
      const adapterSample = sampleUnpacked(unpacked)
      if (adapterSample) push({ phase: 'unpacked', surface: spec.surface, ...adapterSample })
    }
    video.requestVideoFrameCallback(onFrame)
  }
  const scan = setInterval(() => document.querySelectorAll('video').forEach(watch), 250)
  window.__parityCameraProgram = {
    drain() {
      const out = events
      events = []
      return { performanceMs: performance.now(), events: out, dropped }
    },
    close() {
      clearInterval(scan)
      clearInterval(rateTimer)
      return { performanceMs: performance.now(), events: [], dropped }
    }
  }
}

/** Desktop renderer: one sample of the monitor adapter's unpacked canvas. */
export function sampleMonitorCameraFrame(spec) {
  const canvases = [...document.querySelectorAll('canvas[data-camera-frame]')]
  const videos = [...document.querySelectorAll('video')].filter(
    (v) => Math.abs(v.videoWidth / (v.videoHeight || 1) - spec.packedWidth / spec.height) < 0.02
  )
  const result = {
    canvases: canvases.length,
    packedVideosVisible: videos.filter((v) => getComputedStyle(v).opacity !== '0').length,
    sample: null
  }
  const canvas = canvases[0]
  if (!canvas || canvas.width !== spec.logicalWidth || canvas.height !== spec.height) return result
  const scratch = new OffscreenCanvas(spec.logicalWidth, spec.height)
  const ctx = scratch.getContext('2d', { willReadFrequently: true })
  ctx.drawImage(canvas, 0, 0)
  const row = ctx.getImageData(0, spec.patchRow, spec.logicalWidth, 1).data
  const color = {},
    alpha = {}
  for (const x of spec.patches) {
    color[x] = [row[x * 4], row[x * 4 + 1], row[x * 4 + 2]]
    alpha[x] = row[x * 4 + 3]
  }
  result.sample = { surface: 'monitor', color, alpha }
  return result
}

/** In-page (program, guest or desktop renderer): where each camera-frame canvas
 * is actually drawn, after CSS fit and transforms, and what clips it. Read with
 * a compositor capture to check blending, crop and mask on final pixels. */
export function cameraFrameGeometry(selector = 'canvas[data-camera-frame]') {
  const parse = (value) => {
    const m = /rgba?\(([^)]+)\)/.exec(value ?? '')
    if (!m) return null
    const [r, g, b, a = '1'] = m[1].split(/[ ,/]+/).filter(Boolean)
    return [Number(r), Number(g), Number(b), Number(a)]
  }
  const groundOf = (element) => {
    for (let node = element; node; node = node.parentElement) {
      const color = parse(getComputedStyle(node).backgroundColor)
      if (color && color[3] > 0.99) return color.slice(0, 3)
    }
    return null
  }
  return [...document.querySelectorAll(selector)].map((canvas) => {
    const box = canvas.getBoundingClientRect()
    const style = getComputedStyle(canvas)
    const iw = canvas.width,
      ih = canvas.height
    let content = { x: box.left, y: box.top, w: box.width, h: box.height }
    if ((style.objectFit === 'cover' || style.objectFit === 'contain') && iw && ih && box.width) {
      const scale = (style.objectFit === 'cover' ? Math.max : Math.min)(
        box.width / iw,
        box.height / ih
      )
      content = {
        x: box.left + (box.width - iw * scale) / 2,
        y: box.top + (box.height - ih * scale) / 2,
        w: iw * scale,
        h: ih * scale
      }
    }
    // Mirror and clip can live on ancestors (S12 mirrors its scene clip and
    // masks the tile): compose every transform's horizontal sign and
    // intersect every clipping ancestor's box.
    let mirrored = false
    let visible = null
    let radius = 0
    let clipPath = 'none'
    for (let node = canvas; node && node !== document.body; node = node.parentElement) {
      const ns = getComputedStyle(node)
      if (ns.transform !== 'none' && new DOMMatrixReadOnly(ns.transform).a < 0) mirrored = !mirrored
      if (node !== canvas && (ns.overflow !== 'visible' || ns.clipPath !== 'none')) {
        const r = node.getBoundingClientRect()
        visible = visible
          ? {
              x: Math.max(visible.x, r.left),
              y: Math.max(visible.y, r.top),
              r: Math.min(visible.r, r.right),
              b: Math.min(visible.b, r.bottom)
            }
          : { x: r.left, y: r.top, r: r.right, b: r.bottom }
        radius = Math.max(radius, Number.parseFloat(ns.borderTopLeftRadius) || 0)
        if (ns.clipPath !== 'none') clipPath = ns.clipPath
      }
    }
    return {
      content,
      logical: { w: iw, h: ih },
      mirrored,
      tile: visible
        ? { x: visible.x, y: visible.y, w: visible.r - visible.x, h: visible.b - visible.y }
        : null,
      radius,
      clipPath,
      ground: groundOf(canvas.parentElement),
      dpr: devicePixelRatio,
      viewport: { w: innerWidth, h: innerHeight }
    }
  })
}
