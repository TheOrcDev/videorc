import { execFile } from 'node:child_process'
import { win32 } from 'node:path'

// Windows update signature check, replacing electron-updater's built-in one.
//
// electron-updater (6.8.9) checks a downloaded installer with
// `Get-AuthenticodeSignature … | ConvertTo-Json` under a hard 20-second
// timeout and throws the update away when the timeout kills PowerShell. Hashing
// a 210 MB installer while Videorc's preview runs took 18–21 s on an i5-8365U
// at 92% CPU (2026-11-10 field report), so every 0.21.0 download was discarded
// and downloaded again on the next check. The installer itself was valid.
//
// This keeps the same trust rule (status Valid, the file checked is the file
// downloaded, and the signer matches app-update.yml's publisherName) and the
// same PowerShell invocation, but allows minutes instead of 20 s and asks
// PowerShell only for the three fields it needs instead of serialising the
// whole certificate. Any failure still rejects: an update is never installed
// on a guess.

export const WINDOWS_SIGNATURE_CHECK_TIMEOUT_MS = 3 * 60 * 1000

/** Mirrors electron-updater's `VerifyUpdateCodeSignature`. Null means trusted;
 * a string is the reason the installer is not signed by the publisher. */
export type VerifyUpdateCodeSignature = (
  publisherNames: string[],
  installerPath: string
) => Promise<string | null>

export interface SignatureCheckOutput {
  Status?: unknown
  Path?: unknown
  Subject?: unknown
}

type ExecError = Error & { killed?: boolean; signal?: NodeJS.Signals | null; code?: unknown }

export type SignatureExecFile = (
  file: string,
  args: string[],
  options: { shell: true; timeout: number; windowsHide: true },
  callback: (error: ExecError | null, stdout: string, stderr: string) => void
) => void

/** The PowerShell command, as electron-updater passes it through cmd.exe. */
export function signatureCheckCommand(installerPath: string): string {
  // Single quotes are doubled inside a PowerShell single-quoted string; the
  // path is already on disk, so it holds none of <>:"/\|?* in a name.
  const literalPath = installerPath.replace(/'/g, "''")
  return (
    `"Get-AuthenticodeSignature -LiteralPath '${literalPath}' | ` +
    `Select-Object @{n='Status';e={[int]$_.Status}},Path,` +
    `@{n='Subject';e={$_.SignerCertificate.Subject}} | ConvertTo-Json -Compress"`
  )
}

export function signatureCheckInvocation(installerPath: string): [string, string[]] {
  // Same shell prefix as electron-updater: an empty PSModulePath avoids a
  // PowerShell 7 module path breaking Windows PowerShell (electron-builder
  // #7127), and code page 65001 keeps a non-ASCII signer (Málaga) intact.
  return [
    'set "PSModulePath=" & chcp 65001 >NUL & powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-InputFormat',
      'None',
      '-Command',
      signatureCheckCommand(installerPath)
    ]
  ]
}

/** `CN=Uros Miric, O=Uros Miric, S="A, B"` → key/value map. */
export function parseDistinguishedName(dn: string): Map<string, string> {
  const parts: string[] = []
  let current = ''
  let quoted = false
  for (const char of dn) {
    if (char === '"') {
      quoted = !quoted
      current += char
    } else if (char === ',' && !quoted) {
      parts.push(current)
      current = ''
    } else {
      current += char
    }
  }
  parts.push(current)

  const result = new Map<string, string>()
  for (const part of parts) {
    const separator = part.indexOf('=')
    if (separator <= 0) {
      continue
    }
    const key = part.slice(0, separator).trim()
    let value = part.slice(separator + 1).trim()
    if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
      value = value.slice(1, -1)
    }
    if (key) {
      result.set(key, value)
    }
  }
  return result
}

function signerMatches(publisherNames: string[], subject: string): boolean {
  const signer = parseDistinguishedName(subject)
  return publisherNames.some((name) => {
    const wanted = parseDistinguishedName(name)
    if (wanted.size > 0) {
      return Array.from(wanted.entries()).every(([key, value]) => signer.get(key) === value)
    }
    return name === signer.get('CN')
  })
}

/** Null when the installer is trusted, otherwise why it is not. */
export function signatureVerdict(
  publisherNames: string[],
  installerPath: string,
  output: SignatureCheckOutput
): string | null {
  const status = output.Status
  // 0 is SignatureStatus.Valid; a string covers PowerShell builds that
  // serialise the enum by name.
  if (status !== 0 && status !== 'Valid') {
    return `signature status ${String(status)} is not Valid`
  }
  if (typeof output.Path === 'string') {
    const checked = win32.normalize(output.Path).toLowerCase()
    const downloaded = win32.normalize(installerPath).toLowerCase()
    if (checked !== downloaded) {
      return `PowerShell checked ${output.Path}, not the downloaded installer`
    }
  }
  const subject = typeof output.Subject === 'string' ? output.Subject : ''
  if (!subject || !signerMatches(publisherNames, subject)) {
    return `publisherNames: ${publisherNames.join(' | ')}, signer: ${subject || 'none'}`
  }
  return null
}

export function createWindowsSignatureVerifier({
  exec = execFile as unknown as SignatureExecFile,
  timeoutMs = WINDOWS_SIGNATURE_CHECK_TIMEOUT_MS,
  now = () => Date.now(),
  log
}: {
  exec?: SignatureExecFile
  timeoutMs?: number
  now?: () => number
  log: { info: (message: string) => void; warn: (message: string) => void }
}): VerifyUpdateCodeSignature {
  return (publisherNames, installerPath) =>
    new Promise((resolve, reject) => {
      const [file, args] = signatureCheckInvocation(installerPath)
      const startedAt = now()
      log.info(`Verifying signature of ${installerPath}`)
      exec(
        file,
        args,
        { shell: true, timeout: timeoutMs, windowsHide: true },
        (error, stdout, stderr) => {
          const seconds = ((now() - startedAt) / 1000).toFixed(1)
          if (error?.killed || error?.signal) {
            reject(
              new Error(
                `Checking the update's signature took longer than ${Math.round(timeoutMs / 1000)} seconds, so the download was discarded.`
              )
            )
            return
          }
          if (error || stderr.trim()) {
            const detail = stderr.trim() || error?.message || 'unknown error'
            reject(new Error(`Couldn't check the update's signature: ${detail}`))
            return
          }
          let output: SignatureCheckOutput
          try {
            output = JSON.parse(stdout.trim()) as SignatureCheckOutput
          } catch {
            reject(
              new Error(`Couldn't read the update's signature: ${stdout.trim().slice(0, 200)}`)
            )
            return
          }
          const verdict = signatureVerdict(publisherNames, installerPath, output ?? {})
          if (verdict) {
            log.warn(`Signature check failed after ${seconds} s: ${verdict}`)
          } else {
            log.info(`Signature check passed in ${seconds} s`)
          }
          resolve(verdict)
        }
      )
    })
}
