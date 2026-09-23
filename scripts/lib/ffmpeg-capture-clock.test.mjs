import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import {
  hasCaptureClockProtocol,
  probeCaptureClock,
  verifyCaptureClockManifest
} from '../ffmpeg-capture-clock.mjs'

test('the actual binary must expose the exact capture-clock protocol', () => {
  const help =
    '  -videorc_audio_clock <boolean> .D......... export exact packet capture clock metadata (Videorc AVF clock protocol 1) (default false)\n  -videorc_audio_uid <string> .D......... select exact stable audio UID'
  assert.equal(hasCaptureClockProtocol(help), true)
  for (const invalid of [
    '',
    help.replace('protocol 1', 'protocol 0'),
    help.replace('protocol 1', 'protocol 10'),
    help.replace('protocol 1', 'protocol 11'),
    help.replace('-videorc_audio_clock', '-something_else'),
    help.replace('-videorc_audio_uid', '-something_else')
  ]) {
    assert.equal(hasCaptureClockProtocol(invalid), false)
    assert.throws(() => probeCaptureClock('fixture', () => invalid), /lacks/)
  }
  assert.deepEqual(
    probeCaptureClock('fixture', (binary, args, options) => {
      assert.equal(binary, 'fixture')
      assert.deepEqual(args, ['-hide_banner', '-h', 'demuxer=avfoundation'])
      assert.equal(options.timeout, 15000)
      return help
    }),
    { protocol: 1 }
  )
})

test('reuse requires matching protocol, both manifests, and distributed source patch', () => {
  const bundle = mkdtempSync(join(tmpdir(), 'videorc-clock-manifest-'))
  try {
    const patch = join(bundle, 'maintained.patch')
    writeFileSync(patch, 'maintained source modification\n')
    const fingerprint = createHash('sha256')
      .update('maintained source modification\n')
      .digest('hex')
    const manifest = `Videorc AVF clock protocol: 1\nVideorc AVF clock patch SHA-256: ${fingerprint}\n`
    mkdirSync(join(bundle, 'source-patches'))
    const distributed = join(bundle, 'source-patches', 'avfoundation-capture-clock.patch')
    writeFileSync(distributed, 'maintained source modification\n')
    for (const file of ['SOURCE.txt', 'BUILD-CONFIG.txt'])
      writeFileSync(join(bundle, file), manifest)
    assert.equal(verifyCaptureClockManifest(bundle, patch), fingerprint)
    for (const file of ['SOURCE.txt', 'BUILD-CONFIG.txt']) {
      for (const invalid of [
        '',
        manifest.replace('protocol: 1', 'protocol: 0'),
        manifest.replace(fingerprint, '0'.repeat(64))
      ]) {
        writeFileSync(join(bundle, file), invalid)
        assert.throws(() => verifyCaptureClockManifest(bundle, patch), /does not identify/)
      }
      writeFileSync(join(bundle, file), manifest)
    }
    writeFileSync(distributed, 'different patch')
    assert.throws(() => verifyCaptureClockManifest(bundle, patch), /differs/)
  } finally {
    rmSync(bundle, { recursive: true, force: true })
  }
})
