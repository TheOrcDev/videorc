import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { buildLinuxCapabilities } from './linux-capabilities.mjs'

describe('buildLinuxCapabilities', () => {
  it('defaults absent runtime probe fields to false', () => {
    const payload = buildLinuxCapabilities({ artifactPath: '/tmp/videorc.deb' })
    assert.equal(payload.runtime.capture.pipewire, false)
    assert.equal(payload.verification.notes[0], 'No runtime probe output was attached at build time.')
    assert.equal(payload.policy.fallbackPolicy, 'unknown')
  })

  it('includes runtime override values', () => {
    const payload = buildLinuxCapabilities({
      artifactPath: '/tmp/videorc.deb',
      runtimeCapabilities: {
        source: 'hardware-test',
        capture: { gnomeWayland: true, portal: true, pipewire: true },
        audio: { microphone: true, systemAudio: true },
        preview: { nativeAvailable: true, webglAvailable: false },
        encoding: { vaapi: true, openh264: true, x264: false, qsv: false },
        selected: {
          capture: 'portal-pipewire',
          audio: 'pipewire-system-default',
          preview: 'native',
          recordingEncoder: 'h264_vaapi',
          streamingEncoder: 'h264_openh264'
        },
        policy: 'hardware-only',
        requestedMode: 'performance',
        notes: ['hw test passed']
      }
    })
    assert.equal(payload.runtime.capture.pipewire, true)
    assert.equal(payload.runtime.audio.systemAudio, true)
    assert.equal(payload.selected.preview, 'native')
    assert.equal(payload.policy.fallbackPolicy, 'hardware-only')
    assert.equal(payload.verification.notes.includes('hw test passed'), true)
  })
})
