import { readFile, realpath, stat } from 'node:fs/promises'
import { isAbsolute, join, relative, sep } from 'node:path'
import { assertLinuxReleaseManifest, sha256File } from './linux-release.mjs'

export const LINUX_BETA_ENVIRONMENTS = ['ubuntu-24.04-gnome-wayland', 'omarchy-hyprland-wayland']
export const LINUX_BETA_CATEGORIES = [
  'provenance-and-gates',
  'install-and-payload',
  'first-run-and-accounts',
  'portal-capture',
  'camera-and-microphone',
  'scenes-and-preview',
  'recording-and-storage',
  'audio-and-sync',
  'replay-library-and-export',
  'streaming-and-recovery',
  'companion-and-remotes',
  'performance-and-endurance',
  'security-and-licenses',
  'updates-and-rollback',
  'support-and-production'
]
export const LINUX_BETA_ENCODERS = ['openh264', 'vaapi']
const identityFields = ['releaseId', 'sourceCommit', 'filename', 'sha256', 'sizeBytes']
const sha256Pattern = /^[a-f0-9]{64}$/

export function linuxBetaAcceptanceTemplate(manifest) {
  assertCandidate(manifest)
  return {
    schemaVersion: 1,
    status: 'pending',
    candidate: Object.fromEntries(identityFields.map((key) => [key, manifest[key]])),
    owners: { release: null, acceptance: null, support: null, rollback: null },
    environments: LINUX_BETA_ENVIRONMENTS.map((id) => ({
      id,
      physical: true,
      architecture: 'x64',
      sessionType: 'wayland',
      machine: null,
      operator: null,
      osVersion: null,
      desktopVersion: null,
      kernel: null,
      cpu: null,
      gpu: null,
      ramGiB: null,
      startedAt: null,
      finishedAt: null,
      categories: LINUX_BETA_CATEGORIES.map((id) => ({ id, status: 'pending', evidence: [] })),
      criticalWorkflowFreshPasses: 0,
      previewCycles: 0,
      minimumSpecHours: 0,
      encoders: LINUX_BETA_ENCODERS.map((id) => ({
        id,
        recordCycles: 0,
        recordAndLocalStreamMinutes: 0,
        metrics: null
      })),
      pilot: { startedAt: null, finishedAt: null, sessions: [] }
    }))
  }
}

function assertCandidate(manifest) {
  assertLinuxReleaseManifest(manifest)
  if (manifest.channel !== 'beta')
    throw new Error('Beta acceptance requires a Linux Beta manifest.')
}

// This validates the evidence contract, not the truth of a physical observation.
// Named operators and protected review must verify the cited private reports.
// There is deliberately no waiver, skip, or threshold override.
export function assessLinuxBetaAcceptance(record, manifest, { now = new Date() } = {}) {
  const failures = []
  try {
    assertCandidate(manifest)
  } catch (error) {
    return { ok: false, failures: [error.message] }
  }
  const check = (ok, message) => {
    if (!ok) failures.push(message)
  }
  const named = (value) => typeof value === 'string' && value.trim().length > 0
  const number = (value, min) => Number.isFinite(value) && value >= min
  const stamp = (value) =>
    typeof value === 'string' &&
    Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString() === value
  const period = (start, end, label) => {
    const valid =
      stamp(start) &&
      stamp(end) &&
      Date.parse(start) >= Date.parse(manifest.releasedAt) &&
      Date.parse(end) >= Date.parse(start) &&
      Date.parse(end) <= Number(now)
    check(
      valid,
      `${label}: timestamps must follow the candidate build and must not be in the future`
    )
    return valid ? Date.parse(end) - Date.parse(start) : 0
  }
  const exactRows = (rows, ids, label) => {
    const actual = Array.isArray(rows) ? rows.map((row) => row?.id) : []
    check(
      actual.length === ids.length &&
        new Set(actual).size === ids.length &&
        ids.every((id) => actual.includes(id)),
      `${label}: require exactly ${ids.join(', ')}`
    )
    return Array.isArray(rows) ? rows.filter((row) => row && ids.includes(row.id)) : []
  }
  check(
    record?.schemaVersion === 1 && record?.status === 'pass',
    'record: require schemaVersion=1 and status=pass'
  )
  for (const key of identityFields)
    check(
      record?.candidate?.[key] === manifest[key],
      `candidate: ${key} differs from the immutable candidate`
    )
  for (const role of ['release', 'acceptance', 'support', 'rollback'])
    check(named(record?.owners?.[role]), `owner: missing ${role}`)
  const environments = exactRows(record?.environments, LINUX_BETA_ENVIRONMENTS, 'environments')
  const machineNames = new Set()
  let totalPilotHours = 0
  for (const environment of environments) {
    const label = environment.id
    check(
      environment.physical === true &&
        environment.architecture === 'x64' &&
        environment.sessionType === 'wayland',
      `${label}: physical x64 hardware with a Wayland session required`
    )
    for (const field of [
      'machine',
      'operator',
      'osVersion',
      'desktopVersion',
      'kernel',
      'cpu',
      'gpu'
    ])
      check(named(environment[field]), `${label}: missing ${field}`)
    check(
      !machineNames.has(environment.machine),
      `${label}: require a separate physical acceptance machine`
    )
    machineNames.add(environment.machine)
    check(number(environment.ramGiB, 1), `${label}: missing hardware memory`)
    if (label.startsWith('ubuntu')) {
      check(
        /Ubuntu 24\.04/i.test(environment.osVersion ?? '') &&
          /GNOME/i.test(environment.desktopVersion ?? ''),
        `${label}: require Ubuntu 24.04 and GNOME versions`
      )
    } else {
      check(
        /Omarchy/i.test(environment.osVersion ?? '') &&
          /Hyprland/i.test(environment.desktopVersion ?? ''),
        `${label}: require Omarchy and Hyprland versions`
      )
    }
    period(environment.startedAt, environment.finishedAt, label)
    for (const category of exactRows(
      environment.categories,
      LINUX_BETA_CATEGORIES,
      `${label} categories`
    )) {
      check(category.status === 'pass', `${label}/${category.id}: required category did not pass`)
      check(
        Array.isArray(category.evidence) && category.evidence.length > 0,
        `${label}/${category.id}: missing evidence`
      )
      for (const ref of Array.isArray(category.evidence) ? category.evidence : []) {
        check(
          validEvidenceReference(ref),
          `${label}/${category.id}: unsafe or unhashed evidence reference`
        )
      }
    }
    check(
      Number.isInteger(environment.criticalWorkflowFreshPasses) &&
        environment.criticalWorkflowFreshPasses >= 3,
      `${label}: require three fresh critical workflow passes`
    )
    check(
      Number.isInteger(environment.previewCycles) && environment.previewCycles >= 20,
      `${label}: require 20 preview cycles`
    )
    check(
      number(environment.minimumSpecHours, 4),
      `${label}: require four hours on minimum-spec hardware`
    )
    for (const encoder of exactRows(
      environment.encoders,
      LINUX_BETA_ENCODERS,
      `${label} encoders`
    )) {
      const prefix = `${label}/${encoder.id}`
      check(
        Number.isInteger(encoder.recordCycles) && encoder.recordCycles >= 50,
        `${prefix}: require 50 Record/Stop cycles`
      )
      check(
        number(encoder.recordAndLocalStreamMinutes, 60),
        `${prefix}: require 60 minutes of simultaneous real recording and local streaming`
      )
      const limits = {
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
        shortFinalizeP95Ms: 5000
      }
      for (const [metric, limit] of Object.entries(limits)) {
        const value = encoder.metrics?.[metric]
        check(
          number(value, 0) && value <= limit,
          `${prefix}: ${metric} must be measured and <= ${limit}`
        )
      }
      check(
        number(encoder.metrics?.takeCoverage, 0.98) && encoder.metrics.takeCoverage <= 1,
        `${prefix}: takeCoverage must be >= 0.98 and <= 1`
      )
    }
    const pilot = environment.pilot
    check(
      period(pilot?.startedAt, pilot?.finishedAt, `${label} pilot`) >= 7 * 86400000,
      `${label}: require a seven-day pilot`
    )
    const sessions = Array.isArray(pilot?.sessions) ? pilot.sessions : []
    const testerCounts = new Map()
    const sessionIds = new Set()
    const testerIntervals = new Map()
    for (const session of sessions) {
      if (!session || typeof session !== 'object') {
        check(false, `${label}: malformed pilot session`)
        continue
      }
      check(
        named(session?.id) && !sessionIds.has(session.id),
        `${label}: pilot session IDs must be unique`
      )
      sessionIds.add(session?.id)
      check(named(session?.tester), `${label}: missing pilot tester`)
      const duration = period(session?.startedAt, session?.finishedAt, `${label} pilot session`)
      check(
        duration > 0 &&
          Date.parse(session.startedAt) >= Date.parse(pilot.startedAt) &&
          Date.parse(session.finishedAt) <= Date.parse(pilot.finishedAt),
        `${label}: session must be inside the pilot window`
      )
      check(
        session?.status === 'pass' && validEvidenceReference(session?.evidence),
        `${label}: pilot sessions require passed, hashed evidence`
      )
      const intervals = testerIntervals.get(session?.tester) ?? []
      const from = Date.parse(session?.startedAt),
        to = Date.parse(session?.finishedAt)
      check(
        intervals.every(([start, end]) => to <= start || from >= end),
        `${label}: a tester's pilot sessions cannot overlap`
      )
      intervals.push([from, to])
      testerIntervals.set(session?.tester, intervals)
      testerCounts.set(session?.tester, (testerCounts.get(session?.tester) ?? 0) + 1)
      totalPilotHours += duration / 3600000
    }
    check(
      testerCounts.size >= 3 && [...testerCounts.values()].every((count) => count >= 3),
      `${label}: require at least three testers with three sessions each`
    )
  }
  check(totalPilotHours >= 20, 'pilot: require at least 20 aggregate session hours')
  return { ok: failures.length === 0, failures }
}

export function validEvidenceReference(ref) {
  return (
    typeof ref?.path === 'string' &&
    /^[A-Za-z0-9_./-]+$/.test(ref.path) &&
    !isAbsolute(ref.path) &&
    !ref.path.split('/').some((part) => !part || part === '..' || part === '.') &&
    sha256Pattern.test(ref.sha256 ?? '')
  )
}

export async function verifyLinuxBetaEvidenceFiles(record, evidenceRoot) {
  const root = await realpath(evidenceRoot)
  const verified = new Set()
  async function verify(ref) {
    if (!validEvidenceReference(ref)) throw new Error('Unsafe evidence reference.')
    const path = await realpath(join(root, ref.path))
    const local = relative(root, path)
    if (isAbsolute(local) || local === '..' || local.startsWith(`..${sep}`))
      throw new Error('Evidence symlink escapes the private evidence root.')
    const info = await stat(path)
    if (!info.isFile() || !info.size || (await sha256File(path)) !== ref.sha256)
      throw new Error(`Missing or changed evidence: ${ref.path}`)
    verified.add(ref.path)
    return { path, sizeBytes: info.size }
  }
  for (const environment of record.environments ?? []) {
    const entries = [
      ...(environment.categories ?? []).flatMap((category) =>
        (category.evidence ?? []).map((ref) => ({ ref, categoryId: category.id }))
      ),
      ...(environment.pilot?.sessions ?? []).map((session) => ({ ref: session.evidence, session }))
    ]
    for (const { ref, categoryId, session } of entries) {
      const { path, sizeBytes } = await verify(ref)
      if (sizeBytes > 1024 * 1024)
        throw new Error(
          'Evidence receipt must be JSON under 1 MiB; reference large artifacts by digest.'
        )
      const report = JSON.parse(await readFile(path, 'utf8'))
      if (
        report.schemaVersion !== 1 ||
        report.status !== 'pass' ||
        report.environmentId !== environment.id ||
        identityFields.some((field) => report.candidate?.[field] !== record.candidate?.[field])
      )
        throw new Error(`Evidence does not match the passed candidate/environment: ${ref.path}`)
      const start = Date.parse(report.startedAt),
        end = Date.parse(report.finishedAt)
      if (
        !(
          start >= Date.parse(environment.startedAt) &&
          end >= start &&
          end <= Date.parse(environment.finishedAt)
        )
      )
        throw new Error(`Evidence falls outside acceptance timestamps: ${ref.path}`)
      if (
        categoryId &&
        (!Array.isArray(report.categoryIds) ||
          !report.categoryIds.includes(categoryId) ||
          report.operator !== environment.operator)
      )
        throw new Error(`Evidence does not cover category/operator: ${ref.path}`)
      if (
        session &&
        (report.pilotSessionId !== session.id ||
          report.operator !== session.tester ||
          report.startedAt !== session.startedAt ||
          report.finishedAt !== session.finishedAt)
      )
        throw new Error(`Evidence does not match pilot session: ${ref.path}`)
      if (!Array.isArray(report.artifacts) || report.artifacts.length === 0)
        throw new Error(`Evidence receipt must reference measured artifacts: ${ref.path}`)
      for (const artifact of report.artifacts) await verify(artifact)
    }
  }
  return { verifiedFiles: verified.size }
}
