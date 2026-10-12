import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmod, cp, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { test } from 'node:test'

import {
  EXIT_COPY_FAILED,
  EXIT_SETUP_FAILED,
  PARAMS_ENV,
  RemoteUsageError,
  buildRemoteScript,
  buildScpArgs,
  buildSshArgs,
  parseLabSideArgs,
  parseParams,
  parseRemoteArgs,
  parseRunDir,
  runLabSide,
  runRemote,
  shellQuote,
  validateHost,
  validateRef,
  validateScenario
} from './remote.mjs'

const RUN_ID = '2026-10-12-chat-a1b2c3'
const LAB_RUN_DIR = `/Users/videorc-lab/videorc-live-lab/runs/${RUN_ID}`

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

async function tempDir(t) {
  const dir = await mkdtemp(join(tmpdir(), 'live-remote-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  return dir
}

function sh(command, env = {}) {
  return spawnSync('/bin/sh', ['-c', command], { encoding: 'utf8', env })
}

test('shellQuote survives a real shell for hostile strings', () => {
  const nasty = [
    '',
    'plain',
    "it's",
    "''",
    '$(touch /tmp/pwned) `id` $HOME ${PATH}',
    '"double" \\back\\slash',
    'new\nline\ttab',
    '; rm -rf / #',
    '{"a":"it\'s $(x)","b":[1,2]}',
    'ünïcødé ✓'
  ]
  for (const value of nasty) {
    const result = sh(`printf '%s' ${shellQuote(value)}`)
    assert.equal(result.status, 0)
    assert.equal(result.stdout, value)
  }
  assert.throws(() => shellQuote('a\0b'), RemoteUsageError)
  assert.throws(() => shellQuote(42), TypeError)
})

test('validators refuse anything that could reach a shell or ssh as an option', () => {
  assert.equal(validateScenario('chat'), 'chat')
  assert.equal(validateScenario('first-light'), 'first-light')
  for (const bad of ['', 'Chat', 'a b', 'a;b', '-x', '../x', 'a'.repeat(49)]) {
    assert.throws(() => validateScenario(bad), RemoteUsageError, bad)
  }
  assert.equal(validateRef('origin/main'), 'origin/main')
  assert.equal(validateRef('abc1234'), 'abc1234')
  assert.equal(validateRef('refs/pull/812/head'), 'refs/pull/812/head')
  for (const bad of ['', '-b', '--upload-pack=x', 'a..b', 'a b', 'a;b', 'a$(x)', "a'b"]) {
    assert.throws(() => validateRef(bad), RemoteUsageError, bad)
  }
  assert.equal(validateHost('videorc-lab@lab-mac'), 'videorc-lab@lab-mac')
  for (const bad of ['', '-oProxyCommand=x', 'a b', 'host;id', 'h:22']) {
    assert.throws(() => validateHost(bad), RemoteUsageError, bad)
  }
})

test('params must be a small JSON object with nothing secret-shaped in it', () => {
  assert.equal(parseParams(undefined), null)
  assert.equal(parseParams('{ "marathonHours": 4 }'), '{"marathonHours":4}')
  assert.throws(() => parseParams('{'), /not valid JSON/)
  assert.throws(() => parseParams('[1]'), /JSON object/)
  assert.throws(() => parseParams('"x"'), /JSON object/)
  assert.throws(() => parseParams(JSON.stringify({ pad: 'x'.repeat(4100) })), /at most 4096/)
  const key = ['abcd', 'efgh', 'ijkl', 'mnop', 'qrst'].join('-')
  assert.throws(() => parseParams(JSON.stringify({ key })), /secret/)
  assert.throws(() => parseParams(JSON.stringify({ who: 'someone@example.com' })), /secret/)
})

test('parseRemoteArgs validates every flag and keeps the defaults', () => {
  const options = parseRemoteArgs([
    '--host',
    'lab',
    '--scenario',
    'chat',
    '--build',
    'candidate:ABCDEF1',
    '--privacy',
    'unlisted',
    '--params',
    '{"a":1}'
  ])
  assert.equal(options.ref, 'origin/main')
  assert.deepEqual(options.build, { text: 'candidate:abcdef1', kind: 'candidate', id: 'abcdef1' })
  assert.equal(options.paramsJson, '{"a":1}')
  assert.equal(options.publish, false)
  assert.throws(() =>
    parseRemoteArgs(['--host', 'lab', '--scenario', 'chat', '--build', 'nightly'])
  )
  // Plan 179: file:/local: are paths on the lab; never a remote --build, on any host.
  for (const build of ['file:/tmp/Videorc.AppImage', 'local:/tmp/linux-unpacked']) {
    assert.throws(
      () => parseRemoteArgs(['--host', 'lab', '--scenario', 'chat', '--build', build]),
      RemoteUsageError
    )
  }
  assert.throws(() => parseRemoteArgs(['--host', 'lab', '--scenario', 'chat', '--privacy', 'x']))
  assert.throws(() => parseRemoteArgs(['--host', 'lab', '--scenario', 'chat', '--evil']))
  assert.throws(() => parseRemoteArgs(['--scenario', 'chat']), /--host/)
  assert.deepEqual(parseLabSideArgs(['--lab-side', '--scenario', 'dry', '--build', 'release']), {
    scenario: 'dry',
    build: { text: 'release', kind: 'release', id: null },
    privacy: null,
    publish: false
  })
})

test('ssh never forwards the agent and never takes the host as an option', () => {
  const args = buildSshArgs('lab', 'echo hi\n')
  assert.ok(!args.includes('-A'))
  assert.ok(args.includes('-a') && args.includes('-x') && args.includes('-T'))
  assert.ok(args.includes('BatchMode=yes') && args.includes('ForwardAgent=no'))
  const dash = args.indexOf('--')
  assert.equal(args[dash + 1], 'lab')
  assert.equal(args[dash + 2], `/bin/sh -c ${shellQuote('echo hi\n')}`)
  assert.throws(() => buildSshArgs('-oProxyCommand=id', 'x'), RemoteUsageError)
  const scp = buildScpArgs('lab', `${LAB_RUN_DIR}/charts`, '/tmp/x', { recursive: true })
  assert.ok(scp.includes('-r') && scp.includes('BatchMode=yes'))
  assert.equal(scp.at(-2), `lab:${LAB_RUN_DIR}/charts`)
})

test('parseRunDir only accepts a run folder under runs/', () => {
  assert.deepEqual(parseRunDir(LAB_RUN_DIR), { runDir: LAB_RUN_DIR, runId: RUN_ID })
  assert.equal(parseRunDir('/etc/passwd'), null)
  assert.equal(parseRunDir(`/x/runs/${RUN_ID}/../../etc`), null)
  assert.equal(parseRunDir(`relative/runs/${RUN_ID}`), null)
  assert.equal(parseRunDir(`/x/runs/${RUN_ID}; rm -rf /`), null)
})

// The whole SSH script, run by a real /bin/sh against fake git, pnpm and node.
async function fakeLab(t) {
  const root = await tempDir(t)
  const home = join(root, 'home')
  const bin = join(root, 'bin')
  const log = join(root, 'calls.log')
  await mkdir(join(home, 'videorc', 'node_modules'), { recursive: true })
  await mkdir(bin)
  const script = (body) => `#!/bin/sh\n${body}\n`
  await writeFile(
    join(bin, 'git'),
    script(`printf 'git %s\\n' "$*" >> "${log}"
if [ "$1" = "rev-parse" ]; then cat "${root}/lock-sha"; fi`)
  )
  await writeFile(join(bin, 'pnpm'), script(`printf 'pnpm %s\\n' "$*" >> "${log}"`))
  await writeFile(
    join(bin, 'node'),
    script(`printf 'node' >> "${log}"; for a in "$@"; do printf ' [%s]' "$a" >> "${log}"; done
printf '\\nparams=[%s] set=%s\\n' "$${PARAMS_ENV}" "\${${PARAMS_ENV}+yes}" >> "${log}"
echo "RUN_EXIT=0"`)
  )
  for (const name of ['git', 'pnpm', 'node']) await chmod(join(bin, name), 0o755)
  await writeFile(join(root, 'lock-sha'), 'sha-one\n')
  const run = (scriptText) => {
    const command = buildSshArgs('lab', scriptText).at(-1)
    return sh(command, { HOME: home, PATH: `${bin}:/usr/bin:/bin` })
  }
  return { root, home, log, run }
}

test('the SSH script checks out the ref, installs only on a lockfile change, and passes params intact', async (t) => {
  const lab = await fakeLab(t)
  const params = JSON.stringify({ note: 'it\'s $(rm -rf /) `id` "q" \\ $HOME', hours: 4 })
  const options = {
    scenario: 'chat',
    build: { text: 'candidate:abcdef1', kind: 'candidate', id: 'abcdef1' },
    privacy: 'unlisted',
    paramsJson: params,
    ref: 'refs/pull/812/head',
    publish: true
  }
  const first = lab.run(buildRemoteScript(options))
  assert.equal(first.status, 0, first.stderr)
  assert.match(first.stdout, /lockfile changed/)
  let calls = await readFile(lab.log, 'utf8')
  assert.match(calls, /git fetch --quiet origin/)
  assert.match(calls, /git checkout --quiet --detach refs\/pull\/812\/head/)
  assert.match(calls, /pnpm install --frozen-lockfile --ignore-scripts/)
  assert.ok(
    calls.includes(
      'node [scripts/live-lab/remote.mjs] [--lab-side] [--scenario] [chat] [--build] [candidate:abcdef1] [--privacy] [unlisted] [--publish]'
    ),
    calls
  )
  assert.ok(calls.includes(`params=[${params}] set=yes`), calls)

  await writeFile(lab.log, '')
  const second = lab.run(buildRemoteScript({ ...options, paramsJson: null }))
  assert.equal(second.status, 0, second.stderr)
  calls = await readFile(lab.log, 'utf8')
  assert.doesNotMatch(calls, /pnpm install/)
  assert.match(calls, /params=\[\] set=\n/)

  await writeFile(join(lab.root, 'lock-sha'), 'sha-two\n')
  await writeFile(lab.log, '')
  lab.run(buildRemoteScript(options))
  assert.match(await readFile(lab.log, 'utf8'), /pnpm install/)
})

test('the SSH script stops at the first failing step', async (t) => {
  const lab = await fakeLab(t)
  await writeFile(join(lab.home, '..', 'bin', 'git'), '#!/bin/sh\nexit 128\n')
  const result = lab.run(buildRemoteScript({ scenario: 'dry', ref: 'origin/main' }))
  assert.equal(result.status, 128)
  assert.doesNotMatch(await readFile(lab.log, 'utf8').catch(() => ''), /node/)
})

// A fake lab run folder that the fake scp copies from.
async function labFolder(t, { report = '# Run report\n\nAll good.\n', extra = {} } = {}) {
  const dir = await tempDir(t)
  await writeFile(join(dir, 'verdict.json'), JSON.stringify({ schema: 1, runId: RUN_ID }))
  await writeFile(join(dir, 'report.md'), report)
  await mkdir(join(dir, 'charts'))
  await writeFile(
    join(dir, 'charts', 'rss.png'),
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  )
  for (const [name, content] of Object.entries(extra)) await writeFile(join(dir, name), content)
  return dir
}

function fakeScp(sourceDir, calls) {
  return async (args) => {
    calls.push(args)
    const remote = args.at(-2)
    const local = args.at(-1)
    const name = basename(remote.split(':').pop())
    await cp(join(sourceDir, name), local, { recursive: true })
    return { code: 0 }
  }
}

function fakeSsh(lines, { code = 0, stderr = [] } = {}) {
  const calls = []
  const ssh = async (args, { onStdout, onStderr }) => {
    calls.push(args)
    for (const line of lines) onStdout(line)
    for (const line of stderr) onStderr(line)
    return { code }
  }
  return { ssh, calls }
}

const baseOptions = {
  host: 'lab',
  scenario: 'chat',
  build: null,
  privacy: 'unlisted',
  paramsJson: null,
  ref: 'origin/main',
  out: null,
  publish: false
}

test('runRemote streams sanitized lines, copies back only guarded files, and keeps the run exit', async (t) => {
  const source = await labFolder(t)
  const outRoot = join(await tempDir(t), 'remote-runs')
  const { ssh, calls } = fakeSsh([
    'live:run: going live',
    'viewer said hi from someone@example.com',
    `RUN_DIR=${LAB_RUN_DIR}`,
    'RUN_FILES=verdict.json,report.md,charts,secrets.txt',
    'RUN_EXIT=1',
    `RUN_DIR=${LAB_RUN_DIR}`
  ])
  const scpCalls = []
  const out = []
  const code = await runRemote({
    options: baseOptions,
    ssh,
    scp: fakeScp(source, scpCalls),
    redactor: fakeRedactor,
    outRoot,
    print: (line) => out.push(line),
    printErr: (line) => out.push(line)
  })
  assert.equal(code, 1)
  assert.equal(calls.length, 1)
  const text = out.join('\n')
  assert.match(text, /\[lab\] live:run: going live/)
  assert.match(text, /\[lab\] viewer said hi from \[redacted\]/)
  assert.doesNotMatch(text, /example\.com|\/Users\//)
  assert.match(text, new RegExp(`run folder runs/${RUN_ID}`))
  // secrets.txt was not an allowed artifact name: never requested.
  assert.deepEqual(
    scpCalls.map((args) => args.at(-2)),
    ['verdict.json', 'report.md', 'charts'].map((name) => `lab:${LAB_RUN_DIR}/${name}`)
  )
  const dest = join(outRoot, RUN_ID)
  assert.deepEqual((await readdir(dest)).sort(), ['charts', 'report.md', 'verdict.json'])
  assert.equal((await stat(dest)).mode & 0o777, 0o700)
  assert.ok(out.includes(`REPORT_DIR=${dest}`))
})

test('runRemote keeps nothing when the guard refuses a copied file', async (t) => {
  for (const report of ['# Report\nkey abcd-efgh-ijkl-mnop-qrst\n', '# Report\nU9-HIT\n']) {
    const source = await labFolder(t, { report })
    const outRoot = join(await tempDir(t), 'remote-runs')
    const { ssh } = fakeSsh([
      `RUN_DIR=${LAB_RUN_DIR}`,
      'RUN_FILES=verdict.json,report.md',
      'RUN_EXIT=0'
    ])
    const out = []
    const code = await runRemote({
      options: baseOptions,
      ssh,
      scp: fakeScp(source, []),
      redactor: fakeRedactor,
      outRoot,
      print: (line) => out.push(line),
      printErr: (line) => out.push(line)
    })
    assert.equal(code, EXIT_COPY_FAILED)
    assert.match(out.join('\n'), /COPY_FAILED \(REDACTION_FAILED/)
    assert.doesNotMatch(out.join('\n'), /abcd-efgh/)
    assert.deepEqual(await readdir(outRoot), [])
  }
})

test('runRemote refuses to copy back without the U9 redactor', async (t) => {
  const source = await labFolder(t)
  const outRoot = join(await tempDir(t), 'remote-runs')
  const { ssh } = fakeSsh([`RUN_DIR=${LAB_RUN_DIR}`, 'RUN_FILES=report.md', 'RUN_EXIT=0'])
  const out = []
  const code = await runRemote({
    options: baseOptions,
    ssh,
    scp: fakeScp(source, []),
    redactor: null,
    outRoot,
    print: (line) => out.push(line),
    printErr: (line) => out.push(line)
  })
  assert.equal(code, EXIT_COPY_FAILED)
  assert.match(out.join('\n'), /REDACTION_UNAVAILABLE/)
})

test('runRemote: refusal passes through, setup failure is 5, odd RUN_DIR is refused', async (t) => {
  const outRoot = join(await tempDir(t), 'remote-runs')
  const quiet = { print: () => {}, printErr: () => {} }
  const scp = async () => assert.fail('no copy expected')
  let lines = []
  const refusal = fakeSsh(['REFUSED (policy disabled (enabled is false))', 'RUN_EXIT=2'])
  const code = await runRemote({
    options: baseOptions,
    ssh: refusal.ssh,
    scp,
    redactor: fakeRedactor,
    outRoot,
    print: (line) => lines.push(line),
    printErr: () => {}
  })
  assert.equal(code, 2)
  assert.match(lines.join('\n'), /\[lab\] REFUSED \(policy disabled/)

  const broken = fakeSsh(['fatal: not a git repository'], { code: 128 })
  assert.equal(
    await runRemote({
      options: baseOptions,
      ssh: broken.ssh,
      scp,
      redactor: fakeRedactor,
      outRoot,
      ...quiet
    }),
    EXIT_SETUP_FAILED
  )
  lines = []
  const odd = fakeSsh(['RUN_DIR=/etc', 'RUN_EXIT=0'])
  assert.equal(
    await runRemote({
      options: baseOptions,
      ssh: odd.ssh,
      scp,
      redactor: fakeRedactor,
      outRoot,
      ...quiet
    }),
    EXIT_COPY_FAILED
  )
})

function labDeps({
  policy = { enabled: true, onDemand: { allowedBuilds: ['release', 'candidate'] } },
  lockOk = true,
  stop = false,
  runCode = 0,
  installCode = 0
} = {}) {
  const calls = []
  const out = []
  const deps = {
    scripts: { install: 'install.mjs', run: 'run.mjs', publish: 'publish.mjs' },
    loadPolicy: async () => ({ policy, problems: policy ? [] : ['missing'] }),
    stopFileExists: async () => stop,
    acquireLock: async (id) => {
      calls.push(['lock', id])
      return lockOk ? { ok: true } : { ok: false, reason: 'run lock held by schedule-x (pid 1)' }
    },
    releaseLock: async (id) => calls.push(['unlock', id]),
    presentArtifacts: async () => ['verdict.json', 'report.md'],
    runNode: async (script, args, { onStdout, detached }) => {
      calls.push(['node', script, ...args, ...(detached ? ['(detached)'] : [])])
      if (script === 'run.mjs') {
        onStdout('step 1 ok')
        onStdout(`RUN_DIR=${LAB_RUN_DIR}`)
        return { code: runCode }
      }
      if (script === 'install.mjs' && args[0] === '--build') return { code: installCode }
      return { code: 0 }
    },
    print: (line) => out.push(line),
    printErr: (line) => out.push(line)
  }
  return { deps, calls, out }
}

const candidateOptions = {
  scenario: 'chat',
  build: { text: 'candidate:abcdef1', kind: 'candidate', id: 'abcdef1' },
  privacy: 'unlisted',
  publish: false
}

test('lab side: a candidate installs under the run lock, runs on-demand detached, then restores', async () => {
  const { deps, calls, out } = labDeps({ runCode: 1 })
  const code = await runLabSide({ options: candidateOptions, ...deps })
  assert.equal(code, 1)
  assert.deepEqual(calls, [
    ['lock', 'on-demand-install-abcdef1'],
    ['node', 'install.mjs', '--build', 'candidate:abcdef1', '--json'],
    ['unlock', 'on-demand-install-abcdef1'],
    [
      'node',
      'run.mjs',
      '--scenario',
      'chat',
      '--trigger',
      'on-demand',
      '--build',
      'candidate',
      '--privacy',
      'unlisted',
      '(detached)'
    ],
    ['lock', 'on-demand-restore-abcdef1'],
    ['node', 'install.mjs', '--rollback'],
    ['unlock', 'on-demand-restore-abcdef1']
  ])
  assert.deepEqual(out.slice(-3), [
    'RUN_FILES=verdict.json,report.md',
    'RUN_EXIT=1',
    `RUN_DIR=${LAB_RUN_DIR}`
  ])
})

test('lab side: refusals happen before anything is installed', async () => {
  const cases = [
    [{ stop: true }, /STOP file present/],
    [{ policy: null }, /policy missing or invalid/],
    [{ policy: { enabled: false, onDemand: { allowedBuilds: ['candidate'] } } }, /policy disabled/],
    [
      { policy: { enabled: true, onDemand: { allowedBuilds: ['release'] } } },
      /candidate not allowed/
    ],
    [{ lockOk: false }, /run lock held/],
    [{ installCode: 2 }, /install refused/]
  ]
  for (const [setup, reason] of cases) {
    const { deps, calls, out } = labDeps(setup)
    const code = await runLabSide({ options: candidateOptions, ...deps })
    assert.equal(code, 2, String(reason))
    assert.match(out.join('\n'), reason)
    assert.equal(out.at(-1), 'RUN_EXIT=2')
    assert.ok(!calls.some((call) => call[1] === 'run.mjs'))
  }
})

test('lab side: a release run installs nothing and can publish its run', async () => {
  const { deps, calls, out } = labDeps()
  const code = await runLabSide({
    options: {
      scenario: 'dry',
      build: { text: 'release', kind: 'release', id: null },
      privacy: null,
      publish: true
    },
    ...deps
  })
  assert.equal(code, 0)
  assert.deepEqual(calls, [
    [
      'node',
      'run.mjs',
      '--scenario',
      'dry',
      '--trigger',
      'on-demand',
      '--build',
      'release',
      '(detached)'
    ],
    ['node', 'publish.mjs', '--run', LAB_RUN_DIR]
  ])
  assert.ok(out.includes('PUBLISH_EXIT=0'))
})
