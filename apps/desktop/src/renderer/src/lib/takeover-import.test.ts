import { describe, expect, it, vi } from 'vitest'

import { UserFacingError } from '@/lib/user-error'

import { SCREEN_IMAGE_REFUSALS } from '../../../shared/screen-image-files'
import { createTakeoverImporter, screenImportAuthorizationError } from './takeover-import'

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
  const selection = deferred<readonly string[]>()
  const imported = deferred<string>()
  const options = {
    pick: vi.fn(() => selection.promise),
    importImage: vi.fn((_selection: string) => imported.promise),
    isCurrent: vi.fn(() => true),
    onPhase: vi.fn(),
    onPending: vi.fn(),
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
    selection.resolve(['image'])
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
    selection.resolve([])
    await run
    expect(options.importImage).not.toHaveBeenCalled()
    expect(options.onError).not.toHaveBeenCalled()
    expect(options.onPhase).toHaveBeenLastCalledWith('idle')
  })
  it('a refused pick reports once, without a file, and allows retry', async () => {
    const { importer, selection, options } = harness()
    const refusal = new Error('not an image')
    const run = importer.run(options)
    selection.reject(refusal)
    await run
    expect(options.onError).toHaveBeenCalledExactlyOnceWith(refusal)
    expect(options.onPhase).toHaveBeenLastCalledWith('idle')
    await importer.run({ ...options, pick: async () => ['retry'], importImage: async () => 'ok' })
    expect(options.onImported).toHaveBeenLastCalledWith('ok')
  })
  it('imports a batch in order, past a failed image, releasing each as it settles', async () => {
    const { importer, options } = harness()
    const failure = new Error('corrupt image')
    const pending: (readonly string[])[] = []
    await importer.run({
      ...options,
      pick: async () => ['a', 'b', 'c'],
      importImage: async (selection: string) => {
        if (selection === 'b') throw failure
        return `screen-${selection}`
      },
      onPending: (selections: readonly string[]) => pending.push(selections)
    })
    expect(options.onImported.mock.calls).toEqual([['screen-a'], ['screen-c']])
    expect(options.onError).toHaveBeenCalledExactlyOnceWith(failure, 'b')
    expect(pending).toEqual([['a', 'b', 'c'], ['b', 'c'], ['c'], [], []])
  })
  it('a retired connection cannot submit a picker result', async () => {
    const { importer, selection, options } = harness()
    const run = importer.run(options)
    options.isCurrent.mockReturnValue(false)
    selection.resolve(['image'])
    await run
    expect(options.importImage).not.toHaveBeenCalled()
  })
  it('a reset during a batch stops the images not yet imported', async () => {
    const { importer, selection, imported, options } = harness()
    const run = importer.run(options)
    selection.resolve(['a', 'b'])
    await Promise.resolve()
    importer.reset()
    imported.resolve('screen-a')
    await run
    expect(options.importImage).toHaveBeenCalledExactlyOnceWith('a')
    expect(options.onImported).not.toHaveBeenCalled()
  })
  it.each(['success', 'failure'] as const)(
    'late %s cannot change state or clear a newer import',
    async (outcome) => {
      const { importer, selection, imported, options } = harness()
      const old = importer.run(options)
      selection.resolve(['image'])
      await Promise.resolve()
      importer.reset()
      const next = harness()
      const active = importer.run(next.options)
      options.onPhase.mockClear()
      options.onPending.mockClear()
      if (outcome === 'success') imported.resolve('old')
      else imported.reject(new Error('old'))
      await old
      expect(options.onPhase).not.toHaveBeenCalled()
      expect(options.onPending).not.toHaveBeenCalled()
      expect(options.onImported).not.toHaveBeenCalled()
      expect(options.onError).not.toHaveBeenCalled()
      await importer.run(next.options)
      expect(next.options.pick).toHaveBeenCalledTimes(1)
      next.selection.resolve([])
      await active
    }
  )
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
