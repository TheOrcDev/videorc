// @vitest-environment happy-dom
import fixture from '../../../../../../../protocol-fixtures/cloud-source-iso.json'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { TooltipProvider } from '@/components/ui/tooltip'
import type { CloudIsoAnswer, CloudStatus } from '@/lib/backend'
import { ada, openRoom, talkStatus } from '@/lib/guests-room-fixtures'

import { CloudIsoSection } from './cloud-iso-section'

// Plan 249 S22: Destinations → Guests → Separate files. Disabled with its
// reason while unqualified; on only through the confirmation and its
// checkbox; then who agreed and what records, failures said.

const studio = vi.hoisted(() => ({
  cloud: { cloudStatus: null as CloudStatus | null },
  core: { wsStatus: 'connected' },
  diagnostics: { client: null as unknown }
}))

vi.mock('@/hooks/use-studio', () => ({
  useStudioCloud: () => studio.cloud,
  useStudioCore: () => studio.core,
  useStudioDiagnostics: () => studio.diagnostics
}))

const SHOW = 'sh_aaaaaaaaaaaaaaaaaaaaaa'

function answer(qualified: boolean, on = false): CloudIsoAnswer {
  return {
    availability: { enabled: qualified, productionQualified: qualified },
    iso: on
      ? {
          request: {
            atMs: 1,
            consentVersion: 'iso-consent-v1',
            maxActiveEntries: 12,
            maxMinutes: 120,
            costCeilingMicros: 1_440_000,
            retentionDays: 30
          },
          lastRefusal: null,
          guestConsent: [{ identity: 'g_ann', atMs: 2 }],
          takes: [{ manifest: structuredClone(fixture.valid), programRecordingId: 'rec_program' }]
        }
      : null
  }
}

function fakeClient(status: CloudIsoAnswer, refuse?: string) {
  const calls: Array<{ method: string; params: unknown }> = []
  // The backend's state: what Turn on and Turn off changed, the next status reads.
  let current = status
  return {
    calls,
    requestTyped: vi.fn(async (method: string, params?: unknown) => {
      calls.push({ method, params })
      if (method === 'cloud.iso.status') return current
      if (method === 'cloud.iso.enable') {
        if (refuse) throw Object.assign(new Error('refused'), { code: refuse })
        current = answer(true, true)
        return current
      }
      if (method === 'cloud.iso.disable') {
        current = answer(true, false)
        return current
      }
      throw new Error(`unexpected ${method}`)
    })
  }
}

let root: Root
let container: HTMLDivElement

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  studio.core.wsStatus = 'connected'
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})

async function mount(client: ReturnType<typeof fakeClient>, room = openRoom()): Promise<void> {
  studio.cloud.cloudStatus = talkStatus({
    show: { id: SHOW, nodeId: 'n', resumable: false, kind: 'talk' },
    room
  })
  studio.diagnostics.client = client
  await act(async () =>
    root.render(createElement(TooltipProvider, null, createElement(CloudIsoSection)))
  )
}

const find = (testId: string): HTMLElement | null =>
  document.body.querySelector<HTMLElement>(`[data-testid="${testId}"]`)

async function click(testId: string): Promise<void> {
  const element = find(testId)
  expect(element, testId).not.toBeNull()
  await act(async () => element?.click())
}

describe('Separate files in the room (Plan 249 S22)', () => {
  it('stays on screen, disabled with its reason, while unqualified', async () => {
    const client = fakeClient(answer(false))
    await mount(client)
    const row = find('guests-iso-row')
    expect(row?.textContent).toContain('Record separate files')
    expect(row?.textContent).toContain("Separate cloud files aren't available yet.")
    const toggle = find('guests-iso-switch')
    expect(
      toggle?.getAttribute('aria-disabled') ?? toggle?.hasAttribute('data-disabled')
    ).toBeTruthy()
    await click('guests-iso-switch')
    expect(find('guests-iso-enable-dialog')).toBeNull()
    expect(client.calls.map((call) => call.method)).toEqual(['cloud.iso.status'])
    expect(client.calls[0]?.params).toEqual({ showId: SHOW })
  })

  it('says the plan refusal instead of a generic failure', async () => {
    const client = fakeClient(answer(false))
    client.requestTyped.mockImplementationOnce(async () => {
      throw Object.assign(new Error('plan'), { code: 'cloud-iso-plan' })
    })
    await mount(client)
    expect(find('guests-iso-row')?.textContent).toContain(
      "Separate cloud files aren't part of your plan."
    )
    expect(find('guests-iso-row')?.textContent).not.toContain("Couldn't check")
  })

  it('turns on only through the confirmation, with consent checked', async () => {
    const client = fakeClient(answer(true))
    await mount(client)
    await click('guests-iso-switch')
    const dialog = find('guests-iso-enable-dialog')
    expect(dialog).not.toBeNull()
    const text = dialog?.textContent ?? ''
    expect(text).toContain('Your camera, microphone and screen, each as its own file.')
    expect(text).toContain('combined in one file')
    expect(text).toContain('Only guests who agree are recorded separately')
    expect(text).toContain('Up to 12 files at once, for up to 2 hours.')
    expect(find('guests-iso-cost')?.textContent).toBe(
      'Estimated cost: up to $1.44 (12 files × 120 minutes at $0.001 a minute, the published price). An estimate, not a bill.'
    )
    // Without the checkbox the confirmation sends nothing.
    expect((find('guests-iso-enable-confirm') as HTMLButtonElement).disabled).toBe(true)
    await click('guests-iso-enable-confirm')
    expect(client.calls.some((call) => call.method === 'cloud.iso.enable')).toBe(false)

    await click('guests-iso-agree')
    expect((find('guests-iso-enable-confirm') as HTMLButtonElement).disabled).toBe(false)
    await click('guests-iso-enable-confirm')
    const enable = client.calls.find((call) => call.method === 'cloud.iso.enable')
    expect(enable?.params).toEqual({
      showId: SHOW,
      consent: true,
      maxActiveEntries: 12,
      maxMinutes: 120,
      costCeilingMicros: 1_440_000
    })
    expect(find('guests-iso-row')?.textContent).toContain('On for this show.')
  })

  it('Cancel sends nothing', async () => {
    const client = fakeClient(answer(true))
    await mount(client)
    await click('guests-iso-switch')
    await click('guests-iso-agree')
    await click('guests-iso-enable-cancel')
    expect(client.calls.some((call) => call.method === 'cloud.iso.enable')).toBe(false)
  })

  it('keeps the confirmation up with the refusal said', async () => {
    const client = fakeClient(answer(true), 'cloud-iso-refused')
    await mount(client)
    await click('guests-iso-switch')
    await click('guests-iso-agree')
    await click('guests-iso-enable-confirm')
    expect(find('guests-iso-enable-error')?.textContent).toBe(
      "Videorc Cloud can't record separate files for this show right now."
    )
    expect(find('guests-iso-enable-dialog')).not.toBeNull()
  })

  it('shows who agreed and what records, failures per file, and turns off', async () => {
    const client = fakeClient(answer(true, true))
    await mount(
      client,
      openRoom({
        guests: [
          ada,
          { guestId: 'g_ann', name: 'Ann', joinedAt: '', muted: false, screenShareAllowed: true }
        ]
      })
    )
    const guests = [...document.body.querySelectorAll('[data-testid="guests-iso-guest"]')].map(
      (row) => row.textContent
    )
    expect(guests).toEqual([expect.stringContaining('Ada'), expect.stringContaining('Ann')])
    expect(guests[0]).toContain("Hasn't agreed")
    expect(guests[1]).toContain('Agreed')
    const files = [...document.body.querySelectorAll('[data-testid="guests-iso-file"]')].map(
      (row) => row.textContent ?? ''
    )
    expect(files[0]).toContain('Your camera')
    expect(files.at(-1)).toContain("Ann's microphone")
    expect(files.at(-1)).toContain("Couldn't start")
    expect(files.at(-1)).toContain('Failed')
    expect(find('guests-iso-note')?.textContent).toContain("weren't recorded separately")

    await click('guests-iso-switch')
    expect(find('guests-iso-enable-dialog')).toBeNull()
    expect(client.calls.find((call) => call.method === 'cloud.iso.disable')?.params).toEqual({
      showId: SHOW
    })
  })

  it('waits for the room before it asks', async () => {
    const client = fakeClient(answer(true))
    await mount(client, openRoom({ phase: 'closed' }))
    expect(client.calls).toHaveLength(0)
    expect(find('guests-iso-row')?.textContent).toContain('Open the room first.')
  })
})
