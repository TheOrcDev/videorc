import { describe, expect, it, vi } from 'vitest'

import { trashPaths } from './trash-paths'

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
