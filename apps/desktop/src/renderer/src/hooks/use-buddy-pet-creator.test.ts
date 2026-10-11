import { describe, expect, it, vi } from 'vitest'

import type { BuddyPetCreation, BuddyPetCreationSource } from '@/lib/backend'
import { BUDDY_PET_ATLAS_SHEETS } from '../../../shared/buddy-pet-creator'

import {
  createBuddyPetCreatorController,
  type BuddyPetCreatorClient
} from './use-buddy-pet-creator'

const BUILD = '5f0c2a8e-3b1d-4c6e-9a7f-2d8b1e4c6a90'

function source(sheet: string, version = 1): BuddyPetCreationSource {
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

function creation(overrides: Partial<BuddyPetCreation> = {}): BuddyPetCreation {
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
function fakeBackend(initial: BuddyPetCreation | null) {
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
  } as unknown as BuddyPetCreatorClient
  return {
    client,
    calls,
    emit,
    set: (next: BuddyPetCreation | null) => {
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
    const controller = createBuddyPetCreatorController(backend.client)
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
    const controller = createBuddyPetCreatorController(backend.client)
    await controller.refresh()
    await controller.makeSheets()
    const made: BuddyPetCreationSource[] = []
    for (const [index, sheet] of BUDDY_PET_ATLAS_SHEETS.entries()) {
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

  it('picks the sheets up again in a creator opened after leaving the tab mid-way', async () => {
    // QA 2026-10-11: the loop lives in the creator, so leaving the Buddy tab
    // during "Making the sheets" stopped it after the sheet in flight, and
    // the creator came back waiting at "Make the sheets".
    const backend = fakeBackend(creation())
    const first = createBuddyPetCreatorController(backend.client)
    await first.refresh()
    await first.makeSheets()
    first.dispose()
    const generated = (): number =>
      backend.methods().filter((method) => method === 'cohost.pet.sheet.generate').length
    expect(generated()).toBe(1)
    // Back while the first sheet is still being made: nothing new is asked
    // for, and its event carries on to the next.
    backend.set(
      creation({ step: 'build', pilotAccepted: true, running: { job: 'sheet', sheet: 'gaze-up2' } })
    )
    const second = createBuddyPetCreatorController(backend.client)
    await second.refresh()
    await flush()
    expect(generated()).toBe(1)
    expect(second.getState().autoSheets).toBe(true)
    backend.set(creation({ step: 'build', pilotAccepted: true, sheets: [source('gaze-up2')] }))
    backend.emit('cohost.pet.sheet.generated', {
      buildId: BUILD,
      sheet: 'gaze-up2',
      version: 1,
      opaque: false
    })
    await flush()
    expect(generated()).toBe(2)
    second.dispose()
    // Back after that one landed unseen: the next one is asked for at once.
    backend.set(
      creation({
        step: 'build',
        pilotAccepted: true,
        sheets: [source('gaze-up2'), source('gaze-up1')]
      })
    )
    const third = createBuddyPetCreatorController(backend.client)
    await third.refresh()
    await flush()
    expect(generated()).toBe(3)
    expect(backend.calls.at(-2)?.[1]).toMatchObject({ kind: 'gaze', row: 'level' })
    // Cancelled, it is never picked up again.
    await third.cancel()
    third.dispose()
    // A creation nobody asked sheets for opens as it was.
    const other = fakeBackend(creation({ buildId: '1d2e3f40-5a6b-4c7d-8e9f-0a1b2c3d4e5f' }))
    const fourth = createBuddyPetCreatorController(other.client)
    await fourth.refresh()
    await flush()
    expect(other.methods()).not.toContain('cohost.pet.sheet.generate')
    fourth.dispose()
  })

  it('stops the sheets at a failure and says why on that row', async () => {
    const backend = fakeBackend(creation())
    const controller = createBuddyPetCreatorController(backend.client)
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
    const all = BUDDY_PET_ATLAS_SHEETS.map((sheet) => source(sheet.key))
    const backend = fakeBackend(
      creation({
        step: 'review',
        pilotAccepted: true,
        sheets: all,
        build: { state: 'built', fresh: true, finishedAt: 'x' }
      })
    )
    const controller = createBuddyPetCreatorController(backend.client)
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
    const controller = createBuddyPetCreatorController(backend.client)
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
