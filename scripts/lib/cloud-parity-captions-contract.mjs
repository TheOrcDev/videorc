import { createHash } from 'node:crypto'
/** Measures actual decoded screenshot pixels; receipts alone are insufficient. */
export function captionPixels(rgb) {
  if (!Buffer.isBuffer(rgb) || rgb.length < 3 || rgb.length % 3)
    throw new Error('Invalid decoded RGB picture')
  let ink = 0
  for (let i = 0; i < rgb.length; i += 3)
    if (rgb[i] > 200 && rgb[i + 1] > 200 && rgb[i + 2] > 200) ink++
  return { ink, sha256: createHash('sha256').update(rgb).digest('hex') }
}
export function assessCaptionEvidence(report) {
  const required = [
    'off-with-live-guest-audio',
    'muted-host-guests-still-publishing',
    'consent-withdrawn',
    'room-closed'
  ]
  const failures = required.filter(
    (name) =>
      !report?.steps?.some(
        (s) => s.name === name && s.zeroUpload === true && s.zeroGuestCommands === true
      )
  )
  if (
    !report?.steps?.some(
      (s) => s.name === 'partial-final-and-transcript' && s.canonicalFinals === 1
    )
  )
    failures.push('canonical-final')
  if (
    !Array.isArray(report?.artifacts) ||
    report.artifacts.length < 4 ||
    report.artifacts.some(
      (a) =>
        a.kind !== 'actual-program-caption-pixels' ||
        a.ink <= 30 ||
        !/^[a-f0-9]{64}$/.test(a.sha256)
    )
  )
    failures.push('program-pixels')
  for (const name of ['listen-only-muted', 'listen-consent-withdrawn', 'restart-with-room-closed'])
    if (!report?.steps?.some((s) => s.name === name && s.zeroUpload && s.zeroGuestCommands))
      failures.push(name)
  if (
    !report?.steps?.some(
      (s) => s.name === 'independent-output-pixels' && s.streamOnly && s.recordingOnly
    )
  )
    failures.push('independent-output-pixels')
  if (!report?.steps?.some((s) => s.name === 'durable-restart' && s.cues > 0))
    failures.push('durable-restart')
  if (!report?.steps?.some((s) => s.name === 'listen-only-host' && s.uploaded))
    failures.push('listen-only-host')
  if (
    !report?.steps?.some(
      (s) =>
        s.name === 'local-cue-timing' &&
        [s.partialToPaintMs, s.finalToPaintMs].every(
          (n) => Number.isFinite(n) && n >= 0 && n < 5000
        )
    )
  )
    failures.push('local-cue-timing')
  return {
    status: failures.length ? 'failed' : 'passed',
    failures,
    productionQualified: false,
    managed: 'not-run',
    devices: 'not-run',
    showClockUncertaintyMs: null
  }
}
