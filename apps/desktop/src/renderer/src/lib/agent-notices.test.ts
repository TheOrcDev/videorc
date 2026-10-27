import { describe, expect, it, vi } from 'vitest'

import { AGENT_TOOL_CATALOG } from '../../../shared/agent-tools'
import type { AgentActivityEntry, AgentIntentEvent } from '@/lib/backend'
import type { AgentsStoreEvent } from '@/lib/agents-store'

import {
  AgentIntentArguments,
  agentNoticeId,
  agentNoticeTitle,
  startAgentNotices,
  summarizeAgentArguments
} from './agent-notices'

// Plan 209 D11: a notice naming the agent for the catalog's onAir tools, after
// the action worked, and `notify`'s own message signed with the agent's name.
// Nothing for any other tool.

function entry(overrides: Partial<AgentActivityEntry> = {}): AgentActivityEntry {
  return {
    id: 'e1',
    at: '2026-10-27T14:00:00Z',
    agentId: 'a1',
    agentName: 'Claude Desktop',
    tool: 'notify',
    summary: '{"message":"Stream starts in 5 minutes."}',
    outcome: 'ok',
    ...overrides
  }
}

function intent(args: Record<string, unknown>, overrides: Partial<AgentIntentEvent> = {}) {
  return {
    intentId: 'ai-1',
    agentId: 'a1',
    agentName: 'Claude Desktop',
    tool: 'notify',
    args,
    ...overrides
  } satisfies AgentIntentEvent
}

describe('agent notices (plan 209 D11)', () => {
  it('signs notify with the agent, as the catalog writes it, without a closing period', () => {
    expect(AGENT_TOOL_CATALOG.tools.find((tool) => tool.name === 'notify')?.onAir).toBe(true)
    expect(agentNoticeTitle(entry(), null)).toBe('Claude Desktop: Stream starts in 5 minutes')
  })

  it('shows nothing for a tool that is not on air, or an action that did not run', () => {
    expect(agentNoticeTitle(entry({ tool: 'add_marker', summary: '{}' }), null)).toBeNull()
    expect(
      agentNoticeTitle(entry({ tool: 'set_banner', summary: '{"shown":true}' }), null)
    ).toBeNull()
    expect(agentNoticeTitle(entry({ outcome: 'refused' }), null)).toBeNull()
    expect(agentNoticeTitle(entry({ outcome: 'failed' }), null)).toBeNull()
    expect(agentNoticeTitle(entry({ tool: 'no_such_tool' }), null)).toBeNull()
  })

  it("fills a clipped summary from the intent's own arguments", () => {
    const message = `Heads up: ${'x'.repeat(170)}`
    const summary = summarizeAgentArguments({ message })
    expect(summary.endsWith('…')).toBe(true)
    expect([...summary]).toHaveLength(160)
    const remembered = new AgentIntentArguments()
    remembered.remember(intent({ message }), 0)
    const args = remembered.take(entry({ summary }), 10)
    expect(agentNoticeTitle(entry({ summary }), args)).toBe(`Claude Desktop: ${message}`)
    // Taken once.
    expect(remembered.take(entry({ summary }), 20)).toBeNull()
  })

  it('names the action when no argument can fill the sentence', () => {
    expect(agentNoticeTitle(entry({ summary: '{"message":"clipped…' }), null)).toBe(
      'Claude Desktop: Show a notice'
    )
  })

  it('matches an intent by agent, tool and summary, and forgets old ones', () => {
    const remembered = new AgentIntentArguments()
    remembered.remember(intent({ message: 'first' }), 0)
    remembered.remember(intent({ message: 'second' }), 0)
    expect(
      remembered.take(entry({ summary: summarizeAgentArguments({ message: 'second' }) }), 1)
    ).toEqual({ message: 'second' })
    expect(remembered.take(entry({ agentId: 'other' }), 1)).toBeNull()
    expect(remembered.take(entry({ summary: 'whatever' }), 1)).toEqual({ message: 'first' })
    remembered.remember(intent({ message: 'stale' }), 0)
    expect(remembered.take(entry(), 10 * 60_000)).toBeNull()
  })

  it('mirrors the backend summary: nothing for no arguments, else the JSON', () => {
    expect(summarizeAgentArguments({})).toBe('')
    expect(summarizeAgentArguments({ shown: false })).toBe('{"shown":false}')
  })

  it('toasts from the store events, one id per agent and tool', () => {
    let listener: ((event: AgentsStoreEvent) => void) | null = null
    const show = vi.fn()
    const stop = startAgentNotices(
      {
        onEvent: (next) => {
          listener = next
          return () => {
            listener = null
          }
        }
      },
      { now: () => 0, show }
    )
    listener!({ kind: 'intent', intent: intent({ message: 'Going live soon.' }) })
    listener!({
      kind: 'activity',
      entry: entry({ summary: summarizeAgentArguments({ message: 'Going live soon.' }) })
    })
    listener!({ kind: 'activity', entry: entry({ id: 'e2', tool: 'add_marker', summary: '{}' }) })
    expect(show).toHaveBeenCalledExactlyOnceWith(
      'Claude Desktop: Going live soon',
      'agent-notice:a1:notify'
    )
    expect(agentNoticeId(entry())).toBe('agent-notice:a1:notify')
    stop()
    expect(listener).toBeNull()
  })
})
