import { waitForCleanProcessState, waitForNoLiveProcessState } from './process-census.mjs'
import { evaluateOwnedTeardown } from './process-endurance.mjs'
import { requestSmokeCommand } from './smoke-command-client.mjs'

// Let Electron retire its GPU, renderer and backend before touching the owned
// process group. Signaling the entire tree first can crash the still-live main
// process while it tries to restart its simultaneously terminated GPU service.
export async function stopFirstRunApp(
  launched,
  ledgerPaths,
  {
    requestQuit = requestSmokeCommand,
    waitNoLive = waitForNoLiveProcessState,
    waitClean = waitForCleanProcessState
  } = {}
) {
  const scope = { ledgerPaths, pgid: launched.process.pid }
  const evidence = {
    clean: false,
    gracefulQuitRequested: true,
    gracefulQuitError: null,
    stopResult: null,
    finalCensus: null
  }
  try {
    const result = await requestQuit(
      launched.connections['preview-motion-ready'],
      'app-quit',
      {},
      { timeoutMs: 1000 }
    )
    if (result?.quitting !== true) throw new Error('App quit was not acknowledged.')
    await waitNoLive({ ...scope, timeoutMs: 10000 })
  } catch (error) {
    evidence.gracefulQuitError = error?.message ?? String(error)
    try {
      evidence.stopResult = await launched.stop()
    } catch (cleanupError) {
      evidence.error = cleanupError?.message ?? String(cleanupError)
    }
  }
  try {
    evidence.finalCensus = await waitClean({ ...scope, timeoutMs: 1000 })
    evidence.clean =
      evidence.finalCensus.records.length === 0 &&
      evidence.finalCensus.processGroupRows.length === 0
  } catch (error) {
    evidence.error = [evidence.error, error?.message ?? String(error)].filter(Boolean).join('; ')
  }
  evidence.controllerExit = {
    code: launched.process.exitCode,
    signal: launched.process.signalCode
  }
  const failures = evaluateOwnedTeardown(evidence)
  if (evidence.controllerExit.code !== 0 || evidence.controllerExit.signal !== null) {
    failures.push('First-run app controller did not exit successfully.')
  }
  return { ...evidence, pass: failures.length === 0, failures }
}
