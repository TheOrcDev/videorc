import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

import { readPackagedBuildFlags } from './packaged-app-hardening.mjs'

function identity(executable) {
  return Object.fromEntries(
    [executable, join(dirname(executable), 'resources', 'app.asar')].map((path) => [
      path,
      createHash('sha256').update(readFileSync(path)).digest('hex')
    ])
  )
}

/** Build a separate CDP-enabled directory; never repack the installer under test. */
export function runWindowsRecoveryTestBuild({
  repoRoot,
  productionExecutable,
  testDirectory,
  viteCli,
  builderCli,
  env,
  run,
  readIdentity = identity,
  readFlags = (path) => readPackagedBuildFlags(path, 'win32')
}) {
  const production = resolve(productionExecutable)
  const output = resolve(testDirectory)
  const productionDirectory = dirname(production)
  for (const [parent, child] of [
    [productionDirectory, output],
    [output, productionDirectory]
  ]) {
    const path = relative(parent, child)
    if (!isAbsolute(path) && path !== '..' && !path.startsWith(`..${sep}`)) {
      throw new Error('Recovery test output must be outside the production package.')
    }
  }
  const desktop = join(repoRoot, 'apps', 'desktop')
  const testExecutable = join(output, 'win-unpacked', 'Videorc.exe')
  const check = join(repoRoot, 'scripts', 'check-packaged-app.mjs')
  const original = readIdentity(production)
  run([check, '--app', production], { cwd: repoRoot, env })
  if (readFlags(production)?.packagedTestHooks !== false) {
    throw new Error('The installer under test must be a production build.')
  }
  try {
    const buildEnv = {
      ...env,
      VIDEORC_PACKAGED_TEST_HOOKS: '1',
      CSC_IDENTITY_AUTO_DISCOVERY: 'false'
    }
    run([viteCli, 'build'], { cwd: desktop, env: buildEnv })
    run(
      [
        builderCli,
        '--win',
        'dir',
        '--publish',
        'never',
        '--config',
        'electron-builder.yml',
        `--config.directories.output=${output}`
      ],
      { cwd: desktop, env: buildEnv }
    )
    run([check, '--app', testExecutable, '--allow-test-hooks'], { cwd: repoRoot, env })
    if (readFlags(testExecutable)?.packagedTestHooks !== true) {
      throw new Error('Recovery smoke requires a separate packaged test build with CDP enabled.')
    }
    const testIdentity = readIdentity(testExecutable)
    run([join(repoRoot, 'scripts', 'smoke-windows-main-window-recovery.mjs')], {
      cwd: repoRoot,
      env: { ...env, VIDEORC_PERF_APP_EXECUTABLE: testExecutable }
    })
    return { production: original, test: testIdentity, evidenceKind: 'packaged-test-build' }
  } finally {
    if (JSON.stringify(readIdentity(production)) !== JSON.stringify(original)) {
      throw new Error('The production package changed during recovery testing.')
    }
  }
}
