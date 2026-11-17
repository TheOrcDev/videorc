/** Pure decisions plus an artifact-backed analyzer. No acquisition is run on import. */
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import { createInterface } from 'node:readline'
import { resolve, sep } from 'node:path'
import { execFileSync } from 'node:child_process'

export const ALPHA_BUDGET = Object.freeze({
  durationMs: 1800_000,
  warmupMs: 120_000,
  addedDropRate: 0.01,
  memoryGrowth: 0.1,
  latencyP95Ms: 500,
  latencyGrowthMs: 50,
  alphaError: 16,
  colorError: 24,
  startupMs: 15000,
  maxQueue: 1,
  maxProxyBytes: 2 * 1024 * 1024
})
const finite = (n) => typeof n === 'number' && Number.isFinite(n)
const validMemory = (value) => finite(value?.growth) && typeof value?.monotonic === 'boolean'
export function percentile(values, fraction) {
  if (!values.length || values.some((n) => !finite(n))) return null
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * fraction))]
}
export function memoryTrend(values) {
  if (values.length < 4 || values.some((v) => !finite(v) || v <= 0))
    return { growth: null, monotonic: null }
  const chunks = [0, 1, 2, 3].map((i) =>
    percentile(
      values.slice(Math.floor((i * values.length) / 4), Math.floor(((i + 1) * values.length) / 4)),
      0.5
    )
  )
  return {
    growth: chunks[3] / chunks[0] - 1,
    monotonic: chunks.slice(1).every((v, i) => v >= chunks[i])
  }
}
/** Unit fixtures exercise this rule; only analyzeAlphaAcquisition can label acquired evidence. */
export function decideAlphaBudget(current, baseline) {
  const failures = [],
    required = [
      'durationMs',
      'frames',
      'drops',
      'decodeSeconds',
      'bytes',
      'cpuSeconds',
      'rssBytes',
      'taskSeconds',
      'jsHeapBytes',
      'renderTicks',
      'renderMissed'
    ]
  if (
    required.some((k) => !finite(current[k]) || current[k] < 0) ||
    required.some((k) => !finite(baseline[k]) || baseline[k] < 0)
  )
    failures.push('missing-counters')
  if (current.durationMs < ALPHA_BUDGET.durationMs || baseline.durationMs < ALPHA_BUDGET.durationMs)
    failures.push('short-acquisition')
  if (
    !(
      current.frames > 0 &&
      baseline.frames > 0 &&
      current.bytes > 0 &&
      baseline.bytes > 0 &&
      current.decodeSeconds > 0 &&
      baseline.decodeSeconds > 0 &&
      current.renderTicks > 0 &&
      baseline.renderTicks > 0
    )
  )
    failures.push('no-decoded-media')
  const dropDelta =
    current.drops / Math.max(1, current.frames) - baseline.drops / Math.max(1, baseline.frames)
  if (dropDelta > ALPHA_BUDGET.addedDropRate) failures.push('added-frame-drops')
  const renderDropDelta =
    current.renderMissed / Math.max(1, current.renderTicks + current.renderMissed) -
    baseline.renderMissed / Math.max(1, baseline.renderTicks + baseline.renderMissed)
  if (renderDropDelta > ALPHA_BUDGET.addedDropRate) failures.push('added-render-cadence-misses')
  if (!finite(current.latencyP95Ms) || current.latencyP95Ms > ALPHA_BUDGET.latencyP95Ms)
    failures.push('latency-budget-or-missing')
  if (!finite(current.latencyGrowthMs) || current.latencyGrowthMs > ALPHA_BUDGET.latencyGrowthMs)
    failures.push('increasing-latency')
  if (
    !finite(current.alphaError) ||
    current.alphaError > ALPHA_BUDGET.alphaError ||
    !finite(current.colorError) ||
    current.colorError > ALPHA_BUDGET.colorError
  )
    failures.push('alpha-or-color-fidelity')
  if (!finite(current.startupMs) || current.startupMs > ALPHA_BUDGET.startupMs)
    failures.push('recorder-startup')
  if (
    current.queuePeak !== 1 ||
    current.contextLost ||
    current.proxyOverflow ||
    !finite(current.proxyQueuePeak) ||
    current.proxyQueuePeak > ALPHA_BUDGET.maxProxyBytes
  )
    failures.push('resource-bound')
  if (
    !validMemory(current.memory) ||
    (current.memory.monotonic && current.memory.growth > ALPHA_BUDGET.memoryGrowth)
  )
    failures.push('memory-growth-or-missing')
  if (
    !finite(current.gpuTextureBytes) ||
    current.gpuTextureBytes <= 0 ||
    !finite(current.gpuFrames) ||
    current.gpuFrames <= 0 ||
    !finite(current.gpuDrawMs) ||
    current.gpuDrawMs < 0 ||
    current.gpuTextureBytes > 3 * 1024 * 1024
  )
    failures.push('gpu-allocation-bound')
  if (
    !validMemory(current.jsMemory) ||
    (current.jsMemory.monotonic && current.jsMemory.growth > ALPHA_BUDGET.memoryGrowth)
  )
    failures.push('javascript-memory-growth')
  if (current.transportVerified !== true || baseline.transportVerified !== true)
    failures.push('unverified-network-path')
  if (
    !finite(current.validClockFraction) ||
    current.validClockFraction < 0.99 ||
    !finite(current.sampleCount) ||
    !finite(baseline.sampleCount) ||
    current.sampleCount < 900 ||
    baseline.sampleCount < 900
  )
    failures.push('insufficient-samples')
  return {
    passed: failures.length === 0,
    failures,
    dropDelta,
    renderDropDelta,
    cpuRatio: current.cpuSeconds / Math.max(0.0001, baseline.cpuSeconds),
    decodeRatio: current.decodeSeconds / Math.max(0.0001, baseline.decodeSeconds),
    bitrate: (current.bytes * 8) / Math.max(1, current.durationMs / 1000),
    productionApproved: false
  }
}
const safePath = (root, file) => {
  if (typeof file !== 'string') throw new Error('Missing acquired artifact')
  const path = resolve(root, file)
  if (!path.startsWith(resolve(root) + sep)) throw new Error('Artifact escaped acquisition root')
  return path
}
const hashFile = async (file) => {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(file)) hash.update(chunk)
  return hash.digest('hex')
}
function decodeComposite(file, orientation, layer) {
  const w = orientation === 'h' ? 160 : 90,
    h = orientation === 'h' ? 90 : 160
  // Finished browser artifact, not the producer's raster or a hand-authored score.
  const bytes = execFileSync(
    'ffmpeg',
    [
      '-v',
      'error',
      '-i',
      file,
      '-vf',
      `fps=1/60,scale=${w}:${h}`,
      '-pix_fmt',
      'rgb24',
      '-f',
      'rawvideo',
      'pipe:1'
    ],
    { timeout: 180000, maxBuffer: 8 * 1024 * 1024 }
  )
  const size = w * h * 3
  if (bytes.length < size * 25 || bytes.length % size)
    throw new Error('Finished artifact has insufficient decoded frames')
  let maxError = 0,
    hits = 0
  const expected = layer
    ? [
        [255, 0, 255],
        [16, 160, 48],
        [32, 64, 96]
      ]
    : [
        [32, 64, 96],
        [32, 64, 96],
        [32, 64, 96]
      ]
  // Startup is reported separately; inspect frames after the first two minutes.
  for (let offset = size * 2; offset < bytes.length; offset += size) {
    for (const [i, x] of [0.35, 0.45, 0.55].entries()) {
      const at = offset + (Math.floor(h * 0.65) * w + Math.floor(w * x)) * 3
      for (let c = 0; c < 3; c++)
        maxError = Math.max(maxError, Math.abs(bytes[at + c] - expected[i][c]))
    }
    hits++
  }
  return { maxError, frames: hits }
}
export async function analyzeAlphaAcquisition(root) {
  const manifest = JSON.parse(await readFile(resolve(root, 'acquisition.json'), 'utf8'))
  const failures = [],
    lanes = {},
    composites = {}
  if (
    manifest.schema !== 1 ||
    manifest.kind !== 'acquired-local-sfu-browser' ||
    manifest.status !== 'acquired' ||
    manifest.managedQualification !== 'not-run' ||
    manifest.productionEnabled !== false ||
    !manifest.runId
  )
    throw new Error('Not a completed local acquisition')
  for (const key of [
    'sfu',
    'browser',
    'client',
    'desktopClient',
    'serverSdk',
    'ffmpeg',
    'desktopRevision',
    'webRevision'
  ])
    if (typeof manifest.versions?.[key] !== 'string' || !manifest.versions[key])
      failures.push(`missing-version:${key}`)
  if (!manifest.sources?.served || !manifest.sources?.desktop || !manifest.sources?.web)
    failures.push('missing-source-hashes')
  if (!Array.isArray(manifest.artifacts) || manifest.artifacts.length > 1000)
    throw new Error('Acquisition artifact list is invalid')
  for (const artifact of manifest.artifacts) {
    const file = safePath(root, artifact.file),
      info = await stat(file)
    if (
      info.size !== artifact.bytes ||
      info.size <= 0 ||
      (await hashFile(file)) !== artifact.sha256
    )
      throw new Error('Acquired artifact integrity mismatch')
    if (artifact.kind === 'browser-video') {
      composites[`${artifact.case}:${artifact.lane}`] = decodeComposite(
        file,
        artifact.lane.endsWith('-v') ? 'v' : 'h',
        artifact.case.startsWith('alpha-')
      )
    }
  }
  const expectedCases = ['baseline-clean', 'alpha-clean', 'baseline-jitter', 'alpha-jitter']
  if (
    manifest.cases.length !== 4 ||
    expectedCases.some((name) => manifest.cases.filter((c) => c.name === name).length !== 1)
  )
    throw new Error('Incomplete matched scenario matrix')
  for (const run of manifest.cases) {
    if (
      !run.complete ||
      run.participants !== 6 ||
      !run.screen ||
      run.permissionsValidated !== true ||
      run.lanes.length !== 4 ||
      run.grantShape !== 'production-roomGrantFor/recorder' ||
      run.hostSourceCounts?.camera !== (run.layer ? 3 : 1) ||
      run.hostSourceCounts?.screen_share !== 1 ||
      run.hostSourceCounts?.microphone !== 1
    )
      failures.push(`${run.name}:incomplete-sources`)
    const samplesPath = safePath(root, run.sampleFile)
    if (
      (await stat(samplesPath)).size > 128 * 1024 * 1024 ||
      !manifest.artifacts.some((a) => a.file === run.sampleFile && a.kind === 'raw-counters')
    )
      throw new Error('Unbounded/unverified raw counters')
    const series = new Map()
    let count = 0
    for await (const line of createInterface({
      input: createReadStream(samplesPath),
      crlfDelay: Infinity
    })) {
      if (++count > 2000 || line.length > 256 * 1024)
        throw new Error('Raw acquisition exceeded bounds')
      const raw = JSON.parse(line)
      for (const sample of raw.samples) {
        const list = series.get(sample.lane) ?? []
        list.push({ ...sample, raw })
        series.set(sample.lane, list)
      }
    }
    for (const lane of ['stream-h', 'stream-v', 'recording-h', 'recording-v']) {
      const list = series.get(lane) ?? [],
        first = list[0],
        last = list.at(-1)
      if (!first || !last) {
        failures.push(`${run.name}:${lane}:missing`)
        continue
      }
      const steady = list.filter((s) => s.at - first.at > ALPHA_BUDGET.warmupMs)
      const sum = (sample, field) => sample.videos.reduce((n, v) => n + (v[field] ?? NaN), 0)
      const inbound = (sample, field) =>
        sample.videos.flatMap((v) => v.inbound).reduce((n, v) => n + (v[field] ?? NaN), 0)
      const delta = (field) => sum(last, field) - sum(first, field)
      const latency = steady.map((s) => s.alpha?.measurement?.latencyMs).filter(finite)
      const patches = steady.flatMap((s) => s.alpha?.measurement?.patches ?? [])
      const alphaError = patches.length
        ? Math.max(...patches.map((p) => Math.abs(p.actual[3] - p.expected[3])))
        : null
      const colorError = patches.length
        ? Math.max(
            ...patches
              .filter((p) => p.expected[3] > 0)
              .flatMap((p) => [0, 1, 2].map((i) => Math.abs(p.actual[i] - p.expected[i])))
          )
        : null
      const transportVerified =
        steady.length > 0 &&
        steady.every(
          (s) =>
            s.videos.length === (run.layer ? 8 : 7) &&
            s.videos.every(
              (v) =>
                v.transport.length &&
                v.transport.every((t) => t.protocol === 'tcp' && t.port === s.raw.proxyPort)
            )
        )
      const metric = {
        durationMs: last.at - first.at,
        renderTicks: last.cadence?.ticks - first.cadence?.ticks,
        renderMissed: last.cadence?.missed - first.cadence?.missed,
        frames: delta('totalVideoFrames'),
        drops: delta('droppedVideoFrames'),
        decodeSeconds: inbound(last, 'totalDecodeTime') - inbound(first, 'totalDecodeTime'),
        bytes: inbound(last, 'bytesReceived') - inbound(first, 'bytesReceived'),
        cpuSeconds: last.raw.cpuSeconds - first.raw.cpuSeconds,
        rssBytes: last.raw.rssBytes,
        taskSeconds: last.metrics.taskSeconds - first.metrics.taskSeconds,
        jsHeapBytes: last.metrics.jsHeapBytes,
        memory: memoryTrend(steady.map((s) => s.raw.rssBytes)),
        jsMemory: memoryTrend(steady.map((s) => s.metrics.jsHeapBytes)),
        gpuTextureBytes: Math.max(
          ...list.map((s) => s.alpha?.gpu.textureBytes ?? (run.layer ? NaN : 0))
        ),
        gpuDrawMs: last.alpha?.gpu.drawMs ?? null,
        gpuFrames: last.alpha?.gpu.frames ?? null,
        latencyP95Ms: percentile(latency, 0.95),
        latencyGrowthMs:
          latency.length >= 4
            ? percentile(latency.slice(-Math.floor(latency.length / 4)), 0.5) -
              percentile(latency.slice(0, Math.floor(latency.length / 4)), 0.5)
            : null,
        startupMs:
          Math.max(
            ...last.videos.map((v) => v.firstAt ?? NaN),
            run.layer ? (last.alpha?.gpu.firstDrawAt ?? NaN) : last.connectedAt
          ) - last.connectedAt,
        alphaError,
        colorError,
        queuePeak: Math.max(...list.map((s) => s.alpha?.gpu.queuePeak ?? 0)),
        contextLost: list.some((s) => s.alpha?.gpu.contextLost || s.alpha?.gpu.closed),
        proxyOverflow: last.raw.proxy.overflow,
        proxyQueuePeak: last.raw.proxy.queuePeakBytes,
        transportVerified,
        validClockFraction: latency.length / Math.max(1, steady.length),
        sampleCount: list.length
      }
      lanes[`${run.name}:${lane}`] = metric
      const composite = composites[`${run.name}:${lane}`]
      if (!composite || composite.maxError > ALPHA_BUDGET.colorError)
        failures.push(`${run.name}:${lane}:finished-pixel-artifact`)
      if (
        run.jitterMs &&
        !(last.raw.proxy.bytes > 0 && last.raw.proxy.maxDelayMs >= run.jitterMs / 2)
      )
        failures.push(`${run.name}:${lane}:jitter-not-observed`)
    }
  }
  const decisions = {}
  for (const network of ['clean', 'jitter'])
    for (const lane of ['stream-h', 'stream-v', 'recording-h', 'recording-v']) {
      const key = `alpha-${network}:${lane}`,
        baseline = lanes[`baseline-${network}:${lane}`]
      if (!lanes[key] || !baseline) {
        failures.push(`${key}:unmatched-baseline`)
        continue
      }
      decisions[key] = decideAlphaBudget(lanes[key], baseline)
      failures.push(...decisions[key].failures.map((reason) => `${key}:${reason}`))
    }
  return {
    schema: 1,
    runId: manifest.runId,
    localGate: failures.length ? 'failed' : 'passed',
    failures,
    managedQualification: 'not-run',
    productionApproved: false,
    capabilityEnabled: false,
    decision: 'undecided-until-separately-authorized-managed-egress-evidence',
    budgets: ALPHA_BUDGET,
    versions: manifest.versions,
    sources: manifest.sources,
    lanes,
    composites,
    decisions
  }
}
