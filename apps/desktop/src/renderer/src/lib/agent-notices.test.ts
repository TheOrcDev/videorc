import { describe, expect, it, vi } from 'vitest'

import type { AgentActivityEntry } from '@/lib/backend'
import type { AgentsStoreEvent } from '@/lib/agents-store'

import { agentNoticeId, agentNoticeTitle, startAgentNotices } from './agent-notices'

// Plan 209 D11: the backend fills the catalog's notice for a successful onAir
// call and puts it on the `agents.activity` event as `notice`. The Studio
// toasts that sentence, once, and nothing for a row without one.

function entry(overrides: Partial<AgentActivityEntry> = {}): AgentActivityEntry {
  return {
    id: 'e1',
    at: '2026-10-27T14:00:00Z',
    agentId: 'a1',
    agentName: 'Claude Desktop',
    tool: 'notify',
    summary: '{"message":"Stream starts in 5 minutes."}',
    outcome: 'ok',
    notice: 'Claude Desktop: Stream starts in 5 minutes.',
    ...overrides
  }
}

function listen(): {
  emit: (event: AgentsStoreEvent) => void
  show: ReturnType<typeof vi.fn>
  stop: () => void
  listening: () => boolean
} {
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
    { show }
  )
  return { emit: (event) => listener?.(event), show, stop, listening: () => listener !== null }
}

describe('agent notices (plan 209 D11)', () => {
  it("shows the backend's sentence as it came, without a closing period", () => {
    expect(agentNoticeTitle(entry())).toBe('Claude Desktop: Stream starts in 5 minutes')
    // `stop`'s sentence needs the result ("{stopped}"); only the backend has it.
    expect(
      agentNoticeTitle(entry({ tool: 'stop', summary: '', notice: 'Cursor ended the livestream.' }))
    ).toBe('Cursor ended the livestream')
  })

  it('shows nothing for a row without a notice', () => {
    expect(agentNoticeTitle(entry({ notice: undefined }))).toBeNull()
    expect(agentNoticeTitle(entry({ notice: '  ' }))).toBeNull()
    // A stored row or another tool's: no sentence, no toast, whatever the tool.
    expect(
      agentNoticeTitle(entry({ tool: 'stop', outcome: 'refused', notice: undefined }))
    ).toBeNull()
    expect(agentNoticeTitle(entry({ tool: 'add_marker', notice: undefined }))).toBeNull()
  })

  it('toasts notify\'s "{agent}: {message}" exactly once, one id per agent and tool', () => {
    const { emit, show, stop, listening } = listen()
    emit({ kind: 'activity', entry: entry({ notice: 'Claude Desktop: Going live soon.' }) })
    emit({
      kind: 'activity',
      entry: entry({ id: 'e2', tool: 'add_marker', summary: '{}', notice: undefined })
    })
    emit({ kind: 'activity', entry: entry({ id: 'e3', outcome: 'refused', notice: undefined }) })
    expect(show).toHaveBeenCalledExactlyOnceWith(
      'Claude Desktop: Going live soon',
      'agent-notice:a1:notify'
    )
    expect(agentNoticeId(entry())).toBe('agent-notice:a1:notify')
    stop()
    expect(listening()).toBe(false)
  })
})
