import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { renderLineChart, renderTimeline } from './charts.mjs'
import { assertPublishable, redactText } from './redact.mjs'

// Plan 178 U9 step 5 (plan 166 S8 step 2). report.md and charts/*.png for a
// run, from the verdict and the series the engine computed. Links point only
// inside the run folder. Every text output is redacted and then checked with
// assertPublishable: a report that still holds a key-shaped string is not
// written as publishable (the error carries file and pattern only).

const HEALTH_COLORS = Object.freeze({
  good: '#16a34a',
  ok: '#d97706',
  bad: '#dc2626',
  noData: '#7f1d1d',
  noStream: '#9ca3af',
  inactive: '#9ca3af',
  unknown: '#9ca3af'
})

const STATUS_MARK = Object.freeze({
  pass: 'PASS',
  warn: 'WARN',
  fail: 'FAIL',
  'needs-eyes': 'EYES',
  skipped: 'SKIP'
})

function fmt(value, unit) {
  if (value === null || value === undefined) return ''
  return unit ? `${value} ${unit}` : String(value)
}

function table(headers, rows) {
  const line = (cells) =>
    `| ${cells.map((cell) => String(cell ?? '').replace(/\|/g, '\\|')).join(' | ')} |`
  return [line(headers), line(headers.map(() => '---')), ...rows.map(line)].join('\n')
}

/** Pure: the charts to render for a run ({ name, png }[]). */
export function renderCharts(series, { endMs = null } = {}) {
  const charts = []
  for (const [role, points] of Object.entries(series.rssByRole ?? {})) {
    if (!points.length) continue
    charts.push({
      name: `rss-${role}.png`,
      ...renderLineChart({ title: `RSS ${role}`, unit: 'MB', series: [{ name: role, points }] })
    })
  }
  if (series.bitrate?.length) {
    charts.push({
      name: 'bitrate.png',
      ...renderLineChart({
        title: 'Bitrate (all legs)',
        unit: 'kbps',
        series: [{ name: 'kbps', points: series.bitrate }]
      })
    })
  }
  if (series.dropped?.length) {
    charts.push({
      name: 'dropped-frames.png',
      ...renderLineChart({
        title: 'Dropped frames per 5 min window',
        unit: '%',
        series: [{ name: 'dropped %', points: series.dropped }],
        threshold: 0.5
      })
    })
  }
  if (series.speed?.length) {
    charts.push({
      name: 'encoder-speed.png',
      ...renderLineChart({
        title: 'Encoder speed (slowest leg)',
        unit: 'x',
        series: [{ name: 'speed', points: series.speed }],
        yMin: 0.8,
        yMax: 1.1,
        threshold: 0.97
      })
    })
  }
  if (series.health?.length) {
    charts.push({
      name: 'youtube-health.png',
      ...renderTimeline({
        title: 'YouTube stream health',
        bands: series.health,
        colors: HEALTH_COLORS,
        endMs
      })
    })
  }
  return charts
}

/** Pure: the markdown report for a verdict. Links are relative to the run folder. */
export function renderReport(verdict, { chartNames = [], steps = [] } = {}) {
  const lines = []
  lines.push(`# Live lab run ${verdict.runId}`)
  lines.push('')
  lines.push(
    `**Outcome: ${verdict.outcome.toUpperCase()}** (thresholds ${verdict.thresholdsMode} mode, v${verdict.thresholdsVersion ?? 1})`
  )
  lines.push('')
  lines.push(
    table(
      ['Field', 'Value'],
      [
        ['Scenario', verdict.scenario],
        ['Trigger', verdict.trigger],
        ['Privacy', verdict.privacy],
        [
          'Build',
          `${verdict.build?.source ?? '?'} ${verdict.build?.version ?? '?'}${verdict.build?.sha ? ` (${verdict.build.sha})` : ''}`
        ],
        ['Started', verdict.startedAt ?? ''],
        ['Ended', verdict.endedAt ?? ''],
        ['Stop reason', verdict.stopReason ?? 'none'],
        [
          'Steps',
          `${verdict.steps?.passed ?? 0} passed, ${verdict.steps?.failed ?? 0} failed, ${verdict.steps?.skipped ?? 0} skipped of ${verdict.steps?.total ?? 0}`
        ],
        [
          'Lab quota',
          `${verdict.quota?.labUnits ?? 0} units (bundled ${verdict.quota?.bundledUnits ?? 0})`
        ],
        ['VOD', verdict.vod ? `[${verdict.vod.videoId}](${verdict.vod.url})` : 'unknown']
      ]
    )
  )
  lines.push('')
  if (verdict.incidents.length) {
    lines.push('## Incidents')
    lines.push('')
    lines.push(
      table(
        ['Severity', 'Signature', 'First at', 'Summary'],
        verdict.incidents.map((incident) => [
          incident.severity ?? '',
          incident.signature,
          incident.firstAt ?? '',
          incident.summary
        ])
      )
    )
    lines.push('')
  }
  if (verdict.needsEyes.length) {
    lines.push('## Owner digest (needs eyes)')
    lines.push('')
    for (const item of verdict.needsEyes) {
      lines.push(
        `- **${item.id}**: ${item.question}${item.frame ? ` ([frame](${item.frame}))` : ''}`
      )
    }
    lines.push('')
  }
  lines.push('## Signals')
  lines.push('')
  lines.push(
    table(
      ['Status', 'Signal', 'Value', 'Threshold', 'Summary', 'Evidence'],
      verdict.signals.map((entry) => [
        STATUS_MARK[entry.status] ?? entry.status,
        entry.id,
        fmt(entry.value, entry.unit),
        fmt(entry.threshold, entry.unit),
        entry.summary,
        (entry.evidence ?? []).map((path) => `[${path}](${path})`).join(' ')
      ])
    )
  )
  lines.push('')
  if (steps.length) {
    lines.push('## Steps')
    lines.push('')
    lines.push(
      table(
        ['Status', 'Step', 'Duration', 'Reason'],
        steps.map((step) => [
          STATUS_MARK[step.status] ?? step.status,
          step.id,
          Number.isFinite(step.durationMs) ? `${Math.round(step.durationMs / 1000)} s` : '',
          step.reason ?? ''
        ])
      )
    )
    lines.push('')
  }
  if (chartNames.length) {
    lines.push('## Charts')
    lines.push('')
    for (const name of chartNames) lines.push(`![${name}](charts/${name})`)
    lines.push('')
  }
  lines.push('## Files')
  lines.push('')
  for (const name of [
    'manifest.json',
    'verdict.json',
    'steps.ndjson',
    'journal.ndjson',
    'health.ndjson',
    'census.csv',
    'observer.ndjson',
    'features.ndjson',
    'events.ndjson',
    'quota.json',
    'run.log'
  ]) {
    lines.push(`- [${name}](${name})`)
  }
  lines.push('')
  return `${lines.join('\n')}\n`
}

/**
 * Writes verdict.json, report.md and charts into the run folder, then runs
 * assertPublishable on the text outputs (throws REDACTION_FAILED). Returns
 * the written paths.
 */
export async function writeRunReport({
  runDir,
  verdict,
  series = {},
  steps = [],
  charts = true,
  write = writeFile
}) {
  const written = []
  const endMs = Date.parse(verdict.endedAt ?? '') || null
  const rendered = charts ? renderCharts(series, { endMs }) : []
  if (rendered.length) await mkdir(join(runDir, 'charts'), { recursive: true })
  for (const chart of rendered) {
    await write(join(runDir, 'charts', chart.name), chart.png)
    written.push(join(runDir, 'charts', chart.name))
  }
  const verdictPath = join(runDir, 'verdict.json')
  await write(verdictPath, `${redactText(JSON.stringify(verdict, null, 2))}\n`)
  written.push(verdictPath)
  const reportPath = join(runDir, 'report.md')
  await write(
    reportPath,
    redactText(renderReport(verdict, { chartNames: rendered.map((chart) => chart.name), steps }))
  )
  written.push(reportPath)
  await assertPublishable([verdictPath, reportPath])
  return { written, charts: rendered.map((chart) => chart.name) }
}
