import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

export const SURFACES = Object.freeze([
  'local',
  'soloCloud',
  'roomStream',
  'roomRecording',
  'hostMonitor',
  'guestReturn',
  'handoff'
])
export const FEATURE_IDS = Object.freeze(
  Object.entries({ A: 10, G: 12, V: 17, O: 18 }).flatMap(([prefix, count]) =>
    Array.from({ length: count }, (_, i) => `${prefix}${i + 1}`)
  )
)
export const SLICE_IDS = Object.freeze([
  'S0',
  'S1',
  'S2',
  'S3',
  'S4',
  'S5',
  'S6',
  'S7a',
  'S7b',
  'S8',
  'S9',
  'S10',
  'S11',
  'S12',
  'S13a',
  'S13b',
  'S14',
  'S15',
  'S16',
  'S17',
  'S18',
  'S19',
  'S20',
  'S21a',
  'S21b',
  'S21c',
  'S22',
  'S23',
  'S24',
  'S25',
  'S26',
  'S27'
])
export const readParityJson = (name) =>
  JSON.parse(
    readFileSync(new URL(`../../protocol-fixtures/cloud-parity-${name}.json`, import.meta.url))
  )

/** Registry completeness is independent of a browser, app, credentials or build. */
export function validateParityRegistry(plan, inventory) {
  assert.equal(plan.schemaVersion, 1)
  assert.equal(inventory.schemaVersion, 1)
  assert.equal(plan.plan, 249)
  assert.equal(inventory.plan, 249)
  assert.deepEqual(
    plan.slices.map((s) => s.id),
    SLICE_IDS
  )
  const prior = new Set(),
    cases = new Set()
  for (const slice of plan.slices) {
    assert.match(slice.id, /^S\d+[abc]?$/)
    assert.ok(!prior.has(slice.id), `Duplicate slice ${slice.id}`)
    assert.ok(
      slice.dependsOn.every((id) => prior.has(id)),
      `${slice.id}: dependency order`
    )
    assert.ok(!cases.has(slice.case), `Duplicate case ${slice.case}`)
    assert.ok(
      slice.repositories.length && slice.repositories.every((r) => ['desktop', 'web'].includes(r))
    )
    assert.ok(slice.gates && slice.deferredReason)
    assert.ok(slice.crossRepoNeeds && slice.intendedPrTitle && slice.intendedBranch)
    for (const repo of slice.repositories) assert.ok(slice.intendedBase[repo])
    for (const key of ['issueUrl', 'prUrl', 'webIssueUrl', 'webPrUrl']) {
      assert.ok(
        slice[key] === null ||
          /^https:\/\/github\.com\/TheOrcDev\/videorc(?:-web)?\/(?:issues|pull)\/\d+$/.test(
            slice[key]
          )
      )
    }
    assert.ok(['not-run', 'failed', 'passed'].includes(slice.acceptance))
    prior.add(slice.id)
    cases.add(slice.case)
  }
  assert.deepEqual(inventory.features.map((f) => f.id).sort(), [...FEATURE_IDS].sort())
  for (const feature of inventory.features) {
    assert.ok(feature.feature && feature.requiredResult)
    assert.ok(
      ['supported', 'partial', 'missing', 'unknown', 'not-applicable'].includes(feature.sourceState)
    )
    assert.equal(typeof feature.productionParityEnabled, 'boolean')
    assert.ok(feature.slices.length && feature.slices.every((id) => prior.has(id)))
    assert.deepEqual(
      feature.cases.sort(),
      plan.slices
        .filter((s) => feature.slices.includes(s.id))
        .map((s) => s.case)
        .sort()
    )
    assert.deepEqual(Object.keys(feature.surfaces).sort(), [...SURFACES].sort())
    for (const surface of Object.values(feature.surfaces)) {
      assert.ok(
        ['supported', 'partial', 'missing', 'unknown', 'not-applicable'].includes(surface.status)
      )
      assert.ok(surface.note)
    }
    for (const lane of ['localLiveKit', 'managed', 'macos', 'windows', 'linux']) {
      assert.ok(['not-run', 'failed', 'passed'].includes(feature.evidence[lane]))
    }
    if (feature.productionParityEnabled) {
      assert.equal(
        feature.evidence.managed,
        'passed',
        `${feature.id}: unqualified production parity`
      )
      assert.equal(feature.evidence.macos, 'passed')
      assert.equal(feature.evidence.windows, 'passed')
    }
  }
  return { slices: prior.size, features: inventory.features.length }
}

export function parseParityArgs(args, plan) {
  const values = args[0] === '--' ? args.slice(1) : args
  assert.equal(values.length, 2, 'Usage: pnpm smoke:cloud-parity -- --case <name>')
  assert.equal(values[0], '--case')
  const slice = plan.slices.find((s) => s.case === values[1])
  assert.ok(slice, `Unknown parity case: ${values[1]}`)
  return slice
}

export function baselineReport(revisions) {
  for (const name of ['desktop', 'web']) assert.match(revisions[name], /^[0-9a-f]{40}$/)
  assert.match(revisions.template, /^v\d+$/)
  return {
    schemaVersion: 1,
    case: 'baseline',
    status: 'not-run',
    revisions,
    scope:
      'Local LiveKit, actual desktop publisher, web program document and guest component. Browser capture is not managed egress qualification.',
    managedAcceptance: 'not-run',
    deviceAcceptance: 'not-run',
    observations: [],
    artifacts: [],
    blockers: [],
    knownSourceGaps: [
      'A1: soundboard has no room publication',
      'G1/G2: avatar/bubble has no room layer'
    ],
    negativeObservations: { soundboard: 'not-run', avatar: 'not-run' }
  }
}

/** Known gaps are observations, never requirements that a future fix stay broken. */
export function finishBaseline(report, measurements) {
  const required = [
    'programCamera',
    'programMicrophone',
    'programCard',
    'programTakeover',
    'guest1Return',
    'guest2Return'
  ]
  report.observations = measurements
  const missing = required.filter(
    (name) => measurements.find((m) => m.name === name)?.passed !== true
  )
  report.blockers.push(...missing.map((name) => `Missing artifact proof: ${name}`))
  for (const name of ['soundboard', 'avatar']) {
    const observed = measurements.find((m) => m.name === name)
    if (!observed || !['present', 'absent'].includes(observed.observed)) {
      report.blockers.push(`Missing negative/positive observation: ${name}`)
    } else report.negativeObservations[name] = observed.observed
  }
  report.status = report.blockers.length ? 'failed' : 'passed'
  return report
}

/** Only loopback test services. No cloud URLs, platform targets or paid egress. */
export function requireLoopback(value, protocols = ['http:', 'https:', 'ws:', 'wss:']) {
  const url = new URL(value)
  assert.ok(
    protocols.includes(url.protocol) && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname),
    'Parity services must use loopback'
  )
  assert.ok(!url.username && !url.password, 'Credentials in addresses are forbidden')
  return url
}

export function redactParityFailure(error, secrets = []) {
  let message = String(error?.message ?? error)
  for (const secret of secrets)
    if (secret) message = message.replaceAll(secret, '(credential withheld)')
  return message
    .replace(/\b(?:https?|wss?):\/\/[^\s"'<>]+/g, '(address withheld)')
    .replace(/eyJ[\w-]+\.[\w-]+\.[\w-]+/g, '(token withheld)')
    .slice(0, 1500)
}
