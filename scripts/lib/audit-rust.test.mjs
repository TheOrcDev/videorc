import assert from 'node:assert/strict'
import test from 'node:test'

import { rustAuditCommands } from '../audit-rust.mjs'

test('Rust audit clones a fresh database through system Git before auditing offline', () => {
  assert.deepEqual(rustAuditCommands({ databasePath: '/cache/rustsec', databaseExists: false }), [
    ['git', ['clone', '--quiet', 'https://github.com/RustSec/advisory-db.git', '/cache/rustsec']],
    ['cargo', ['audit', '--db', '/cache/rustsec', '--no-fetch', '--deny', 'warnings']]
  ])
})

test('Rust audit fast-forwards its cached database before auditing offline', () => {
  assert.deepEqual(rustAuditCommands({ databasePath: '/cache/rustsec', databaseExists: true }), [
    ['git', ['-C', '/cache/rustsec', 'pull', '--ff-only', '--quiet']],
    ['cargo', ['audit', '--db', '/cache/rustsec', '--no-fetch', '--deny', 'warnings']]
  ])
})
