import assert from 'node:assert/strict'
import test from 'node:test'
import {
  readParityJson,
  validateParityRegistry,
  parseParityArgs,
  baselineReport,
  finishBaseline,
  requireLoopback
} from './cloud-parity-contract.mjs'
import { managedParityGrant } from './fake-cloud-web-managed.mjs'

const plan = readParityJson('plan'),
  inventory = readParityJson('inventory')
const copies = () => [structuredClone(plan), structuredClone(inventory)]
test('all 57 features declare seven surfaces and acceptance owners across 32 ordered slices', () => {
  assert.deepEqual(validateParityRegistry(...copies()), { features: 57, slices: 32 })
  assert.equal(
    plan.slices.every((s) => s.acceptance === 'not-run'),
    true
  )
  assert.equal(
    inventory.features.every((f) => !f.productionParityEnabled && f.evidence.managed === 'not-run'),
    true
  )
})
test('missing/duplicate features, missing surfaces and unmapped cases fail', () => {
  for (const mutate of [
    (p, i) => i.features.pop(),
    (p, i) => i.features.push(i.features[0]),
    (p, i) => delete i.features[0].surfaces.guestReturn,
    (p, i) => i.features[0].cases.push('forgotten'),
    (p, i) => i.features[0].slices.push('S100')
  ]) {
    const input = copies()
    mutate(...input)
    assert.throws(() => validateParityRegistry(...input))
  }
})
test('forward dependency, alias group and unsupported parity promotion fail closed', () => {
  const [p, i] = copies()
  p.slices[0].dependsOn = ['S7']
  assert.throws(() => validateParityRegistry(p, i), /dependency order/)
  p.slices[0].dependsOn = []
  i.features[0].productionParityEnabled = true
  assert.throws(() => validateParityRegistry(p, i), /unqualified production parity/)
})
test('each case has a distinct executable owner and unknown arguments fail', () => {
  for (const slice of plan.slices)
    assert.equal(parseParityArgs(['--', '--case', slice.case], plan).id, slice.id)
  assert.throws(() => parseParityArgs(['--case', 'typo'], plan), /Unknown/)
  assert.throws(() => parseParityArgs(['--case', 'baseline', '--live'], plan), /Usage/)
})
test('unrun baseline never implies measured gaps or managed acceptance', () => {
  const report = baselineReport({
    desktop: plan.desktopRevision,
    web: plan.webRevision,
    template: plan.templateVersion
  })
  assert.equal(report.status, 'not-run')
  assert.deepEqual(report.negativeObservations, { soundboard: 'not-run', avatar: 'not-run' })
  assert.equal(finishBaseline(report, []).status, 'failed')
  assert.equal(report.managedAcceptance, 'not-run')
})
test('a repaired gap cannot make a baseline fail; required paths still need artifact observations', () => {
  for (const observed of ['absent', 'present']) {
    const report = baselineReport({
      desktop: plan.desktopRevision,
      web: plan.webRevision,
      template: 'v1'
    })
    const measured = [
      'programCamera',
      'programMicrophone',
      'programCard',
      'programTakeover',
      'guest1Return',
      'guest2Return'
    ].map((name) => ({ name, passed: true }))
    measured.push({ name: 'soundboard', observed }, { name: 'avatar', observed })
    assert.equal(finishBaseline(report, measured).status, 'passed')
    assert.equal(report.managedAcceptance, 'not-run')
  }
})
test('parity roles mirror production host/guest grants; recorders cannot publish', () => {
  const host = managedParityGrant({ role: 'host', room: 'fixture' })
  assert.deepEqual(host.canPublishSources, [
    'camera',
    'microphone',
    'screen_share',
    'screen_share_audio'
  ])
  const guest = managedParityGrant({ role: 'guest', room: 'fixture' })
  assert.equal(guest.canPublishData, false)
  assert.equal(guest.canUpdateOwnMetadata, false)
  assert.deepEqual(guest.canPublishSources, ['camera', 'microphone'])
  const recorder = managedParityGrant({ role: 'recorder', room: 'fixture' })
  assert.equal(recorder.canPublish, false)
  assert.equal(recorder.canPublishData, false)
  assert.equal(recorder.hidden, true)
  assert.equal(recorder.recorder, true)
  assert.throws(() => managedParityGrant({ role: 'anything', room: 'fixture' }), /Unknown/)
})
test('no production endpoint or credential-bearing URL is admitted', () => {
  for (const value of ['ws://127.0.0.1:1234', 'http://localhost:3333', 'http://[::1]:5555'])
    assert.ok(requireLoopback(value))
  for (const value of [
    'https://videorc.com',
    'wss://test.livekit.cloud',
    'file:///tmp/x',
    'http://localhost.evil',
    'http://secret@localhost'
  ])
    assert.throws(() => requireLoopback(value))
})

test('explicit fixture token roles survive signing without inheriting the legacy host grant', async () => {
  const { startFakeCloudWebManaged } = await import('./fake-cloud-web-managed.mjs')
  const { readLiveKitToken } = await import('./fake-cloud-web.mjs')
  const web = await startFakeCloudWebManaged({
    livekit: { apiKey: 'fixture-key', apiSecret: 'fixture-secret', url: 'ws://127.0.0.1:1' }
  })
  try {
    web.shows.set('fixture', { show: { id: 'fixture' } })
    for (const role of ['host', 'guest', 'recorder']) {
      const claims = readLiveKitToken(
        web.tokenFor('fixture', `${role}-fixture`, role),
        'fixture-secret'
      )
      assert.deepEqual(claims.video, managedParityGrant({ role, room: 'fixture' }))
      assert.equal(claims.exp - claims.nbf, 610)
    }
    const legacy = readLiveKitToken(web.tokenFor('fixture', 'legacy-listener'), 'fixture-secret')
    assert.deepEqual(legacy.video, managedParityGrant({ role: 'host', room: 'fixture' }))
  } finally {
    await web.close()
  }
})

test('failure diagnostics retain actionable errors without publishing credentials', async () => {
  const { redactParityFailure } = await import('./cloud-parity-contract.mjs')
  const text = redactParityFailure(
    new Error(
      'No audio at http://localhost:123/?token=secret123 eyJabc.payload.signature keysecret'
    ),
    ['keysecret']
  )
  assert.match(text, /No audio/)
  assert.ok(!text.includes('secret123') && !text.includes('keysecret') && !text.includes('eyJabc'))
})
