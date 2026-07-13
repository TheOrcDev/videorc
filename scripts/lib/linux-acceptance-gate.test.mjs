import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { join } from 'node:path'
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'

import {
  validateLinuxAcceptanceManifest,
  runAcceptanceGate
} from './linux-acceptance-gate.mjs'

describe('validateLinuxAcceptanceManifest', () => {
  it('rejects a missing-GNOME/portal/PipeWire/feature coverage manifest', () => {
    const errors = validateLinuxAcceptanceManifest({})

    assert.ok(errors.includes('required: gnome-wayland'))
    assert.ok(errors.includes('required: portal'))
    assert.ok(errors.includes('required: pipewire'))
    assert.ok(errors.includes('required: screen-capture'))
    assert.ok(errors.includes('required: preview'))
    assert.ok(errors.includes('required: encoder'))
    assert.ok(errors.includes('required: final-artifact'))
    assert.ok(errors.includes('required: av-sync'))
    assert.ok(errors.includes('required: process-cleanup'))
    assert.ok(errors.includes('required: redaction'))
  })

  it('rejects incomplete feature evidence in any section', () => {
    const manifest = {
      'gnome-wayland': { ok: true, evidence: [] },
      portal: { ok: true },
      pipewire: { ok: false, evidence: ['pipewire-pulse listed'] },
      'screen-capture': { ok: true, evidence: ['selected stream'] },
      preview: { ok: true, evidence: ['latest frame'] },
      encoder: { ok: false, evidence: ['h264_vaapi'] },
      'final-artifact': { ok: true, evidence: [] },
      'av-sync': { ok: true, evidence: ['ffprobe delta'] },
      'process-cleanup': { ok: true, evidence: ['reap complete'] },
      redaction: { ok: true, evidence: ['path removed'] }
    }

    const errors = validateLinuxAcceptanceManifest(manifest)

    assert.ok(errors.includes('required: gnome-wayland.evidence'))
    assert.ok(errors.includes('required: portal.evidence'))
    assert.ok(errors.includes('required: final-artifact.evidence'))
    assert.ok(errors.includes('required: pipewire.ok'))
    assert.ok(errors.includes('requested: pipewire'))
  })

  it('accepts a complete passing manifest', () => {
    const manifest = {
      'gnome-wayland': { ok: true, evidence: ['session type', 'wayland socket'] },
      portal: { ok: true, evidence: ['choose-source', 'restore-token'] },
      pipewire: { ok: true, evidence: ['stream opened', 'nodes inspected'] },
      'screen-capture': { ok: true, evidence: ['display selected', 'source id'] },
      preview: { ok: true, evidence: ['preview liveness verified'] },
      encoder: { ok: true, evidence: ['h264-vaapi'] },
      'final-artifact': { ok: true, evidence: ['ffprobe', 'ffmpeg analyze'] },
      'av-sync': { ok: true, evidence: ['skew report'] },
      'process-cleanup': { ok: true, evidence: ['no stale child pids'] },
      redaction: { ok: true, evidence: ['paths redacted', 'tokens removed'] }
    }

    assert.equal(validateLinuxAcceptanceManifest(manifest).length, 0)
  })
})

describe('runAcceptanceGate', () => {
  it('fails fast when manifest path is missing', async () => {
    const exitCode = await runAcceptanceGate(['node', 'linux-acceptance-gate.mjs'])
    assert.equal(exitCode, 1)
  })

  it('fails when manifest is missing required evidence', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'videorc-linux-acceptance-test-'))
    const manifestPath = join(dir, 'manifest.json')
    writeFileSync(manifestPath, JSON.stringify({}))

    const exitCode = await runAcceptanceGate(['node', 'linux-acceptance-gate.mjs', manifestPath])
    assert.equal(exitCode, 1)
    rmSync(dir, { recursive: true, force: true })
  })

  it('passes on a complete manifest', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'videorc-linux-acceptance-test-'))
    const manifestPath = join(dir, 'manifest.json')
    writeFileSync(
      manifestPath,
      JSON.stringify({
        'gnome-wayland': { ok: true, evidence: ['session type'] },
        portal: { ok: true, evidence: ['session start'] },
        pipewire: { ok: true, evidence: ['node selected'] },
        'screen-capture': { ok: true, evidence: ['screen stream started'] },
        preview: { ok: true, evidence: ['preview frame present'] },
        encoder: { ok: true, evidence: ['encoder variant'] },
        'final-artifact': { ok: true, evidence: ['ffprobe ok'] },
        'av-sync': { ok: true, evidence: ['av skew', 'audio-video'] },
        'process-cleanup': { ok: true, evidence: ['backend exit'] },
        redaction: { ok: true, evidence: ['paths redacted', 'secrets removed'] }
      })
    )

    const exitCode = await runAcceptanceGate(['node', 'linux-acceptance-gate.mjs', manifestPath])
    assert.equal(exitCode, 0)
    rmSync(dir, { recursive: true, force: true })
  })
})
