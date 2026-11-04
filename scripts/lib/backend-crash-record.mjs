// Whether a persisted backend crash record (userData/backend-crashes.json)
// shows the kill smoke:backend-resilience sent. On POSIX the record names
// SIGKILL: the signal itself (packaged, the supervisor's child IS the
// backend) or the stderr tail (dev, where `cargo run` exits 101 and prints
// the backend's "(signal: 9, SIGKILL: kill)" line). Windows has no signals:
// Node's `process.kill(pid, 'SIGKILL')` is TerminateProcess with exit code 1,
// so the record reads `code: 1, signal: null` (or, in dev, cargo's
// "exit code: 1" line). Code 1 is also an ordinary failure exit, so there it
// only counts when the record was written after the harness's own kill (#1081).

/** True when `record` names the kill the harness sent at `killedAtMs`. */
export function crashRecordShowsHarnessKill(
  record,
  { platform = process.platform, killedAtMs } = {}
) {
  const stderrTail = Array.isArray(record?.stderrTail) ? record.stderrTail : []
  if (platform !== 'win32') {
    return (
      record?.signal === 'SIGKILL' || stderrTail.some((line) => /SIGKILL|signal: 9\b/.test(line))
    )
  }
  const recordedAtMs = Date.parse(record?.at ?? '')
  if (!Number.isFinite(killedAtMs) || !Number.isFinite(recordedAtMs) || recordedAtMs < killedAtMs) {
    return false
  }
  return (
    (record.signal ?? null) === null &&
    (record.code === 1 || stderrTail.some((line) => /\(exit code: 1\)/.test(line)))
  )
}
