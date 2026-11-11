import { describe, expect, it, vi } from 'vitest'

import {
  createWindowsSignatureVerifier,
  parseDistinguishedName,
  signatureCheckCommand,
  signatureCheckInvocation,
  signatureVerdict,
  WINDOWS_SIGNATURE_CHECK_TIMEOUT_MS
} from './updater-signature'
import type { SignatureExecFile } from './updater-signature'

const installer =
  'C:\\Users\\tester\\AppData\\Local\\@videorcdesktop-updater\\pending\\temp-Videorc-0.21.0-win-x64.exe'
const subject = 'CN=Uros Miric, O=Uros Miric, L=Malaga, S=Málaga, C=ES'
const valid = { Status: 0, Path: installer, Subject: subject }

function fakeExec(result: {
  error?: Error & { killed?: boolean; signal?: NodeJS.Signals | null }
  stdout?: string
  stderr?: string
}): { exec: SignatureExecFile; calls: Parameters<SignatureExecFile>[] } {
  const calls: Parameters<SignatureExecFile>[] = []
  const exec: SignatureExecFile = (file, args, options, callback) => {
    calls.push([file, args, options, callback])
    callback(result.error ?? null, result.stdout ?? '', result.stderr ?? '')
  }
  return { exec, calls }
}

const log = { info: vi.fn(), warn: vi.fn() }

describe('Windows update signature check', () => {
  it('allows minutes, not electron-updater’s 20 s, for a large installer on a busy machine', () => {
    // Field report 2026-11-10: the check took 18–21 s at 92% CPU.
    expect(WINDOWS_SIGNATURE_CHECK_TIMEOUT_MS).toBeGreaterThanOrEqual(120_000)
  })

  it('passes the timeout and the same PowerShell prefix as electron-updater', async () => {
    const { exec, calls } = fakeExec({ stdout: JSON.stringify(valid) })
    const verify = createWindowsSignatureVerifier({ exec, log })
    await expect(verify(['Uros Miric'], installer)).resolves.toBeNull()
    const [file, args, options] = calls[0]!
    expect(file).toBe('set "PSModulePath=" & chcp 65001 >NUL & powershell.exe')
    expect(args.at(-1)).toBe(signatureCheckCommand(installer))
    expect(options).toEqual({
      shell: true,
      timeout: WINDOWS_SIGNATURE_CHECK_TIMEOUT_MS,
      windowsHide: true
    })
  })

  it('asks PowerShell only for status, path and signer', () => {
    const command = signatureCheckCommand(installer)
    expect(command).toContain(`-LiteralPath '${installer}'`)
    expect(command).toContain('[int]$_.Status')
    expect(command).toContain('$_.SignerCertificate.Subject')
    expect(command.startsWith('"') && command.endsWith('"')).toBe(true)
  })

  it('escapes single quotes in the path', () => {
    expect(signatureCheckCommand("C:\\a'b\\x.exe")).toContain("-LiteralPath 'C:\\a''b\\x.exe'")
    expect(signatureCheckInvocation("C:\\a'b\\x.exe")[1]).toContain('-NonInteractive')
  })

  it('rejects with plain words when the check times out', async () => {
    const killed = Object.assign(new Error('Command failed'), {
      killed: true,
      signal: 'SIGTERM' as const
    })
    const verify = createWindowsSignatureVerifier({ exec: fakeExec({ error: killed }).exec, log })
    await expect(verify(['Uros Miric'], installer)).rejects.toThrow(/longer than 180 seconds/)
  })

  it('fails closed on a PowerShell error or any stderr', async () => {
    const failed = createWindowsSignatureVerifier({
      exec: fakeExec({ error: new Error('spawn powershell.exe ENOENT') }).exec,
      log
    })
    await expect(failed(['Uros Miric'], installer)).rejects.toThrow(/ENOENT/)
    const noisy = createWindowsSignatureVerifier({
      exec: fakeExec({ stdout: JSON.stringify(valid), stderr: 'boom' }).exec,
      log
    })
    await expect(noisy(['Uros Miric'], installer)).rejects.toThrow(/boom/)
    const garbled = createWindowsSignatureVerifier({
      exec: fakeExec({ stdout: 'not json' }).exec,
      log
    })
    await expect(garbled(['Uros Miric'], installer)).rejects.toThrow(/not json/)
  })

  it('returns a reason, not null, for a wrong signer', async () => {
    const other = { ...valid, Subject: 'CN=Someone Else, O=Someone Else, C=US' }
    const verify = createWindowsSignatureVerifier({
      exec: fakeExec({ stdout: JSON.stringify(other) }).exec,
      log
    })
    await expect(verify(['Uros Miric'], installer)).resolves.toMatch(/Someone Else/)
  })
})

describe('signatureVerdict', () => {
  it('trusts a valid installer signed by the publisher (CN or full DN)', () => {
    expect(signatureVerdict(['Uros Miric'], installer, valid)).toBeNull()
    expect(signatureVerdict(['CN=Uros Miric, C=ES'], installer, valid)).toBeNull()
    expect(signatureVerdict(['Someone', 'Uros Miric'], installer, valid)).toBeNull()
    expect(signatureVerdict(['Uros Miric'], installer, { ...valid, Status: 'Valid' })).toBeNull()
  })

  it('treats the path case-insensitively, like Windows', () => {
    expect(
      signatureVerdict(['Uros Miric'], installer, { ...valid, Path: installer.toUpperCase() })
    ).toBeNull()
  })

  it('refuses anything not Valid', () => {
    // 1 UnknownError, 2 NotSigned, 3 HashMismatch, 4 NotTrusted.
    for (const status of [1, 2, 3, 4, 'HashMismatch', undefined]) {
      expect(signatureVerdict(['Uros Miric'], installer, { ...valid, Status: status })).toMatch(
        /not Valid/
      )
    }
  })

  it('refuses a different file, a different signer, or no signer', () => {
    expect(
      signatureVerdict(['Uros Miric'], installer, { ...valid, Path: 'C:\\other.exe' })
    ).toMatch(/not the downloaded installer/)
    expect(signatureVerdict(['CN=Uros Miric, C=US'], installer, valid)).toMatch(/publisherNames/)
    expect(signatureVerdict(['Uros'], installer, valid)).toMatch(/publisherNames/)
    expect(signatureVerdict(['Uros Miric'], installer, { Status: 0, Path: installer })).toMatch(
      /signer: none/
    )
  })
})

describe('parseDistinguishedName', () => {
  it('splits on commas outside quotes and keeps non-ASCII values', () => {
    const dn = parseDistinguishedName('CN="Miric, Uros", O=Uros Miric, S=Málaga')
    expect(dn.get('CN')).toBe('Miric, Uros')
    expect(dn.get('O')).toBe('Uros Miric')
    expect(dn.get('S')).toBe('Málaga')
  })

  it('is empty for a bare name', () => {
    expect(parseDistinguishedName('Uros Miric').size).toBe(0)
  })
})
