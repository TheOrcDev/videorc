// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { AgentSummary, AgentsStatus } from '@/lib/backend'

import { AgentsSessionRow } from './agents-session-row'

// Plan 209 D12: the Studio's Session line while an agent is connected, with
// Stop, in the default look and on the Retro LCD screen.

const mocked = vi.hoisted(() => ({
  status: null as AgentsStatus | null,
  stop: vi.fn(async () => undefined)
}))
vi.mock('@/hooks/use-agents', () => ({
  useAgents: () => ({ status: mocked.status }),
  useAgentsActions: () => ({ stop: mocked.stop })
}))

function agent(overrides: Partial<AgentSummary>): AgentSummary {
  return {
    id: 'a1',
    name: 'Claude Desktop',
    client: 'claude-desktop',
    createdAt: '2026-10-27T12:00:00Z',
    connected: true,
    ...overrides
  }
}

function status(agents: AgentSummary[], enabled = true): AgentsStatus {
  return {
    enabled,
    agents,
    connectedCount: agents.filter((entry) => entry.connected).length,
    studioOpen: true
  }
}

let root: Root
let container: HTMLDivElement

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  mocked.stop.mockClear()
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})

async function render(look: 'default' | 'lcd' = 'default'): Promise<void> {
  await act(async () => root.render(createElement(AgentsSessionRow, { look })))
}

const stopButton = (): HTMLButtonElement | null =>
  container.querySelector<HTMLButtonElement>('[data-testid="session-agents-stop"]')

describe('AgentsSessionRow (plan 209 D12)', () => {
  it('shows nothing while no agent is connected, or Agents is off', async () => {
    mocked.status = null
    await render()
    expect(container.textContent).toBe('')
    mocked.status = status([agent({ connected: false })])
    await render()
    expect(container.textContent).toBe('')
    mocked.status = status([agent({})], false)
    await render()
    expect(container.textContent).toBe('')
  })

  it('names one agent, counts several, and Stop cuts them all at once', async () => {
    mocked.status = status([agent({}), agent({ id: 'a2', name: 'Cursor', connected: false })])
    await render()
    expect(container.textContent).toContain('Claude Desktop connected')
    expect(stopButton()?.getAttribute('aria-label')).toBe('Stop agents')
    expect(stopButton()?.textContent).toBe('Stop')
    await act(async () => stopButton()!.click())
    expect(mocked.stop).toHaveBeenCalledOnce()

    mocked.status = status([agent({}), agent({ id: 'a2', name: 'Cursor' })])
    await render()
    expect(container.textContent).toContain('2 agents connected')
  })

  it('draws the same line on the Retro LCD screen', async () => {
    mocked.status = status([agent({})])
    await render('lcd')
    expect(container.textContent).toContain('Claude Desktop connected')
    await act(async () => stopButton()!.click())
    expect(mocked.stop).toHaveBeenCalledOnce()
  })
})
