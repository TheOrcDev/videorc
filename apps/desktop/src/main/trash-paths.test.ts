import { describe, expect, it, vi } from 'vitest'

import { smokeTrashDirectory, smokeTrashItem, trashPaths } from './trash-paths'

function fileError(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(code), { code })
}

describe('trashPaths', () => {
  it('treats an already-missing path as complete', async () => {
    const trashItem = vi.fn<(path: string) => Promise<void>>()

    await expect(
      trashPaths(['/recordings/missing.mp4'], {
        stat: vi.fn().mockRejectedValue(fileError('ENOENT')),
        trashItem
      })
    ).resolves.toEqual({ failures: [] })
    expect(trashItem).not.toHaveBeenCalled()
  })

  it('retains stat errors instead of treating them as missing', async () => {
    const trashItem = vi.fn<(path: string) => Promise<void>>()

    await expect(
      trashPaths(['/recordings/protected.mp4'], {
        stat: vi.fn().mockRejectedValue(fileError('EACCES')),
        trashItem
      })
    ).resolves.toEqual({ failures: ['/recordings/protected.mp4'] })
    expect(trashItem).not.toHaveBeenCalled()
  })

  it('returns only paths whose Trash move failed', async () => {
    const trashItem = vi
      .fn<(path: string) => Promise<void>>()
      .mockResolvedValueOnce()
      .mockRejectedValueOnce(new Error('Trash unavailable'))

    await expect(
      trashPaths(['/recordings/a.mp4', '/recordings/b.mp4'], {
        stat: vi.fn().mockResolvedValue({}),
        trashItem
      })
    ).resolves.toEqual({ failures: ['/recordings/b.mp4'] })
  })
})

describe('the smoke Trash stand-in (plan 209 S16)', () => {
  const dev = { packaged: false, smokeCommandServer: true }

  it('is only for a dev build running the smoke command server, with an absolute folder', () => {
    expect(smokeTrashDirectory('/tmp/run/trash', dev)).toBe('/tmp/run/trash')
    expect(smokeTrashDirectory('/tmp/run/trash', { ...dev, packaged: true })).toBeNull()
    expect(smokeTrashDirectory('/tmp/run/trash', { ...dev, smokeCommandServer: false })).toBeNull()
    expect(smokeTrashDirectory('run/trash', dev)).toBeNull()
    expect(smokeTrashDirectory('  ', dev)).toBeNull()
    expect(smokeTrashDirectory(undefined, dev)).toBeNull()
  })

  it('moves each file into the folder under a name of its own', async () => {
    const mkdir = vi.fn().mockResolvedValue(undefined)
    const rename = vi.fn<(from: string, to: string) => Promise<void>>().mockResolvedValue()
    const trashItem = smokeTrashItem('/tmp/run/trash', { mkdir, rename, now: () => 42 })

    await trashItem('/tmp/run/recordings/take.mp4')
    await trashItem('/tmp/run/other/take.mp4')

    expect(mkdir).toHaveBeenCalledWith('/tmp/run/trash')
    expect(rename.mock.calls).toEqual([
      ['/tmp/run/recordings/take.mp4', '/tmp/run/trash/42-1-take.mp4'],
      ['/tmp/run/other/take.mp4', '/tmp/run/trash/42-2-take.mp4']
    ])
  })
})
