import test from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { readFileSync } from 'node:fs'
import { captionPixels, assessCaptionEvidence } from './cloud-parity-captions-contract.mjs'
test('caption evidence rejects acknowledgements and unrun acquisition', () => {
  assert.equal(assessCaptionEvidence({ status: 'not-run', ack: true }).status, 'failed')
  assert.equal(captionPixels(Buffer.from([255, 255, 255, 0, 0, 0])).ink, 1)
  assert.throws(() => captionPixels(Buffer.alloc(1)))
  assert.equal(assessCaptionEvidence({}).productionQualified, false)
})
test('host-only transcript migration is additive and idempotent', () => {
  const db = new DatabaseSync(':memory:')
  db.exec(
    "CREATE TABLE sessions(id TEXT,started_at TEXT);INSERT INTO sessions VALUES('historical','2001-01-01')"
  )
  const migration = readFileSync(
    new URL('../../crates/videorc-backend/src/storage/cloud_speech.sql', import.meta.url),
    'utf8'
  )
  db.exec(migration)
  db.exec(migration)
  const save = db.prepare(
    'INSERT INTO cloud_host_transcript(show_id,source_id,speech_session_id,seq,offset_seconds,duration_seconds,text,clock_json) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(show_id,source_id,speech_session_id,seq) DO UPDATE SET text=excluded.text'
  )
  save.run('show', 'source', 'speech', 1, 2, 1, 'First final', '{}')
  save.run('show', 'source', 'speech', 1, 2, 1, 'Canonical final', '{}')
  assert.equal(db.prepare('SELECT count(*) n FROM cloud_host_transcript').get().n, 1)
  assert.equal(db.prepare('SELECT text FROM cloud_host_transcript').get().text, 'Canonical final')
  assert.equal(db.prepare('SELECT started_at FROM sessions').get().started_at, '2001-01-01')
  assert.equal(
    db.prepare('SELECT count(*) n FROM cloud_host_transcript WHERE show_id=?').get('other').n,
    0
  )
  db.close()
})
