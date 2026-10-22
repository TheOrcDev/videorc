import { describe, expect, it, vi } from 'vitest'
import { createTakeoverImporter } from './takeover-import'

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
  const selection = deferred<string | null>()
  const imported = deferred<string>()
  const options = {
    pick: vi.fn(() => selection.promise),
    importImage: vi.fn(() => imported.promise),
    isCurrent: vi.fn(() => true),
    onPhase: vi.fn(),
    onImported: vi.fn(),
    onError: vi.fn()
  }
  return { importer: createTakeoverImporter(), selection, imported, options }
}

describe('takeover import lifecycle', () => {
  it('admits one picker and one import until completion, then allows another', async () => {
    const { importer, selection, imported, options } = harness()
    const first = importer.run(options)
    await importer.run(options)
    expect(options.pick).toHaveBeenCalledTimes(1)
    expect(options.onPhase).toHaveBeenLastCalledWith('choosing')
    selection.resolve('image')
    await Promise.resolve()
    expect(options.onPhase).toHaveBeenLastCalledWith('importing')
    await importer.run(options)
    expect(options.importImage).toHaveBeenCalledTimes(1)
    imported.resolve('ready')
    await first
    expect(options.onImported).toHaveBeenCalledExactlyOnceWith('ready')
    expect(options.onPhase).toHaveBeenLastCalledWith('idle')
    await importer.run(options)
    expect(options.pick).toHaveBeenCalledTimes(2)
  })
  it('canceling the picker is quiet and never imports', async () => {
    const { importer, selection, options } = harness()
    const run = importer.run(options)
    selection.resolve(null)
    await run
    expect(options.importImage).not.toHaveBeenCalled()
    expect(options.onError).not.toHaveBeenCalled()
    expect(options.onPhase).toHaveBeenLastCalledWith('idle')
  })
  it('failure reports once, clears pending and allows retry', async () => {
    const { importer, selection, imported, options } = harness()
    const run = importer.run(options)
    selection.resolve('image')
    await Promise.resolve()
    imported.reject(new Error('invalid image'))
    await run
    expect(options.onError).toHaveBeenCalledTimes(1)
    expect(options.onImported).not.toHaveBeenCalled()
    expect(options.onPhase).toHaveBeenLastCalledWith('idle')
    await importer.run({ ...options, importImage: async () => 'retry' })
    expect(options.onImported).toHaveBeenLastCalledWith('retry')
  })
  it('a retired connection cannot submit a picker result', async () => {
    const { importer, selection, options } = harness()
    const run = importer.run(options)
    options.isCurrent.mockReturnValue(false)
    selection.resolve('image')
    await run
    expect(options.importImage).not.toHaveBeenCalled()
  })
  it.each(['success', 'failure'] as const)(
    'late %s cannot change state or clear a newer import',
    async (outcome) => {
      const { importer, selection, imported, options } = harness()
      const old = importer.run(options)
      selection.resolve('image')
      await Promise.resolve()
      importer.reset()
      const next = harness()
      const active = importer.run(next.options)
      options.onPhase.mockClear()
      if (outcome === 'success') imported.resolve('old')
      else imported.reject(new Error('old'))
      await old
      expect(options.onPhase).not.toHaveBeenCalled()
      expect(options.onImported).not.toHaveBeenCalled()
      expect(options.onError).not.toHaveBeenCalled()
      await importer.run(next.options)
      expect(next.options.pick).toHaveBeenCalledTimes(1)
      next.selection.resolve(null)
      await active
    }
  )
})
