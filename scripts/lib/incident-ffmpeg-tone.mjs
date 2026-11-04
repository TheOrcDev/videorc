// The backend's FFmpeg incident tone (`VIDEORC_INCIDENT_FFMPEG_TONE=1`) is a
// debug-build control: `incident_ffmpeg_tone_allowed` in recording.rs ignores
// it in a release backend, and then a no-microphone session carries paced
// zeros instead of the tone. A smoke that gates digital-zero runs would report
// every combo as an audio dropout (#1089), so it refuses up front instead.

/** The health event the backend emits when a session really carries the tone. */
export const INCIDENT_FFMPEG_TONE_EVENT = 'incident-ffmpeg-tone-enabled'

/**
 * Why a dev-app launch that asks for the incident tone must not start, or
 * null: the release dev backend would silently drop the tone. Pure for the
 * unit test.
 */
export function releaseBackendIncidentToneRefusal(env = {}, processEnv = process.env) {
  const profile = env.VIDEORC_DEV_BACKEND_PROFILE ?? processEnv.VIDEORC_DEV_BACKEND_PROFILE
  if (profile !== 'release') return null
  const tone = env.VIDEORC_INCIDENT_FFMPEG_TONE ?? processEnv.VIDEORC_INCIDENT_FFMPEG_TONE
  if (tone !== '1') return null
  return (
    'VIDEORC_INCIDENT_FFMPEG_TONE only works with the debug backend; with ' +
    'VIDEORC_DEV_BACKEND_PROFILE=release the backend ignores it, the session carries ' +
    'silence, and every digital-zero gate fails. Unset VIDEORC_DEV_BACKEND_PROFILE ' +
    '(or set it to debug) for this smoke.'
  )
}

/**
 * Why a session that asked for the incident tone is not carrying it, or null
 * when its health events include the tone event. Pure for the unit test.
 */
export function incidentToneMissingFailure(healthEvents) {
  const events = healthEvents?.events ?? []
  if (events.some((event) => event?.code === INCIDENT_FFMPEG_TONE_EVENT)) return null
  return (
    `the session has no ${INCIDENT_FFMPEG_TONE_EVENT} health event, so it carries silence ` +
    'instead of the FFmpeg tone and every digital-zero gate would fail. The backend ' +
    'enables the tone only in a debug build, with VIDEORC_ENABLE_SMOKE_RPC=1 and no ' +
    'microphone requested or resolved.'
  )
}
