#!/usr/bin/env node
// Plan 178 U10 step 1. Start an on-demand live-lab run on the lab machine
// from any dev machine.
//
//   pnpm live:remote --host <ssh-host> --scenario <name>
//        [--build release|candidate:<run-id|sha>] [--privacy unlisted]
//        [--params '<json>'] [--ref <harness ref, default origin/main>]
//        [--out <dir>] [--publish]
//
// SSH (BatchMode, no agent or X11 forwarding) to the lab user, check out the
// harness ref in ~/videorc, reinstall dependencies only when the lockfile
// changed, install a candidate if asked, run `live:run --trigger on-demand`,
// stream its lines back, then copy back only verdict.json, report.md,
// charts/ and frames/ after the publish guard passes, into
// ~/videorc-live-lab/remote-runs/<runId> (or --out). --publish also runs
// live:publish for the run on the lab machine. The lab's policy decides
// whether the run may start; a refusal is printed as REFUSED (<reason>).
//
// Exit codes: run.mjs's 0 / 1 / 2 / 3; 4 copy-back failed or refused;
// 5 SSH or the lab-side setup failed before a run started; 64 bad arguments. Ctrl-C detaches
// only: a started run keeps going under the lab's kill switches (stop it with
// `ssh <host> touch ~/videorc-live-lab/STOP`).
//
// On the lab machine the same file runs as `remote.mjs --lab-side ...`
// (invoked by the SSH script; not for humans).

import { access } from 'node:fs/promises'
import { join, resolve } from 'node:path'

import { workDir } from './lib/config.mjs'
import { stopFilePath } from './lib/kill-switch.mjs'
import { loadPolicy } from './lib/policy.mjs'
import { loadRedactor } from './lib/publish-guard.mjs'
import {
  RemoteUsageError,
  parseLabSideArgs,
  parseRemoteArgs,
  runLabSide,
  runRemote,
  spawnLines
} from './lib/remote.mjs'
import { acquireRunLock, releaseRunLock } from './lib/run-lock.mjs'

const USAGE = `Usage: pnpm live:remote --host <ssh-host> --scenario <name>
        [--build release|candidate:<run-id|sha>] [--privacy unlisted]
        [--params '<json, max 4 KB>'] [--ref <harness ref, default origin/main>]
        [--out <dir>] [--publish]`

const repoRoot = resolve(import.meta.dirname, '..', '..')

async function labSide(argv) {
  const options = parseLabSideArgs(argv)
  const work = workDir()
  let current = null
  // An SSH drop must never take a live run down with it: ignore SIGHUP and
  // broken pipes; the run itself sits in its own process group.
  process.on('SIGHUP', () => {})
  process.stdout.on('error', () => {})
  process.stderr.on('error', () => {})
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => current?.kill('SIGTERM'))
  }
  const safe = (stream) => (line) => {
    try {
      stream.write(`${line}\n`)
    } catch {
      // The SSH session is gone; the run carries on.
    }
  }
  const runNode = (script, args, { onStdout, onStderr, detached = false } = {}) =>
    spawnLines(process.execPath, [script, ...args], {
      cwd: repoRoot,
      env: process.env,
      detached,
      onStdout,
      onStderr,
      onChild: (child) => {
        current = child
      }
    })
  return runLabSide({
    options,
    scripts: {
      install: join(repoRoot, 'scripts', 'live-lab', 'install.mjs'),
      run: join(repoRoot, 'scripts', 'live-lab', 'run.mjs'),
      publish: join(repoRoot, 'scripts', 'live-lab', 'publish.mjs')
    },
    runNode,
    loadPolicy: () => loadPolicy(),
    stopFileExists: async () => {
      try {
        await access(stopFilePath(work))
        return true
      } catch {
        return false
      }
    },
    acquireLock: (runId) => acquireRunLock({ dir: work, runId }),
    releaseLock: (runId) => releaseRunLock({ dir: work, runId, pid: process.pid }),
    print: safe(process.stdout),
    printErr: safe(process.stderr)
  })
}

async function local(argv) {
  const options = parseRemoteArgs(argv)
  if (options.help) {
    console.log(USAGE)
    return 0
  }
  const redactor = await loadRedactor()
  if (!redactor) {
    console.error(
      'live:remote: REDACTION_UNAVAILABLE (scripts/live-lab/lib/redact.mjs is missing); nothing would be copied back'
    )
    return 4
  }
  let detached = false
  process.on('SIGINT', () => {
    if (detached) process.exit(130)
    detached = true
    console.error(
      `\nlive:remote: detached. A started run keeps going under the lab's kill switches; stop it with: ssh ${options.host} touch ~/videorc-live-lab/STOP`
    )
  })
  return runRemote({
    options,
    redactor,
    outRoot: join(workDir(), 'remote-runs'),
    ssh: (args, handlers) => spawnLines('ssh', args, handlers),
    scp: (args) => spawnLines('scp', args, { onStderr: (line) => console.error(`[scp] ${line}`) })
  })
}

const argv = process.argv.slice(2)
try {
  process.exitCode = argv.includes('--lab-side') ? await labSide(argv) : await local(argv)
} catch (error) {
  if (error instanceof RemoteUsageError) {
    console.error(`live:remote: ${error.message}\n${USAGE}`)
    process.exitCode = 64
  } else {
    console.error(`live:remote failed: ${error.message}`)
    process.exitCode = 1
  }
}
