import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { createGlassWindowReader } from './glass-window-oracle.mjs'

test('oracle compiles once and uses bounded one-shot reads with reduced metadata', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'videorc-glass-oracle-test-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const calls = []
  const window = {
    id: 21,
    pid: 42,
    order: 0,
    layer: 4,
    alpha: 1,
    x: 40,
    y: 50,
    width: 600,
    height: 400,
    ownerCategory: 'target-app'
  }
  const read = createGlassWindowReader(directory, {
    execute: (command, args, options) => {
      calls.push({ command, args, options })
      if (command === 'swiftc') return ''
      return JSON.stringify({
        observedAt: 1000,
        privateMetadata: 'private title',
        windows: [{ ...window, title: 'private title', ownerName: 'private owner' }]
      })
    }
  })
  assert.deepEqual(read(), { observedAt: 1000, windows: [window] })
  assert.deepEqual(read(), { observedAt: 1000, windows: [window] })
  assert.equal(calls.length, 3)
  assert.deepEqual(calls[0], {
    command: 'swiftc',
    args: [
      join(directory, 'glass-window-oracle.swift'),
      '-o',
      join(directory, 'glass-window-oracle')
    ],
    options: { timeout: 30_000, stdio: ['ignore', 'ignore', 'ignore'] }
  })
  assert.ok(readFileSync(calls[0].args[0], 'utf8').includes('CGWindowListCopyWindowInfo'))
  for (const call of calls.slice(1)) {
    assert.deepEqual(call, {
      command: join(directory, 'glass-window-oracle'),
      args: [],
      options: {
        timeout: 2_000,
        maxBuffer: 1024 * 1024,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore']
      }
    })
  }
})

test('malformed or unavailable native metadata throws only a reduced failure', async (t) => {
  for (const [name, value] of [
    ['invalid JSON', 'private title'],
    ['missing windows', JSON.stringify({ ownerName: 'private owner' })],
    ['failed read', new Error('private title')]
  ]) {
    await t.test(name, (t) => {
      const directory = mkdtempSync(join(tmpdir(), 'videorc-glass-oracle-test-'))
      t.after(() => rmSync(directory, { recursive: true, force: true }))
      const read = createGlassWindowReader(directory, {
        execute: (command) => {
          if (command === 'swiftc') return ''
          if (value instanceof Error) throw value
          return value
        }
      })
      assert.throws(read, { message: 'Window metadata unavailable.' })
    })
  }
})

test('cursor-free captures omit only the identified system cursor at its native level', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'videorc-glass-oracle-test-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const cursorWindowLevel = 2147483630
  const window = {
    id: 21,
    pid: 42,
    order: 1,
    layer: 4,
    alpha: 1,
    x: 40,
    y: 50,
    width: 600,
    height: 400,
    ownerCategory: 'target-app'
  }
  const cursor = {
    ...window,
    id: 4,
    pid: 395,
    order: 0,
    layer: cursorWindowLevel,
    width: 28,
    height: 40,
    ownerCategory: 'system-cursor'
  }
  const ordinaryOverlay = {
    ...cursor,
    id: 80,
    order: 2,
    ownerCategory: 'other-app'
  }
  const systemDialog = {
    ...cursor,
    id: 81,
    order: 3,
    ownerCategory: 'system-dialog'
  }
  const mismatchedCursor = { ...cursor, id: 82, order: 4, layer: 10 }
  const read = createGlassWindowReader(directory, {
    execute: (command) =>
      command === 'swiftc'
        ? ''
        : JSON.stringify({
            observedAt: 1000,
            cursorWindowLevel,
            windows: [cursor, window, ordinaryOverlay, systemDialog, mismatchedCursor]
          })
  })
  assert.deepEqual(read(), {
    observedAt: 1000,
    windows: [window, ordinaryOverlay, systemDialog, mismatchedCursor]
  })
  for (const level of [undefined, null, String(cursorWindowLevel), cursorWindowLevel + 0.5]) {
    const uncertain = createGlassWindowReader(directory, {
      execute: (command) =>
        command === 'swiftc'
          ? ''
          : JSON.stringify({ observedAt: 1000, cursorWindowLevel: level, windows: [cursor] })
    })
    assert.deepEqual(uncertain().windows, [cursor], 'uncertain metadata must remain fail-closed')
  }
})
