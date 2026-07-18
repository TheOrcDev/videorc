import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import test from 'node:test'

const repoRoot = resolve(import.meta.dirname, '..', '..')
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

test('every direct smoke command HTTP caller sends the per-run bearer capability', () => {
  const unauthenticated = []

  for (const path of scriptFiles()) {
    const source = readFileSync(path, 'utf8')
    for (const match of source.matchAll(/\/command\b|\/health\b|\/preview-frame\.png\b/g)) {
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
  const allowed = new Set([...allowlistBlock[1].matchAll(/'([^']+)'/g)].map((match) => match[1]))
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

  const unlisted = [...callers.keys()].filter((command) => !allowed.has(command)).sort()
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
