import { extname } from 'node:path'

const SILENT_AUDIO_PEAK_MAX = 0.001
const SILENT_AUDIO_RMS_MAX = 0.0005

export function evaluateMicrophoneLossContinuity({
  sessionId,
  disconnectResult,
  healthEvents,
  statusAfterLoss,
  stoppedStatus,
  postLossAudio
}) {
  const failures = []
  if (disconnectResult?.disconnected !== true) {
    failures.push('synthetic microphone source did not disconnect')
  }

  const matchingLossEvents = (healthEvents ?? []).filter(
    (event) => event?.sessionId === sessionId && event?.code === 'microphone-input-lost'
  )
  if (matchingLossEvents.length !== 1) {
    failures.push(
      `expected exactly one microphone-input-lost health event, observed ${matchingLossEvents.length}`
    )
  } else if (matchingLossEvents[0].level !== 'warn') {
    failures.push(
      `microphone-input-lost health event was ${matchingLossEvents[0].level ?? 'unclassified'}, not warn`
    )
  }

  if (statusAfterLoss?.state !== 'recording') {
    failures.push(
      `recording did not remain active after microphone loss ` +
        `(state=${statusAfterLoss?.state ?? 'missing'}; ${statusAfterLoss?.message ?? 'no message'})`
    )
  }
  if (stoppedStatus?.state !== 'idle') {
    failures.push(
      `microphone-loss session did not return to idle after user stop ` +
        `(state=${stoppedStatus?.state ?? 'missing'})`
    )
  }
  if (extname(stoppedStatus?.outputPath ?? '').toLowerCase() !== '.mp4') {
    failures.push(
      `microphone-loss session did not produce a finalized MP4 ` +
        `(path=${stoppedStatus?.outputPath ?? 'missing'})`
    )
  }

  if (!(postLossAudio?.sampleCount > 0)) {
    failures.push('post-loss audio tail contained no decodable samples')
  } else if (
    postLossAudio.peak > SILENT_AUDIO_PEAK_MAX ||
    postLossAudio.rms > SILENT_AUDIO_RMS_MAX
  ) {
    failures.push(
      `post-loss padded audio was not silent ` +
        `(peak=${postLossAudio.peak}, rms=${postLossAudio.rms})`
    )
  }
  return failures
}
