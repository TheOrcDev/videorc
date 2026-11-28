/** S20 maintained local app/HTTPS-storage acceptance. Never imported by unit
 * tests. Provider lifecycle, real database migration and managed artifact
 * acceptance remain separate, explicit deferred gates. */
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { managedHarness, OUTPUT, waitFor } from './cloud-managed-smoke.mjs'
import { analyzeRecording } from './recording-analyzer.mjs'

export async function runLibrary() {
  const h = await managedHarness('talk')
  const report = {
    case: 'library',
    status: 'running',
    managedAcceptance: 'not-run',
    realDatabaseMigration: 'not-run',
    artifacts: []
  }
  const output = join(h.root, 'library.json')
  const sql = (query) =>
    JSON.parse(
      execFileSync('sqlite3', ['-json', join(h.appData, 'videorc.sqlite3'), query], {
        encoding: 'utf8'
      }) || '[]'
    )
  const start = async (id) => {
    const { capabilityId } = await h.command('authorize-smoke-resource', {
      kind: 'output-directory',
      path: h.env.VIDEORC_RECORDINGS_DIR
    })
    return h.rpc('cloud.recordings.download', { id, outputDirectoryCapability: capabilityId })
  }
  const terminal = async ({ jobId }) =>
    (
      await waitFor(
        () =>
          h.events.find(
            (e) =>
              e.event === 'cloud.recordings.download' &&
              e.payload.jobId === jobId &&
              ['done', 'failed', 'cancelled'].includes(e.payload.state)
          ),
        'download terminal',
        90000
      )
    ).payload
  try {
    await h.launch()
    const opened = await h.rpc('cloud.room.open', {
      outputs: [OUTPUT],
      title: 'Library record-only',
      platforms: []
    })
    h.showId = opened.show.id
    await h.rpc('cloud.recording.start')
    await h.status((s) => s.recording?.active && !s.room?.live, 'record-only room')
    await waitFor(
      () =>
        sql("SELECT id FROM sessions WHERE mode IN ('cloud-stream', 'cloud-room')").length === 1,
      'record-only Library history'
    )
    const historical = sql(
      "SELECT id, started_at FROM sessions WHERE mode IN ('cloud-stream', 'cloud-room')"
    )
    await h.rpc('cloud.recording.stop')
    // Canonical IDs here are fixture server facts, not generated desktop
    // interval identities. S16's real provider boundary is a separate gate.
    const takes = [[], ['fixture-interval-A'], ['fixture-interval-A', 'fixture-interval-B']].map(
      (liveIntervalIds, index) =>
        h.web.hooks.addRecording({
          showId: h.showId,
          takeId: `tk_${String(index).padStart(12, '0')}`,
          liveIntervalIds,
          associationKnown: true
        })
    )
    for (const take of takes) {
      const listed = (await h.rpc('cloud.recordings.list')).recordings.find((r) => r.id === take.id)
      assert.deepEqual(listed.liveIntervalIds, take.liveIntervalIds)
      const done = await terminal(await start(take.id))
      assert.equal(done.state, 'done', done.error)
      assert.ok(done.localSessionId)
      const rows = sql(
        `SELECT id, mode, started_at, mp4_path FROM sessions WHERE id = '${done.localSessionId}'`
      )
      assert.equal(rows.length, 1)
      assert.equal(rows[0].mode, 'cloud-recording')
      assert.equal(rows[0].started_at, take.startedAt)
      const repeated = await terminal(await start(take.id))
      assert.equal(repeated.path, done.path)
      assert.equal(repeated.localSessionId, done.localSessionId)
      const artifact = await analyzeRecording(done.path, {
        ffmpegPath: h.ffmpeg,
        ffprobePath: h.ffprobe,
        expectAudio: true
      })
      report.artifacts.push(artifact)
      assert.ok(artifact.verdict.pass, artifact.verdict.failures.join('; '))
    }
    const interrupted = h.web.hooks.addRecording({ showId: h.showId })
    const barrier = h.web.hooks.pause('segment')
    try {
      await start(interrupted.id)
      await waitFor(() => barrier.hits, 'interrupted download held')
      await h.kill()
    } finally {
      barrier.release()
    }
    await h.launch()
    const retried = await terminal(await start(interrupted.id))
    assert.equal(retried.state, 'done', retried.error)
    assert.equal(sql(`SELECT id FROM sessions WHERE id = '${retried.localSessionId}'`).length, 1)
    assert.deepEqual(
      sql("SELECT id, started_at FROM sessions WHERE mode IN ('cloud-stream', 'cloud-room')"),
      historical
    )
    const expired = h.web.hooks.addRecording({
      showId: h.showId,
      expiresAt: '2000-01-01T00:00:00Z',
      availability: 'expired'
    })
    const expiry = await terminal(await start(expired.id))
    assert.equal(expiry.state, 'failed')
    assert.match(expiry.error, /expired/)
    // The cloud recordings are the Library's Cloud tab (#1544).
    if (h.isGpui) {
      await h.command('open-tab', { tab: 'library' })
      await h.uiClick({ within: { id: 'library-tabs/tabs' }, role: 'tab', index: 1 })
      await waitFor(
        async () => Boolean(await h.uiFind({ label: 'Open in Library' }, { timeoutMs: 250 })),
        'Library local-file navigation'
      )
    } else {
      await h.command('open-tab', { tab: 'library', waitFor: '[data-library-view="cloud"]' })
      await h.eval(`document.querySelector('[data-library-view="cloud"]').click(); return true`)
      await waitFor(
        () => h.eval("return document.body.textContent.includes('Open in Library')"),
        'Library local-file navigation'
      )
    }
    report.status = 'passed-local-fixture'
  } catch (error) {
    report.status = 'failed'
    report.error = String(error.message)
    throw error
  } finally {
    writeFileSync(output, JSON.stringify(report, null, 2) + '\n')
    await h.close()
  }
  return { output }
}
