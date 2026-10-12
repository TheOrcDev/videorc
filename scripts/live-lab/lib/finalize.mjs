import { writeRunReport } from './report.mjs'
import { verdictForRun } from './verdict.mjs'

// Plan 178 U9 step 6. The one entry point that turns a finished run folder
// into verdict.json + report.md + charts. live:run calls it after teardown
// and before the run lock is released; `node scripts/live-lab/verdict.mjs`
// calls it offline. Frame checks run against the clips in the folder.

export async function finalizeRunFolder({
  runDir,
  thresholdsPath,
  thresholds,
  charts = true,
  frameChecks,
  runFrames
} = {}) {
  const { run, verdict, series } = await verdictForRun(runDir, {
    thresholdsPath,
    thresholds,
    ...(frameChecks ? { frameChecks } : {}),
    ...(runFrames === undefined ? {} : { runFrames })
  })
  const { written } = await writeRunReport({ runDir, verdict, series, steps: run.steps, charts })
  return { verdict, written, run }
}
