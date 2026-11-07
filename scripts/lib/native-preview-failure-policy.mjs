// Only latency failures may enter the smoke's explicitly configured retry path.
export class PreviewLatencyGateBreach extends Error {
  constructor(message) {
    super(message)
    this.name = 'PreviewLatencyGateBreach'
    this.retryable = true
  }
}

export function reportPreviewGateFailure(
  problem,
  { reportOnly = false, warn = console.warn } = {}
) {
  if (reportOnly) {
    warn(`[report-only] ${problem instanceof Error ? problem.message : problem}`)
    return
  }
  throw problem instanceof Error ? problem : new Error(problem)
}

export function assertPreviewGate(check, options) {
  try {
    return check()
  } catch (error) {
    // Keep the original error, including its type and cause, across this boundary.
    reportPreviewGateFailure(error, options)
  }
}
