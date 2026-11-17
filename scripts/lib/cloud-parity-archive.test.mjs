import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
const sql = readFileSync(
  new URL('../../crates/videorc-backend/src/storage/cloud_archives.sql', import.meta.url),
  'utf8'
)
test('archive migration is additive/idempotent and cannot rewrite historical takes', () => {
  const db = new DatabaseSync(':memory:')
  try {
    db.exec(
      "CREATE TABLE sessions(id TEXT PRIMARY KEY, started_at TEXT); INSERT INTO sessions VALUES('take','2020-01-01T00:00:00Z')"
    )
    db.exec(sql)
    db.exec(sql)
    db.prepare('INSERT INTO cloud_program_archives VALUES (?,?)').run(
      'archive',
      JSON.stringify({ state: 'interrupted', generation: 'original' })
    )
    assert.equal(
      db.prepare('SELECT started_at FROM sessions').get().started_at,
      '2020-01-01T00:00:00Z'
    )
    assert.deepEqual(
      JSON.parse(db.prepare('SELECT journal_json FROM cloud_program_archives').get().journal_json),
      { state: 'interrupted', generation: 'original' }
    )
    assert.throws(
      () =>
        db
          .prepare('INSERT INTO cloud_program_archives VALUES (?,?)')
          .run('oversized', 'x'.repeat(524289)),
      /CHECK constraint/
    )
  } finally {
    db.close()
  }
})
