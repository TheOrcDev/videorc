// Lines from the dev app that a Linux smoke log must always carry (Plan 0009):
// the backend's exact VAAPI probe command (the doc promises testers can copy
// and bisect it verbatim) and the backend prebuild progress.

const LINUX_SMOKE_EVIDENCE = /VAAPI probe on |^\[smoke:prebuild\] /

export function isLinuxSmokeEvidenceLine(line) {
  return typeof line === 'string' && LINUX_SMOKE_EVIDENCE.test(line)
}
