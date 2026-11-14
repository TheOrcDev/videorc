import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createServer } from 'node:https'
import { join } from 'node:path'
import { managedPath, managedWire as w } from './fake-cloud-web-managed.mjs'
import { runMedia, waitFor } from './cloud-managed-smoke.mjs'

/** Exercise the ACTUAL bundled remux, rather than Node's TLS verifier. The
 * API route stays on the existing loopback HTTP fake for this isolated test;
 * the HLS segment's root is deliberately different from the trusted feed root.
 */
export async function assertUntrustedManagedSegment(h, download) {
  const dir = mkdtempSync(join(h.root, 'untrusted-root-')),
    key = join(dir, 'key.pem'),
    cert = join(dir, 'cert.pem')
  let server,
    requests = 0
  try {
    runMedia('openssl', [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-keyout',
      key,
      '-out',
      cert,
      '-days',
      '1',
      '-subj',
      '/CN=localhost',
      '-addext',
      'subjectAltName=DNS:localhost,IP:127.0.0.1'
    ])
    server = createServer({ key: readFileSync(key), cert: readFileSync(cert) }, (_req, res) => {
      requests++
      res.writeHead(200, { 'content-type': 'video/mp2t' })
      res.end(Buffer.alloc(188))
    })
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
    const row = h.web.hooks.addRecording({ showId: h.showId })
    h.web.recordings.find((r) => r.id === row.id).playlistUrl =
      `${h.web.httpOrigin}${managedPath('recordingPlaylist', row.id)}`
    const address = `https://localhost:${server.address().port}/segment.ts?signature=unit-test-only`
    h.web.hooks.answerNext(
      'recordingPlaylist',
      `#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:2\n#EXTINF:2,\n${address}\n#EXT-X-ENDLIST\n`,
      200,
      w.recordings.playlistContentType
    )
    const job = await h.rpc(
      download.start,
      { id: row.id, outputDirectory: h.env.VIDEORC_RECORDINGS_DIR },
      5000
    )
    assert.ok(job.jobId, 'download must be a job')
    const event = await waitFor(
      () =>
        h.events.find(
          (e) =>
            e.event === download.event &&
            e.payload.jobId === job.jobId &&
            ['done', 'failed'].includes(e.payload.state ?? e.payload.phase)
        ),
      'untrusted segment failure',
      45000
    )
    assert.equal(event.payload.state ?? event.payload.phase, 'failed')
    assert.equal(
      requests,
      0,
      'remux disclosed the signed segment URL before trusting its certificate'
    )
    assert.equal(JSON.stringify(event).includes(address), false)
  } finally {
    if (server)
      await new Promise((resolve) => {
        server.close(resolve)
        server.closeAllConnections()
      })
    rmSync(dir, { recursive: true, force: true })
  }
}
