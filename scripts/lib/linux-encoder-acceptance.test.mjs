import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  assessLinuxEncoderAcceptanceHost,
  assessLinuxEncoderMatrixResults,
  describeLinuxRenderNodes,
  linuxRenderNodeDriver,
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

  it('parses os-release and accepts the named Ubuntu hardware contract', () => {
    assert.deepEqual(
      parseOsRelease('ID=ubuntu\nVERSION_ID="24.04"\nPRETTY_NAME="Ubuntu 24.04.3 LTS"\n'),
      { ID: 'ubuntu', VERSION_ID: '24.04', PRETTY_NAME: 'Ubuntu 24.04.3 LTS' }
    )
    assert.deepEqual(assessLinuxEncoderAcceptanceHost(validHost), { ok: true, problems: [] })
  })

  it('accepts any named physical Linux x64 box and only records its distribution', () => {
    assert.deepEqual(
      assessLinuxEncoderAcceptanceHost({
        ...validHost,
        osRelease: { ID: 'debian', VERSION_ID: '13', PRETTY_NAME: 'Debian 13' }
      }),
      { ok: true, problems: [] }
    )
    const omarchy = parseOsRelease(
      'ID=omarchy\nID_LIKE=arch\nVERSION_ID=4.0.4\nPRETTY_NAME="Omarchy 4.0.4"\n'
    )
    assert.equal(omarchy.ID_LIKE, 'arch')
    assert.deepEqual(assessLinuxEncoderAcceptanceHost({ ...validHost, osRelease: omarchy }), {
      ok: true,
      problems: []
    })
    const unreadable = assessLinuxEncoderAcceptanceHost({ ...validHost, osRelease: undefined })
    assert.equal(unreadable.ok, false)
    assert.match(unreadable.problems.join('\n'), /os-release/)
  })

  it('still requires the physical attestation on a non-Ubuntu box', () => {
    const assessment = assessLinuxEncoderAcceptanceHost({
      ...validHost,
      osRelease: { ID: 'omarchy', ID_LIKE: 'arch', VERSION_ID: '4.0.4' },
      physicalHardware: ''
    })
    assert.equal(assessment.ok, false)
    assert.deepEqual(assessment.problems, [
      'VIDEORC_LINUX_PHYSICAL_HARDWARE=1 must attest this is a real, non-VM box'
    ])
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
    assert.doesNotMatch(assessment.problems.join('\n'), /Ubuntu/)
    assert.match(assessment.problems.join('\n'), /TESTER_NAME/)
    assert.match(assessment.problems.join('\n'), /TESTER_MACHINE/)
    assert.match(assessment.problems.join('\n'), /PHYSICAL_HARDWARE/)
    assert.match(assessment.problems.join('\n'), /webcam/)
    assert.match(assessment.problems.join('\n'), /renderD/)
  })
})

describe('Linux render node drivers', () => {
  const links = {
    '/sys/class/drm/renderD128/device/driver': '../../../../bus/pci/drivers/i915',
    '/sys/class/drm/renderD129/device/driver': '../../../../bus/pci/drivers/amdgpu'
  }
  const readlink = (path) => {
    if (!(path in links)) throw new Error(`ENOENT: ${path}`)
    return links[path]
  }

  it('reads the driver basename behind a render node and never throws', () => {
    assert.equal(linuxRenderNodeDriver('/dev/dri/renderD128', readlink), 'i915')
    assert.equal(linuxRenderNodeDriver('/dev/dri/renderD129', readlink), 'amdgpu')
    assert.equal(linuxRenderNodeDriver('/dev/dri/renderD130', readlink), null)
    assert.equal(linuxRenderNodeDriver('', readlink), null)
    assert.equal(
      linuxRenderNodeDriver('/dev/dri/renderD128', () => {
        throw new Error('EACCES')
      }),
      null
    )
  })

  it('describes every render node as evidence, unreadable drivers included', () => {
    assert.deepEqual(
      describeLinuxRenderNodes(
        ['/dev/dri/renderD128', '/dev/dri/renderD129', '/dev/dri/renderD130'],
        readlink
      ),
      [
        { node: '/dev/dri/renderD128', driver: 'i915' },
        { node: '/dev/dri/renderD129', driver: 'amdgpu' },
        { node: '/dev/dri/renderD130', driver: null }
      ]
    )
    assert.deepEqual(describeLinuxRenderNodes(undefined, readlink), [])
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
