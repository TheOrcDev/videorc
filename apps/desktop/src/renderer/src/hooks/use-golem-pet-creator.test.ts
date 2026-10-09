import { describe, expect, it, vi } from 'vitest'

import type { GolemPetCreation, GolemPetCreationSource } from '@/lib/backend'
import { GOLEM_PET_ATLAS_SHEETS } from '../../../shared/golem-pet-creator'

import {
  createGolemPetCreatorController,
  type GolemPetCreatorClient
} from './use-golem-pet-creator'

const BUILD = '5f0c2a8e-3b1d-4c6e-9a7f-2d8b1e4c6a90'

function source(sheet: string, version = 1): GolemPetCreationSource {
  return {
    sheet,
    version,
    file: `sources/${sheet}-v${version}.png`,
    sha256: 'a'.repeat(64),
    opaque: false,
    referenceVersion: 1,
    createdAt: '2026-10-09T10:00:00Z'
  }
}

function creation(overrides: Partial<GolemPetCreation> = {}): GolemPetCreation {
  return {
    buildId: BUILD,
    step: 'pilot',
    createdAt: '2026-10-09T10:00:00Z',
    expiresAt: '2026-10-10T10:00:00Z',
    expired: false,
    sheetsAllowed: 9,
    redosAllowed: 6,
    pilotsAllowed: 3,
    sheetsRemaining: 9,
    redosRemaining: 6,
    pilotsUsed: 1,
    reference: source('reference'),
    notes: { palette: ['grey'], materials: [], proportions: 'Stout.', asymmetric: [] },
    pilot: source('pilot'),
    pilotAccepted: false,
    sheets: [],
    ...overrides
  }
}

/** A backend that keeps a creation in memory and answers like the real one. */
function fakeBackend(initial: GolemPetCreation | null) {
  let current = initial
  const handlers = new Map<string, Set<(payload: unknown) => void>>()
  const calls: [string, unknown][] = []
  const emit = (event: string, payload: unknown): void => {
    for (const handler of handlers.get(event) ?? []) handler(payload)
  }
  const requestTyped = vi.fn(async (method: string, params?: unknown) => {
    calls.push([method, params])
    switch (method) {
      case 'cohost.pet.creation.status':
        return { creation: current }
      case 'cohost.pet.creation.start':
        current = creation({
          step: 'reference',
          notes: undefined,
          pilot: undefined,
          reference: undefined
        })
        return { creation: current }
      case 'cohost.pet.identity':
        return { buildId: BUILD }
      case 'cohost.pet.sheet.generate': {
        const { kind, row } = params as { kind: string; row?: string }
        return { buildId: BUILD, sheet: kind === 'gaze' ? `gaze-${row}` : kind }
      }
      case 'cohost.pet.build':
        return { buildId: BUILD }
      case 'cohost.pet.creation.cancel':
        current = null
        return { creation: null }
      default:
        throw new Error(`unexpected ${method}`)
    }
  })
  const client = {
    requestTyped,
    on: (event: string, handler: (payload: unknown) => void) => {
      const set = handlers.get(event) ?? new Set()
      set.add(handler)
      handlers.set(event, set)
      return () => set.delete(handler)
    }
  } as unknown as GolemPetCreatorClient
  return {
    client,
    calls,
    emit,
    set: (next: GolemPetCreation | null) => {
      current = next
    },
    methods: () => calls.map(([method]) => method)
  }
}

const flush = async (): Promise<void> => {
  for (let i = 0; i < 10; i += 1) await Promise.resolve()
}

describe('the creator controller (plan 168 S-F5)', () => {
  it('opens a creation before reading the first reference', async () => {
    const backend = fakeBackend(null)
    const controller = createGolemPetCreatorController(backend.client)
    await controller.refresh()
    expect(controller.getState().creation).toBeNull()
    await controller.readReference({ kind: 'persona-idle' })
    expect(backend.calls.slice(-2)).toEqual([
      ['cohost.pet.creation.start', undefined],
      ['cohost.pet.identity', { buildId: BUILD, reference: { kind: 'persona-idle' } }]
    ])
    expect(controller.getState().pending).toBe('identity')
    backend.set(creation())
    backend.emit('cohost.pet.identity.read', { buildId: BUILD, notes: creation().notes })
    await flush()
    expect(controller.getState().pending).toBeNull()
    expect(controller.getState().creation?.step).toBe('pilot')
    controller.dispose()
  })

  it('makes the sheets one at a time, then builds', async () => {
    const backend = fakeBackend(creation())
    const controller = createGolemPetCreatorController(backend.client)
    await controller.refresh()
    await controller.makeSheets()
    const made: GolemPetCreationSource[] = []
    for (const [index, sheet] of GOLEM_PET_ATLAS_SHEETS.entries()) {
      const generate = backend.calls.filter(([method]) => method === 'cohost.pet.sheet.generate')
      expect(generate).toHaveLength(index + 1)
      expect(generate[index]![1]).toEqual({
        buildId: BUILD,
        kind: sheet.kind,
        ...(sheet.row ? { row: sheet.row } : {}),
        redo: false
      })
      made.push(source(sheet.key))
      backend.set(creation({ step: 'build', pilotAccepted: true, sheets: [...made] }))
      backend.emit('cohost.pet.sheet.generated', {
        buildId: BUILD,
        sheet: sheet.key,
        version: 1,
        opaque: false
      })
      await flush()
    }
    expect(backend.methods().filter((method) => method === 'cohost.pet.build')).toHaveLength(1)
    expect(controller.getState().pending).toBe('build')
    backend.emit('cohost.pet.build.progress', {
      buildId: BUILD,
      step: 'cutting',
      sheet: 'gaze-up2',
      done: 1,
      total: 19
    })
    expect(controller.getState().build?.step).toBe('cutting')
    backend.emit('cohost.pet.build.progress', { buildId: BUILD, step: 'done', done: 1, total: 1 })
    await flush()
    expect(controller.getState().pending).toBeNull()
    controller.dispose()
  })

  it('stops the sheets at a failure and says why on that row', async () => {
    const backend = fakeBackend(creation())
    const controller = createGolemPetCreatorController(backend.client)
    await controller.refresh()
    await controller.makeSheets()
    backend.emit('cohost.pet.sheet.generated', {
      buildId: BUILD,
      sheet: 'gaze-up2',
      opaque: false,
      error: { code: 'pet-sheets-used', message: "This creation's sheets are used up." }
    })
    await flush()
    const state = controller.getState()
    expect(state.autoSheets).toBe(false)
    expect(state.sheetErrors['gaze-up2']).toBe("This creation's sheets are used up.")
    expect(
      backend.methods().filter((method) => method === 'cohost.pet.sheet.generate')
    ).toHaveLength(1)
    controller.dispose()
  })

  it('builds again after a redo, and cancels to nothing', async () => {
    const all = GOLEM_PET_ATLAS_SHEETS.map((sheet) => source(sheet.key))
    const backend = fakeBackend(
      creation({
        step: 'review',
        pilotAccepted: true,
        sheets: all,
        build: { state: 'built', fresh: true, finishedAt: 'x' }
      })
    )
    const controller = createGolemPetCreatorController(backend.client)
    await controller.refresh()
    await controller.redoSheet('reactions-a')
    expect(backend.calls.at(-2)).toEqual([
      'cohost.pet.sheet.generate',
      { buildId: BUILD, kind: 'reactions-a', redo: true }
    ])
    backend.emit('cohost.pet.sheet.generated', {
      buildId: BUILD,
      sheet: 'reactions-a',
      version: 2,
      opaque: false,
      redosRemaining: 5
    })
    await flush()
    expect(backend.methods()).toContain('cohost.pet.build')
    await controller.cancel()
    expect(backend.calls.at(-1)).toEqual(['cohost.pet.creation.cancel', { buildId: BUILD }])
    expect(controller.getState().creation).toBeNull()
    expect(controller.getState().pending).toBeNull()
    controller.dispose()
  })

  it('ignores events of another creation', async () => {
    const backend = fakeBackend(creation())
    const controller = createGolemPetCreatorController(backend.client)
    await controller.refresh()
    backend.emit('cohost.pet.build.progress', {
      buildId: '00000000-0000-4000-8000-000000000000',
      step: 'cutting',
      done: 1,
      total: 19
    })
    expect(controller.getState().build).toBeNull()
    controller.dispose()
  })
})
