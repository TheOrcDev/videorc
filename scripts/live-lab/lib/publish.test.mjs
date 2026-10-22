import assert from 'node:assert/strict'
import { access, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import {
  buildP0Message,
  p0Incidents,
  postDiscord,
  validateWebhookUrl,
  webhookUrlFrom
} from './discord.mjs'
import { signatureMarker } from './issues.mjs'
import {
  PUBLISHED_FILE,
  createPublishContext,
  doctorFileTime,
  findRunsToPublish,
  gitBlobSha,
  publishAll,
  pushFile,
  reportFileUrl,
  updateVodDescription
} from './publish.mjs'
import { QuotaRefused } from './quota-ledger.mjs'

// The live lab runs on macOS only (launchd, pf, codesign, POSIX paths and modes).
const macOnly = { skip: process.platform === 'win32' && 'the live lab runs on macOS only' }

const RUN_ID = '2026-10-12-chat-a1b2c3'
const POLICY = {
  killSwitchUrl:
    'https://raw.githubusercontent.com/TheOrcDev/videorc-live-lab-reports/main/control.json'
}
const TARGET = {
  owner: 'TheOrcDev',
  repo: 'videorc-live-lab-reports',
  ref: 'main',
  name: 'TheOrcDev/videorc-live-lab-reports'
}
const WEBHOOK = `https://discord.com/api/${'webhooks'}/123456/${'t'.repeat(30)}`
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

const fakeRedactor = {
  async assertPublishable(paths) {
    for (const path of paths) {
      if ((await readFile(path, 'utf8')).includes('U9-HIT')) {
        throw Object.assign(new Error('REDACTION_FAILED'), { code: 'REDACTION_FAILED' })
      }
    }
  },
  findSensitive: (text) => (text.includes('U9-HIT') ? [{ pattern: 'u9', index: 0 }] : [])
}

function verdictFor(runId = RUN_ID, overrides = {}) {
  return {
    schema: 1,
    runId,
    scenario: 'chat',
    trigger: 'schedule',
    privacy: 'unlisted',
    build: { source: 'release', version: '0.9.141', sha: 'abc1234' },
    startedAt: '2026-10-12T06:00:00.000Z',
    endedAt: '2026-10-12T07:00:00.000Z',
    outcome: 'fail',
    thresholdsMode: 'report',
    signals: [],
    incidents: [
      {
        signature: 'stream:noData-while-live',
        severity: 'P0',
        summary: 'YouTube got no data while the app said On air',
        firstAt: '2026-10-12T06:20:00.000Z',
        evidence: ['observer.ndjson']
      },
      {
        signature: 'leak:renderer',
        severity: 'P1',
        summary: 'Renderer RSS grew 40 MB/h',
        evidence: ['charts/rss-renderer.png']
      }
    ],
    needsEyes: [],
    quota: { labUnits: 300, bundledUnits: 0 },
    vod: { videoId: 'abcdefghijk', url: 'https://www.youtube.com/watch?v=abcdefghijk' },
    ...overrides
  }
}

async function workDir(t) {
  const dir = await mkdtemp(join(tmpdir(), 'live-publish-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  return dir
}

async function writeRun(
  work,
  {
    runId = RUN_ID,
    verdict = verdictFor(runId),
    report = '# Report\n\nOutcome: fail.\n',
    published = null
  } = {}
) {
  const dir = join(work, 'runs', runId)
  await mkdir(join(dir, 'charts'), { recursive: true })
  await writeFile(join(dir, 'verdict.json'), JSON.stringify(verdict, null, 2))
  if (report !== null) await writeFile(join(dir, 'report.md'), report)
  await writeFile(join(dir, 'charts', 'rss-renderer.png'), PNG)
  await writeFile(join(dir, 'census.csv'), 'never,published\n')
  await writeFile(join(dir, 'observer.ndjson'), '{}\n')
  if (published) await writeFile(join(dir, PUBLISHED_FILE), JSON.stringify(published))
  return dir
}

function fakeGh({ openIssues = [], existing = {}, fail = () => null } = {}) {
  const calls = []
  const repoFiles = new Map(Object.entries(existing))
  let nextIssue = 100
  const gh = async (args, { input } = {}) => {
    calls.push({ args, input: input ?? null })
    const failure = fail(args, calls)
    if (failure) return failure
    if (args[0] === 'api' && args[1] === '--method' && args[2] === 'PUT') {
      const body = JSON.parse(input)
      const path = decodeURIComponent(args[3].split('/contents/')[1])
      repoFiles.set(path, gitBlobSha(Buffer.from(body.content, 'base64')))
      return { code: 0, stdout: '{}', stderr: '' }
    }
    if (args[0] === 'api') {
      const path = decodeURIComponent(args[1].split('/contents/')[1].split('?')[0])
      return repoFiles.has(path)
        ? { code: 0, stdout: `${repoFiles.get(path)}\n`, stderr: '' }
        : { code: 1, stdout: '', stderr: 'gh: Not Found (HTTP 404)' }
    }
    if (args[0] === 'issue' && args[1] === 'list')
      return { code: 0, stdout: JSON.stringify(openIssues), stderr: '' }
    if (args[0] === 'label') return { code: 0, stdout: '', stderr: '' }
    if (args[0] === 'issue' && args[1] === 'create') {
      nextIssue += 1
      return {
        code: 0,
        stdout: `https://github.com/TheOrcDev/videorc/issues/${nextIssue}\n`,
        stderr: ''
      }
    }
    if (args[0] === 'issue' && args[1] === 'comment') return { code: 0, stdout: '', stderr: '' }
    return { code: 9, stdout: '', stderr: `unexpected gh ${args.join(' ')}` }
  }
  return { gh, calls, repoFiles }
}

function fakeYoutube({ channelId = 'UCLAB', description = 'Lab stream.' } = {}) {
  const calls = []
  const client = {
    async call(request) {
      calls.push(request)
      if (request.method === 'videos.list') {
        return {
          items: [
            {
              id: 'abcdefghijk',
              snippet: {
                channelId,
                title: 'Automated test chat',
                description,
                categoryId: '28',
                tags: ['lab']
              }
            }
          ]
        }
      }
      return { id: 'abcdefghijk' }
    }
  }
  return { client, calls, ledger: { canSpend: () => true } }
}

function context(overrides = {}) {
  const out = []
  const discord = []
  const youtube = fakeYoutube()
  const ctx = createPublishContext({
    gh: overrides.gh,
    redactor: 'redactor' in overrides ? overrides.redactor : fakeRedactor,
    policy: 'policy' in overrides ? overrides.policy : POLICY,
    webhookUrl: 'webhookUrl' in overrides ? overrides.webhookUrl : WEBHOOK,
    postDiscord: async (message) => discord.push(message),
    youtube: async () => ({ client: youtube.client, ledger: youtube.ledger, channelId: 'UCLAB' }),
    now: () => new Date('2026-10-12T13:30:00.000Z'),
    dryRun: overrides.dryRun ?? false,
    print: (line) => out.push(line),
    printErr: (line) => out.push(line)
  })
  return { ctx, out, discord, youtube }
}

async function exists(path) {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

test(
  'a run publishes files, files issues (dedupe), pings Discord on P0, links the VOD and writes published.json 0600',
  macOnly,
  async (t) => {
    const work = await workDir(t)
    const runDir = await writeRun(work)
    const openIssues = [
      {
        number: 41,
        url: 'https://github.com/TheOrcDev/videorc/issues/41',
        title: 'x',
        body: `${signatureMarker('leak:renderer')}\nolder`
      }
    ]
    const github = fakeGh({ openIssues })
    const { ctx, out, discord, youtube } = context({ gh: github.gh })

    assert.equal(await publishAll(ctx, { workDir: work }), 0)

    // Reports repo: only report.md, verdict.json and the PNG, base64 over stdin.
    const puts = github.calls.filter((call) => call.args[2] === 'PUT')
    assert.deepEqual(
      puts.map((call) => call.args[3]),
      ['report.md', 'verdict.json', 'charts/rss-renderer.png'].map(
        (rel) => `repos/TheOrcDev/videorc-live-lab-reports/contents/runs/${RUN_ID}/${rel}`
      )
    )
    const firstPut = JSON.parse(puts[0].input)
    assert.equal(firstPut.branch, 'main')
    assert.equal(firstPut.sha, undefined)
    assert.equal(Buffer.from(firstPut.content, 'base64').toString(), '# Report\n\nOutcome: fail.\n')
    assert.ok(!github.calls.some((call) => call.args.join(' ').includes('census.csv')))

    // Issues: leak:renderer is open (#41) -> comment; the P0 is new -> create with label.
    const comment = github.calls.find(
      (call) => call.args[0] === 'issue' && call.args[1] === 'comment'
    )
    assert.deepEqual(comment.args.slice(0, 3), ['issue', 'comment', '41'])
    assert.match(comment.input, /Seen again: `2026-10-12-chat-a1b2c3`/)
    assert.match(comment.input, new RegExp(`runs/${RUN_ID}/report\\.md`))
    const create = github.calls.find(
      (call) => call.args[0] === 'issue' && call.args[1] === 'create'
    )
    assert.ok(create.args.includes('--label'))
    assert.equal(
      create.args[create.args.indexOf('--title') + 1],
      '[live-lab] stream:noData-while-live: YouTube got no data while the app said On air'
    )
    assert.ok(create.input.startsWith(signatureMarker('stream:noData-while-live')))
    assert.match(create.input, /`observer\.ndjson` \(lab run folder only\)/)
    assert.ok(github.calls.some((call) => call.args[0] === 'label'))

    // Discord once, for the P0, with the new issue link.
    assert.equal(discord.length, 1)
    assert.equal(discord[0].webhookUrl, WEBHOOK)
    assert.match(discord[0].content, /stream:noData-while-live/)
    assert.match(discord[0].content, /issues\/101/)
    assert.doesNotMatch(discord[0].content, /leak:renderer/)

    // VOD: list (1) + update (50), report link appended, snippet kept.
    assert.deepEqual(
      youtube.calls.map((call) => call.method),
      ['videos.list', 'videos.update']
    )
    const update = youtube.calls[1]
    assert.equal(update.httpMethod, 'PUT')
    assert.equal(
      update.body.snippet.description,
      `Lab stream.\n\nAutomated test report: ${reportFileUrl(TARGET, RUN_ID, 'report.md')}`
    )
    assert.deepEqual(update.body.snippet.tags, ['lab'])

    const published = JSON.parse(await readFile(join(runDir, PUBLISHED_FILE), 'utf8'))
    assert.equal(published.complete, true)
    assert.equal(published.reportsRepo, 'TheOrcDev/videorc-live-lab-reports@main')
    assert.equal(published.issues['leak:renderer'].action, 'commented')
    assert.equal(published.issues['stream:noData-while-live'].action, 'created')
    assert.equal(published.discord.sent, true)
    assert.equal(published.vod.status, 'updated')
    assert.equal((await stat(join(runDir, PUBLISHED_FILE))).mode & 0o777, 0o600)
    assert.match(out.join('\n'), /published$/m)

    // Idempotent: a second publish finds nothing to do and calls nothing.
    const again = fakeGh({ openIssues })
    const second = context({ gh: again.gh })
    assert.equal(await publishAll(second.ctx, { workDir: work }), 0)
    assert.deepEqual(again.calls, [])
    assert.equal(second.discord.length, 0)
  }
)

test('Discord is pinged only on a P0', async (t) => {
  const work = await workDir(t)
  const verdict = verdictFor(RUN_ID, {
    incidents: [
      { signature: 'leak:renderer', severity: 'P1', summary: 'slow growth', evidence: [] }
    ],
    vod: null
  })
  await writeRun(work, { verdict })
  const github = fakeGh()
  const { ctx, discord } = context({ gh: github.gh })
  assert.equal(await publishAll(ctx, { workDir: work }), 0)
  assert.equal(discord.length, 0)
  assert.equal(p0Incidents(verdict).length, 0)
  assert.equal(buildP0Message(verdict), null)
})

test('a P0 with no webhook configured is recorded, not fatal', async (t) => {
  const work = await workDir(t)
  const runDir = await writeRun(work, { verdict: verdictFor(RUN_ID, { vod: null }) })
  const { ctx, discord } = context({ gh: fakeGh().gh, webhookUrl: null })
  assert.equal(await publishAll(ctx, { workDir: work }), 0)
  assert.equal(discord.length, 0)
  const published = JSON.parse(await readFile(join(runDir, PUBLISHED_FILE), 'utf8'))
  assert.deepEqual(published.discord, { sent: false, reason: 'no webhook configured' })
})

test('the guard refusing any file publishes nothing of that run', async (t) => {
  for (const report of [
    `# Report\nviewer ${['someone', 'example.com'].join('@')}\n`,
    '# Report\nU9-HIT\n'
  ]) {
    const work = await workDir(t)
    const runDir = await writeRun(work, { report })
    const github = fakeGh()
    const { ctx, out, discord } = context({ gh: github.gh })
    assert.equal(await publishAll(ctx, { workDir: work }), 1)
    assert.deepEqual(github.calls, [])
    assert.equal(discord.length, 0)
    assert.equal(await exists(join(runDir, PUBLISHED_FILE)), false)
    assert.match(
      out.join('\n'),
      /REDACTION_FAILED: nothing of this run was published \((?:.*report\.md|.*assertPublishable refused)/
    )
    assert.doesNotMatch(out.join('\n'), /example\.com/)
  }
})

test('without the U9 redaction module nothing is published', async (t) => {
  const work = await workDir(t)
  await writeRun(work)
  const github = fakeGh()
  const { ctx, out } = context({ gh: github.gh, redactor: null })
  assert.equal(await publishAll(ctx, { workDir: work }), 1)
  assert.deepEqual(github.calls, [])
  assert.match(out.join('\n'), /REDACTION_UNAVAILABLE/)
})

test('an incident summary with a secret shape never reaches an issue', async (t) => {
  const work = await workDir(t)
  const key = ['abcd', 'efgh', 'ijkl', 'mnop', 'qrst'].join('-')
  // The verdict file guard refuses it first; either way no issue is filed.
  const verdict = verdictFor(RUN_ID, {
    incidents: [
      { signature: 'stream:key-leak', severity: 'P1', summary: `key ${key}`, evidence: [] }
    ],
    vod: null
  })
  await writeRun(work, { verdict })
  const github = fakeGh()
  const { ctx } = context({ gh: github.gh })
  assert.equal(await publishAll(ctx, { workDir: work }), 1)
  assert.ok(!github.calls.some((call) => call.args[0] === 'issue' && call.args[1] === 'create'))
})

test('--dry-run prints the issue it would open and touches nothing', async (t) => {
  const work = await workDir(t)
  const runDir = await writeRun(work)
  const gh = async () => assert.fail('no gh call in a dry run')
  const { ctx, out, discord, youtube } = context({ gh, dryRun: true })
  assert.equal(await publishAll(ctx, { workDir: work }), 0)
  const text = out.join('\n')
  assert.match(text, /\[dry-run\] 2026-10-12-chat-a1b2c3: guard passed on 3 file\(s\)/)
  assert.match(
    text,
    /would push runs\/2026-10-12-chat-a1b2c3\/report\.md to TheOrcDev\/videorc-live-lab-reports@main/
  )
  assert.match(
    text,
    /else open "\[live-lab\] stream:noData-while-live: YouTube got no data while the app said On air"/
  )
  assert.match(text, /<!-- live-lab-signature: stream:noData-while-live -->/)
  assert.match(text, /would post to Discord/)
  assert.match(text, /would add the report link to the description of VOD abcdefghijk/)
  assert.match(text, /would write published\.json/)
  assert.equal(discord.length, 0)
  assert.equal(youtube.calls.length, 0)
  assert.equal(await exists(join(runDir, PUBLISHED_FILE)), false)
})

test('a publish that dies half way resumes without pushing or filing twice', async (t) => {
  const work = await workDir(t)
  const runDir = await writeRun(work, { verdict: verdictFor(RUN_ID, { vod: null }) })
  // First attempt: the second issue create fails.
  let creates = 0
  const first = fakeGh({
    fail: (args) => {
      if (args[0] === 'issue' && args[1] === 'create') {
        creates += 1
        if (creates === 2) return { code: 1, stdout: '', stderr: 'HTTP 502' }
      }
      return null
    }
  })
  const one = context({ gh: first.gh })
  assert.equal(await publishAll(one.ctx, { workDir: work }), 1)
  const partial = JSON.parse(await readFile(join(runDir, PUBLISHED_FILE), 'utf8'))
  assert.equal(partial.complete, false)
  assert.equal(partial.files.length, 3)
  assert.deepEqual(Object.keys(partial.issues), ['stream:noData-while-live'])

  const second = fakeGh()
  const two = context({ gh: second.gh })
  assert.equal(await publishAll(two.ctx, { workDir: work }), 0)
  assert.ok(!second.calls.some((call) => call.args[2] === 'PUT'), 'no file pushed again')
  const created = second.calls.filter(
    (call) => call.args[0] === 'issue' && call.args[1] === 'create'
  )
  assert.equal(created.length, 1)
  assert.match(created[0].args[created[0].args.indexOf('--title') + 1], /leak:renderer/)
  const done = JSON.parse(await readFile(join(runDir, PUBLISHED_FILE), 'utf8'))
  assert.equal(done.complete, true)
  assert.ok(!done.warnings.some((warning) => warning.startsWith('stopped: ')))
})

test('findRunsToPublish: verdict required, complete published.json skipped, --since filters', async (t) => {
  const work = await workDir(t)
  await writeRun(work, {
    runId: '2026-10-11-idle-aaaaaa',
    verdict: { ...verdictFor('2026-10-11-idle-aaaaaa'), endedAt: '2026-10-11T13:00:00.000Z' }
  })
  await writeRun(work, { runId: '2026-10-12-chat-bbbbbb', published: { complete: true } })
  await writeRun(work, {
    runId: '2026-10-12-churn-cccccc',
    published: { complete: false, issues: {} }
  })
  await mkdir(join(work, 'runs', '2026-10-12-dry-dddddd'), { recursive: true })
  await mkdir(join(work, 'runs', 'not-a-run'), { recursive: true })
  const all = await findRunsToPublish({ runsDir: join(work, 'runs') })
  assert.deepEqual(
    all.runs.map((run) => run.runId),
    ['2026-10-11-idle-aaaaaa', '2026-10-12-churn-cccccc']
  )
  const recent = await findRunsToPublish({
    runsDir: join(work, 'runs'),
    since: '2026-10-12T00:00:00.000Z'
  })
  assert.deepEqual(
    recent.runs.map((run) => run.runId),
    ['2026-10-12-churn-cccccc']
  )
  await assert.rejects(
    findRunsToPublish({ runsDir: join(work, 'runs'), since: 'yesterday' }),
    /ISO/
  )
  const one = await findRunsToPublish({
    runsDir: null,
    only: join(work, 'runs', '2026-10-12-dry-dddddd')
  })
  assert.deepEqual(one.runs, [])
  assert.match(one.warnings[0], /no verdict\.json yet/)
})

test('pushFile updates with the existing sha and skips unchanged content', async () => {
  const content = Buffer.from('hello\n')
  const same = fakeGh({ existing: { 'runs/x/a.md': gitBlobSha(content) } })
  assert.equal(
    (
      await pushFile({
        gh: same.gh,
        target: TARGET,
        repoPath: 'runs/x/a.md',
        content,
        message: 'm'
      })
    ).action,
    'unchanged'
  )
  assert.equal(same.calls.length, 1)
  const other = fakeGh({ existing: { 'runs/x/a.md': 'f'.repeat(40) } })
  const result = await pushFile({
    gh: other.gh,
    target: TARGET,
    repoPath: 'runs/x/a.md',
    content,
    message: 'm'
  })
  assert.equal(result.action, 'updated')
  assert.equal(JSON.parse(other.calls[1].input).sha, 'f'.repeat(40))
  // git's blob sha for "hello\n".
  assert.equal(gitBlobSha(content), 'ce013625030ba8dba906f756967f9e9ca394464a')
  const broken = fakeGh({ fail: () => ({ code: 1, stdout: '', stderr: 'HTTP 403: forbidden' }) })
  await assert.rejects(
    pushFile({ gh: broken.gh, target: TARGET, repoPath: 'runs/x/a.md', content, message: 'm' }),
    /lookup failed/
  )
})

test('updateVodDescription skips on quota, another channel, or an existing link', async () => {
  const url = reportFileUrl(TARGET, RUN_ID, 'report.md')
  const base = fakeYoutube()
  assert.deepEqual(
    await updateVodDescription({
      youtube: base.client,
      ledger: { canSpend: () => false },
      channelId: 'UCLAB',
      videoId: 'abcdefghijk',
      reportUrl: url
    }),
    { status: 'skipped', reason: 'lab quota would be exceeded' }
  )
  assert.equal(base.calls.length, 0)
  const foreign = fakeYoutube({ channelId: 'UCOTHER' })
  assert.equal(
    (
      await updateVodDescription({
        youtube: foreign.client,
        channelId: 'UCLAB',
        videoId: 'abcdefghijk',
        reportUrl: url
      })
    ).reason,
    'video is not on the lab channel'
  )
  const linked = fakeYoutube({ description: `x\n${url}` })
  assert.equal(
    (
      await updateVodDescription({
        youtube: linked.client,
        channelId: 'UCLAB',
        videoId: 'abcdefghijk',
        reportUrl: url
      })
    ).reason,
    'already linked'
  )
  const refusing = {
    call: async () => {
      throw new QuotaRefused({
        method: 'videos.update',
        units: 50,
        spent: 7990,
        max: 8000,
        day: '2026-10-12'
      })
    }
  }
  assert.deepEqual(
    await updateVodDescription({
      youtube: refusing,
      channelId: 'UCLAB',
      videoId: 'abcdefghijk',
      reportUrl: url
    }),
    { status: 'skipped', reason: 'lab quota refused' }
  )
  assert.equal(
    (await updateVodDescription({ youtube: base.client, videoId: 'bad id', reportUrl: url }))
      .reason,
    'bad video id'
  )
})

test(
  'boot doctor FAILs become doctor:<check> issues once, with home paths withheld',
  macOnly,
  async (t) => {
    const work = await workDir(t)
    await mkdir(join(work, 'doctor'), { recursive: true })
    const home = ['', 'Users', 'videorc-lab', '.videorc-live-lab', 'config.json'].join('/')
    const text = [
      'PASS  auto-login             videorc-lab logs in automatically.',
      'FAIL  screen lock            Screen lock is on. Turn it off.',
      `FAIL  config                 ${home} is missing. Run pnpm live:hookup.`,
      'Lab NOT ready: 1 pass, 0 warn, 2 fail, 0 skip.'
    ].join('\n')
    const file = join(work, 'doctor', 'boot-2026-10-12T03-35-00-000Z.txt')
    await writeFile(file, text)
    await writeFile(
      join(work, 'doctor', 'boot-2026-10-01T03-35-00-000Z.txt'),
      'FAIL  old                    old\n'
    )
    const openIssues = [
      { number: 5, url: 'u5', title: 't', body: signatureMarker('doctor:screen-lock') }
    ]
    const github = fakeGh({ openIssues })
    const { ctx } = context({ gh: github.gh })
    assert.equal(await publishAll(ctx, { workDir: work, since: '2026-10-12T00:00:00.000Z' }), 0)
    const comment = github.calls.find(
      (call) => call.args[0] === 'issue' && call.args[1] === 'comment'
    )
    assert.equal(comment.args[2], '5')
    assert.match(comment.input, /Screen lock is on/)
    const create = github.calls.find(
      (call) => call.args[0] === 'issue' && call.args[1] === 'create'
    )
    assert.equal(
      create.args[create.args.indexOf('--title') + 1],
      '[live-lab] doctor:config: FAIL after boot'
    )
    assert.match(create.input, /detail withheld/)
    assert.ok(
      !github.calls.some((call) => `${call.input}${call.args.join(' ')}`.includes('/Users/'))
    )
    assert.ok(!github.calls.some((call) => `${call.input}`.includes('old')))
    const sidecar = JSON.parse(await readFile(file.replace(/\.txt$/, '.published.json'), 'utf8'))
    assert.equal(sidecar.complete, true)
    assert.equal((await stat(file.replace(/\.txt$/, '.published.json'))).mode & 0o777, 0o600)

    const again = fakeGh({ openIssues })
    const second = context({ gh: again.gh })
    assert.equal(
      await publishAll(second.ctx, { workDir: work, since: '2026-10-12T00:00:00.000Z' }),
      0
    )
    assert.deepEqual(again.calls, [])
    assert.equal(
      doctorFileTime('boot-2026-10-12T03-35-00-000Z.txt'),
      Date.parse('2026-10-12T03:35:00.000Z')
    )
    assert.equal(doctorFileTime('boot-x.txt'), null)
  }
)

test('discord: webhook from config, else env; validated and never echoed', async () => {
  assert.equal(webhookUrlFrom({ discord: { webhookUrl: WEBHOOK } }, {}), WEBHOOK)
  assert.equal(webhookUrlFrom(null, { VIDEORC_LIVE_LAB_DISCORD_WEBHOOK: ` ${WEBHOOK} ` }), WEBHOOK)
  assert.equal(webhookUrlFrom(null, {}), null)
  assert.throws(
    () => validateWebhookUrl('https://evil.test/hook'),
    (error) => !error.message.includes('evil')
  )
  const sent = []
  await postDiscord({
    webhookUrl: WEBHOOK,
    content: 'hi',
    fetchImpl: async (url, init) => {
      sent.push({ url, body: JSON.parse(init.body) })
      return { ok: true, status: 204 }
    }
  })
  assert.deepEqual(sent[0].body, { content: 'hi', flags: 4, allowed_mentions: { parse: [] } })
  await assert.rejects(
    postDiscord({
      webhookUrl: WEBHOOK,
      content: 'x',
      fetchImpl: async () => ({ ok: false, status: 429 })
    }),
    (error) => error.message === 'Discord webhook returned HTTP 429'
  )
})
