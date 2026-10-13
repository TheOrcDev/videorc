import { describe, expect, it, vi } from 'vitest'

import type { ResourceSelection } from '@/lib/backend'
import { UserFacingError } from '@/lib/user-error'

import { SCREEN_IMAGE_REFUSALS } from '../../../shared/screen-image-files'
import { importEachSelection, screenImportAuthorizationError } from './screen-import'

const selection = (displayName: string): ResourceSelection => ({
  capabilityId: `cap-${displayName}`,
  kind: 'input-file',
  displayName
})

describe('importEachSelection', () => {
  it('imports in order and keeps going past a failed file', async () => {
    const imported: string[] = []
    const failure = new Error('corrupt image')
    const onFailure = vi.fn()
    await importEachSelection(
      [selection('a.png'), selection('b.png'), selection('c.png')],
      async ({ displayName }) => {
        if (displayName === 'b.png') throw failure
        imported.push(displayName)
      },
      onFailure
    )
    expect(imported).toEqual(['a.png', 'c.png'])
    expect(onFailure).toHaveBeenCalledExactlyOnceWith(failure, selection('b.png'))
  })
})

describe('screenImportAuthorizationError', () => {
  it("shows main's refusal as written, without Electron's IPC wrapper", () => {
    const wrapped = new Error(
      `Error invoking remote method 'screens:pick-images': Error: ${SCREEN_IMAGE_REFUSALS.tooMany}`
    )
    const error = screenImportAuthorizationError(wrapped)
    expect(error).toBeInstanceOf(UserFacingError)
    expect((error as Error).message).toBe(SCREEN_IMAGE_REFUSALS.tooMany)
  })

  it('leaves any other failure to the usual error copy', () => {
    const other = new Error('EACCES: permission denied')
    expect(screenImportAuthorizationError(other)).toBe(other)
  })
})
