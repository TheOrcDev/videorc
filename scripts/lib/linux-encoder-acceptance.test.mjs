import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  assessLinuxEncoderAcceptanceHost,
  assessLinuxEncoderMatrixResults,
  parseLinuxEncoderAcceptanceArgs,
  parseOsRelease
} from './linux-encoder-acceptance.mjs'

describe('Linux encoder acceptance arguments', () => {
  it('runs both backends by default and accepts one explicit diagnostic backend', () => {
    assert.deepEqual(parseLinuxEncoderAcceptanceArgs([]), {
      requested: 'all',
      backends: ['openh264', 'vaapi']
    })
    assert.deepEqual(parseLinuxEncoderAcceptanceArgs(['--backend=vaapi']), {
      requested: 'vaapi',
      backends: ['vaapi']
    })
    assert.deepEqual(parseLinuxEncoderAcceptanceArgs(['--backend', 'openh264']), {
      requested: 'openh264',
      backends: ['openh264']
    })
  })

  it('rejects unknown, missing, and repeated backend arguments', () => {
    assert.throws(() => parseLinuxEncoderAcceptanceArgs(['--backend']), /requires/)
    assert.throws(() => parseLinuxEncoderAcceptanceArgs(['--backend=x264']), /openh264, or vaapi/)
    assert.throws(
      () => parseLinuxEncoderAcceptanceArgs(['--backend=vaapi', '--backend=openh264']),
      /only once/
    )
    assert.throws(() => parseLinuxEncoderAcceptanceArgs(['--force']), /Unknown/)
  })
})

describe('Linux encoder acceptance host contract', () => {
  const validHost = {
    platform: 'linux',
    arch: 'x64',
    osRelease: { ID: 'ubuntu', VERSION_ID: '24.04', PRETTY_NAME: 'Ubuntu 24.04.3 LTS' },
    testerName: 'Tester One',
    machineName: 'intel-laptop-a',
    physicalHardware: '1',
    videoDevices: ['/dev/video0'],
    renderDevices: ['/dev/dri/renderD128'],
    backends: ['openh264', 'vaapi']
  }

  it('parses os-release and accepts only the named Ubuntu hardware contract', () => {
    assert.deepEqual(
      parseOsRelease('ID=ubuntu\nVERSION_ID="24.04"\nPRETTY_NAME="Ubuntu 24.04.3 LTS"\n'),
      { ID: 'ubuntu', VERSION_ID: '24.04', PRETTY_NAME: 'Ubuntu 24.04.3 LTS' }
    )
    assert.deepEqual(assessLinuxEncoderAcceptanceHost(validHost), { ok: true, problems: [] })
  })

  it('rejects CI/VM substitutes, anonymous boxes, and missing real devices', () => {
    const assessment = assessLinuxEncoderAcceptanceHost({
      ...validHost,
      osRelease: { ID: 'debian', VERSION_ID: '13', PRETTY_NAME: 'Debian 13' },
      testerName: '',
      machineName: '',
      physicalHardware: '',
      videoDevices: [],
      renderDevices: []
    })
    assert.equal(assessment.ok, false)
    assert.match(assessment.problems.join('\n'), /Ubuntu 24.04/)
    assert.match(assessment.problems.join('\n'), /TESTER_NAME/)
    assert.match(assessment.problems.join('\n'), /TESTER_MACHINE/)
    assert.match(assessment.problems.join('\n'), /PHYSICAL_HARDWARE/)
    assert.match(assessment.problems.join('\n'), /webcam/)
    assert.match(assessment.problems.join('\n'), /renderD/)
  })
})

describe('Linux encoder acceptance evidence', () => {
  function passingResult(encodeBackend) {
    return [
      {
        combo: '1080p30',
        outputPath: '/tmp/recording.mp4',
        sizeBytes: 2048,
        failures: [],
        metrics: { width: 1920, height: 1080, observedFps: 30.0 },
        bridgeDiagnostics: { encodeBackend }
      }
    ]
  }

  it('requires the artifact and truthful forced backend diagnostics', () => {
    assert.equal(
      assessLinuxEncoderMatrixResults({
        backend: 'openh264',
        results: passingResult('software-open-h264')
      }).ok,
      true
    )
    assert.equal(
      assessLinuxEncoderMatrixResults({
        backend: 'vaapi',
        results: passingResult('hardware-vaapi')
      }).ok,
      true
    )

    const wrongBackend = assessLinuxEncoderMatrixResults({
      backend: 'vaapi',
      results: passingResult('software-open-h264')
    })
    assert.equal(wrongBackend.ok, false)
    assert.match(wrongBackend.problems.join('\n'), /hardware-vaapi/)
  })
})
