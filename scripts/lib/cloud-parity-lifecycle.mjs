/** Deferred S16 acceptance runner. This is intentionally NOT a unit-test import.
 * Uses maintained fake-provider/ownership fixtures plus the real local room
 * control baseline. Never activates managed egress or a public provider.
 * Source/fixture evidence is reported separately from managed qualification.
 */
import { spawn } from 'node:child_process'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { runBaseline } from './cloud-parity-baseline.mjs'

function run(cwd, command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: 'inherit' })
    child.once('error', reject)
    child.once('exit', (code, signal) => {
      if (code === 0) resolve()
      else reject(new Error(`Lifecycle fixture failed: ${command}, exit ${code}, signal ${signal}`))
    })
  })
}

export async function runLifecycle({ desktopRoot, webRoot }) {
  // The real room/guest/program fixture verifies independent live/record stops.
  // Scheduled-provider requests are verified by local fakes, not live APIs.
  await run(webRoot, process.execPath, [
    '--import',
    'tsx',
    '--test',
    'tests/cloud-provider-lifecycle.test.ts',
    'tests/cloud-managed-end-order.test.ts',
    'tests/cloud-managed-talk-egress.test.ts',
    'tests/cloud-managed-egress-dies.test.ts',
    'tests/cloud-managed-ended-cleanup.test.ts',
    'tests/cloud-managed-deadlines.test.ts'
  ])
  await run(join(desktopRoot, 'apps/desktop'), process.execPath, [
    'node_modules/vitest/vitest.mjs',
    'run',
    'src/renderer/src/lib/cloud-provider-lifecycle.test.ts',
    'src/renderer/src/lib/scheduled-streams.test.ts',
    'src/renderer/src/lib/talk-show-session.test.ts'
  ])
  for (const filter of [
    'scheduled_streams_service::tests',
    'scheduled_streams_service::x_tests',
    'ending_acknowledgement_survives_the_web_control_adapter',
    'provider_output::tests',
    'explicit_end_keeps_the_output_until_the_web_confirms'
  ]) {
    await run(desktopRoot, 'cargo', ['test', '-p', 'videorc-backend', filter])
  }
  const baseline = await runBaseline({ desktopRoot, webRoot, controls: true })
  await writeFile(
    join(baseline.output, 'lifecycle.json'),
    JSON.stringify(
      {
        slice: 'S16',
        fakeProviders: 'passed',
        localRoomControls: 'passed',
        scheduledMetadataAndThumbnail: 'fake-provider-tested',
        managedProviderIntegration: 'not-run',
        realPublicBroadcasts: 'not-run',
        serverProviderAuthority: 'disabled-without-explicit-consent'
      },
      null,
      2
    )
  )
  return baseline
}
