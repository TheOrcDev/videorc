import { DEV_BACKEND_PREBUILD_TIMEOUT_MS } from './app-launcher.mjs'
import { withLiveAwareBuildSlot } from './host-lock.mjs'
import { spawnProcessGroup } from './process-group.mjs'

/**
 * Compile the exact test target under the shared build admission/budget, then
 * give execution its own 600s. An invocation already using --no-run returns
 * the build output (e.g. Cargo JSON containing the runtime test executable).
 * SKIP_PREBUILD applies to dev-app builds only: test targets always take a slot.
 */
export async function runSmokeCargoTest(
  args,
  {
    cwd,
    env = process.env,
    capture = false,
    log = console.log,
    buildSlot = withLiveAwareBuildSlot,
    run = runCargo
  } = {}
) {
  if (args[0] !== 'test') throw new Error('Smoke Cargo helper requires cargo test arguments')
  const separator = args.indexOf('--')
  const cargoEnd = separator === -1 ? args.length : separator
  const buildOnly = args.slice(0, cargoEnd).includes('--no-run')
  const buildArgs = buildOnly
    ? [...args]
    : [...args.slice(0, cargoEnd), '--no-run', ...args.slice(cargoEnd)]
  const configured = Number(
    env.VIDEORC_SMOKE_PREBUILD_TIMEOUT_MS ?? DEV_BACKEND_PREBUILD_TIMEOUT_MS
  )
  const timeoutMs =
    Number.isFinite(configured) && configured > 0 ? configured : DEV_BACKEND_PREBUILD_TIMEOUT_MS
  const options = { cwd, env, capture }
  const built = await buildSlot(
    async () => {
      const startedAt = Date.now()
      log(
        `[smoke:prebuild] cargo ${buildArgs.join(' ')} (timeout ${Math.round(timeoutMs / 1000)}s)`
      )
      const output = await run(buildArgs, { ...options, timeoutMs })
      log(`[smoke:prebuild] test target built in ${Math.round((Date.now() - startedAt) / 1000)}s`)
      return output
    },
    { env, log }
  )
  if (buildOnly) return built
  log('[smoke:test] cargo test (timeout 600s; test target precompiled)')
  return run(args, { ...options, timeoutMs: 600_000 })
}

async function runCargo(args, { cwd, env, capture, timeoutMs }) {
  const { child, result } = spawnProcessGroup('cargo', args, {
    cwd,
    env,
    stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    timeoutMs
  })
  const stdout = []
  const stderr = []
  if (capture) {
    child.stdout.on('data', (chunk) => stdout.push(chunk))
    child.stderr.on('data', (chunk) => stderr.push(chunk))
  }
  const { status, signal, error, timedOut, interrupted } = await result
  if (error) throw error
  if (interrupted) {
    const failure = new Error('cargo test interrupted')
    failure.name = 'AbortError'
    throw failure
  }
  if (timedOut || status !== 0) {
    throw new Error(
      `${timedOut ? `cargo test exceeded ${timeoutMs / 1000}s` : `cargo test exited ${status ?? signal}`}\n` +
        Buffer.concat(stderr).toString() +
        Buffer.concat(stdout).toString()
    )
  }
  return Buffer.concat(stdout)
}
