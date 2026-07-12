import assert from 'node:assert/strict'
import test from 'node:test'

import { inspectTextBuffer, isTrackedTextPath } from './text-file-integrity.mjs'

test('tracked text path classification includes source and repository control files', () => {
  assert.equal(isTrackedTextPath('apps/desktop/src/main/index.ts'), true)
  assert.equal(isTrackedTextPath('.gitattributes'), true)
  assert.equal(isTrackedTextPath('Cargo.lock'), true)
  assert.equal(isTrackedTextPath('assets/app-icon.png'), false)
})

test('tracked text integrity accepts valid UTF-8', () => {
  assert.deepEqual(inspectTextBuffer('README.md', Buffer.from('Videorc — studio\n')), [])
})

test('tracked text integrity rejects embedded NUL bytes', () => {
  assert.deepEqual(inspectTextBuffer('index.ts', Buffer.from('before\0after')), [
    'index.ts: contains a NUL byte at offset 6'
  ])
})

test('tracked text integrity rejects malformed UTF-8', () => {
  assert.deepEqual(inspectTextBuffer('index.ts', Buffer.from([0xc3, 0x28])), [
    'index.ts: is not valid UTF-8'
  ])
})

test('tracked text integrity ignores known binary paths', () => {
  assert.deepEqual(inspectTextBuffer('icon.png', Buffer.from([0, 0xff])), [])
})
