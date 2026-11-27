import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const scriptsRoot = join(repoRoot, 'scripts')
const securitySourcePath = join(
  repoRoot,
  'apps',
  'desktop',
  'src',
  'main',
  'smoke-command-security.ts'
)
const mainSourcePath = join(repoRoot, 'apps', 'desktop', 'src', 'main', 'index.ts')
const gpuiStudioSourcePath = join(
  repoRoot,
  'crates',
  'videorc-app-core',
  'src',
  'smoke',
  'studio.rs'
)
const gpuiCommandsSourcePath = join(
  repoRoot,
  'crates',
  'videorc-app-core',
  'src',
  'smoke',
  'commands.rs'
)

test('the maintained preview-lifecycle probe uses its supported gate argument', () => {
  const packageDocument = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'))
  assert.equal(
    packageDocument.scripts['probe:preview-lifecycle'],
    'node scripts/preview-lifecycle-probe.mjs --gate'
  )
  const parserSource = readFileSync(
    join(scriptsRoot, 'lib', 'windows-preview-lifecycle-gates.mjs'),
    'utf8'
  )
  assert.match(parserSource, /\['--gate', '--report-only'\]/)
})

test('the Windows local gate fresh-verifies the full installed candidate before PASS', () => {
  const source = readFileSync(join(scriptsRoot, 'smoke-local-gates-windows.mjs'), 'utf8')
  assert.match(
    source,
    /manifest\.status = 'passed'[\s\S]*?await revalidateInstalledWindowsCandidate\(\{[\s\S]*?expectedCandidate: candidateIdentity[\s\S]*?repoRoot,[\s\S]*?env: process\.env,[\s\S]*?platform: process\.platform[\s\S]*?\}\)[\s\S]*?await writeManifest\(\)[\s\S]*?windows-local-gates: PASS/
  )
})

test('Windows release PASS artifacts are prepared before final verification and never post-hashed', () => {
  const d3d = readFileSync(join(scriptsRoot, 'smoke-windows-d3d11-media.mjs'), 'utf8')
  const obs = readFileSync(join(scriptsRoot, 'smoke-windows-obs-side-by-side.mjs'), 'utf8')
  const stream = readFileSync(join(scriptsRoot, 'smoke-windows-stream-performance.mjs'), 'utf8')

  assert.equal((d3d.match(/await prepareExclusiveJsonArtifact\(/g) ?? []).length, 4)
  assert.equal((d3d.match(/await finalizePreparedJsonArtifact\(/g) ?? []).length, 4)
  assert.match(
    d3d,
    /finalizePreparedJsonArtifact\(preparedReport, async \(\) => \{[\s\S]*?assertArtifactsUnchanged[\s\S]*?revalidateD3dFinalCandidate\(candidate\)[\s\S]*?\}\)/
  )
  assert.match(
    d3d,
    /finalizePreparedJsonArtifact\(preparedAggregate, async \(\) => \{[\s\S]*?assertArtifactsUnchanged[\s\S]*?revalidateD3dFinalCandidate\(aggregate\.candidate\)[\s\S]*?\}\)[\s\S]*?aggregate evidence PASS/
  )

  assert.match(
    obs,
    /prepareExclusiveJsonArtifact\(plan\.aggregatePath, aggregate\)[\s\S]*?finalizePreparedJsonArtifact\([\s\S]*?revalidateCandidate[\s\S]*?aggregateSha256: publishedAggregate\.sha256/
  )
  assert.match(
    obs,
    /prepareExclusiveJsonArtifact\(runPlan\.reportPath, report\)[\s\S]*?finalizePreparedJsonArtifact\(preparedReport, revalidateCandidate\)[\s\S]*?reportSha256: publishedReport\.sha256/
  )
  assert.doesNotMatch(obs, /sha256File\((?:plan\.aggregatePath|runPlan\.reportPath)\)/)

  assert.match(
    stream,
    /prepareExclusiveJsonArtifact\(artifacts\.verdict,[\s\S]*?finalizePreparedJsonArtifact\([\s\S]*?result\.verdict === 'PASS' \? revalidateCandidate[\s\S]*?reportSha256: publishedReport\.sha256/
  )
  assert.doesNotMatch(stream, /sha256File\(artifacts\.verdict\)/)
})

test('every direct smoke command HTTP caller sends the per-run bearer capability', () => {
  const unauthenticated = []

  for (const path of scriptFiles()) {
    const source = readFileSync(path, 'utf8')
    // The node agent's `/v1/health` (plan 222 D7: the fake web's node-signed
    // probe) is not a smoke command call; the command server's is `/health`.
    // The fake web's `/api/ai/cohost/command` forward (plan 249 S15) is not one either.
    for (const match of source.matchAll(
      /(?<!\/cohost)\/command\b|(?<!\/v1)\/health\b|\/preview-frame\.png\b/g
    )) {
      const requestWindow = source.slice(match.index, match.index + 800)
      if (!/Bearer \$\{(?:smoke|conn\.smoke)\.capability\}|Bearer \$\{C\}/.test(requestWindow)) {
        unauthenticated.push(`${relativeScriptPath(path)}:${lineNumber(source, match.index)}`)
      }
    }
  }

  assert.deepEqual(
    unauthenticated,
    [],
    `Smoke command HTTP calls missing Authorization: ${unauthenticated.join(', ')}`
  )
})

test('the server allowlist covers literal commands used by smoke callers and names real handlers', () => {
  const securitySource = readFileSync(securitySourcePath, 'utf8')
  const allowlistBlock = securitySource.match(/SMOKE_COMMAND_NAMES = new Set\(\[([\s\S]*?)\]\)/)
  assert.ok(allowlistBlock, 'Could not locate SMOKE_COMMAND_NAMES.')
  // Line comments go first: an apostrophe in one ("can't") would pair with the
  // next entry's quote and shift every name after it.
  const entries = allowlistBlock[1].replace(/\/\/.*$/gm, '')
  const allowed = new Set([...entries.matchAll(/'([^']+)'/g)].map((match) => match[1]))
  const callers = new Map()

  for (const path of scriptFiles()) {
    const source = readFileSync(path, 'utf8')
    collectLiteralCommands(
      callers,
      path,
      source,
      /\b(?:cmd|smokeCommand|requestSmokeCommand(?:WithRetry)?)\(\s*['"]([a-z][a-z0-9-]+)['"]/g
    )
    collectLiteralCommands(
      callers,
      path,
      source,
      /\b(?:smokeCommand|sendSmokeCommand|requestSmokeCommand(?:WithRetry)?)\(\s*[^,\n]+,\s*['"]([a-z][a-z0-9-]+)['"]/g
    )
  }

  // Smokes that also drive the GPUI app (plan 260) send its Studio handler's
  // own commands from their `gpuiApp` branches. Those are served by
  // videorc-app-core's STUDIO_SMOKE_COMMANDS, never by Electron's server.
  const gpuiStudioBlock = readFileSync(gpuiStudioSourcePath, 'utf8').match(
    /STUDIO_SMOKE_COMMANDS: &\[&str\] = &\[([\s\S]*?)\];/
  )
  assert.ok(gpuiStudioBlock, 'Could not locate STUDIO_SMOKE_COMMANDS.')
  const gpuiStudio = new Set(
    [...gpuiStudioBlock[1].replace(/\/\/.*$/gm, '').matchAll(/"([^"]+)"/g)].map((match) => match[1])
  )
  // The same for the GPUI app's own window commands (APP_WINDOW_COMMANDS,
  // e.g. `notifications-state`), which only its window handlers serve.
  const gpuiWindowBlock = readFileSync(gpuiCommandsSourcePath, 'utf8').match(
    /APP_WINDOW_COMMANDS: &\[&str\] = &\[([\s\S]*?)\];/
  )
  assert.ok(gpuiWindowBlock, 'Could not locate APP_WINDOW_COMMANDS.')
  const gpuiWindow = new Set(
    [...gpuiWindowBlock[1].replace(/\/\/.*$/gm, '').matchAll(/"([^"]+)"/g)].map((match) => match[1])
  )
  const unlisted = [...callers.keys()]
    .filter(
      (command) => !allowed.has(command) && !gpuiStudio.has(command) && !gpuiWindow.has(command)
    )
    .sort()
  assert.deepEqual(
    unlisted,
    [],
    `Smoke callers use commands outside the allowlist: ${unlisted
      .map((command) => `${command} (${callers.get(command)})`)
      .join(', ')}`
  )

  const mainSource = readFileSync(mainSourcePath, 'utf8')
  const unhandled = [...allowed].filter(
    (command) => !mainSource.includes(`'${command}'`) && !mainSource.includes(`"${command}"`)
  )
  assert.deepEqual(
    unhandled,
    [],
    `Allowlisted commands without a main-process handler: ${unhandled}`
  )
})

test('the Electron server is loopback-only and packaged mode requires a harness capability', () => {
  const mainSource = readFileSync(mainSourcePath, 'utf8')
  assert.match(
    mainSource,
    /smokeCommandServerAllowed\([\s\S]*?VIDEORC_SMOKE_COMMAND_SERVER[\s\S]*?app\.isPackaged,\s*packagedSmokeHarnessCapability/
  )
  assert.match(mainSource, /VIDEORC_PACKAGED_SMOKE_TEST === '1'/)
  assert.match(mainSource, /smokePreviewMotionServer\.listen\(0, '127\.0\.0\.1'/)
  assert.match(mainSource, /preview-motion-ready[\s\S]*?capability: smokeCommandCapability/)
  assert.doesNotMatch(mainSource, /\/preview-frame\.png/)
  assert.match(mainSource, /url\.host === 'smoke-preview'/)
  assert.match(
    readFileSync(securitySourcePath, 'utf8'),
    /videorc-asset:\/\/smoke-preview\/frame\.svg/
  )
  const packagedPreviewSmoke = readFileSync(
    join(scriptsRoot, 'smoke-recording-native-preview-app.mjs'),
    'utf8'
  )
  assert.match(packagedPreviewSmoke, /VIDEORC_PACKAGED_SMOKE_TEST: '1'/)
  assert.match(packagedPreviewSmoke, /VIDEORC_SMOKE_COMMAND_CAPABILITY: packagedSmokeCapability/)
  assert.match(packagedPreviewSmoke, /connections\.smoke\.capability = packagedSmokeCapability/)
  assert.match(packagedPreviewSmoke, /usePackagedWindowsScreen/)
  assert.match(packagedPreviewSmoke, /VIDEORC_DISABLE_AUTO_SOURCE_PREVIEW: '1'/)
  assert.match(packagedPreviewSmoke, /nativeWindowsScreenCandidates/)
  assert.match(packagedPreviewSmoke, /'scene\.layout\.apply_preview'/)
  assert.match(packagedPreviewSmoke, /exerciseProofFramePolling && !packagedSpawnSpec/)
  assert.match(packagedPreviewSmoke, /expectAudio: !usePackagedWindowsScreen/)
  assert.match(packagedPreviewSmoke, /'preview\.screen\.start'/)
  const packagedSurfaceSmoke = readFileSync(
    join(scriptsRoot, 'smoke-preview-surface-app.mjs'),
    'utf8'
  )
  assert.match(packagedSurfaceSmoke, /VIDEORC_PACKAGED_SMOKE_TEST: '1'/)
  assert.match(packagedSurfaceSmoke, /VIDEORC_SMOKE_COMMAND_CAPABILITY: packagedSmokeCapability/)
  assert.match(packagedSurfaceSmoke, /connections\.smoke\.capability = expectedPackagedCapability/)
  const packagedRecordingSmoke = readFileSync(join(scriptsRoot, 'smoke-packaged-app.mjs'), 'utf8')
  assert.match(packagedRecordingSmoke, /inspect-packaged-bundled-background/)
  assert.match(packagedRecordingSmoke, /managedAssetPath/)
  assert.match(packagedRecordingSmoke, /decodedWidth/)
  assert.match(packagedRecordingSmoke, /videorc-asset:\/\/background\//)
  const windowsNativeScreenSmoke = readFileSync(
    join(scriptsRoot, 'smoke-windows-native-screen-app.mjs'),
    'utf8'
  )
  assert.match(windowsNativeScreenSmoke, /preview\/screen\/latest\.bmp/)
  assert.match(windowsNativeScreenSmoke, /layoutPreset: 'screen-only'/)
  assert.match(windowsNativeScreenSmoke, /assertNonblankBmp/)
  assert.match(windowsNativeScreenSmoke, /waitForNonblankBmpFrame/)
  assert.match(windowsNativeScreenSmoke, /VIDEORC_DISABLE_AUTO_PREVIEW: '1'/)
  const windowsWorkflow = readFileSync(
    join(repoRoot, '.github', 'workflows', 'windows.yml'),
    'utf8'
  )
  assert.match(windowsWorkflow, /pnpm smoke:windows-native-screen/)
  const uiDriverSource = readFileSync(join(scriptsRoot, 'ui-driver.mjs'), 'utf8')
  assert.match(uiDriverSource, /mode: 0o600/)
  assert.match(uiDriverSource, /chmodSync\(UI_DRIVER_CONNECTION_FILE, 0o600\)/)
})

function collectLiteralCommands(commands, path, source, pattern) {
  for (const match of source.matchAll(pattern)) {
    if (!commands.has(match[1])) {
      commands.set(match[1], `${relativeScriptPath(path)}:${lineNumber(source, match.index)}`)
    }
  }
}

// Plan 220 S1.4b.2: the renderer's UI settings seam refuses a write until the
// window's store holds its snapshot, and smokes seed right after launch or a
// reload, while it is still hydrating (smoke:agent-mcp, smoke:buddy-act and
// smoke:record-latency failed at step 1). Every seed gets the seam through
// the shared wait in lib/renderer-profile-seed.mjs; a script only reads it
// directly (a poll: before the snapshot every key reads null).
test('every UI settings seed waits for the window store before it writes', () => {
  const seedHelper = join(scriptsRoot, 'lib', 'renderer-profile-seed.mjs')
  const direct = []
  const unawaited = []
  for (const path of scriptFiles()) {
    if (path === seedHelper) continue
    const source = readFileSync(path, 'utf8')
    for (const match of source.matchAll(/__videorcUiSettings(.{0,10})/g)) {
      if (!/^\?\.getItem\(/.test(match[1])) {
        direct.push(`${relativeScriptPath(path)}:${lineNumber(source, match.index)}`)
      }
    }
    for (const match of source.matchAll(
      /(.{0,8})\$\{(UI_SETTINGS_READY_JS|uiSettingsReadyJs\()/g
    )) {
      if (!/\bawait\s+$/.test(match[1])) {
        unawaited.push(`${relativeScriptPath(path)}:${lineNumber(source, match.index)}`)
      }
    }
  }
  assert.deepEqual(
    direct,
    [],
    'Write through seedUiSettingsJs, reloadKeepingSeedJs or `await ${UI_SETTINGS_READY_JS}` (scripts/lib/renderer-profile-seed.mjs), never window.__videorcUiSettings itself.'
  )
  assert.deepEqual(unawaited, [], 'The UI settings wait is a promise: await it.')
})

function scriptFiles(directory = scriptsRoot) {
  const paths = []
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) {
      paths.push(...scriptFiles(path))
    } else if (entry.name.endsWith('.mjs') && !entry.name.endsWith('.test.mjs')) {
      paths.push(path)
    }
  }
  return paths
}

function relativeScriptPath(path) {
  return path.slice(repoRoot.length + 1)
}

function lineNumber(source, index) {
  return source.slice(0, index).split('\n').length
}
