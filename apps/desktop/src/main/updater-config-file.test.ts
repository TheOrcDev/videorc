import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

import { APP_UPDATE_CONFIG_FILE, createAppUpdateConfigGate } from './updater-config-file'

const resourcesPath = join('C:', 'Videorc', 'resources')

describe('app-update.yml gate', () => {
  it('skips the check and logs once when the file is absent', () => {
    const fileExists = vi.fn(() => false)
    const log = vi.fn()
    const allowsCheck = createAppUpdateConfigGate({ resourcesPath, fileExists, log })

    expect(allowsCheck(false)).toBe(false)
    expect(allowsCheck(false)).toBe(false)
    expect(fileExists).toHaveBeenCalledTimes(1)
    expect(fileExists).toHaveBeenCalledWith(join(resourcesPath, APP_UPDATE_CONFIG_FILE))
    expect(log).toHaveBeenCalledTimes(1)
    expect(log.mock.calls[0]?.[0]).toContain(APP_UPDATE_CONFIG_FILE)
  })

  it('checks as before when the file is present', () => {
    const fileExists = vi.fn(() => true)
    const log = vi.fn()
    const allowsCheck = createAppUpdateConfigGate({ resourcesPath, fileExists, log })

    expect(allowsCheck(false)).toBe(true)
    expect(allowsCheck(false)).toBe(true)
    expect(log).not.toHaveBeenCalled()
  })

  it('checks a pinned feed without the file', () => {
    const fileExists = vi.fn(() => false)
    const log = vi.fn()
    const allowsCheck = createAppUpdateConfigGate({ resourcesPath, fileExists, log })

    expect(allowsCheck(true)).toBe(true)
    expect(fileExists).not.toHaveBeenCalled()
    expect(log).not.toHaveBeenCalled()
  })
})
