import { mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { spawnProcessGroup } from './lib/process-group.mjs'
import { prepareSpeechFixture, rnnoisePassEnv } from './lib/rnnoise-speech-fixture.mjs'

// `pnpm smoke:rnnoise`: the tone pass, then the speech pass, each its own app
// launch, because the backend reads the speech fixture when its microphone
// source starts. The tone proves suppression; the speech pass proves speech
// survives it and that mute and unmute act on processed audio
// (docs/rnnoise.md). VIDEORC_RNNOISE_TEST_PCM_PATH supplies the speech;
// without it, macOS `say` speaks a sentence and FFmpeg converts it into a temp
// file that is deleted at the end. The reports keep its source and SHA-256.
//
// Platform policy: macOS only. The native microphone fixture is the macOS
// debug build's, so elsewhere the smoke says SKIPPED and exits 0, like the
// other macOS-only members of smoke:local-gates. On macOS, a missing `say` or
// FFmpeg fails the smoke: the speech pass is never skipped there.

const passSmoke = resolve(import.meta.dirname, 'smoke-rnnoise-app.mjs')
const outputDirectory = resolve(
  process.env.VIDEORC_SMOKE_OUTPUT_DIR ?? join(tmpdir(), `videorc-rnnoise-${Date.now()}`)
)
const summaryPath = join(outputDirectory, 'rnnoise-smoke.json')

if (process.platform !== 'darwin') {
  console.log('RNNoise smoke SKIPPED: the native microphone fixture it records from is macOS only.')
  process.exit(0)
}

const summary = { pass: false, passes: [], fixture: null }
let fixture = null
mkdirSync(outputDirectory, { recursive: true })
try {
  // Before the first launch, so a missing `say` or a bad file fails in seconds.
  fixture = prepareSpeechFixture()
  summary.fixture = fixture.record
  for (const pass of ['tone', 'speech']) {
    const passDirectory = join(outputDirectory, pass)
    const { exitCode, interrupted } = await runPass(
      rnnoisePassEnv(process.env, {
        pass,
        outputDirectory: passDirectory,
        fixturePath: fixture.path,
        fixtureSource: fixture.record.source
      })
    )
    const ok = exitCode === 0 && !interrupted
    summary.passes.push({
      pass,
      ok,
      exitCode,
      ...(interrupted ? { interrupted } : {}),
      report: join(passDirectory, 'rnnoise-artifact.json')
    })
    if (!ok) {
      // The speech pass runs only after the tone pass passes.
      if (pass === 'tone') summary.passes.push({ pass: 'speech', ok: false, skipped: 'tone pass' })
      break
    }
  }
  summary.pass = summary.passes.length === 2 && summary.passes.every(({ ok }) => ok)
} catch (error) {
  summary.error = error instanceof Error ? error.message : String(error)
  console.error(`RNNoise smoke FAILED: ${summary.error}`)
} finally {
  writeFileSync(summaryPath, `${JSON.stringify(summary, null, 2)}\n`)
  fixture?.cleanup()
}
console.log(
  `RNNoise smoke ${summary.pass ? 'PASS' : 'FAILED'} (tone, then ${summary.fixture?.source ?? 'no'} speech). ` +
    `Evidence: ${summaryPath}`
)
process.exit(summary.pass ? 0 : 1)

/** One pass in its own process group: Ctrl-C stops it, and the temp files still go. */
async function runPass(env) {
  const { result } = spawnProcessGroup(process.execPath, [passSmoke], {
    env,
    // Its own process group never reads the terminal.
    stdio: ['ignore', 'inherit', 'inherit']
  })
  const { status, signal, error, interrupted } = await result
  if (error) throw error
  return { exitCode: signal ? 1 : (status ?? 1), interrupted }
}
