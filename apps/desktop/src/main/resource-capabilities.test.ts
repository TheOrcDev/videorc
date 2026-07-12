import { mkdtempSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { MainResourceCapabilityRegistry } from './resource-capabilities'

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
      String.raw`\\?\C:\Windows\System32\cmd.exe`,
      String.raw`\\.\PhysicalDrive0`,
      String.raw`C:relative\file.mp4`
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
  })
})
