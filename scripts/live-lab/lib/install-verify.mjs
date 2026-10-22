import { join } from 'node:path'

import { refuse } from './install-runner.mjs'

// Plan 178 U5. The lab installs only a Videorc.app signed with the Videorc
// Developer ID. Developer ID keeps the designated requirement stable across
// builds, so macOS TCC keeps the Screen Recording, Microphone and System Audio
// grants after a swap. An ad-hoc signature changes with every build and the
// grants silently stop applying.

export const LAB_TEAM_ID = 'C2PA37RB58'

// `codesign -dv --verbose=4` prints key=value lines on stderr.
export function parseCodesignDetails(text) {
  const details = { identifier: null, teamId: null, adhoc: false, authorities: [] }
  for (const line of String(text).split(/\r?\n/)) {
    const index = line.indexOf('=')
    if (index < 0) continue
    const key = line.slice(0, index).trim()
    const value = line.slice(index + 1).trim()
    if (key === 'Identifier') details.identifier = value
    if (key === 'TeamIdentifier') details.teamId = value === 'not set' ? null : value
    if (key === 'Signature' && value === 'adhoc') details.adhoc = true
    if (key === 'Authority') details.authorities.push(value)
    if (key === 'flags' && /\badhoc\b/.test(value)) details.adhoc = true
  }
  return details
}

function lastLines(text, count = 4) {
  return String(text).trim().split(/\r?\n/).slice(-count).join(' | ')
}

export async function readBundleVersion(runner, appPath) {
  const result = await runner('/usr/bin/plutil', [
    '-extract',
    'CFBundleShortVersionString',
    'raw',
    '-o',
    '-',
    join(appPath, 'Contents', 'Info.plist')
  ])
  return result.code === 0 ? result.stdout.trim() : null
}

// Throws InstallRefusal on the first failed check. `gatekeeper` is true for
// notarized release builds; lab candidates are not notarized, so instead the
// app must carry no quarantine flag (a quarantined, un-notarized app would
// not launch, which is plan 178 U5's STOP condition, not something to strip).
export async function verifyApp(
  runner,
  appPath,
  { teamId = LAB_TEAM_ID, gatekeeper, expectedVersion = null }
) {
  const strict = await runner('codesign', [
    '--verify',
    '--deep',
    '--strict',
    '--verbose=2',
    appPath
  ])
  if (strict.code !== 0) {
    refuse(
      'codesign-invalid',
      `codesign --verify --deep --strict failed: ${lastLines(strict.stderr || strict.stdout)}`
    )
  }

  const display = await runner('codesign', ['-dv', '--verbose=4', appPath])
  const details = parseCodesignDetails(`${display.stderr}\n${display.stdout}`)
  if (display.code !== 0) {
    refuse('codesign-unreadable', `codesign -dv failed: ${lastLines(display.stderr)}`)
  }
  if (details.adhoc) {
    refuse(
      'adhoc-signature',
      'The app is ad-hoc signed (Signature=adhoc). The lab refuses it: an ad-hoc signature changes with every build, so macOS TCC would drop the Screen Recording, Microphone and System Audio grants. Use a Developer-ID-signed candidate from lab-candidate-macos.yml.'
    )
  }
  if (details.teamId !== teamId) {
    refuse(
      'wrong-team',
      `The app is signed by team ${details.teamId ?? '(none)'}, expected ${teamId}. Refusing to install it.`
    )
  }
  if (!details.authorities.some((authority) => authority.startsWith('Developer ID Application:'))) {
    refuse('not-developer-id', 'The app is not signed with a Developer ID Application certificate.')
  }

  let gatekeeperResult = 'skipped (candidate is not notarized)'
  if (gatekeeper) {
    const assessment = await runner('spctl', ['-a', '-vv', '-t', 'exec', appPath])
    const output = `${assessment.stderr}\n${assessment.stdout}`
    if (assessment.code !== 0 || !/\baccepted\b/.test(output)) {
      refuse('gatekeeper-rejected', `spctl rejected the app: ${lastLines(output)}`)
    }
    gatekeeperResult = /source=([^\n]+)/.exec(output)?.[1]?.trim() ?? 'accepted'
  } else {
    const quarantine = await runner('xattr', ['-p', 'com.apple.quarantine', appPath])
    if (quarantine.code === 0) {
      refuse(
        'quarantined-candidate',
        'The candidate carries the com.apple.quarantine flag and is not notarized, so macOS would block its launch. Plan 178 U5 says STOP here: report it, do not strip the flag.'
      )
    }
  }

  const version = await readBundleVersion(runner, appPath)
  if (expectedVersion !== null && version !== expectedVersion) {
    refuse(
      'version-mismatch',
      `The app reports version ${version ?? '(unreadable)'}, expected ${expectedVersion}.`
    )
  }

  return { teamId: details.teamId, version, gatekeeper: gatekeeperResult }
}
