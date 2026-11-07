/** A recovered, decodable fragment is not a successful Record/Stop cycle. */
export function assessAgentRecordingCompletion(session, sessionId) {
  const failures = []
  if (!sessionId || session?.id !== sessionId) failures.push('the recording session is missing')
  if (session?.status !== 'completed') failures.push('the recording did not complete normally')
  if (session?.interruptionRecovery != null) {
    failures.push(`the recording was interrupted (${session.interruptionRecovery})`)
  }
  if (
    session?.finalizationError ||
    (session?.finalizationState != null && session.finalizationState !== 'finalized')
  ) {
    failures.push('the recording did not finalize normally')
  }
  if (typeof session?.mp4Path !== 'string' || session.mp4Path.length === 0) {
    failures.push('the recording has no published MP4')
  }
  return { pass: failures.length === 0, failures }
}
