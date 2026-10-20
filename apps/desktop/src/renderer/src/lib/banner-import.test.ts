import { describe, expect, it, vi } from 'vitest'

import { BANNER_COUNT_LIMIT_REASON } from './banners'
import { createBannerImporter } from './banner-import'

// Plan 186 S5: Import image… on Assets → Banners, single-flight like the
// takeover import (plan 182).

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}

function harness() {
  const selection = deferred<{ capabilityId: string } | null>()
  const imported = deferred<{ id: string }>()
  const options = {
    pick: vi.fn(() => selection.promise),
    importImage: vi.fn(() => imported.promise),
    isCurrent: vi.fn(() => true),
    onPhase: vi.fn(),
    onImported: vi.fn(),
    onError: vi.fn()
  }
  return { selection, imported, options }
}

describe('banner import lifecycle', () => {
  it('admits one picker and one import at a time, then the next', async () => {
    const importer = createBannerImporter()
    const { selection, imported, options } = harness()
    const first = importer.run(options)
    await importer.run(options)
    expect(options.pick).toHaveBeenCalledTimes(1)
    expect(options.onPhase).toHaveBeenLastCalledWith('choosing')
    selection.resolve({ capabilityId: 'cap-1' })
    await Promise.resolve()
    expect(options.onPhase).toHaveBeenLastCalledWith('importing')
    expect(options.importImage).toHaveBeenCalledExactlyOnceWith({ capabilityId: 'cap-1' })
    imported.resolve({ id: 'banner-1' })
    await first
    expect(options.onImported).toHaveBeenCalledExactlyOnceWith({ id: 'banner-1' })
    expect(options.onPhase).toHaveBeenLastCalledWith('idle')
    const next = harness()
    const again = importer.run(next.options)
    expect(next.options.pick).toHaveBeenCalledTimes(1)
    next.selection.resolve(null)
    await again
    expect(next.options.importImage).not.toHaveBeenCalled()
  })

  it('is its own instance: a banner import never waits on a takeover picker', async () => {
    const takeover = createBannerImporter()
    const banners = createBannerImporter()
    const waiting = harness()
    const running = harness()
    const held = takeover.run(waiting.options)
    const run = banners.run(running.options)
    expect(running.options.pick).toHaveBeenCalledTimes(1)
    running.selection.resolve(null)
    waiting.selection.resolve(null)
    await Promise.all([held, run])
  })

  it('reports a refusal once, clears pending and fences a retired connection', async () => {
    const importer = createBannerImporter()
    const { selection, imported, options } = harness()
    const run = importer.run(options)
    selection.resolve({ capabilityId: 'cap-1' })
    await Promise.resolve()
    imported.reject(new Error(BANNER_COUNT_LIMIT_REASON))
    await run
    expect(options.onError).toHaveBeenCalledTimes(1)
    expect(options.onImported).not.toHaveBeenCalled()
    expect(options.onPhase).toHaveBeenLastCalledWith('idle')

    const retired = harness()
    const late = importer.run(retired.options)
    retired.options.isCurrent.mockReturnValue(false)
    retired.selection.resolve({ capabilityId: 'cap-2' })
    await late
    expect(retired.options.importImage).not.toHaveBeenCalled()
  })
})
