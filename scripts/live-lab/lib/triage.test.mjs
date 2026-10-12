import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { runLockPath } from './run-lock.mjs'
import {
  CLAUDE_TOOLS,
  DISALLOWED_TOOLS,
  ENV_FIXED,
  ISSUES_REPO,
  PUBLISHED_FILE,
  RESULT_SCHEMA,
  SETTINGS_PATH,
  SKILL_PATH,
  TRIAGED_FILE,
  buildClaudeArgs,
  buildPrompt,
  checkCanTriage,
  childEnv,
  commentBody,
  findRunsToTriage,
  issueNumbersFrom,
  localFindSensitive,
  localRedactText,
  modelPermission,
  parseClaudeResult,
  triageRun,
  triageSection,
  validateComments,
  verdictSummary
} from './triage.mjs'

const settings = JSON.parse(await readFile(SETTINGS_PATH, 'utf8'))
const skillText = await readFile(SKILL_PATH, 'utf8')

// Everything the agent must never have. Each one must be denied in the
// settings file AND removed on the command line.
const MUST_DENY_TOOLS = [
  'Bash',
  'Edit',
  'Write',
  'MultiEdit',
  'NotebookEdit',
  'WebFetch',
  'WebSearch',
  'Agent',
  'Skill'
]
const MUST_DENY_COMMANDS = [
  'ssh:*',
  'scp:*',
  'curl:*',
  'git push:*',
  'git commit:*',
  'gh issue create:*',
  'gh issue comment:*',
  'gh pr:*',
  'gh workflow:*',
  'node:*',
  'pnpm:*',
  'launchctl:*',
  'sudo:*',
  'rm:*',
  'open:*',
  'live:*',
  'cat:*',
  'kill:*',
  'pgrep:*'
]
const MUST_DENY_READS = [
  '~/.videorc-live-lab/**',
  '~/.ssh/**',
  '~/.config/**',
  '~/.claude/**',
  '~/Library/**',
  '//Library/Keychains/**',
  '.env',
  'config.json',
  '**/clips/**'
]

async function freshDir() {
  return mkdtemp(join(tmpdir(), 'live-lab-triage-'))
}

function verdict(overrides = {}) {
  return {
    schema: 1,
    runId: '2026-10-12-chat-a1b2c3',
    scenario: 'chat',
    trigger: 'schedule',
    privacy: 'unlisted',
    build: { source: 'release', version: '0.9.141', sha: 'abc1234' },
    startedAt: '2026-10-12T04:30:00Z',
    endedAt: '2026-10-12T05:45:00Z',
    outcome: 'fail',
    thresholdsMode: 'report',
    signals: [
      { id: 'leak:renderer', status: 'pass', severity: null, signature: null, summary: 'flat' },
      {
        id: 'stream:data',
        status: 'fail',
        severity: 'P0',
        signature: 'stream:noData-while-live',
        summary: 'YouTube reported noData for 90 s while the app said On air',
        evidence: ['observer.ndjson']
      }
    ],
    incidents: [
      {
        signature: 'stream:noData-while-live',
        severity: 'P0',
        summary: 'noData while live',
        firstAt: '2026-10-12T05:01:00Z',
        evidence: ['observer.ndjson']
      }
    ],
    needsEyes: [
      { id: 'highlight-card-look', question: 'Does the card look right?', frame: 'frames/h1.png' }
    ],
    quota: { labUnits: 312, bundledUnits: 0 },
    vod: null,
    ...overrides
  }
}

async function seedRun(
  dir,
  { published = { issues: [{ number: 701, signature: 'stream:noData-while-live' }] } } = {}
) {
  const runDir = join(dir, 'runs', '2026-10-12-chat-a1b2c3')
  await mkdir(join(runDir, 'frames'), { recursive: true })
  await writeFile(join(runDir, 'verdict.json'), JSON.stringify(verdict()))
  await writeFile(join(runDir, 'report.md'), '# report\n')
  await writeFile(join(runDir, 'frames', 'h1.png'), '')
  if (published) await writeFile(join(runDir, PUBLISHED_FILE), JSON.stringify(published))
  return runDir
}

function claudeResult(analysis, extra = {}) {
  return JSON.stringify({
    type: 'result',
    subtype: 'success',
    is_error: false,
    num_turns: 7,
    duration_ms: 1234,
    total_cost_usd: 0.42,
    session_id: 'sess-1',
    result: JSON.stringify(analysis),
    structured_output: analysis,
    permission_denials: [],
    ...extra
  })
}

test('settings file: deny-by-default, every forbidden tool, command and read is denied', () => {
  assert.equal(settings.permissions.defaultMode, 'dontAsk')
  assert.equal(settings.disableAllHooks, true)
  assert.equal(settings.permissions.ask, undefined, 'nothing may prompt; nobody is there')
  const deny = settings.permissions.deny
  for (const tool of MUST_DENY_TOOLS) assert.ok(deny.includes(tool), `deny ${tool}`)
  for (const command of MUST_DENY_COMMANDS) {
    assert.ok(deny.includes(`Bash(${command})`), `deny Bash(${command})`)
  }
  for (const path of MUST_DENY_READS)
    assert.ok(deny.includes(`Read(${path})`), `deny Read(${path})`)
})

test('settings file: allow rules are Read rules on the run folder and the harness clone only', () => {
  const allow = settings.permissions.allow
  assert.deepEqual(allow, ['Read(./**)', 'Read(~/videorc/**)'])
  for (const rule of allow) {
    assert.ok(rule.startsWith('Read('), `${rule} is not a Read rule`)
    for (const bad of [
      'Edit',
      'Write',
      'Bash',
      'ssh',
      'curl',
      'gh issue',
      'git push',
      'WebFetch'
    ]) {
      assert.ok(!rule.includes(bad), `${rule} must not mention ${bad}`)
    }
  }
})

test('settings file: every rule uses a documented form (an invalid file is silently ignored by -p)', () => {
  const all = [...settings.permissions.allow, ...settings.permissions.deny]
  const documentedTools = [
    'Bash',
    'Edit',
    'Write',
    'MultiEdit',
    'NotebookEdit',
    'WebFetch',
    'WebSearch',
    'Agent',
    'Skill',
    'Read'
  ]
  for (const rule of all) {
    const match = /^([A-Za-z]+)(?:\((.+)\))?$/.exec(rule)
    assert.ok(match, `${rule} is not Tool or Tool(spec)`)
    assert.ok(documentedTools.includes(match[1]), `${rule} names an undocumented tool`)
    if (match[1] === 'Bash' && match[2]) {
      assert.match(
        match[2],
        /^[A-Za-z0-9 ./_-]+(:\*)?$/,
        `${rule}: Bash specs are plain prefixes with :*`
      )
    }
  }
  for (const key of Object.keys(settings))
    assert.ok(['disableAllHooks', 'permissions'].includes(key))
  for (const key of Object.keys(settings.permissions)) {
    assert.ok(['defaultMode', 'allow', 'deny'].includes(key), `unexpected permissions key ${key}`)
  }
  assert.ok(!JSON.stringify(settings).includes('/Users/'), 'no home path in the settings file')
})

test('documented-semantics model: an edit, a write, a shell command and a secret read resolve to deny', () => {
  // A model of permissions.md, not the real engine (that check is owed on the lab machine).
  const deny = (call) => assert.equal(modelPermission(settings, call), 'deny', JSON.stringify(call))
  deny({ tool: 'Edit', path: '/run/report.md' })
  deny({ tool: 'Write', path: '/run/triaged.json' })
  deny({ tool: 'NotebookEdit', path: '/run/x.ipynb' })
  deny({ tool: 'MultiEdit', path: '/run/x' })
  deny({ tool: 'WebFetch' })
  deny({ tool: 'WebSearch' })
  deny({ tool: 'Agent' })
  deny({ tool: 'Bash', command: 'ls' })
  deny({ tool: 'Bash', command: 'git log --oneline' })
  deny({ tool: 'Bash', command: 'gh issue view 12 --repo TheOrcDev/videorc' })
  deny({ tool: 'Bash', command: 'cd /tmp && curl https://example.com' })
  deny({ tool: 'Bash', command: 'gh issue create --title x' })
  deny({ tool: 'Bash', command: 'pnpm live:run --scenario chat' })
  deny({ tool: 'Bash', command: 'cat ~/.videorc-live-lab/config.json' })
  deny({ tool: 'Read', path: '/home/lab/.videorc-live-lab/config.json' })
  deny({ tool: 'Read', path: '/home/lab/.ssh/id_ed25519' })
  deny({ tool: 'Read', path: '/home/lab/.config/gh/hosts.yml' })
  deny({ tool: 'Read', path: '/run/clips/take-1.mp4' })
  deny({ tool: 'Read', path: '/run/sub/.env' })
  deny({ tool: 'Read', path: '/Library/Keychains/System.keychain' })
  assert.equal(modelPermission(settings, { tool: 'Read', path: '/run/verdict.json' }), 'allow')
  assert.equal(modelPermission(settings, { tool: 'Read', path: '/run/frames/h1.png' }), 'allow')
  assert.equal(
    modelPermission(settings, { tool: 'Read', path: '/home/lab/videorc/scripts/x.mjs' }),
    'allow'
  )
  assert.equal(
    modelPermission(settings, { tool: 'Read', path: '/home/lab/Desktop/notes.txt' }),
    'ask',
    'outside the run folder and the clone it would prompt, and dontAsk denies a prompt'
  )
})

test('claude argv: settings, dontAsk, no prompts, restricted, read-only tool set, bounded turns and budget', () => {
  const args = buildClaudeArgs({
    settingsPath: '/x/claude-settings.json',
    harnessDir: '/x/videorc'
  })
  const flag = (name) => args[args.indexOf(name) + 1]
  assert.equal(args[0], '-p')
  assert.equal(flag('--output-format'), 'json')
  assert.equal(flag('--settings'), '/x/claude-settings.json')
  assert.equal(flag('--permission-mode'), 'dontAsk')
  assert.equal(flag('--permission-prompts'), 'none')
  assert.ok(args.includes('--restricted'))
  assert.ok(args.includes('--strict-mcp-config'))
  assert.ok(args.includes('--disable-slash-commands'))
  assert.ok(args.includes('--no-session-persistence'))
  assert.equal(flag('--tools'), 'Read,Glob,Grep')
  assert.deepEqual(CLAUDE_TOOLS, ['Read', 'Glob', 'Grep'])
  const disallowed = flag('--disallowedTools').split(',')
  for (const tool of [...MUST_DENY_TOOLS, 'mcp__*'])
    assert.ok(disallowed.includes(tool), `disallow ${tool}`)
  assert.deepEqual(disallowed, [...DISALLOWED_TOOLS])
  assert.equal(flag('--add-dir'), '/x/videorc')
  assert.equal(Number(flag('--max-turns')), 40)
  assert.equal(Number(flag('--max-budget-usd')), 5)
  assert.deepEqual(JSON.parse(flag('--json-schema')), RESULT_SCHEMA)
  assert.ok(!args.some((a) => /dangerously|bypassPermissions|acceptEdits/.test(a)))
  assert.ok(!args.includes('--allowedTools'), 'nothing is pre-approved beyond the settings file')
})

test('child env: allowlist only, fixed values on, no lab or GitHub or Videorc variables', () => {
  const env = childEnv({
    PATH: '/usr/bin',
    HOME: '/home/lab',
    ANTHROPIC_API_KEY: 'k',
    CLAUDE_CODE_OAUTH_TOKEN: 't',
    CLAUDE_CODE_SOMETHING: 'x',
    GH_TOKEN: 'ghp_secret',
    GITHUB_TOKEN: 'ghp_secret',
    VIDEORC_LIVE_LAB_DIR: '/secret',
    VIDEORC_YOUTUBE_CLIENT_SECRET: 'nope',
    DISCORD_WEBHOOK_URL: 'nope',
    YOUTUBE_STREAM_KEY: 'nope',
    AWS_SECRET_ACCESS_KEY: 'nope',
    DISABLE_AUTOUPDATER: ''
  })
  assert.deepEqual(
    Object.keys(env).filter((k) => /GH_|GITHUB|VIDEORC|DISCORD|YOUTUBE|AWS/.test(k)),
    []
  )
  assert.equal(env.PATH, '/usr/bin')
  assert.equal(env.ANTHROPIC_API_KEY, 'k')
  assert.equal(env.CLAUDE_CODE_SOMETHING, 'x')
  for (const [key, value] of Object.entries(ENV_FIXED)) assert.equal(env[key], value)
})

test('published.json issue numbers: every shape, only this repo, sorted and unique', () => {
  assert.deepEqual(
    issueNumbersFrom({ issues: [{ number: 12 }, { number: 3 }, { number: 12 }] }),
    [3, 12]
  )
  assert.deepEqual(issueNumbersFrom({ issues: [7, '8'] }), [7, 8])
  assert.deepEqual(issueNumbersFrom({ issueNumbers: [5] }), [5])
  assert.deepEqual(
    issueNumbersFrom({
      issues: [
        { url: `https://github.com/${ISSUES_REPO}/issues/44` },
        { url: 'https://github.com/other/repo/issues/45' },
        { number: 46, repo: 'other/repo' },
        { number: 47, repo: ISSUES_REPO }
      ]
    }),
    [44, 47]
  )
  assert.deepEqual(issueNumbersFrom({ incidents: [{ signature: 'x', issue: 9 }] }), [9])
  assert.deepEqual(issueNumbersFrom(null), [])
  assert.deepEqual(
    issueNumbersFrom({ issues: [{ number: -1 }, { number: 0 }, { number: 1.5 }] }),
    []
  )
})

test('the skill has a "Triage a run" section and the prompt carries it, the verdict, the log and the issues', () => {
  const section = triageSection(skillText)
  assert.ok(section.startsWith('## Triage a run'))
  assert.ok(!section.includes('## Workflow (attended)'))
  for (const must of ['Never', 'needs-eyes', 'one concise comment', 'no way to do these']) {
    assert.ok(
      section.toLowerCase().includes(must.toLowerCase()),
      `skill section mentions "${must}"`
    )
  }
  assert.throws(() => triageSection('# nothing here'), /no "## Triage a run" section/)

  const text = verdictSummary(verdict())
  assert.match(text, /outcome: fail/)
  assert.match(text, /\[fail P0\] stream:data/)
  assert.ok(!text.includes('leak:renderer'), 'passing signals stay out of the summary')
  assert.match(text, /highlight-card-look/)
  assert.match(text, /vod: unknown/)
  assert.equal(verdictSummary(null), '(verdict.json missing or unreadable)')

  const prompt = buildPrompt({
    runId: 'r1',
    skillSection: section,
    verdictText: text,
    issues: [
      { number: 701, title: 'noData while live', state: 'OPEN', body: 'body', comments: ['c1'] }
    ],
    gitLog: 'abc1234 2026-10-11 fix(stream): x',
    files: ['verdict.json', 'report.md']
  })
  assert.match(prompt, /### #701 noData while live \(OPEN\)/)
  assert.match(prompt, /abc1234 2026-10-11 fix\(stream\): x/)
  assert.match(prompt, /- verdict\.json/)
  assert.match(prompt, /comment only on these numbers/)
  assert.match(prompt, /You cannot run commands, edit files or post anything/)
  assert.match(
    buildPrompt({ runId: 'r2', skillSection: section, verdictText: text }),
    /return an empty comments list/
  )
})

test('parseClaudeResult: structured output, fenced text fallback, errors, max-turns and denials', () => {
  const analysis = { summary: 's', comments: [] }
  const ok = parseClaudeResult(claudeResult(analysis))
  assert.equal(ok.ok, true)
  assert.deepEqual(ok.analysis, analysis)
  assert.equal(ok.result.costUsd, 0.42)

  const fenced = parseClaudeResult(
    JSON.stringify({
      type: 'result',
      subtype: 'success',
      result: '```json\n{"summary":"x","comments":[]}\n```'
    })
  )
  assert.equal(fenced.ok, true)
  assert.equal(fenced.analysis.summary, 'x')

  const array = parseClaudeResult(
    JSON.stringify([{ type: 'system' }, JSON.parse(claudeResult(analysis))])
  )
  assert.equal(array.ok, true)

  const maxTurns = parseClaudeResult(
    JSON.stringify({
      type: 'result',
      subtype: 'error_max_turns',
      is_error: true,
      errors: ['max turns']
    })
  )
  assert.equal(maxTurns.ok, false)
  assert.match(maxTurns.error, /error_max_turns: max turns/)

  const denied = parseClaudeResult(
    claudeResult(analysis, {
      permission_denials: [
        {
          tool_name: 'Write',
          tool_use_id: 'x',
          tool_input: { file_path: '/run/probe.txt', content: 'hello' }
        }
      ]
    })
  )
  assert.deepEqual(denied.result.permissionDenials, [
    { tool: 'Write', input: { file_path: '/run/probe.txt' } }
  ])

  assert.equal(parseClaudeResult('').ok, false)
  assert.equal(
    parseClaudeResult(JSON.stringify({ type: 'result', subtype: 'success', result: 'prose' })).ok,
    false
  )
})

test('validateComments: unknown issue, duplicate, short, oversize and sensitive bodies are refused', () => {
  const body = 'The stream reported noData for 90 s while the app said On air; see observer.ndjson.'
  const analysis = {
    comments: [
      { issue: 701, body },
      { issue: 701, body },
      { issue: 999, body },
      { issue: 702, body: 'short' },
      { issue: 702, body: 'x'.repeat(4001) },
      { issue: 703, body: `${body} Token ya29.abcdefghijklmnop` },
      { issue: 704, body: `${body} Frame at /Users/lab/x/h1.png` },
      { issue: 705, body: `${body} Mail me at someone@example.com` }
    ]
  }
  const out = validateComments(analysis, {
    allowedIssues: [701, 702, 703, 704, 705],
    findSensitive: localFindSensitive,
    runId: 'r1',
    outcome: 'fail'
  })
  assert.deepEqual(
    out.map((c) => [c.issue, c.ok, c.reason]),
    [
      [701, true, null],
      [701, false, 'duplicate comment for this issue'],
      [999, false, 'issue not in published.json'],
      [702, false, 'body missing or too short'],
      [702, false, 'duplicate comment for this issue'],
      [703, false, 'redaction: token prefix, secret word'],
      [704, false, 'redaction: home path'],
      [705, false, 'redaction: email']
    ]
  )
  assert.equal(out[0].body, commentBody({ runId: 'r1', outcome: 'fail', body }))
  assert.match(out[0].body, /^\*\*Live lab triage\*\* for run `r1` \(outcome: fail\)/)
  assert.equal(
    validateComments(
      { comments: [{ issue: 1, body: 'x'.repeat(4001) }] },
      { allowedIssues: [1], findSensitive: () => [] }
    )[0].reason,
    'body over 4000 characters'
  )
})

test('local redaction guard names the pattern and never the match', () => {
  const text =
    'key abcd-efgh-ijkl-mnop-qrst at /Users/lab/x and ghp_abcdefghijklmnopqrstuvwxyz0123456789'
  const redacted = localRedactText(text)
  assert.ok(!redacted.includes('abcd-efgh'))
  assert.ok(!redacted.includes('/Users/lab'))
  assert.ok(!redacted.includes('ghp_'))
  assert.match(redacted, /\[redacted:stream key\]/)
  assert.match(redacted, /\[redacted:home path\]/)
  assert.deepEqual(localFindSensitive('nothing here'), [])
  assert.equal(
    localRedactText('additionalProperties and a token'),
    '[redacted:opaque secret] and a [redacted:secret word]',
    'a replacement label is never scanned again'
  )
})

test('checkCanTriage: policy off, policy invalid, held lock, corrupt lock refuse; free lock allows', async () => {
  const dir = await freshDir()
  const on = { triage: true }
  assert.deepEqual(await checkCanTriage({ workDir: dir, policy: null, problems: ['bad'] }), {
    ok: false,
    reason: 'policy invalid: bad'
  })
  assert.equal(
    (await checkCanTriage({ workDir: dir, policy: { triage: false } })).reason,
    'policy.triage is not true'
  )
  assert.equal(
    (await checkCanTriage({ workDir: dir, policy: { clipPull: true } })).reason,
    'policy.triage is not true'
  )
  assert.deepEqual(await checkCanTriage({ workDir: dir, policy: on }), { ok: true, reason: null })
  await writeFile(
    runLockPath(dir),
    JSON.stringify({ pid: 4242, runId: 'live-1', startedAt: 'now' })
  )
  const held = await checkCanTriage({ workDir: dir, policy: on, isAlive: () => true })
  assert.equal(held.ok, false)
  assert.match(held.reason, /run lock held \(live-1, pid 4242\); a run is live/)
  const stale = await checkCanTriage({ workDir: dir, policy: on, isAlive: () => false })
  assert.equal(stale.ok, true, 'a dead holder does not block triage')
  await writeFile(runLockPath(dir), 'not json')
  const corrupt = await checkCanTriage({ workDir: dir, policy: on })
  assert.equal(corrupt.ok, false)
  assert.match(corrupt.reason, /run lock unreadable/)
})

test('findRunsToTriage: published and not yet triaged, oldest first, --since honoured', async () => {
  const dir = await freshDir()
  const runs = join(dir, 'runs')
  for (const [name, files] of [
    ['2026-10-10-idle-aaaaaa', { 'published.json': '{"publishedAt":"2026-10-10T12:00:00Z"}' }],
    [
      '2026-10-11-chat-bbbbbb',
      { 'published.json': '{"publishedAt":"2026-10-11T12:00:00Z"}', 'triaged.json': '{}' }
    ],
    ['2026-10-12-chat-cccccc', { 'published.json': '{"publishedAt":"2026-10-12T12:00:00Z"}' }],
    ['2026-10-12-marathon-dddddd', { 'verdict.json': '{}' }]
  ]) {
    await mkdir(join(runs, name), { recursive: true })
    for (const [file, text] of Object.entries(files)) await writeFile(join(runs, name, file), text)
  }
  await writeFile(join(runs, 'stray.txt'), '')
  assert.deepEqual(await findRunsToTriage({ runsDir: runs }), [
    join(runs, '2026-10-10-idle-aaaaaa'),
    join(runs, '2026-10-12-chat-cccccc')
  ])
  assert.deepEqual(await findRunsToTriage({ runsDir: runs, since: '2026-10-11T00:00:00Z' }), [
    join(runs, '2026-10-12-chat-cccccc')
  ])
  assert.deepEqual(await findRunsToTriage({ runsDir: join(dir, 'missing') }), [])
})

function fakeExec(calls, { ghView = null } = {}) {
  return async (bin, args) => {
    calls.push([bin, ...args])
    if (bin === 'git')
      return { stdout: 'abc1234 2026-10-11 fix(stream): keep the leg alive\n', stderr: '' }
    if (bin === 'gh' && args[0] === 'issue' && args[1] === 'view') {
      return {
        stdout: JSON.stringify(
          ghView ?? {
            number: 701,
            title: 'noData while live',
            state: 'OPEN',
            body: 'opened by publish',
            comments: [{ body: 'first' }]
          }
        ),
        stderr: ''
      }
    }
    if (bin === 'gh' && args[0] === 'issue' && args[1] === 'comment')
      return { stdout: '', stderr: '' }
    throw new Error(`unexpected exec ${bin} ${args.join(' ')}`)
  }
}

const redactor = { redactText: localRedactText, findSensitive: localFindSensitive, source: 'local' }

test('triageRun end to end with a fake claude: prompt in, validated comment out, triaged.json written', async () => {
  const dir = await freshDir()
  const runDir = await seedRun(dir)
  const calls = []
  const invocations = []
  const analysis = {
    summary: 'The leg died while the app said On air.',
    likelyCauses: [
      { signature: 'stream:noData-while-live', commit: 'abc1234', why: 'touches the leg monitor' }
    ],
    needsEyes: [{ id: 'highlight-card-look', frame: 'frames/h1.png', seen: 'A blank frame.' }],
    comments: [
      {
        issue: 701,
        body: 'The run saw noData for 90 s (observer.ndjson) while the app stayed On air; may come from abc1234.'
      },
      {
        issue: 999,
        body: 'This issue is not in published.json and must be refused by the wrapper.'
      }
    ]
  }
  const record = await triageRun({
    runDir,
    harnessDir: '/x/videorc',
    now: () => new Date('2026-10-12T13:40:00Z'),
    env: { PATH: '/usr/bin', GH_TOKEN: 'ghp_secret_value_here_1234567890' },
    deps: {
      exec: fakeExec(calls),
      redactor,
      invoke: async (call) => {
        invocations.push(call)
        return {
          code: 0,
          signal: null,
          stdout: claudeResult(analysis),
          stderr: '',
          timedOut: false
        }
      }
    }
  })
  assert.equal(invocations.length, 1)
  const call = invocations[0]
  assert.equal(call.cwd, runDir)
  assert.equal(call.env.GH_TOKEN, undefined, 'the agent never sees the GitHub token')
  assert.equal(call.env.PATH, '/usr/bin')
  assert.equal(call.args[call.args.indexOf('--settings') + 1], SETTINGS_PATH)
  assert.equal(call.args[call.args.indexOf('--add-dir') + 1], '/x/videorc')
  assert.match(call.prompt, /## Triage a run/)
  assert.match(call.prompt, /### #701 noData while live \(OPEN\)/)
  assert.match(call.prompt, /abc1234 2026-10-11 fix\(stream\)/)
  assert.ok(!call.prompt.includes(dir), 'the prompt never carries the run folder path')

  assert.ok(calls.some((c) => c[0] === 'git' && c.includes('/x/videorc') && c.includes('log')))
  assert.ok(
    calls.some(
      (c) =>
        c.join(' ') ===
        `gh issue view 701 --repo ${ISSUES_REPO} --json number,title,state,body,comments`
    )
  )
  const posted = calls.filter((c) => c[0] === 'gh' && c[2] === 'comment')
  assert.equal(posted.length, 1, 'only the allowed issue gets a comment')
  assert.deepEqual(posted[0].slice(0, 5), ['gh', 'issue', 'comment', '701', '--repo'])
  assert.equal(posted[0][5], ISSUES_REPO)
  assert.equal(posted[0][7], join(runDir, 'triage', 'comment-701.md'))
  const bodyText = await readFile(join(runDir, 'triage', 'comment-701.md'), 'utf8')
  assert.match(bodyText, /Live lab triage/)
  assert.match(bodyText, /may come from abc1234/)

  assert.equal(record.status, 'posted')
  assert.equal(record.reason, '1 posted, 1 refused')
  assert.deepEqual(record.issues, [701])
  assert.equal(record.comments[0].posted, true)
  assert.deepEqual(record.comments[1], {
    issue: 999,
    posted: false,
    reason: 'issue not in published.json'
  })
  assert.equal(record.claude.costUsd, 0.42)
  assert.equal(record.claude.numTurns, 7)
  const written = JSON.parse(await readFile(join(runDir, TRIAGED_FILE), 'utf8'))
  assert.equal(written.schema, 1)
  assert.equal(written.runId, '2026-10-12-chat-a1b2c3')
  assert.equal(written.status, 'posted')
  assert.ok(!JSON.stringify(written).includes(dir), 'triaged.json carries no run folder path')
  assert.ok(!JSON.stringify(written).includes('ghp_secret'))

  assert.deepEqual(
    await findRunsToTriage({ runsDir: join(dir, 'runs') }),
    [],
    'a triaged run is not picked again'
  )
})

test('triageRun: a sensitive comment body is refused and recorded, never posted', async () => {
  const dir = await freshDir()
  const runDir = await seedRun(dir)
  const calls = []
  const record = await triageRun({
    runDir,
    deps: {
      exec: fakeExec(calls),
      redactor,
      invoke: async () => ({
        code: 0,
        signal: null,
        stdout: claudeResult({
          summary: 's',
          comments: [
            {
              issue: 701,
              body: 'The config at /Users/lab/.videorc-live-lab/config.json holds the stream key.'
            }
          ]
        }),
        stderr: '',
        timedOut: false
      })
    }
  })
  assert.equal(record.status, 'refused')
  assert.equal(calls.filter((c) => c[2] === 'comment').length, 0)
  assert.match(record.comments[0].reason, /redaction: home path/)
  const written = await readFile(join(runDir, TRIAGED_FILE), 'utf8')
  assert.ok(!written.includes('/Users/lab'), 'the analysis is redacted before it is written')
})

test('triageRun: timeout, non-zero exit, no issues, missing files and dry run', async () => {
  const dir = await freshDir()
  const runDir = await seedRun(dir)
  const base = { runDir, deps: { exec: fakeExec([]), redactor } }

  const timedOut = await triageRun({
    ...base,
    deps: {
      ...base.deps,
      invoke: async () => ({
        code: null,
        signal: 'SIGTERM',
        stdout: '',
        stderr: '',
        timedOut: true
      })
    }
  })
  assert.equal(timedOut.status, 'error')
  assert.match(timedOut.reason, /timed out after 10 min/)

  const crashed = await triageRun({
    ...base,
    deps: {
      ...base.deps,
      invoke: async () => ({
        code: 1,
        signal: null,
        stdout: '',
        stderr: 'usage: unknown flag',
        timedOut: false
      })
    }
  })
  assert.equal(crashed.status, 'error')
  assert.equal(crashed.reason, 'claude printed no JSON result')
  assert.match(crashed.claude.stderrTail, /unknown flag/)

  const noIssues = await seedRun(await freshDir(), { published: { issues: [] } })
  const quiet = await triageRun({
    runDir: noIssues,
    deps: {
      ...base.deps,
      invoke: async () => ({
        code: 0,
        signal: null,
        stdout: claudeResult({ summary: 's', comments: [] }),
        stderr: '',
        timedOut: false
      })
    }
  })
  assert.equal(quiet.status, 'nothing-to-post')
  assert.equal(quiet.reason, 'no issues for this run')

  const unpublished = await seedRun(await freshDir(), { published: null })
  const skipped = await triageRun({
    runDir: unpublished,
    deps: { ...base.deps, invoke: async () => assert.fail('never invoked') }
  })
  assert.equal(skipped.status, 'skipped')
  assert.equal(skipped.reason, 'published.json missing')

  const untouched = await seedRun(await freshDir())
  const dry = await triageRun({
    runDir: untouched,
    dryRun: true,
    deps: { ...base.deps, invoke: async () => assert.fail('dry run never invokes claude') }
  })
  assert.equal(dry.status, 'dry-run')
  assert.match(dry.prompt, /## Triage a run/)
  assert.ok(dry.claude.args.includes('--restricted'))
  await assert.rejects(
    readFile(join(untouched, TRIAGED_FILE)),
    { code: 'ENOENT' },
    'dry run writes nothing'
  )
})
