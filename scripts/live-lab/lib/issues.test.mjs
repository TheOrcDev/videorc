import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  ISSUE_LABEL,
  doctorSignature,
  fileSignature,
  findIssueForSignature,
  incidentIssueBody,
  isValidSignature,
  issueTitle,
  listOpenLabIssues,
  parseDoctorFails,
  safeEvidence,
  signatureMarker
} from './issues.mjs'

function fakeGh(handler) {
  const calls = []
  const gh = async (args, options = {}) => {
    calls.push({ args, input: options.input ?? null })
    return handler(args, options) ?? { code: 0, stdout: '', stderr: '' }
  }
  return { gh, calls }
}

test('signatures: valid shapes only, exact markers', () => {
  assert.ok(isValidSignature('stream:noData-while-live'))
  assert.ok(isValidSignature('leak:renderer'))
  assert.ok(isValidSignature('doctor:screen-lock'))
  for (const bad of ['', ' leak', 'a b', 'x-->y', 'a<!--', '-x', 'x'.repeat(101), null]) {
    assert.ok(!isValidSignature(bad), String(bad))
  }
  assert.equal(signatureMarker('leak:renderer'), '<!-- live-lab-signature: leak:renderer -->')
  const issues = [
    { number: 1, body: `${signatureMarker('leak:renderer-gpu')}\nother` },
    { number: 2, body: `intro\n${signatureMarker('leak:renderer')}` }
  ]
  assert.equal(findIssueForSignature(issues, 'leak:renderer').number, 2)
  assert.equal(findIssueForSignature(issues, 'leak:main'), null)
})

test('titles are one line and capped; evidence keeps only safe relative names', () => {
  const title = issueTitle('leak:renderer', `line one\nline two ${'x'.repeat(300)}`)
  assert.ok(title.startsWith('[live-lab] leak:renderer: line one line two'))
  assert.ok(title.length <= 120)
  assert.deepEqual(
    safeEvidence(['census.csv', 'charts/a.png', '../etc/passwd', '/abs', 'a b', 4]),
    ['census.csv', 'charts/a.png']
  )
})

test('the issue body carries the marker, the run and evidence links', () => {
  const body = incidentIssueBody({
    incident: {
      signature: 'leak:renderer',
      severity: 'P1',
      summary: 'RSS grew',
      evidence: ['charts/rss.png', 'census.csv']
    },
    run: {
      runId: '2026-10-12-chat-a1b2c3',
      scenario: 'chat',
      trigger: 'schedule',
      outcome: 'warn',
      build: { source: 'release', version: '0.9.141', sha: 'abc1234' }
    },
    links: {
      report: 'https://github.com/o/r/blob/main/runs/x/report.md',
      file: (name) => (name.endsWith('.png') ? `https://x/${name}` : null)
    }
  })
  assert.ok(body.startsWith(signatureMarker('leak:renderer')))
  assert.match(
    body,
    /`2026-10-12-chat-a1b2c3`, scenario `chat`, schedule, release 0\.9\.141 \(abc1234\)/
  )
  assert.match(body, /\[charts\/rss\.png\]\(https:\/\/x\/charts\/rss\.png\)/)
  assert.match(body, /`census\.csv` \(lab run folder only\)/)
})

test('fileSignature comments on the open issue with that signature', async () => {
  const { gh, calls } = fakeGh(() => ({ code: 0, stdout: '' }))
  const issues = [
    {
      number: 41,
      url: 'https://github.com/TheOrcDev/videorc/issues/41',
      body: signatureMarker('leak:renderer')
    }
  ]
  const result = await fileSignature({
    gh,
    issues,
    signature: 'leak:renderer',
    title: 't',
    body: 'b',
    comment: 'seen again',
    labelReady: () => assert.fail('no label work when commenting')
  })
  assert.deepEqual(result, { action: 'commented', number: 41, url: issues[0].url })
  assert.deepEqual(calls, [
    {
      args: ['issue', 'comment', '41', '--repo', 'TheOrcDev/videorc', '--body-file', '-'],
      input: 'seen again'
    }
  ])
})

test('fileSignature creates a labeled issue when none is open, then comments on a repeat', async () => {
  const { gh, calls } = fakeGh((args) =>
    args[1] === 'create'
      ? { code: 0, stdout: 'https://github.com/TheOrcDev/videorc/issues/77\n' }
      : { code: 0 }
  )
  const issues = []
  const body = `${signatureMarker('stream:noData-while-live')}\nbody`
  const first = await fileSignature({
    gh,
    issues,
    signature: 'stream:noData-while-live',
    title: 'T',
    body,
    comment: 'c',
    labelReady: async () => true
  })
  assert.deepEqual(first, {
    action: 'created',
    number: 77,
    url: 'https://github.com/TheOrcDev/videorc/issues/77',
    labeled: true
  })
  assert.deepEqual(calls[0], {
    args: [
      'issue',
      'create',
      '--repo',
      'TheOrcDev/videorc',
      '--title',
      'T',
      '--body-file',
      '-',
      '--label',
      ISSUE_LABEL
    ],
    input: body
  })
  const second = await fileSignature({
    gh,
    issues,
    signature: 'stream:noData-while-live',
    title: 'T',
    body,
    comment: 'again',
    labelReady: true
  })
  assert.equal(second.action, 'commented')
  assert.equal(second.number, 77)
})

test('fileSignature falls back to no label when the label cannot be used', async () => {
  let attempt = 0
  const { gh, calls } = fakeGh((args) => {
    if (args[1] !== 'create') return { code: 0 }
    attempt += 1
    return attempt === 1
      ? { code: 1, stderr: "could not add label: 'live-lab' not found" }
      : { code: 0, stdout: 'https://github.com/TheOrcDev/videorc/issues/9' }
  })
  const result = await fileSignature({
    gh,
    issues: [],
    signature: 'leak:main',
    title: 'T',
    body: 'B',
    comment: 'C',
    labelReady: true
  })
  assert.equal(result.labeled, false)
  assert.ok(calls[0].args.includes('--label'))
  assert.ok(!calls[1].args.includes('--label'))
  assert.equal(calls[1].input, 'B')
})

test('listOpenLabIssues reads JSON and treats a missing label as no issues', async () => {
  const ok = fakeGh(() => ({ code: 0, stdout: '[{"number":3,"body":"x","title":"t","url":"u"}]' }))
  assert.equal((await listOpenLabIssues({ gh: ok.gh }))[0].number, 3)
  assert.ok(ok.calls[0].args.includes('--label') && ok.calls[0].args.includes(ISSUE_LABEL))
  const missing = fakeGh(() => ({
    code: 1,
    stderr: "could not find label 'live-lab'... label not found"
  }))
  assert.deepEqual(await listOpenLabIssues({ gh: missing.gh }), [])
  const broken = fakeGh(() => ({ code: 4, stderr: 'HTTP 401: Bad credentials' }))
  await assert.rejects(listOpenLabIssues({ gh: broken.gh }), /issue list failed \(exit 4\)/)
})

test('doctor output: FAIL lines become doctor:<check> signatures', () => {
  const text = [
    'PASS  config                 ~/.videorc-live-lab/config.json is 0600.',
    'FAIL  screen lock            Screen lock is on. Turn it off in System Settings.',
    'WARN  lab quota today        7900 of 8000 units.',
    'FAIL  display sleep          displaysleep is 10, must be 0.',
    '',
    'Lab NOT ready: 1 pass, 1 warn, 2 fail, 0 skip.'
  ].join('\n')
  assert.deepEqual(parseDoctorFails(text), [
    { check: 'screen lock', detail: 'Screen lock is on. Turn it off in System Settings.' },
    { check: 'display sleep', detail: 'displaysleep is 10, must be 0.' }
  ])
  assert.equal(doctorSignature('screen lock'), 'doctor:screen-lock')
  assert.equal(doctorSignature('No Developer ID key!'), 'doctor:no-developer-id-key')
})
