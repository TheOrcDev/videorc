// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { SessionSourceKind, SessionSources } from '@/lib/backend'

import { SourceSwitchStatus } from './source-switch-status'

const mocked = vi.hoisted(() => ({ core: {} as Record<string, unknown> }))
vi.mock('@/hooks/use-studio', () => ({ useStudioCore: () => mocked.core }))

const LINUX_MICROPHONE_REASON =
  'Live microphone replacement is not available on Linux yet. This session keeps its initial microphone input.'
const LINUX_SCREEN_REASON =
  "Changing the screen during a session isn't available on Linux yet. Stop, change it, then start again."

function lostSource(
  kind: SessionSourceKind,
  capability: { supported: boolean; reason: string | null }
): SessionSources {
  return {
    audio: null,
    sessionId: 'session-1',
    sourceRevision: 1,
    outputProcessId: 1,
    confirmed: {},
    health: [{ kind, deviceId: 'device-1', health: 'unavailable' }],
    pending: null,
    lastOperation: null,
    capabilities: [{ kind, ...capability }]
  }
}

let root: Root
let container: HTMLDivElement

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})

async function renderStatus(kind: SessionSourceKind, snapshot: SessionSources): Promise<string> {
  const capability = snapshot.capabilities.find((item) => item.kind === kind)
  mocked.core = {
    sourceSelectionState: { snapshot, pending: null, checking: false, error: null },
    // The pickers disable themselves on this reason, as the controller does.
    sourceSwitchReason: () =>
      capability?.supported ? null : (capability?.reason ?? 'Checking available source controls…'),
    retrySourceStatus: vi.fn(),
    deviceList: { devices: [] }
  }
  await act(async () => root.render(createElement(SourceSwitchStatus, { kind })))
  return container.textContent ?? ''
}

describe('SourceSwitchStatus for a source that stopped mid-session', () => {
  it('asks to choose it again where the picker can change it', async () => {
    const text = await renderStatus(
      'microphone',
      lostSource('microphone', { supported: true, reason: null })
    )
    expect(text).toBe('Source unavailable. Choose it again to retry, or choose another.')
  })

  it('says to stop first where the picker is disabled (Linux microphone)', async () => {
    const text = await renderStatus(
      'microphone',
      lostSource('microphone', { supported: false, reason: LINUX_MICROPHONE_REASON })
    )
    expect(text).toBe('Source unavailable. Stop, then choose it again or choose another.')
    expect(text).not.toContain('Choose it again to retry')
  })

  it('says to stop first for a Linux screen that went away', async () => {
    const text = await renderStatus(
      'capture',
      lostSource('capture', { supported: false, reason: LINUX_SCREEN_REASON })
    )
    expect(text).toBe('Source unavailable. Stop, then choose it again or choose another.')
  })
})
