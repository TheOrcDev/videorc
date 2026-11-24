/**
 * The command line of the Rust UI baseline (plan 220 S0.1a): `--baseline` runs
 * the shooter, `--baseline-manifest` writes the committed manifest from a
 * folder's logs. See the header of scripts/capture-ui-pages.mjs.
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { arch, homedir, platform, release } from 'node:os'
import { join, resolve } from 'node:path'

import { repoRoot } from './app-launcher.mjs'
import {
  BASELINE_LOOKS,
  manifestFromFolder,
  manifestProblems
} from './rust-ui-baseline-manifest.mjs'
import { parseSizes, UI_SWEEP_SIZES } from './ui-layout-check.mjs'

const today = () => new Date().toISOString().slice(0, 10)

/** `dark,dark-contrast` to looks; throws on anything else. */
export function parseLooks(value) {
  return value.split(',').map((part) => {
    const look = BASELINE_LOOKS.find(
      (candidate) =>
        `${candidate.theme}${candidate.contrast === 'more' ? '-contrast' : ''}` === part.trim()
    )
    if (!look)
      throw new Error(`A look is dark, light, dark-contrast or light-contrast, got ${part}`)
    return look
  })
}

export async function runBaselineCli({ arg, flag }) {
  const date = arg('baseline-date') ?? today()
  const folder = resolve(
    (arg('baseline-out') ?? join(homedir(), 'videorc-gpui-baseline', date)).replace(/^~/, homedir())
  )
  const appCommit = execFileSync('git', ['-C', repoRoot, 'rev-parse', 'HEAD'], {
    encoding: 'utf8'
  }).trim()
  if (flag('baseline-manifest')) {
    const manifest = manifestFromFolder(folder, {
      appCommit: arg('app-commit') ?? appCommit,
      date,
      host: `${platform()} ${release()} ${arch()}`
    })
    const problems = manifestProblems(manifest, folder)
    const target = join(repoRoot, 'docs', 'gpui', 'baseline-manifest.json')
    mkdirSync(join(target, '..'), { recursive: true })
    writeFileSync(target, `${JSON.stringify(manifest, null, 2)}\n`)
    console.log(
      `${manifest.entries.length} entries, ${manifest.missing.length} missing lines: ${target}`
    )
    for (const problem of problems) console.log(`PROBLEM ${problem}`)
    process.exit(problems.length > 0 && flag('gate') ? 1 : 0)
  }
  const { runBaseline } = await import('./rust-ui-baseline.mjs')
  const parts = (arg('parts') ?? 'idle,windows,live,first-run').split(',').filter(Boolean)
  const only = arg('screens')?.split(',').filter(Boolean) ?? null
  const looks = arg('looks') ? parseLooks(arg('looks')) : BASELINE_LOOKS
  const sizes = arg('sizes') ? parseSizes(arg('sizes')) : UI_SWEEP_SIZES
  console.log(`Baseline of ${appCommit} into ${folder} (parts ${parts.join(', ')})`)
  // First run (and the signed-in Buddy run) each need their own launch: the
  // first-run decision is made at load, and the account is an environment.
  const runs = [
    parts.filter((part) => part !== 'first-run' && part !== 'buddy'),
    ...parts.filter((part) => part === 'first-run' || part === 'buddy').map((part) => [part])
  ].filter((run) => run.length > 0)
  const failures = []
  for (const run of runs) {
    const result = await runBaseline({ out: folder, appCommit, only, looks, sizes, parts: run })
    failures.push(...result.failures)
  }
  console.log(`\n${failures.length} step failures${failures.length ? ':' : '.'}`)
  for (const failure of failures) console.log(`  ${failure.what}: ${failure.reason}`)
}
