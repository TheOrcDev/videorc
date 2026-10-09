// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type {
  AiCapabilities,
  CohostSettings,
  GolemPetCreation,
  GolemPetCreationSource
} from '@/lib/backend'
import type { EntitlementUiGate } from '@/lib/entitlement-ui'
import { GOLEM_PET_REVIEW_ROWS } from '@/lib/golem-pet-creator-view'
import type { GolemPetCreatorClient } from '@/hooks/use-golem-pet-creator'
import { GOLEM_PET_ATLAS_SHEETS } from '../../../shared/golem-pet-creator'

import { GolemPetCreator } from './golem-pet-creator'

const mocked = vi.hoisted(() => ({ core: {} as Record<string, unknown> }))
vi.mock('@/hooks/use-studio', () => ({ useStudioCore: () => mocked.core }))

const BUILD = '5f0c2a8e-3b1d-4c6e-9a7f-2d8b1e4c6a90'
const PACK = '7d3c9b2a-1e4f-4a6b-8c5d-9e0f1a2b3c4d'
const premium: EntitlementUiGate = { allowed: true }
const basic: EntitlementUiGate = {
  allowed: false,
  featureId: 'live-cohost',
  reason: 'Golem requires Videorc Premium.',
  upgradeUrl: 'https://www.videorc.com/premium'
}
const petOn = (left: number): AiCapabilities =>
  ({
    cohost: { pet: { enabled: true, creationsRemainingThisMonth: left, monthlyLimit: 3 } }
  }) as unknown as AiCapabilities

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

function reviewCreation(overrides: Partial<GolemPetCreation> = {}): GolemPetCreation {
  return {
    buildId: BUILD,
    step: 'review',
    createdAt: '2026-10-09T10:00:00Z',
    expiresAt: '2099-10-10T10:00:00Z',
    expired: false,
    sheetsAllowed: 9,
    redosAllowed: 6,
    pilotsAllowed: 3,
    sheetsRemaining: 1,
    redosRemaining: 6,
    pilotsUsed: 1,
    reference: source('reference'),
    notes: { palette: ['grey'], materials: ['granite'], proportions: 'Stout.', asymmetric: [] },
    pilot: source('pilot'),
    pilotAccepted: true,
    sheets: GOLEM_PET_ATLAS_SHEETS.map((sheet) => source(sheet.key)),
    build: { state: 'built', fresh: true, finishedAt: '2026-10-09T10:30:00Z' },
    ...overrides
  }
}

function settings(): CohostSettings {
  return {
    enabled: false,
    tone: 'friendly',
    notes: '',
    autoHighlight: false,
    voiceHighlight: false,
    rules: [],
    listen: false,
    wakeWordRequired: false,
    removeConfirm: 'confirm',
    persona: {
      id: 'default',
      name: 'Golem',
      personality: '',
      bubbleStyle: 'speech',
      images: {},
      source: 'default',
      avatar: { kind: 'still' },
      motion: { intensity: 0.45, sleepAfterSeconds: 180, breathing: true },
      reactions: {}
    },
    autoChat: {
      mode: 'off',
      greetings: { enabled: false, templates: [] },
      answers: { enabled: false, cooldownSeconds: 20 },
      banter: { enabled: false, cooldownSeconds: 240 }
    }
  }
}

/** The built pack's manifest: every review cell on a 5-wide 128 px grid. */
const MANIFEST = {
  version: 1,
  name: 'Golem',
  neutral: 'gaze-2-2',
  frames: GOLEM_PET_REVIEW_ROWS.flatMap((row) => row.cells).map((id, index) => ({
    id,
    kind: id.startsWith('gaze-') ? 'gaze' : 'reaction',
    sheet: 'mascot.webp',
    rect: [(index % 5) * 128, Math.floor(index / 5) * 128, 128, 128]
  }))
}

function fakeBackend(initial: GolemPetCreation | null) {
  let current = initial
  const handlers = new Map<string, Set<(payload: unknown) => void>>()
  const requestTyped = vi.fn(async (method: string, params?: unknown) => {
    switch (method) {
      case 'cohost.pet.creation.status':
        return { creation: current }
      case 'cohost.pet.creation.cancel':
        current = null
        return { creation: null }
      case 'cohost.pet.sheet.generate': {
        const { kind } = params as { kind: string }
        current = current ? { ...current, running: { job: 'sheet', sheet: kind } } : null
        return { buildId: BUILD, sheet: kind }
      }
      case 'cohost.pet.build':
        return { buildId: BUILD }
      case 'cohost.pet.save': {
        current = null
        const saved = settings()
        saved.persona.avatar = { kind: 'alive', packId: PACK }
        return {
          pack: {
            packId: PACK,
            name: (params as { name: string }).name,
            cellSize: 640,
            gazeCount: 25,
            reactions: ['laugh'],
            source: 'videorc-creator',
            hasTalk: true
          },
          settings: saved
        }
      }
      default:
        throw new Error(`unexpected ${method}`)
    }
  })
  return {
    client: {
      requestTyped,
      on: (event: string, handler: (payload: unknown) => void) => {
        const set = handlers.get(event) ?? new Set()
        set.add(handler)
        handlers.set(event, set)
        return () => set.delete(handler)
      }
    } as unknown as GolemPetCreatorClient,
    requestTyped,
    set: (next: GolemPetCreation | null) => {
      current = next
    },
    emit: (event: string, payload: unknown) => {
      for (const handler of handlers.get(event) ?? []) handler(payload)
    }
  }
}

let root: Root
let container: HTMLDivElement
const onClose = vi.fn()
const patchCohostSettings = vi.fn(async () => undefined)
const readGolemCreationFile = vi.fn(async (_persona: string, _build: string, file: string) =>
  file === 'pack/manifest.json'
    ? new TextEncoder().encode(JSON.stringify(MANIFEST))
    : new Uint8Array([1, 2, 3])
)

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  onClose.mockClear()
  patchCohostSettings.mockClear()
  readGolemCreationFile.mockClear()
  Object.assign(window, { videorc: { readGolemCreationFile } })
  Object.assign(URL, { createObjectURL: () => 'blob:atlas', revokeObjectURL: () => undefined })
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  document.body.innerHTML = ''
  vi.unstubAllGlobals()
})

async function render({
  client,
  gate = premium,
  capabilities = petOn(2) as AiCapabilities | null
}: {
  client: GolemPetCreatorClient
  gate?: EntitlementUiGate
  capabilities?: AiCapabilities | null
}): Promise<void> {
  mocked.core = {
    account: { status: 'signed-in' },
    aiCapabilities: capabilities,
    aiConsent: true,
    cohostGate: gate,
    cohostSettings: settings(),
    patchCohostSettings,
    runtimeInfo: { platform: 'darwin' },
    connection: null,
    wsStatus: 'disconnected'
  }
  await act(async () => root.render(createElement(GolemPetCreator, { onClose, client })))
  await settle()
}

async function settle(): Promise<void> {
  for (let i = 0; i < 5; i += 1) {
    await act(async () => {
      await Promise.resolve()
    })
  }
}

const byTestId = <T extends HTMLElement = HTMLElement>(id: string): T | null =>
  document.querySelector<T>(`[data-testid="${id}"]`)

async function click(element: HTMLElement | null): Promise<void> {
  expect(element).not.toBeNull()
  await act(async () => {
    element!.click()
  })
  await settle()
}

describe('GolemPetCreator (plan 168 S-F5)', () => {
  it('is locked with one reason for Basic, every control off', async () => {
    const backend = fakeBackend(null)
    await render({ client: backend.client, gate: basic })
    expect(byTestId('golem-pet-gate')?.textContent).toContain(basic.reason)
    expect(byTestId<HTMLButtonElement>('golem-pet-read')?.disabled).toBe(true)
    expect(byTestId('golem-pet-step-reference')?.getAttribute('aria-current')).toBe('step')
  })

  it("shows this month's allowance, and starts nothing when it is used up", async () => {
    const backend = fakeBackend(null)
    await render({ client: backend.client })
    expect(byTestId('golem-pet-allowance')?.textContent).toBe('2 of 3 left this month')
    expect(byTestId<HTMLButtonElement>('golem-pet-read')?.disabled).toBe(false)
    expect(byTestId('golem-pet-gate')).toBeNull()

    await act(async () => root.unmount())
    root = createRoot(container)
    await render({ client: fakeBackend(null).client, capabilities: petOn(0) })
    expect(byTestId('golem-pet-allowance')?.textContent).toBe('0 of 3 left this month')
    expect(byTestId('golem-pet-gate')?.textContent).toContain("This month's creations are used up.")
    expect(byTestId<HTMLButtonElement>('golem-pet-read')?.disabled).toBe(true)
  })

  it('keeps Save off until every row looks right, and a redo clears that row', async () => {
    const backend = fakeBackend(reviewCreation())
    await render({ client: backend.client })
    expect(byTestId('golem-pet-step-review')?.getAttribute('aria-current')).toBe('step')
    const next = (): HTMLButtonElement => byTestId<HTMLButtonElement>('golem-pet-continue')!
    expect(next().disabled).toBe(true)
    for (const row of GOLEM_PET_REVIEW_ROWS.slice(0, 7)) {
      await click(byTestId(`golem-pet-mark-${row.key}`))
    }
    expect(byTestId('golem-pet-marked')?.textContent).toBe('7 of 8 rows look right')
    expect(next().disabled).toBe(true)
    await click(byTestId('golem-pet-mark-extras'))
    expect(byTestId('golem-pet-mark-extras')?.getAttribute('aria-pressed')).toBe('true')
    expect(next().disabled).toBe(false)

    // Redo a row: its mark goes at once and the creator asks for a redo.
    await click(byTestId('golem-pet-redo-reactions-a'))
    expect(backend.requestTyped).toHaveBeenCalledWith(
      'cohost.pet.sheet.generate',
      { buildId: BUILD, kind: 'reactions-a', redo: true },
      expect.anything()
    )
    expect(byTestId('golem-pet-mark-reactions-a')?.getAttribute('aria-pressed')).toBe('false')
    expect(next().disabled).toBe(true)

    // The new version arrives: the build is stale and runs again, with
    // Review kept on screen and the row busy until it is built.
    const redone = GOLEM_PET_ATLAS_SHEETS.map((sheet) =>
      sheet.key === 'reactions-a' ? source('reactions-a', 2) : source(sheet.key)
    )
    backend.set(
      reviewCreation({
        step: 'build',
        sheets: redone,
        build: { state: 'built', fresh: false, finishedAt: '2026-10-09T10:30:00Z' }
      })
    )
    await act(async () => {
      backend.emit('cohost.pet.sheet.generated', {
        buildId: BUILD,
        sheet: 'reactions-a',
        version: 2,
        opaque: false
      })
    })
    await settle()
    expect(backend.requestTyped).toHaveBeenCalledWith(
      'cohost.pet.build',
      { buildId: BUILD },
      expect.anything()
    )
    expect(byTestId('golem-pet-step-review')?.getAttribute('aria-current')).toBe('step')
    expect(byTestId('golem-pet-redo-reactions-a')?.textContent).toContain('Redoing')
    expect(next().disabled).toBe(true)
    backend.set(
      reviewCreation({
        sheets: redone,
        build: { state: 'built', fresh: true, finishedAt: '2026-10-09T11:00:00Z' }
      })
    )
    await act(async () => {
      backend.emit('cohost.pet.build.progress', { buildId: BUILD, step: 'done', done: 1, total: 1 })
    })
    await settle()
    expect(byTestId('golem-pet-mark-reactions-a')?.getAttribute('aria-pressed')).toBe('false')
    expect(next().disabled).toBe(true)
    await click(byTestId('golem-pet-mark-reactions-a'))
    expect(next().disabled).toBe(false)

    // Name it: Save needs a name.
    await click(next())
    expect(byTestId('golem-pet-step-save')?.getAttribute('aria-current')).toBe('step')
    expect(byTestId<HTMLButtonElement>('golem-pet-save')?.disabled).toBe(false)
    await click(byTestId('golem-pet-save'))
    expect(backend.requestTyped).toHaveBeenCalledWith(
      'cohost.pet.save',
      { buildId: BUILD, name: 'Golem' },
      expect.anything()
    )
    // The provider takes the persona the backend made Alive; no toast, the
    // wizard closes onto the Golem tab.
    expect(patchCohostSettings).toHaveBeenCalledWith({
      persona: expect.objectContaining({ avatar: { kind: 'alive', packId: PACK } })
    })
    expect(onClose).toHaveBeenCalledTimes(1)
    // The cells and the pack come from the creation folder, through main.
    expect(readGolemCreationFile).toHaveBeenCalledWith('default', BUILD, 'pack/manifest.json')
    expect(readGolemCreationFile).toHaveBeenCalledWith('default', BUILD, 'pack/mascot.webp')
  })

  it('cancels after a confirmation, and nothing is left to continue', async () => {
    const backend = fakeBackend(reviewCreation({ step: 'build', build: undefined }))
    await render({ client: backend.client })
    expect(byTestId('golem-pet-step-build')?.getAttribute('aria-current')).toBe('step')
    await click(byTestId('golem-pet-cancel'))
    expect(backend.requestTyped).not.toHaveBeenCalledWith(
      'cohost.pet.creation.cancel',
      expect.anything(),
      expect.anything()
    )
    await click(byTestId('golem-pet-cancel-confirm'))
    expect(backend.requestTyped).toHaveBeenCalledWith(
      'cohost.pet.creation.cancel',
      { buildId: BUILD },
      expect.anything()
    )
    expect(byTestId('golem-pet-cancel')).toBeNull()
    expect(byTestId('golem-pet-step-reference')?.getAttribute('aria-current')).toBe('step')
    expect(onClose).not.toHaveBeenCalled()
  })

  it('closes from the header without touching the creation', async () => {
    const backend = fakeBackend(reviewCreation())
    await render({ client: backend.client })
    const back = [...document.querySelectorAll('button')].find(
      (button) => button.textContent === 'Golem'
    )
    await click(back ?? null)
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(backend.requestTyped).not.toHaveBeenCalledWith(
      'cohost.pet.creation.cancel',
      expect.anything(),
      expect.anything()
    )
  })
})
