// Plan 178 U7. Pure view code for the test card: state in, HTML strings out.
// The browser page imports it to paint, and the Node redaction test imports
// it to render the same strings from a fixture. No DOM, no Node APIs.
//
// It only ever receives state that already passed `lib/card-state.mjs`; it
// still escapes every string it prints.

export const CHART_WINDOW_MS = 10 * 60 * 1000
export const PULSE_INTERVAL_MS = 10_000
export const FLASH_MS = 50

// Dark categorical slots 1-5 (validated on the card's #141416 panel surface).
export const ROLE_COLORS = Object.freeze({
  backend: '#3987e5',
  main: '#d95926',
  renderer: '#199e70',
  gpu: '#c98500',
  ffmpeg: '#d55181'
})
export const SERIES_COLOR = '#3987e5'
export const STATUS_COLORS = Object.freeze({ good: '#0ca30c', serious: '#ec835a' })

const ROLE_LABELS = Object.freeze({
  backend: 'Backend',
  main: 'Main',
  renderer: 'Renderer',
  gpu: 'GPU',
  ffmpeg: 'FFmpeg'
})

export function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

const pad = (value, size = 2) => String(value).padStart(size, '0')

/** Wall clock in UTC with milliseconds: `14:03:22.417`. */
export function formatClock(ms) {
  const date = new Date(ms)
  return `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}.${pad(date.getUTCMilliseconds(), 3)}`
}

export function formatUptime(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '0:00:00'
  const total = Math.floor(ms / 1000)
  const hours = Math.floor(total / 3600)
  return `${hours}:${pad(Math.floor((total % 3600) / 60))}:${pad(total % 60)}`
}

/** Milliseconds until the next 10 s wall-clock boundary (the sync pulse). */
export function msUntilPulse(now, interval = PULSE_INTERVAL_MS) {
  const rest = interval - (now % interval)
  return rest === interval ? 0 : rest
}

function formatNumber(value, digits = 0) {
  if (!Number.isFinite(value)) return '-'
  return value.toLocaleString('en-US', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits
  })
}

/**
 * SVG path for one series. `points` are `{ ts, value }`. The right edge is the
 * newest point and the left edge the oldest point inside the 10 min window,
 * so the line fills the chart from the first sample on. Without a fixed
 * `min`/`max` the value domain is the data's range with padding, so trends
 * show; a fixed bound keeps meaning (speed tops out at 1.2x).
 */
export function sparklinePath(points, { width = 300, height = 60, min, max } = {}) {
  const usable = points.filter((point) => Number.isFinite(point.value) && Number.isFinite(point.ts))
  if (usable.length === 0) return ''
  const right = usable[usable.length - 1].ts
  const inWindow = usable.filter((point) => point.ts >= right - CHART_WINDOW_MS)
  const left = inWindow[0].ts
  const values = inWindow.map((point) => point.value)
  const dataMin = Math.min(...values)
  const dataMax = Math.max(...values)
  const pad = Math.max(Math.abs(dataMax) * 0.05, (dataMax - dataMin) * 0.15, 1e-6)
  const low = min ?? dataMin - pad
  const high = Math.max(max ?? dataMax + pad, dataMax)
  const span = high - Math.min(low, dataMin) || 1
  const floor = Math.min(low, dataMin)
  const inset = 2
  const y = (value) => (inset + (1 - (value - floor) / span) * (height - inset * 2)).toFixed(1)
  if (inWindow.length === 1 || right === left) {
    const level = y(inWindow[inWindow.length - 1].value)
    return `M${(width - 4).toFixed(1)},${level}L${width.toFixed(1)},${level}`
  }
  const coords = inWindow.map(
    (point) => `${(((point.ts - left) / (right - left)) * width).toFixed(1)},${y(point.value)}`
  )
  return `M${coords.join('L')}`
}

function series(history, pick) {
  return history.map((point) => ({ ts: point.ts, value: pick(point) }))
}

function latest(points) {
  for (let index = points.length - 1; index >= 0; index -= 1) {
    if (Number.isFinite(points[index].value)) return points[index].value
  }
  return null
}

/** Display model for the card from a sanitized card state. */
export function buildCardView(state, now = Date.now()) {
  const history = state?.history ?? []
  const run = state?.run ?? {}
  const step = state?.step ?? { index: 0, total: null, name: null, sceneId: 0 }
  const roles = Object.keys(ROLE_COLORS).filter((role) =>
    history.some((point) => Number.isFinite(point.memoryMb?.[role]))
  )
  const memory = roles.map((role) => {
    const points = series(history, (point) => point.memoryMb?.[role])
    return {
      role,
      label: ROLE_LABELS[role],
      color: ROLE_COLORS[role],
      points,
      latest: latest(points)
    }
  })
  const memoryValues = memory.flatMap((line) =>
    line.points.map((p) => p.value).filter(Number.isFinite)
  )
  const memoryPad = memoryValues.length
    ? Math.max((Math.max(...memoryValues) - Math.min(...memoryValues)) * 0.1, 10)
    : 0
  const memoryDomain = memoryValues.length
    ? {
        min: Math.max(0, Math.min(...memoryValues) - memoryPad),
        max: Math.max(...memoryValues) + memoryPad
      }
    : {}
  const single = (id, title, unit, pick, digits, domain = {}) => {
    const points = series(history, pick)
    const value = latest(points)
    return {
      id,
      title,
      unit,
      value: value === null ? '-' : formatNumber(value, digits),
      path: sparklinePath(points, domain)
    }
  }
  return {
    runId: run.runId ?? 'unnamed run',
    scenario: run.scenario ?? 'manual',
    appVersion: run.appVersion ? `v${run.appVersion}` : 'version unknown',
    uptime: formatUptime(run.startedAt ? now - run.startedAt : NaN),
    session: state?.state ?? 'idle',
    stepIndex: step.index,
    stepLabel: step.total ? `Step ${step.index} of ${step.total}` : `Step ${step.index}`,
    stepName: step.name ?? '',
    sceneId: step.sceneId ?? 0,
    memory: memory.map((line) => ({
      ...line,
      value: line.latest === null ? '-' : formatNumber(line.latest),
      path: sparklinePath(line.points, memoryDomain)
    })),
    charts: [
      single('bitrate', 'Bitrate', 'kbps', (point) => point.bitrateKbps, 0),
      single('dropped', 'Dropped frames', 'total', (point) => point.droppedFrames, 0, { min: 0 }),
      single('speed', 'Encoder speed', 'x realtime', (point) => point.encoderSpeed, 2, {
        min: 0,
        max: 1.2
      })
    ],
    events: (state?.healthEvents ?? [])
      .slice()
      .reverse()
      .map((event) => ({ code: event.code, at: formatClock(event.ts).slice(0, 8) })),
    openIncidents: state?.openIncidents ?? 0
  }
}

function chartSvg(paths) {
  const lines = paths
    .filter((line) => line.path)
    .map(
      (line) =>
        `<path d="${escapeHtml(line.path)}" stroke="${escapeHtml(line.color)}" fill="none" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" vector-effect="non-scaling-stroke"/>`
    )
    .join('')
  const empty = lines
    ? ''
    : '<text x="150" y="34" text-anchor="middle" class="chart-empty">waiting for data</text>'
  return `<svg class="spark" viewBox="0 0 300 60" preserveAspectRatio="none" aria-hidden="true"><line x1="0" y1="58" x2="300" y2="58" class="baseline"/>${lines}${empty}</svg>`
}

/** HTML for each live region of the card, keyed by element id. */
export function renderCardRegions(view) {
  const memoryLegend = view.memory.length
    ? view.memory
        .map(
          (line) =>
            `<li><span class="swatch" style="background:${escapeHtml(line.color)}"></span><span class="legend-label">${escapeHtml(line.label)}</span><span class="legend-value">${escapeHtml(line.value)}</span></li>`
        )
        .join('')
    : '<li class="muted">waiting for data</li>'
  const memoryPanel = `<section class="panel chart"><header><h2>Memory per process</h2><span class="unit">MB</span></header>${chartSvg(view.memory)}<ul class="legend">${memoryLegend}</ul></section>`
  const singles = view.charts
    .map(
      (chart) =>
        `<section class="panel chart"><header><h2>${escapeHtml(chart.title)}</h2><span class="value">${escapeHtml(chart.value)}<span class="unit"> ${escapeHtml(chart.unit)}</span></span></header>${chartSvg([{ path: chart.path, color: SERIES_COLOR }])}</section>`
    )
    .join('')
  const events = view.events.length
    ? view.events
        .map(
          (event) =>
            `<li><span class="event-time">${escapeHtml(event.at)}</span><code>${escapeHtml(event.code)}</code></li>`
        )
        .join('')
    : '<li class="muted">No health events yet</li>'
  const incidentTone = view.openIncidents > 0 ? 'serious' : 'good'
  const incidentLabel =
    view.openIncidents === 0
      ? 'No open incidents'
      : `${view.openIncidents} open incident${view.openIncidents === 1 ? '' : 's'}`
  return {
    'run-meta': `<span class="meta-item"><span class="meta-label">Run</span>${escapeHtml(view.runId)}</span><span class="meta-item"><span class="meta-label">Scenario</span>${escapeHtml(view.scenario)}</span><span class="meta-item"><span class="meta-label">App</span>${escapeHtml(view.appVersion)}</span>`,
    step: `<span class="step-label">${escapeHtml(view.stepLabel)}</span><span class="step-name">${escapeHtml(view.stepName)}</span>`,
    session: escapeHtml(view.session),
    charts: memoryPanel + singles,
    events: `<ol class="events">${events}</ol>`,
    incidents: `<span class="incident-count">${escapeHtml(view.openIncidents)}</span><span class="incident-label"><span class="status-dot" style="background:${STATUS_COLORS[incidentTone]}"></span>${escapeHtml(incidentLabel)}</span>`,
    'marker-step': `Step ${escapeHtml(pad(view.stepIndex % 1024, 4))}`,
    'marker-scene': `Scene ${escapeHtml(view.sceneId)}`
  }
}

/** Every visible string of the card, for the string-level redaction test. */
export function renderCardText(state, now = Date.now()) {
  const regions = renderCardRegions(buildCardView(state, now))
  return Object.values(regions).join('\n')
}
