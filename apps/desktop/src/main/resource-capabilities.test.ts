import { mkdtempSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { MainResourceCapabilityRegistry, stripVerbatimDrivePrefix } from './resource-capabilities'

describe('main resource capability registry', () => {
  it('resolves only the original kind before expiry', () => {
    const root = mkdtempSync(join(tmpdir(), 'videorc-main-resource-'))
    const file = join(root, 'picked.mp4')
    writeFileSync(file, 'fixture')
    const registry = new MainResourceCapabilityRegistry()
    const selection = registry.remember(
      'resource:8bc7491d-d5df-4aae-8a18-6cf39ccbaad7',
      'input-file',
      file,
      1_000,
      100
    )

    expect(selection).toMatchObject({ kind: 'input-file', displayName: 'picked.mp4' })
    expect(registry.resolve(selection.capabilityId, 'input-file', 200)).toBe(realpathSync(file))
    expect(() => registry.resolve(selection.capabilityId, 'trash-path', 200)).toThrow(
      /kind mismatch/
    )
    expect(() => registry.resolve(selection.capabilityId, 'input-file', 1_101)).toThrow(
      /unknown or expired/
    )
  })

  it('rejects wrong file kinds and Windows namespace forms on every platform', () => {
    const root = mkdtempSync(join(tmpdir(), 'videorc-main-resource-'))
    mkdirSync(join(root, 'directory'))
    const registry = new MainResourceCapabilityRegistry()
    expect(() =>
      registry.remember(
        'resource:8bc7491d-d5df-4aae-8a18-6cf39ccbaad7',
        'input-file',
        join(root, 'directory'),
        1_000
      )
    ).toThrow(/regular file/)
    for (const forged of [
      String.raw`\\server\share\file.mp4`,
      String.raw`\\?\UNC\server\share\file.mp4`,
      String.raw`\\?\unc\server\share\file.mp4`,
      String.raw`\\?\UnC\server\share\file.mp4`,
      String.raw`\\?\Volume{12345678-1234-1234-1234-123456789abc}\file.mp4`,
      String.raw`\\?\volume{12345678-1234-1234-1234-123456789abc}\file.mp4`,
      String.raw`\\?\GLOBALROOT\Device\Harddisk0\file`,
      String.raw`\\?\globalroot\Device\Harddisk0\file`,
      String.raw`\\?\C:relative\file.mp4`,
      String.raw`\\?\c:relative\file.mp4`,
      String.raw`\\?\C:`,
      '\\\\?\\',
      String.raw`\\?\\\?\C:\x`,
      String.raw`\\?\1:\x`,
      String.raw`\\?\C:\a\..\..\Windows`,
      String.raw`\\?\C:\a\.\b.mp4`,
      String.raw`\\?\C:\clips\take.mp4.`,
      String.raw`\\?/C:\x`,
      String.raw`\\?\C:/x`,
      String.raw`/\?\C:\x`,
      String.raw`\\.\PhysicalDrive0`,
      String.raw`\??\C:\Windows\System32`,
      String.raw`\DEVICE\HarddiskVolume1\file`,
      String.raw`C:relative\file.mp4`,
      'C:'
    ]) {
      expect(() =>
        registry.remember(
          'resource:8bc7491d-d5df-4aae-8a18-6cf39ccbaad7',
          'input-file',
          forged,
          1_000
        )
      ).toThrow()
    }
    if (process.platform !== 'win32') {
      expect(() =>
        registry.remember(
          'resource:8bc7491d-d5df-4aae-8a18-6cf39ccbaad7',
          'input-file',
          String.raw`\\?\C:\Windows\System32\cmd.exe`,
          1_000
        )
      ).toThrow()
    }
  })

  it('strips only plain Windows verbatim drive paths matching the Rust guards', () => {
    expect(stripVerbatimDrivePrefix(String.raw`\\?\C:\Users\alice\clip.mp4`)).toBe(
      String.raw`C:\Users\alice\clip.mp4`
    )
    expect(stripVerbatimDrivePrefix(String.raw`\\?\f:\videorc\airhorn.wav`)).toBe(
      String.raw`f:\videorc\airhorn.wav`
    )
    const longPath = `\\\\?\\C:\\${'a'.repeat(260)}\\clip.mp4`
    for (const keepVerbatim of [
      String.raw`\\?\UNC\server\share\file.mp4`,
      String.raw`\\?\C:\a\.\b.mp4`,
      String.raw`\\?\C:\a\..\b.mp4`,
      String.raw`\\?\C:\clips\take.mp4.`,
      String.raw`\\?\C:\clips\take `,
      String.raw`\\?\C:\a/b.mp4`,
      String.raw`\\?\C:/x`,
      String.raw`\\?/C:\x`,
      String.raw`\\?\C:`,
      '\\\\?\\',
      String.raw`\\?\\\?\C:\x`,
      String.raw`\\?\1:\x`,
      longPath
    ]) {
      expect(stripVerbatimDrivePrefix(keepVerbatim)).toBe(keepVerbatim)
    }
  })
})
