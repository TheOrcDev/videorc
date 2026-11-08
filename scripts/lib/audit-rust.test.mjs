import assert from 'node:assert/strict'
import test from 'node:test'

import { acceptedUnmaintainedAdvisories, rustAuditCommands } from '../audit-rust.mjs'

const ignored = [
  '--ignore',
  'RUSTSEC-2026-0370',
  '--ignore',
  'RUSTSEC-2026-0371',
  '--ignore',
  'RUSTSEC-2026-0372'
]

test('Rust audit clones a fresh database through system Git before auditing offline', () => {
  assert.deepEqual(rustAuditCommands({ databasePath: '/cache/rustsec', databaseExists: false }), [
    ['git', ['clone', '--quiet', 'https://github.com/RustSec/advisory-db.git', '/cache/rustsec']],
    ['cargo', ['fetch', '--locked']],
    ['cargo', ['audit', '--db', '/cache/rustsec', '--no-fetch', '--deny', 'warnings', ...ignored]]
  ])
})

test('Rust audit fast-forwards its cached database before auditing offline', () => {
  assert.deepEqual(rustAuditCommands({ databasePath: '/cache/rustsec', databaseExists: true }), [
    ['git', ['-C', '/cache/rustsec', 'pull', '--ff-only', '--quiet']],
    ['cargo', ['fetch', '--locked']],
    ['cargo', ['audit', '--db', '/cache/rustsec', '--no-fetch', '--deny', 'warnings', ...ignored]]
  ])
})

test('Rust audit ignores only the named unmaintained notices, each with its source', () => {
  for (const advisory of acceptedUnmaintainedAdvisories) {
    assert.match(advisory.id, /^RUSTSEC-\d{4}-\d{4}$/)
    assert.ok(advisory.crate, `${advisory.id} names its crate`)
    assert.ok(advisory.via, `${advisory.id} names the dependency that pulls it in`)
  }
  assert.deepEqual(
    acceptedUnmaintainedAdvisories.map(({ id }) => id),
    ['RUSTSEC-2026-0370', 'RUSTSEC-2026-0371', 'RUSTSEC-2026-0372']
  )
})
