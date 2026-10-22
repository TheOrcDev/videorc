/**
 * A contract violation in the engine's answer is an internal mismatch, not
 * something the user can act on: keep the raw schema path out of toasts and
 * the Ready panel and log it for diagnostics instead (plan 0015).
 */
export function streamOutputCheckFailureMessage(error: unknown): string {
  if (error instanceof Error && error.name === 'RuntimeSchemaError') {
    console.warn(`[stream-output-check] engine answer rejected: ${error.message}`)
    return "Videorc's engine sent an answer this version can't read. Restart Videorc and try again."
  }
  return error instanceof Error ? error.message : "The livestream output path couldn't be verified."
}
