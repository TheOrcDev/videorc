import { existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join, resolve } from 'node:path'

const root = resolve(new URL('..', import.meta.url).pathname)
const appPath = resolve(root, 'apps/desktop/release/mac-arm64/Videorc.app')
const entitlements = resolve(root, 'apps/desktop/build-resources/entitlements.mac.plist')
const identity =
  process.env.VIDEORC_MACOS_SIGN_IDENTITY ?? 'Developer ID Application: Uros Miric (C2PA37RB58)'

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: 'utf8',
    stdio: options.capture ? 'pipe' : 'inherit'
  })
  if (result.status !== 0) {
    const output = [result.stdout, result.stderr].filter(Boolean).join('\n').trim()
    throw new Error(`${command} ${args.join(' ')} failed.${output ? `\n${output}` : ''}`)
  }
  return result
}

function assertExists(path, label) {
  if (!existsSync(path)) {
    throw new Error(`${label} is missing: ${path}`)
  }
}

assertExists(appPath, 'Packaged Videorc.app')
assertExists(entitlements, 'macOS entitlements')

const identityList = run('security', ['find-identity', '-v', '-p', 'codesigning'], {
  capture: true
}).stdout
if (!identityList.includes(identity)) {
  throw new Error(
    `Signing identity not found: ${identity}\nSet VIDEORC_MACOS_SIGN_IDENTITY or install the local Developer ID certificate.`
  )
}

const toolPaths = [
  join(appPath, 'Contents/Resources/videorc-backend'),
  join(appPath, 'Contents/Resources/native_preview_host_helper'),
  join(appPath, 'Contents/Resources/videorc_native_preview.node'),
  join(appPath, 'Contents/Resources/ffmpeg/bin/ffmpeg'),
  join(appPath, 'Contents/Resources/ffmpeg/bin/ffprobe')
]

for (const toolPath of toolPaths) {
  assertExists(toolPath, 'Bundled executable')
  run('codesign', [
    '--force',
    '--options',
    'runtime',
    '--entitlements',
    entitlements,
    '--sign',
    identity,
    toolPath
  ])
}

run('codesign', [
  '--force',
  '--deep',
  '--options',
  'runtime',
  '--entitlements',
  entitlements,
  '--sign',
  identity,
  appPath
])

run('codesign', ['--verify', '--deep', '--strict', '--verbose=2', appPath])

console.log(`sign-macos-local-app: signed ${appPath}`)
