import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { buildLinuxReleaseManifest } from './linux-release.mjs'
import {
  assessLinuxBetaAcceptance,
  linuxBetaAcceptanceTemplate,
  verifyLinuxBetaEvidenceFiles
} from './linux-beta-acceptance.mjs'

// Artificial contract fixtures, never acceptance evidence.
const manifest = buildLinuxReleaseManifest({
  artifactPath: 'Videorc-0.16.1-linux-x64.AppImage',
  packageVersion: '0.16.1',
  sha256: 'a'.repeat(64),
  sizeBytes: 100,
  sourceCommit: 'b'.repeat(40),
  releasedAt: '2026-10-01T00:00:00.000Z',
  env: { VIDEORC_RELEASE_ID: '0.16.1-beta.1' }
})
const now = new Date('2026-10-20T00:00:00.000Z')
const ref = {
  path: 'private-report.json',
  sha256: createHash('sha256').update('evidence fixture').digest('hex')
}
function passedFixture() {
  const record = linuxBetaAcceptanceTemplate(manifest)
  record.status = 'pass'
  for (const role of Object.keys(record.owners)) record.owners[role] = 'fixture-owner'
  for (const [index, env] of record.environments.entries()) {
    Object.assign(env, {
      machine: `fixture-${index}`,
      operator: 'fixture-operator',
      osVersion: index === 0 ? 'Ubuntu 24.04.3' : 'Omarchy 4.0.4',
      desktopVersion: index === 0 ? 'GNOME 46 Wayland' : 'Hyprland 0.51 Wayland',
      cpu: 'fixture-cpu',
      gpu: 'fixture-gpu',
      kernel: 'fixture-kernel',
      ramGiB: 16,
      startedAt: '2026-10-02T00:00:00.000Z',
      finishedAt: '2026-10-19T00:00:00.000Z',
      criticalWorkflowFreshPasses: 3,
      previewCycles: 20,
      minimumSpecHours: 4
    })
    for (const category of env.categories)
      Object.assign(category, { status: 'pass', evidence: [ref] })
    for (const encoder of env.encoders)
      Object.assign(encoder, {
        recordCycles: 50,
        recordAndLocalStreamMinutes: 60,
        metrics: {
          fpsErrorRatio: 0.02,
          frameCountErrorRatio: 0.02,
          motionFreezeMs: 100,
          repeatedFrames: 2,
          audioGapMs: 20,
          avSkewMs: 150,
          gopSeconds: 2.5,
          stopTailMs: 100,
          coldStartMs: 1000,
          warmStartP95Ms: 350,
          stopP95Ms: 300,
          shortFinalizeP95Ms: 5000,
          takeCoverage: 0.98
        }
      })
    env.pilot = {
      startedAt: '2026-10-03T00:00:00.000Z',
      finishedAt: '2026-10-10T00:00:00.000Z',
      sessions: Array.from({ length: 9 }, (_, i) => ({
        id: `session-${i}`,
        tester: `tester-${Math.floor(i / 3)}`,
        status: 'pass',
        evidence: ref,
        startedAt: `2026-10-0${3 + (i % 3)}T10:00:00.000Z`,
        finishedAt: `2026-10-0${3 + (i % 3)}T12:00:00.000Z`
      }))
    }
  }
  return record
}
const assess = (record) => assessLinuxBetaAcceptance(record, manifest, { now })

test('pending template cannot pass; complete exact-candidate contract can', () => {
  assert.equal(assess(linuxBetaAcceptanceTemplate(manifest)).ok, false)
  assert.deepEqual(assess(passedFixture()), { ok: true, failures: [] })
})

test('rejects missing, skipped, stale, duplicate and virtual-machine evidence', () => {
  const edits = [
    (r) => {
      r.status = 'waived'
    },
    (r) => {
      r.candidate.sha256 = 'c'.repeat(64)
    },
    (r) => {
      r.candidate.sourceCommit = 'c'.repeat(40)
    },
    (r) => {
      r.environments.pop()
    },
    (r) => {
      r.environments[1].id = r.environments[0].id
    },
    (r) => {
      r.environments[1].machine = r.environments[0].machine
    },
    (r) => {
      r.environments[0].physical = false
    },
    (r) => {
      r.environments[0].osVersion = 'Ubuntu 22.04'
    },
    (r) => {
      r.environments[0].categories[0].status = 'skipped'
    },
    (r) => {
      r.environments[0].categories[0].evidence = []
    },
    (r) => {
      r.environments[0].categories[0].evidence = [{ ...ref, path: '../escape' }]
    },
    (r) => {
      r.environments[0].startedAt = '2026-09-01T00:00:00.000Z'
    },
    (r) => {
      r.environments[0].finishedAt = '2026-10-21T00:00:00.000Z'
    },
    (r) => {
      r.owners.rollback = null
    },
    (r) => {
      r.environments[0].encoders.pop()
    }
  ]
  for (const edit of edits) {
    const record = passedFixture()
    edit(record)
    assert.equal(assess(record).ok, false, String(edit))
  }
})

test('enforces every artifact and latency limit without overrides', () => {
  for (const metric of Object.keys(passedFixture().environments[0].encoders[0].metrics)) {
    const record = passedFixture()
    const metrics = record.environments[0].encoders[0].metrics
    metrics[metric] = metric === 'takeCoverage' ? 0.979 : metrics[metric] + 0.001
    assert.equal(assess(record).ok, false, metric)
    metrics[metric] = null
    assert.equal(assess(record).ok, false, `${metric} missing`)
  }
})

test('enforces actual endurance and seven-day pilot sessions on both desktops', () => {
  for (const edit of [
    (e) => {
      e.criticalWorkflowFreshPasses = 2
    },
    (e) => {
      e.previewCycles = 19
    },
    (e) => {
      e.minimumSpecHours = 3.99
    },
    (e) => {
      e.encoders[0].recordCycles = 49
    },
    (e) => {
      e.encoders[0].recordAndLocalStreamMinutes = 59.99
    },
    (e) => {
      e.pilot.finishedAt = '2026-10-09T23:59:59.000Z'
    },
    (e) => {
      e.pilot.sessions.pop()
    },
    (e) => {
      e.pilot.sessions[1] = { ...e.pilot.sessions[0], id: 'overlapping' }
    },
    (e) => {
      e.pilot.sessions[0].status = 'blocked'
    },
    (e) => {
      e.pilot.sessions.forEach((s) => {
        s.finishedAt = s.startedAt.replace('10:00', '10:01')
      })
    }
  ]) {
    const record = passedFixture()
    record.environments.forEach(edit)
    assert.equal(assess(record).ok, false, String(edit))
  }
})

test('requires candidate-bound report bytes and measured artifacts; refuses stale reports and symlinks', async () => {
  const root = await mkdtemp(join(tmpdir(), 'beta-evidence-test-'))
  try {
    const record = passedFixture()
    // Focus this byte-verification test on one category; schema coverage is above.
    record.environments = [record.environments[0]]
    const env = record.environments[0]
    env.categories = [env.categories[0]]
    env.pilot.sessions = []
    const raw = {
      path: 'measurement.log',
      sha256: createHash('sha256').update('measurement').digest('hex')
    }
    const report = {
      schemaVersion: 1,
      status: 'pass',
      candidate: record.candidate,
      environmentId: env.id,
      operator: env.operator,
      categoryIds: [env.categories[0].id],
      startedAt: env.startedAt,
      finishedAt: env.finishedAt,
      artifacts: [raw]
    }
    const save = async () => {
      const bytes = JSON.stringify(report)
      env.categories[0].evidence = [
        { path: ref.path, sha256: createHash('sha256').update(bytes).digest('hex') }
      ]
      await writeFile(join(root, ref.path), bytes)
    }
    await assert.rejects(verifyLinuxBetaEvidenceFiles(record, root), { code: 'ENOENT' })
    await save()
    await assert.rejects(verifyLinuxBetaEvidenceFiles(record, root), { code: 'ENOENT' })
    await writeFile(join(root, raw.path), 'measurement')
    assert.deepEqual(await verifyLinuxBetaEvidenceFiles(record, root), { verifiedFiles: 2 })
    report.candidate = { ...record.candidate, sha256: 'c'.repeat(64) }
    await save()
    await assert.rejects(verifyLinuxBetaEvidenceFiles(record, root), /candidate\/environment/)
    report.candidate = record.candidate
    await save()
    await writeFile(join(root, raw.path), 'changed')
    await assert.rejects(verifyLinuxBetaEvidenceFiles(record, root), /changed evidence/)
    if (process.platform !== 'win32') {
      await rm(join(root, raw.path))
      await symlink(import.meta.filename, join(root, raw.path))
      await assert.rejects(verifyLinuxBetaEvidenceFiles(record, root), /escapes/)
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
