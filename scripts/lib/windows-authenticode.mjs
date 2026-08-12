// The one Authenticode signature reader for release tooling.
//
// History that mandates a single shared copy: two scripts carried their own
// powershell.exe-based readers, and BOTH failed the same way on real Azure
// Trusted Signing artifacts — Get-AuthenticodeSignature errors are
// non-terminating by default, so a failure left $sig null, the script still
// exited 0, stderr was discarded, and the operator saw
// "status must be Valid, got ." with no cause. The release validator was fixed
// first (#195); the candidate verifier then failed identically during the
// first pilot promotion because it still had the old copy. Import this;
// do not write another reader.

import { spawnSync } from 'node:child_process'

// Prefer pwsh: it is what the signing job itself uses to verify publisher and
// timestamp, so it is the interpreter this repo has actually proven against
// Azure Trusted Signing signatures. powershell.exe stays as a fallback for
// hosts without PowerShell 7.
const SIGNATURE_SHELLS = ['pwsh', 'powershell.exe']

/**
 * Read { status, publisher, timestampPresent } for a signed PE file.
 * Throws with per-shell reasons (exit codes and stderr) when no shell can
 * produce a non-empty status.
 */
export function readAuthenticodeSignature(target) {
  // ErrorActionPreference=Stop matters: without it a failing
  // Get-AuthenticodeSignature is non-terminating, $sig stays null, the script
  // still exits 0, and the caller sees an empty status with no reason.
  const script = [
    "$ErrorActionPreference = 'Stop'",
    '$sig = Get-AuthenticodeSignature -LiteralPath $env:VIDEORC_SIGNATURE_TARGET',
    'if ($null -eq $sig) { throw "Get-AuthenticodeSignature returned nothing for $env:VIDEORC_SIGNATURE_TARGET" }',
    '$publisher = if ($sig.SignerCertificate) { $sig.SignerCertificate.GetNameInfo([System.Security.Cryptography.X509Certificates.X509NameType]::SimpleName, $false) } else { $null }',
    '[pscustomobject]@{ status = [string]$sig.Status; publisher = $publisher; timestampPresent = ($null -ne $sig.TimeStamperCertificate) } | ConvertTo-Json -Compress'
  ].join('; ')

  const failures = []
  for (const shell of SIGNATURE_SHELLS) {
    const result = spawnSync(
      shell,
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script],
      {
        encoding: 'utf8',
        env: { ...process.env, VIDEORC_SIGNATURE_TARGET: target }
      }
    )
    if (result.error?.code === 'ENOENT') {
      failures.push(`${shell}: not installed`)
      continue
    }
    const stdout = result.stdout?.trim() ?? ''
    if (result.status === 0 && stdout) {
      const parsed = JSON.parse(stdout)
      if (parsed.status) {
        return parsed
      }
      failures.push(`${shell}: empty signature status`)
      continue
    }
    // Surface the real reason instead of swallowing it.
    const stderr = result.stderr?.trim() ?? ''
    failures.push(`${shell}: exit ${result.status}${stderr ? ` — ${stderr}` : ''}`)
  }
  throw new Error(
    `Unable to read the Authenticode signature of ${target}:\n  ${failures.join('\n  ')}`
  )
}
