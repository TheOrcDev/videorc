// Run: node --test scripts/lib/backend-crash-record.test.mjs
import assert from 'node:assert/strict'
import test from 'node:test'

import { crashRecordShowsHarnessKill } from './backend-crash-record.mjs'

const killedAtMs = Date.parse('2026-11-04T10:00:00.000Z')
const record = (fields) => ({
  at: '2026-11-04T10:00:00.250Z',
  code: null,
  signal: null,
  stderrTail: ['backend line'],
  ...fields
})

test('POSIX: the record must name SIGKILL by signal or stderr tail', () => {
  const options = { platform: 'darwin', killedAtMs }
  assert.equal(crashRecordShowsHarnessKill(record({ signal: 'SIGKILL' }), options), true)
  assert.equal(
    crashRecordShowsHarnessKill(
      record({
        code: 101,
        stderrTail: ['error: process did not exit successfully (signal: 9, SIGKILL: kill)']
      }),
      options
    ),
    true
  )
  assert.equal(crashRecordShowsHarnessKill(record({ code: 1 }), options), false)
})

test('Windows: TerminateProcess shows as code 1 with no signal (#1081)', () => {
  const options = { platform: 'win32', killedAtMs }
  assert.equal(crashRecordShowsHarnessKill(record({ code: 1 }), options), true)
  assert.equal(
    crashRecordShowsHarnessKill(
      record({
        code: 101,
        stderrTail: [
          "error: process didn't exit successfully: `videorc-backend.exe` (exit code: 1)"
        ]
      }),
      options
    ),
    true
  )
})

test('Windows: code 1 only counts after the harness kill and without a signal', () => {
  assert.equal(
    crashRecordShowsHarnessKill(record({ code: 1, at: '2026-11-04T09:59:59.000Z' }), {
      platform: 'win32',
      killedAtMs
    }),
    false
  )
  assert.equal(
    crashRecordShowsHarnessKill(record({ code: 1 }), { platform: 'win32' }),
    false,
    'no recorded kill'
  )
  assert.equal(
    crashRecordShowsHarnessKill(record({ code: 2 }), { platform: 'win32', killedAtMs }),
    false
  )
  assert.equal(
    crashRecordShowsHarnessKill(record({ code: 1, signal: 'SIGTERM' }), {
      platform: 'win32',
      killedAtMs
    }),
    false
  )
})
