/** Production SQLite migration on a disposable in-memory old-schema fixture. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
test('S20 backfill is additive, idempotent and preserves old session start times', () => {
  const sql = fileURLToPath(
    new URL('../../crates/videorc-backend/src/storage/cloud_recordings.sql', import.meta.url)
  )
  const output = execFileSync(
    'python3',
    [
      '-c',
      `
import sqlite3, sys
c=sqlite3.connect(':memory:')
c.execute('PRAGMA foreign_keys=ON')
c.execute('CREATE TABLE sessions(id TEXT PRIMARY KEY, mode TEXT, started_at TEXT)')
c.executemany('INSERT INTO sessions VALUES(?,?,?)', [('old-show','cloud-stream','2020-01-01'),('local','record','2019-01-01')])
original=c.execute('SELECT * FROM sessions').fetchall()
sql=open(sys.argv[1]).read()
c.executescript(sql)
c.executescript(sql)
assert c.execute('SELECT * FROM sessions').fetchall()==original
assert c.execute('SELECT session_id,show_id FROM cloud_session_associations').fetchall()==[('old-show','old-show')]
c.execute("INSERT INTO cloud_recording_library(recording_id, show_id, take_id, metadata_json, session_id) VALUES('rec','old-show','take','{}','old-show')")
c.execute("DELETE FROM sessions WHERE id='old-show'")
assert c.execute('SELECT session_id FROM cloud_recording_library').fetchone()==(None,)
assert c.execute('SELECT count(*) FROM cloud_session_associations').fetchone()==(0,)
print('ok')
`,
      sql
    ],
    { encoding: 'utf8' }
  )
  assert.equal(output.trim(), 'ok')
})
