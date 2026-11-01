import { describe, expect, it } from 'vitest'

import type { AgentSummary, AgentsStatus } from '@/lib/backend'

import {
  activityArgumentsLabel,
  activityTimeLabel,
  agentLastActionView,
  agentOutcomeView,
  agentRefusalMessage,
  agentsSessionLine,
  agentsSummaryLine,
  connectedAgents
} from './agents-view'

const NOW = Date.parse('2026-10-27T15:00:00Z')

function agent(overrides: Partial<AgentSummary> = {}): AgentSummary {
  return {
    id: 'a1',
    name: 'Claude Desktop',
    client: 'claude-desktop',
    createdAt: '2026-10-27T12:00:00Z',
    connected: false,
    ...overrides
  }
}

function status(agents: AgentSummary[], enabled = true): AgentsStatus {
  return {
    enabled,
    port: enabled ? 7440 : undefined,
    agents,
    connectedCount: agents.filter((entry) => entry.connected).length,
    studioOpen: true
  }
}

describe('agents view (plan 209 S7, D12)', () => {
  it('says which agent is connected, or how many, and nothing with none', () => {
    expect(agentsSessionLine(null)).toBeNull()
    expect(agentsSessionLine(status([agent()]))).toBeNull()
    expect(agentsSessionLine(status([agent({ connected: true })]))).toBe('Claude Desktop connected')
    expect(
      agentsSessionLine(
        status([agent({ connected: true }), agent({ id: 'a2', name: 'Cursor', connected: true })])
      )
    ).toBe('2 agents connected')
    // Off (after Stop) nothing reads as connected, whatever the rows say.
    expect(agentsSessionLine(status([agent({ connected: true })], false))).toBeNull()
    expect(connectedAgents(status([agent({ connected: true })], false))).toEqual([])
  })

  it('names the last action and when, a restart-old last use, or Never used', () => {
    const titleOf = (tool: string): string => (tool === 'add_marker' ? 'Add a marker' : tool)
    expect(agentLastActionView(agent(), NOW, titleOf)).toEqual({ what: 'Never used', when: null })
    expect(
      agentLastActionView(
        agent({
          lastUsedAt: '2026-10-27T14:56:00Z',
          lastAction: { tool: 'add_marker', at: '2026-10-27T14:56:00Z', outcome: 'ok' }
        }),
        NOW,
        titleOf
      )
    ).toEqual({ what: 'Add a marker', when: '4m' })
    expect(
      agentLastActionView(agent({ lastUsedAt: '2026-10-24T15:00:00Z' }), NOW, titleOf)
    ).toEqual({ what: 'Last seen', when: '3d' })
  })

  it('words each outcome, quiet when it worked', () => {
    expect(agentOutcomeView('ok')).toEqual({ label: 'Done', tone: 'neutral' })
    expect(agentOutcomeView('refused')).toEqual({ label: 'Refused', tone: 'warn' })
    expect(agentOutcomeView('failed')).toEqual({ label: 'Failed', tone: 'error' })
    expect(agentOutcomeView('timeout')).toEqual({ label: 'Timed out', tone: 'error' })
  })

  it('reads the argument summary back as fields, or shows a clipped one as it came', () => {
    expect(activityArgumentsLabel('')).toBe('')
    expect(activityArgumentsLabel('{"bannerId":"sponsor","shown":false}')).toBe(
      'bannerId: sponsor, shown: false'
    )
    expect(activityArgumentsLabel('{"message":"a very long…')).toBe('{"message":"a very long…')
  })

  it('shows the clock for today and the day before that', () => {
    expect(activityTimeLabel('2026-10-27T14:02:11Z', NOW)).toMatch(/\d{1,2}:\d{2}:\d{2}/)
    expect(activityTimeLabel('2026-10-20T14:02:11Z', NOW)).toMatch(/Oct/)
    expect(activityTimeLabel('not a time', NOW)).toBe('')
  })

  it("passes the backend's refusal sentence through, never its raw cause", () => {
    expect(
      agentRefusalMessage({ code: 'agents', message: '16 agents are connected. Remove one first.' })
    ).toBe('16 agents are connected. Remove one first.')
    expect(
      agentRefusalMessage({
        code: 'agents',
        message: "Couldn't save the agent: disk full (os error 28)"
      })
    ).toBeNull()
    expect(agentRefusalMessage({ code: 'invalid-params', message: 'bad' })).toBeNull()
    expect(agentRefusalMessage(new Error('x'))).toBeNull()
  })

  it('says which apps work before the first agent, then how many are connected', () => {
    expect(agentsSummaryLine(status([]))).toMatch(/^Claude Desktop, Claude Code, Cursor, Codex/)
    expect(agentsSummaryLine(status([agent()]))).toBe('None connected right now.')
    expect(agentsSummaryLine(status([agent({ connected: true })]))).toBe('1 connected right now.')
  })
})
