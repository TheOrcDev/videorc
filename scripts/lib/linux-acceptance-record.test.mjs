import assert from 'node:assert/strict'
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { after, describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  assertLinuxAcceptanceRecord,
  compareLinuxReleaseIds,
  LINUX_ALPHA_OWNER_WAIVER_KIND,
  LINUX_BETA_ACCEPTANCE_KIND,
  LINUX_TIER1_DESKTOPS,
  linuxBetaCandidateIdentity,
  LinuxAcceptanceRecordError,
  linuxReleaseTrack,
  loadValidatedLinuxAlphaAcceptanceHistory,
  loadValidatedLinuxBetaAcceptanceHistory,
  REQUIRED_LINUX_BETA_ACCEPTANCE_GATES,
  REQUIRED_LINUX_BETA_DESKTOP
} from './linux-acceptance-record.mjs'
import { linuxCandidateIdentity, linuxCandidatePrefix } from './linux-release-candidate.mjs'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const acceptanceDir = join(repoRoot, 'docs', 'acceptance')

const sourceCommit = 'b'.repeat(40)
const appImageSha256 = 'a'.repeat(64)
const betaReleaseId = '0.40.0-beta.1'
const alphaReleaseId = '0.40.0-alpha.1'
const filename = 'Videorc-0.40.0-linux-x64.AppImage'
const sizeBytes = 283_971_628

const betaExpectations = {
  appImageSha256,
  filename,
  now: new Date('2026-10-10T00:00:00.000Z'),
  releasedAt: '2026-10-01T00:00:00.000Z',
  releaseId: betaReleaseId,
  sizeBytes,
  sourceCommit,
  priorAcceptedReleaseIds: []
}

const alphaExpectations = {
  appImageSha256,
  filename,
  now: new Date('2026-10-10T00:00:00.000Z'),
  releasedAt: '2026-10-01T00:00:00.000Z',
  releaseId: alphaReleaseId,
  sourceCommit
}

function passingGates() {
  return Object.fromEntries(
    REQUIRED_LINUX_BETA_ACCEPTANCE_GATES.map((gate) => [gate, { status: 'PASS' }])
  )
}

function box(desktop, testedAt = '2026-10-05T12:00:00.000Z') {
  return {
    desktop,
    architecture: 'x64',
    physicalHardware: true,
    testedAt,
    requiredGates: passingGates()
  }
}

function validBetaRecord(overrides = {}) {
  return {
    schemaVersion: 1,
    kind: LINUX_BETA_ACCEPTANCE_KIND,
    status: 'PASS',
    releaseId: betaReleaseId,
    sourceCommit,
    candidateIdentity: linuxBetaCandidateIdentity({
      appImageSha256,
      releaseId: betaReleaseId,
      sourceCommit
    }),
    artifact: { filename, sha256: appImageSha256, sizeBytes },
    releaseSequence: { kind: 'first-public-beta' },
    boxes: [box('arch-hyprland-wayland'), box('ubuntu-24.04-gnome-wayland')],
    ...overrides
  }
}

function validAlphaWaiver(overrides = {}) {
  return {
    schemaVersion: 1,
    kind: LINUX_ALPHA_OWNER_WAIVER_KIND,
    status: 'OWNER_WAIVED',
    releaseId: alphaReleaseId,
    sourceCommit,
    candidateIdentity: linuxCandidateIdentity({
      appImageSha256,
      releaseId: alphaReleaseId,
      sourceCommit
    }),
    artifact: { filename, sha256: appImageSha256, sizeBytes },
    decidedAt: '2026-10-02T00:00:00.000Z',
    decidedBy: 'release-owner',
    basis: 'field-use-by-alpha-testers',
    physicalAcceptance: { performed: false },
    ...overrides
  }
}

function rejects(record, expectations, code) {
  assert.throws(
    () => assertLinuxAcceptanceRecord(record, expectations),
    (error) => {
      assert.ok(error instanceof LinuxAcceptanceRecordError, error?.message)
      if (code) assert.equal(error.code, code)
      return true
    }
  )
}

describe('Linux release track', () => {
  it('reads the track from the release id and orders ids numerically', () => {
    assert.equal(linuxReleaseTrack('0.36.0-alpha.1'), 'alpha')
    assert.equal(linuxReleaseTrack('1.0.0-beta.3'), 'beta')
    assert.throws(() => linuxReleaseTrack('1.0.0'), LinuxAcceptanceRecordError)
    assert.throws(() => linuxReleaseTrack('1.0.0-rc.1'), LinuxAcceptanceRecordError)
    assert.ok(compareLinuxReleaseIds('0.9.150-alpha.1', '0.10.0-alpha.1') < 0)
    assert.ok(compareLinuxReleaseIds('0.40.0-beta.2', '0.40.0-beta.10') < 0)
  })

  it('uses the Alpha identity string for a Beta candidate', () => {
    assert.equal(
      linuxBetaCandidateIdentity({ appImageSha256, releaseId: betaReleaseId, sourceCommit }),
      `linux:${betaReleaseId}:${sourceCommit}:sha256:${appImageSha256}`
    )
    assert.throws(
      () => linuxBetaCandidateIdentity({ appImageSha256, releaseId: alphaReleaseId, sourceCommit }),
      LinuxAcceptanceRecordError
    )
  })
})

describe('Linux Beta acceptance record', () => {
  it('accepts an exact-candidate PASS on two Tier 1 boxes with every gate PASS', () => {
    const record = validBetaRecord()
    assert.equal(assertLinuxAcceptanceRecord(record, betaExpectations), record)
    assert.equal(REQUIRED_LINUX_BETA_ACCEPTANCE_GATES.length, 20)
  })

  it('accepts all three Tier 1 desktops in one record', () => {
    const record = validBetaRecord({ boxes: LINUX_TIER1_DESKTOPS.map((desktop) => box(desktop)) })
    assert.equal(assertLinuxAcceptanceRecord(record, betaExpectations), record)
  })

  it('refuses every form of owner waiver for a Beta release (D11)', () => {
    const waivers = [
      validAlphaWaiver({ releaseId: betaReleaseId }),
      {
        ...validAlphaWaiver({ releaseId: betaReleaseId }),
        kind: 'videorc-linux-beta-owner-waiver'
      },
      { ...validBetaRecord(), status: 'OWNER_WAIVED' },
      { ...validBetaRecord(), physicalAcceptance: { performed: true } },
      { ...validBetaRecord(), decidedBy: 'release-owner' },
      { ...validBetaRecord(), kind: 'videorc-linux-beta-waiver' }
    ]
    for (const waiver of waivers) {
      rejects(waiver, betaExpectations, 'beta-waiver-refused')
    }
  })

  it('needs at least two physical boxes on different Tier 1 desktops, one of them Ubuntu 24.04', () => {
    rejects(
      validBetaRecord({ boxes: [box('arch-hyprland-wayland')] }),
      betaExpectations,
      'acceptance-boxes-missing'
    )
    rejects(
      validBetaRecord({ boxes: [box('arch-hyprland-wayland'), box('arch-hyprland-wayland')] }),
      betaExpectations,
      'acceptance-duplicate-desktop'
    )
    rejects(
      validBetaRecord({ boxes: [box('arch-hyprland-wayland'), box('ubuntu-22.04-gnome-x11')] }),
      betaExpectations,
      'acceptance-desktop-not-tier1'
    )
    rejects(
      validBetaRecord({
        boxes: [box('arch-hyprland-wayland'), box('fedora-kde-plasma-6-wayland')]
      }),
      betaExpectations,
      'acceptance-ubuntu-box-missing'
    )
    assert.ok(
      assertLinuxAcceptanceRecord(
        validBetaRecord({
          boxes: [box('fedora-kde-plasma-6-wayland'), box(REQUIRED_LINUX_BETA_DESKTOP)]
        }),
        betaExpectations
      )
    )
    const vm = validBetaRecord()
    vm.boxes[1].physicalHardware = false
    rejects(vm, betaExpectations)
    const arm = validBetaRecord()
    arm.boxes[0].architecture = 'arm64'
    rejects(arm, betaExpectations)
    const named = validBetaRecord()
    named.boxes[0].hostname = 'ogre'
    rejects(named, betaExpectations, 'invalid-boxes[0]-keys')
  })

  it('needs PASS for every gate on every box, with no bootstrap exception', () => {
    for (const status of ['BLOCKED', 'FAIL', 'NOT_APPLICABLE', 'pass']) {
      const record = validBetaRecord()
      record.boxes[1].requiredGates.globalShortcuts = { status }
      rejects(record, betaExpectations)
    }
    const firstBetaUpdate = validBetaRecord()
    firstBetaUpdate.boxes[0].requiredGates.betaToBetaUpdate = {
      status: 'NOT_APPLICABLE',
      reason: 'first-public-beta'
    }
    rejects(firstBetaUpdate, betaExpectations)
    const missing = validBetaRecord()
    delete missing.boxes[0].requiredGates.artifactSignature
    rejects(missing, betaExpectations)
    const extra = validBetaRecord()
    extra.boxes[0].requiredGates.windowsOnly = { status: 'PASS' }
    rejects(extra, betaExpectations)
  })

  it('binds the exact candidate artifact', () => {
    rejects(validBetaRecord({ sourceCommit: 'c'.repeat(40) }), betaExpectations)
    rejects(
      validBetaRecord({ artifact: { filename, sha256: 'd'.repeat(64), sizeBytes } }),
      betaExpectations,
      'candidate-identity-mismatch'
    )
    rejects(
      validAlphaWaiver({ sourceCommit: 'c'.repeat(40) }),
      { ...alphaExpectations, sourceCommit: 'c'.repeat(40) },
      'candidate-identity-mismatch'
    )
    rejects(
      validBetaRecord({ artifact: { filename, sha256: appImageSha256, sizeBytes: sizeBytes + 1 } }),
      betaExpectations
    )
    rejects(validBetaRecord({ artifact: { filename, sha256: appImageSha256 } }), betaExpectations)
    rejects(
      validBetaRecord({
        candidateIdentity: `linux:${betaReleaseId}:${sourceCommit}:sha256:${'d'.repeat(64)}`
      }),
      betaExpectations
    )
    rejects({ ...validBetaRecord(), notes: 'looked fine' }, betaExpectations)
  })

  it('dates each box inside the candidate window', () => {
    const early = validBetaRecord()
    early.boxes[0].testedAt = '2026-09-30T23:59:59.000Z'
    rejects(early, betaExpectations, 'acceptance-before-candidate')
    const future = validBetaRecord()
    future.boxes[1].testedAt = '2026-10-11T00:00:00.000Z'
    rejects(future, betaExpectations, 'acceptance-in-future')
    const sloppy = validBetaRecord()
    sloppy.boxes[0].testedAt = '2026-12-05 12:00'
    rejects(sloppy, betaExpectations)
  })

  it('chains Beta releases with no skipped predecessor', () => {
    const expectations = {
      ...betaExpectations,
      releaseId: '0.41.0-beta.1',
      filename: 'Videorc-0.41.0-linux-x64.AppImage',
      priorAcceptedReleaseIds: ['0.40.0-beta.1']
    }
    const successor = (previousReleaseId) =>
      validBetaRecord({
        releaseId: expectations.releaseId,
        candidateIdentity: linuxBetaCandidateIdentity({
          appImageSha256,
          releaseId: expectations.releaseId,
          sourceCommit
        }),
        artifact: { filename: expectations.filename, sha256: appImageSha256, sizeBytes },
        releaseSequence: { kind: 'successor', previousReleaseId }
      })
    assert.ok(assertLinuxAcceptanceRecord(successor('0.40.0-beta.1'), expectations))
    rejects(successor('0.39.0-beta.1'), expectations, 'unaccepted-previous-release')
    rejects(successor('0.42.0-beta.1'), expectations, 'invalid-previous-release')
    rejects(successor('0.40.0-alpha.1'), expectations, 'invalid-previous-release')
    const bootstrapAgain = {
      ...successor('0.40.0-beta.1'),
      releaseSequence: { kind: 'first-public-beta' }
    }
    rejects(bootstrapAgain, expectations)
    rejects(
      validBetaRecord({
        releaseSequence: { kind: 'successor', previousReleaseId: '0.39.0-beta.1' }
      }),
      betaExpectations
    )
    const { priorAcceptedReleaseIds: _ignored, ...noHistory } = betaExpectations
    rejects(validBetaRecord(), noHistory, 'missing-release-history-expectation')
  })
})

describe('Linux Alpha owner waiver', () => {
  it("accepts the release owner's exact-candidate waiver, with or without the storage prefix", () => {
    assert.ok(assertLinuxAcceptanceRecord(validAlphaWaiver(), alphaExpectations))
    const older = validAlphaWaiver({
      artifact: { filename, sha256: appImageSha256 },
      candidateStoragePrefix: linuxCandidatePrefix({ releaseId: alphaReleaseId, sourceCommit })
    })
    assert.ok(assertLinuxAcceptanceRecord(older, alphaExpectations))
  })

  it('may not claim the physical test it replaces, a gate, or an unknown basis', () => {
    rejects(validAlphaWaiver({ physicalAcceptance: { performed: true } }), alphaExpectations)
    rejects(
      validAlphaWaiver({ physicalAcceptance: { performed: false, gates: 'PASS' } }),
      alphaExpectations
    )
    rejects(
      { ...validAlphaWaiver(), requiredGates: passingGates() },
      alphaExpectations,
      'invalid-record-keys'
    )
    rejects(
      validAlphaWaiver({ basis: 'looked-fine' }),
      alphaExpectations,
      'acceptance-basis-mismatch'
    )
    rejects(validAlphaWaiver({ decidedBy: 'release-agent' }), alphaExpectations)
    rejects(validAlphaWaiver({ status: 'PASS' }), alphaExpectations)
    rejects(validAlphaWaiver({ kind: 'videorc-linux-beta-owner-waiver' }), alphaExpectations)
  })

  it('binds the exact candidate and the decision time', () => {
    rejects(validAlphaWaiver({ sourceCommit: 'c'.repeat(40) }), alphaExpectations)
    rejects(
      validAlphaWaiver({
        candidateStoragePrefix: linuxCandidatePrefix({
          releaseId: alphaReleaseId,
          sourceCommit: 'c'.repeat(40)
        })
      }),
      alphaExpectations
    )
    rejects(
      validAlphaWaiver({ artifact: { filename: 'Videorc.AppImage', sha256: appImageSha256 } }),
      alphaExpectations
    )
    rejects(
      validAlphaWaiver({ decidedAt: '2026-09-30T00:00:00.000Z' }),
      alphaExpectations,
      'waiver-before-candidate'
    )
    rejects(
      validAlphaWaiver({ decidedAt: '2026-10-11T00:00:00.000Z' }),
      alphaExpectations,
      'waiver-in-future'
    )
  })

  it('has no Alpha PASS contract: a physical PASS record is a Beta record', () => {
    const record = validBetaRecord({
      releaseId: alphaReleaseId,
      candidateIdentity: linuxCandidateIdentity({
        appImageSha256,
        releaseId: alphaReleaseId,
        sourceCommit
      })
    })
    rejects(record, alphaExpectations, 'acceptance-kind-mismatch')
  })
})

describe('committed Linux acceptance history', () => {
  const scratch = []
  after(async () => {
    await Promise.all(scratch.map((dir) => rm(dir, { recursive: true, force: true })))
  })
  async function scratchDir(files) {
    const dir = await mkdtemp(join(tmpdir(), 'videorc-linux-acceptance-'))
    scratch.push(dir)
    for (const [name, content] of Object.entries(files)) {
      await writeFile(
        join(dir, name),
        typeof content === 'string' ? content : JSON.stringify(content)
      )
    }
    return dir
  }

  it('validates every committed Linux Alpha record in release order', async () => {
    const dir = join(acceptanceDir, 'linux-alpha')
    const files = (await readdir(dir)).filter((name) => name.endsWith('.json'))
    const ids = await loadValidatedLinuxAlphaAcceptanceHistory(dir)
    assert.equal(ids.length, files.length)
    assert.equal(ids[0], '0.9.122-alpha.1')
    assert.ok(ids.includes('0.15.0-alpha.1') && ids.includes('0.16.0-alpha.1'))
  })

  it('validates every committed Linux Beta record as one chain', async () => {
    const ids = await loadValidatedLinuxBetaAcceptanceHistory(join(acceptanceDir, 'linux-beta'))
    assert.ok(Array.isArray(ids))
  })

  it('refuses a waiver committed as a Beta record', async () => {
    const dir = await scratchDir({
      [`${betaReleaseId}.json`]: validAlphaWaiver({ releaseId: betaReleaseId })
    })
    await assert.rejects(loadValidatedLinuxBetaAcceptanceHistory(dir), {
      code: 'beta-waiver-refused'
    })
  })

  it('loads a Beta chain and refuses a skipped predecessor', async () => {
    const second = (previousReleaseId) =>
      validBetaRecord({
        releaseId: '0.41.0-beta.1',
        candidateIdentity: linuxBetaCandidateIdentity({
          appImageSha256,
          releaseId: '0.41.0-beta.1',
          sourceCommit
        }),
        artifact: {
          filename: 'Videorc-0.41.0-linux-x64.AppImage',
          sha256: appImageSha256,
          sizeBytes
        },
        releaseSequence: { kind: 'successor', previousReleaseId }
      })
    const good = await scratchDir({
      [`${betaReleaseId}.json`]: validBetaRecord(),
      '0.41.0-beta.1.json': second(betaReleaseId)
    })
    assert.deepEqual(await loadValidatedLinuxBetaAcceptanceHistory(good), [
      betaReleaseId,
      '0.41.0-beta.1'
    ])
    const skipped = await scratchDir({
      [`${betaReleaseId}.json`]: validBetaRecord(),
      '0.41.0-beta.1.json': second('0.39.0-beta.1')
    })
    await assert.rejects(loadValidatedLinuxBetaAcceptanceHistory(skipped), {
      code: 'unaccepted-previous-release'
    })
  })

  it('fails on a stray or misnamed file and on an Alpha record for the wrong AppImage', async () => {
    const stray = await scratchDir({
      [`${betaReleaseId}.json`]: validBetaRecord(),
      [`${betaReleaseId}-waiver.json`]: validAlphaWaiver({ releaseId: betaReleaseId })
    })
    await assert.rejects(loadValidatedLinuxBetaAcceptanceHistory(stray), {
      code: 'unexpected-record-file'
    })
    const wrongName = await scratchDir({
      [`${alphaReleaseId}.json`]: validAlphaWaiver({
        artifact: { filename: 'Videorc-0.39.0-linux-x64.AppImage', sha256: appImageSha256 }
      })
    })
    await assert.rejects(loadValidatedLinuxAlphaAcceptanceHistory(wrongName), {
      code: 'acceptance-artifact.filename-mismatch'
    })
    const broken = await scratchDir({ [`${alphaReleaseId}.json`]: '{' })
    await assert.rejects(loadValidatedLinuxAlphaAcceptanceHistory(broken), {
      code: 'acceptance-record-json'
    })
  })

  it('refuses a committed record whose candidateIdentity disagrees with its own fields', async () => {
    // The shapes 0.15.0-alpha.1 and 0.16.0-alpha.1 had before #1645.
    const committed = JSON.parse(
      await readFile(join(acceptanceDir, 'linux-alpha', '0.15.0-alpha.1.json'), 'utf8')
    )
    const corrupted = {
      ...committed,
      candidateIdentity: `linux:${committed.releaseId}:${committed.sourceCommit}a.1/${committed.sourceCommit}`
    }
    const truncated = {
      ...committed,
      candidateIdentity: `linux:${committed.releaseId}:${committed.sourceCommit}a-testers`
    }
    for (const record of [corrupted, truncated]) {
      const dir = await scratchDir({ [`${committed.releaseId}.json`]: record })
      await assert.rejects(loadValidatedLinuxAlphaAcceptanceHistory(dir), {
        code: 'candidate-identity-mismatch'
      })
    }
  })
})

describe('Linux acceptance templates', () => {
  it('the public JSON template carries exactly the validator gates and fails until filled', async () => {
    const template = JSON.parse(
      await readFile(join(acceptanceDir, 'linux-beta-acceptance-record.template.json'), 'utf8')
    )
    assert.equal(template.kind, LINUX_BETA_ACCEPTANCE_KIND)
    assert.ok(template.boxes.length >= 2)
    for (const templateBox of template.boxes) {
      assert.deepEqual(Object.keys(templateBox.requiredGates), [
        ...REQUIRED_LINUX_BETA_ACCEPTANCE_GATES
      ])
    }
    assert.throws(
      () => assertLinuxAcceptanceRecord(template, betaExpectations),
      LinuxAcceptanceRecordError
    )
  })

  it('the checklist and the private template name every gate', async () => {
    for (const name of [
      'linux-physical-acceptance-checklist.md',
      'linux-app-acceptance-template.md'
    ]) {
      const text = await readFile(join(acceptanceDir, name), 'utf8')
      for (const gate of REQUIRED_LINUX_BETA_ACCEPTANCE_GATES) {
        assert.ok(text.includes(`\`${gate}\``), `${name} names ${gate}`)
      }
    }
  })
})
