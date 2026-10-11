import { appendFile, open, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import { collectProcessCensus } from '../../lib/process-census.mjs'
import { snapshotFromJournalLine } from './card-state.mjs'
import { systemClock } from './step-engine.mjs'

// Plan 178 U6 (plan 176 L2 step 3). What the app thinks happened:
//
// - the metrics journal (plan 166 S1 / plan 178 U1, schema v1), tailed from
//   <logs>/metrics/<UTC yyyy-mm-dd>.ndjson, where <logs> is <userData>/logs
//   (Electron main passes VIDEORC_LOGS_DIR) or logs/ beside the database;
// - backend health events (`health.event` on the renderer socket);
// - a process census every 10 s (scripts/lib/process-census.mjs) of the app
//   tree and the owned-process ledgers.
//
// Everything lands in the run folder (journal.ndjson, health.ndjson,
// census.csv) and is pushed to the test card. U1 is built in parallel: the
// journal parser is tolerant and isolated in parseJournalLine, the one
// function to adjust if the schema moves.

export const CENSUS_INTERVAL_MS = 10_000
export const JOURNAL_POLL_MS = 1_000
const MAX_READ_BYTES = 4 * 1024 * 1024

const num = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : null)
const str = (value) => (typeof value === 'string' && value.length <= 200 ? value : null)

/**
 * One journal line, normalized (pure). Unknown fields are ignored, missing
 * ones become null, a line that is not a v1-shaped object returns null.
 * Only allowlisted fields survive, so nothing unexpected reaches the run
 * folder or the card.
 */
export function parseJournalLine(text) {
  let raw
  try {
    raw = typeof text === 'string' ? JSON.parse(text) : text
  } catch {
    return null
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const version = raw.schemaVersion ?? raw.version ?? 1
  if (version !== 1) return null
  const tsMs = typeof raw.ts === 'string' ? Date.parse(raw.ts) : num(raw.ts)
  if (!Number.isFinite(tsMs)) return null
  const state = ['idle', 'live', 'recording', 'both'].includes(raw.state) ? raw.state : null
  const legs = (Array.isArray(raw.legs) ? raw.legs : [])
    .filter((leg) => leg && typeof leg === 'object')
    .slice(0, 10)
    .map((leg) => ({
      targetId: str(leg.targetId),
      platform: str(leg.platform),
      bitrateKbps: num(leg.bitrateKbps),
      fps: num(leg.fps),
      droppedFrames: num(leg.droppedFrames),
      duplicatedFrames: num(leg.duplicatedFrames),
      speed: num(leg.speed),
      state: str(leg.state)
    }))
  return {
    schemaVersion: 1,
    kind: raw.kind === 'health' ? 'health' : 'sample',
    ts: new Date(tsMs).toISOString(),
    tsMs,
    appVersion: str(raw.appVersion),
    sessionId: str(raw.sessionId),
    state,
    legs,
    encoderQueueAgeMs: num(raw.encoderQueueAgeMs),
    previewPresentFps: num(raw.previewPresentFps),
    previewTransport: str(raw.previewTransport),
    previewFallbackReason: str(raw.previewFallbackReason),
    backendRssBytes: num(raw.backendRssBytes),
    ffmpegCount: num(raw.ffmpegCount),
    hostLoad1PerCore: num(raw.hostLoad1PerCore),
    healthEventCodes: (Array.isArray(raw.healthEventCodes) ? raw.healthEventCodes : [])
      .filter((code) => typeof code === 'string' && /^[a-z0-9][a-z0-9._:-]{0,63}$/i.test(code))
      .slice(0, 20),
    healthLevel: ['info', 'warn', 'error'].includes(raw.healthLevel) ? raw.healthLevel : null,
    droppedLines: num(raw.droppedLines)
  }
}

export function journalDirCandidates({ userDataDir, databasePath }) {
  return [join(userDataDir, 'logs', 'metrics'), join(dirname(databasePath), 'logs', 'metrics')]
}

export function utcDay(ms) {
  return new Date(ms).toISOString().slice(0, 10)
}

/**
 * Tails today's journal file. A poll every second is the sampler (the
 * journal itself writes every 5 s); scenario waits stay event-based on the
 * lines it emits. Handles the UTC day rollover and a file that appears late.
 */
export function createJournalTail({
  dirs,
  onLine,
  clock = systemClock,
  statFn = stat,
  openFn = open,
  pollMs = JOURNAL_POLL_MS
}) {
  let current = null // { path, offset, remainder }
  let timer = null
  let busy = false

  async function locate(day) {
    for (const dir of dirs) {
      const path = join(dir, `${day}.ndjson`)
      try {
        await statFn(path)
        return path
      } catch {
        // not here
      }
    }
    return null
  }

  async function drain(entry) {
    let info
    try {
      info = await statFn(entry.path)
    } catch {
      return
    }
    if (info.size < entry.offset) {
      entry.offset = 0
      entry.remainder = ''
    }
    if (info.size === entry.offset) return
    const length = Math.min(MAX_READ_BYTES, info.size - entry.offset)
    const handle = await openFn(entry.path, 'r')
    try {
      const buffer = Buffer.alloc(length)
      const { bytesRead } = await handle.read(buffer, 0, length, entry.offset)
      entry.offset += bytesRead
      const lines = `${entry.remainder}${buffer.toString('utf8', 0, bytesRead)}`.split('\n')
      entry.remainder = lines.pop() ?? ''
      for (const text of lines) {
        if (!text.trim()) continue
        const line = parseJournalLine(text)
        if (line) onLine(line)
      }
    } finally {
      await handle.close()
    }
  }

  async function poll() {
    if (busy) return
    busy = true
    try {
      const day = utcDay(clock.now())
      if (current) await drain(current)
      if (!current || !current.path.endsWith(`${day}.ndjson`)) {
        const path = await locate(day)
        if (path && path !== current?.path) {
          // A new day (or the first file): start at its beginning.
          current = { path, offset: 0, remainder: '' }
          await drain(current)
        }
      }
    } finally {
      busy = false
    }
  }

  return {
    poll,
    start() {
      timer = clock.setInterval(() => {
        poll().catch(() => {})
      }, pollMs)
      return poll()
    },
    stop() {
      if (timer !== null) clock.clearInterval(timer)
      timer = null
    },
    currentPath: () => current?.path ?? null
  }
}

const ROLE_FOR_CARD = Object.freeze({
  backend: 'backend',
  'electron-main': 'main',
  'electron-renderer': 'renderer',
  'electron-renderer-notes': 'renderer',
  'electron-renderer-comments': 'renderer',
  'electron-renderer-captions': 'renderer',
  'electron-gpu': 'gpu',
  ffmpeg: 'ffmpeg'
})

/** Per-role memory in MB for the card, from a census (pure). */
export function memoryFromCensus(census) {
  const memory = {}
  for (const row of census?.processRows ?? []) {
    const role = ROLE_FOR_CARD[row.role]
    if (!role || !Number.isFinite(row.rssKb)) continue
    memory[role] = (memory[role] ?? 0) + row.rssKb / 1024
  }
  for (const key of Object.keys(memory)) memory[key] = Math.round(memory[key])
  return memory
}

export const CENSUS_HEADER = 'ts,pid,ppid,role,rssKb\n'

/** census.csv rows: pid, role and RSS only (no args: they can hold paths). */
export function censusCsvRows(census, ts) {
  return (census?.processRows ?? [])
    .map((row) => `${ts},${row.pid},${row.ppid},${row.role},${row.rssKb}\n`)
    .join('')
}

/** A backend event worth keeping, reduced to non-sensitive fields (pure). */
export function healthRecordFromEvent(message) {
  if (message?.event !== 'health.event') return null
  const payload = message.payload ?? {}
  if (typeof payload.code !== 'string') return null
  return {
    ts: typeof payload.createdAt === 'string' ? payload.createdAt : new Date().toISOString(),
    source: 'backend',
    code: payload.code.slice(0, 64),
    level: ['info', 'warn', 'error'].includes(payload.level) ? payload.level : null,
    sessionId: typeof payload.sessionId === 'string' ? payload.sessionId.slice(0, 64) : null
  }
}

/**
 * The observer for one run. `rootPid()` resolves the app PID for the census;
 * `ledgerPaths()` the owned-process ledgers. Returns the read side used by
 * ctx.observe and a stop() for teardown.
 */
export function createAppObserver({
  bus,
  card,
  runDir,
  journalDirs,
  ledgerPaths,
  rootPid,
  clock = systemClock,
  collectCensus = collectProcessCensus,
  append = appendFile,
  censusIntervalMs = CENSUS_INTERVAL_MS,
  log = () => {}
}) {
  const journal = []
  const health = []
  let lastCensus = null
  let lastJournal = null
  let censusTimer = null
  let censusFailures = 0
  const write = (name, text) => append(join(runDir, name), text).catch(() => {})

  function pushCard() {
    if (!card) return
    const snapshot = lastJournal ? snapshotFromJournalLine(lastJournal) : {}
    const memory = { ...(snapshot.memoryMb ?? {}), ...memoryFromCensus(lastCensus) }
    if (Object.keys(memory).length) snapshot.memoryMb = memory
    card.push(snapshot)
  }

  const tail = createJournalTail({
    dirs: journalDirs,
    clock,
    onLine(line) {
      journal.push(line)
      if (journal.length > 20_000) journal.splice(0, journal.length - 20_000)
      const { tsMs: _tsMs, ...stored } = line
      write('journal.ndjson', `${JSON.stringify(stored)}\n`)
      if (line.kind === 'health') {
        const record = { ts: line.ts, source: 'journal', codes: line.healthEventCodes, level: line.healthLevel }
        health.push(record)
        write('health.ndjson', `${JSON.stringify(record)}\n`)
        bus.emit('health', record)
      } else {
        lastJournal = line
        pushCard()
      }
      bus.emit('journal', line)
    }
  })

  async function sampleCensus() {
    try {
      const pid = await rootPid()
      lastCensus = await collectCensus({ ledgerPaths: await ledgerPaths(), rootPid: pid ?? undefined })
      const ts = new Date(clock.now()).toISOString()
      write('census.csv', censusCsvRows(lastCensus, ts))
      bus.emit('census', { ts, summary: lastCensus.summary })
      pushCard()
    } catch (error) {
      censusFailures += 1
      if (censusFailures <= 3) log(`Census failed: ${error.message}`)
    }
  }

  return {
    async start() {
      await write('census.csv', CENSUS_HEADER)
      await tail.start()
      await sampleCensus()
      censusTimer = clock.setInterval(() => {
        sampleCensus()
      }, censusIntervalMs)
    },
    stop() {
      tail.stop()
      if (censusTimer !== null) clock.clearInterval(censusTimer)
      censusTimer = null
    },
    /** Feed every renderer-socket message here. */
    onBackendMessage(message) {
      const record = healthRecordFromEvent(message)
      if (!record) return
      health.push(record)
      write('health.ndjson', `${JSON.stringify(record)}\n`)
      bus.emit('health', record)
    },
    pollJournal: () => tail.poll(),
    sampleCensus,
    latestJournal: () => lastJournal,
    journalLines: (sinceMs = 0) => journal.filter((line) => line.tsMs >= sinceMs),
    healthEvents: () => [...health],
    lastCensus: () => lastCensus,
    journalPath: () => tail.currentPath()
  }
}
