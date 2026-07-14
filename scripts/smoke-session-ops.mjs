import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, statSync } from 'node:fs'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Library rewrite L6: session ops round-trip over the REAL backend WS —
// import → list → rename → duplicate → storage totals → delete. Runs the
// debug backend binary against an isolated database (secrets/posters derive
// from its parent), so the owner's real library is never touched.
//
// The two-phase Trash contract is asserted the hard way: sessions.delete
// durably hides rows and atomically moves identity-matched media to private
// quarantine names. The renderer receives only opaque operation handles;
// Electron main resolves each handle over its private admin connection before
// an explicit completion removes the rows after simulated Trash moves.

const backendBinary = join(process.cwd(), 'target', 'debug', 'videorc-backend')
assert.ok(
  existsSync(backendBinary),
  'target/debug/videorc-backend missing — run `cargo build -p videorc-backend` first'
)

const stateRoot = mkdtempSync(join(tmpdir(), 'videorc-session-ops-'))
const outputDir = join(stateRoot, 'recordings')
const sourcePath = join(stateRoot, 'Session Ops Smoke.mp4')
const timeoutMs = Number(process.env.VIDEORC_SMOKE_TIMEOUT_MS ?? 60000)

let backend
let socket

try {
  await mkdir(outputDir, { recursive: true })
  // A fake mp4 is enough: import copies bytes and tolerates a failed
  // duration probe / poster extraction (they stay honest as "unknown").
  await writeFile(sourcePath, Buffer.alloc(4096, 7))

  backend = spawn(backendBinary, [], {
    env: {
      ...process.env,
      VIDEORC_DATABASE_PATH: join(stateRoot, 'videorc.sqlite3'),
      VIDEORC_DISABLE_BACKEND_REAP: '1'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  const ready = await waitForReady(backend)
  assert.ok(
    typeof ready.adminToken === 'string' && ready.adminToken.length >= 32,
    'debug backend READY must include its private smoke admin credential'
  )
  socket = await connect(`ws://127.0.0.1:${ready.port}/ws?token=${ready.adminToken}`)
  const rpc = makeRpc(socket)

  // Import: a managed copy into the output directory + a completed row.
  const imported = await rpc('sessions.import', { sourcePath, outputDirectory: outputDir })
  const importedId = imported.sessionId
  assert.ok(importedId, 'import should return the new session id')
  const importedFile = join(outputDir, 'Session Ops Smoke.mp4')
  assert.ok(existsSync(importedFile), 'import should copy the file into the output directory')
  assert.ok(existsSync(sourcePath), 'import must copy, never move, the source file')

  let sessions = await rpc('sessions.list', { limit: 200 })
  let row = sessions.find((session) => session.id === importedId)
  assert.ok(row, 'imported session should appear in sessions.list')
  assert.equal(row.mode, 'imported')
  assert.equal(row.status, 'completed')
  assert.equal(row.title, 'Session Ops Smoke')
  assert.equal(row.fileSizeBytes, statSync(importedFile).size, 'size must come from the real file')

  // Rename: bounds enforced, then the row tells the new truth.
  const badRename = await rpc.expectError('sessions.rename', {
    sessionId: importedId,
    title: '   '
  })
  assert.equal(badRename.code, 'session-rename-invalid')
  await rpc('sessions.rename', { sessionId: importedId, title: 'Renamed by smoke' })
  sessions = await rpc('sessions.list', { limit: 200 })
  assert.equal(
    sessions.find((session) => session.id === importedId)?.title,
    'Renamed by smoke',
    'rename should persist'
  )

  // Duplicate: " (copy)" file next to the original + a cloned row.
  const duplicated = await rpc('sessions.duplicate', { sessionId: importedId })
  const duplicateId = duplicated.sessionId
  assert.ok(duplicateId && duplicateId !== importedId, 'duplicate should mint a new id')
  const copyFile = join(outputDir, 'Session Ops Smoke (copy).mp4')
  assert.ok(existsSync(copyFile), 'duplicate should write the " (copy)" file')
  sessions = await rpc('sessions.list', { limit: 200 })
  const copyRow = sessions.find((session) => session.id === duplicateId)
  assert.ok(copyRow, 'duplicated session should appear in sessions.list')
  assert.equal(copyRow.title, 'Renamed by smoke (copy)')

  const totals = await rpc('sessions.storage')
  assert.equal(totals.count, 2)
  assert.equal(totals.totalBytes, 2 * statSync(importedFile).size)

  // Delete prepare: rows hide, identity-matched files move to operation-owned
  // quarantine names, and the public result contains no path authority.
  const operations = await rpc('sessions.delete', { sessionIds: [importedId, duplicateId] })
  assert.equal(operations.length, 2)
  assert.ok(
    operations.every(
      (operation) =>
        typeof operation.operationId === 'string' &&
        operation.pathCount === 1 &&
        operation.blockedPathCount === 0 &&
        !Object.hasOwn(operation, 'paths') &&
        !Object.hasOwn(operation, 'blockedPaths')
    ),
    'delete prepare should return only renderer-safe operation handles'
  )
  const pendingOperations = await rpc('sessions.delete.pending')
  assert.deepEqual(
    pendingOperations,
    operations,
    'pending delete should return the same non-empty operation handles as prepare'
  )
  assert.ok(
    pendingOperations.every(
      (operation) => !Object.hasOwn(operation, 'paths') && !Object.hasOwn(operation, 'blockedPaths')
    ),
    'pending delete should not expose private path authority to the renderer'
  )
  sessions = await rpc('sessions.list', { limit: 200 })
  assert.equal(sessions.length, 0, 'prepared sessions should be hidden immediately')
  assert.ok(!existsSync(importedFile), 'prepare should quarantine the recording file')
  assert.ok(!existsSync(copyFile), 'prepare should quarantine the duplicated file')
  const resolvedOperations = await Promise.all(
    operations.map((operation) =>
      rpc('sessions.delete.resolve', { operationId: operation.operationId })
    )
  )
  const quarantinePaths = resolvedOperations.flatMap((operation) => operation.paths)
  assert.equal(quarantinePaths.length, 2)
  assert.ok(
    quarantinePaths.every(
      (path) => path.startsWith(outputDir) && path.includes('.videorc-trash-') && existsSync(path)
    ),
    'prepare should return two existing operation-owned quarantine paths'
  )
  assert.ok(
    resolvedOperations.every((operation) => (operation.blockedPaths ?? []).length === 0),
    'identity-matched files should not be blocked from Trash'
  )
  assert.ok(
    quarantinePaths.every((path) => statSync(path).size === 4096),
    'quarantine must preserve both recording payloads'
  )

  for (const path of quarantinePaths) {
    await rm(path)
  }
  for (const operation of operations) {
    const completed = await rpc('sessions.delete.complete', {
      operationId: operation.operationId,
      failedPaths: []
    })
    assert.equal(completed.deleted, true)
  }
  assert.deepEqual(await rpc('sessions.delete.pending'), [])

  console.log(
    'Session ops smoke OK — import/rename/duplicate/storage/two-phase-delete round-trip over the real WS.'
  )
} finally {
  if (socket) {
    socket.close()
  }
  if (backend && backend.exitCode === null) {
    backend.kill('SIGTERM')
  }
  await rm(stateRoot, { recursive: true, force: true })
}

function waitForReady(child) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('backend did not print READY in time')),
      timeoutMs
    )
    let buffer = ''
    child.stdout.on('data', (chunk) => {
      buffer += chunk.toString()
      const line = buffer.split('\n').find((candidate) => candidate.startsWith('READY '))
      if (line) {
        clearTimeout(timer)
        resolve(JSON.parse(line.slice('READY '.length)))
      }
    })
    child.on('exit', (code) => {
      clearTimeout(timer)
      reject(new Error(`backend exited early with code ${code}`))
    })
  })
}

function connect(url) {
  // Node's built-in WebSocket (browser-style events; available since Node 22).
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url)
    ws.addEventListener('open', () => resolve(ws), { once: true })
    ws.addEventListener('error', (event) => reject(event.error ?? new Error('ws error')), {
      once: true
    })
  })
}

function makeRpc(ws) {
  let nextId = 0
  const pending = new Map()
  ws.addEventListener('message', (event) => {
    const message = JSON.parse(String(event.data))
    if (typeof message.id !== 'string' || !pending.has(message.id)) {
      return // server events
    }
    const { resolve, reject, expectError, timer } = pending.get(message.id)
    pending.delete(message.id)
    clearTimeout(timer)
    if (message.ok) {
      if (expectError) {
        reject(new Error(`expected an error but ${message.id} succeeded`))
      } else {
        resolve(message.payload)
      }
    } else if (expectError) {
      resolve(message.error)
    } else {
      reject(new Error(`${message.id} failed: ${message.error?.code} ${message.error?.message}`))
    }
  })
  const send = (method, params, expectError) =>
    new Promise((resolve, reject) => {
      const id = `smoke-${nextId++}-${method}`
      const timer = setTimeout(() => {
        if (pending.has(id)) {
          pending.delete(id)
          reject(new Error(`${method} timed out`))
        }
      }, timeoutMs)
      pending.set(id, { resolve, reject, expectError, timer })
      try {
        ws.send(JSON.stringify({ id, method, params: params ?? {} }))
      } catch (error) {
        clearTimeout(timer)
        pending.delete(id)
        reject(error)
      }
    })
  const rpc = (method, params) => send(method, params, false)
  rpc.expectError = (method, params) => send(method, params, true)
  return rpc
}
