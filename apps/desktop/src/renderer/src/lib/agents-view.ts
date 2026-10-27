import type { AgentActivityOutcome, AgentSummary, AgentsStatus } from '@/lib/backend'
import { compactTime, dayLabel } from '@/lib/format'
import { formatRelativeTime } from '@/lib/format-time'

// Plan 209 S7: the words of Settings → Remote → Agents, the Studio's Session
// line (D12) and ⌘K. Pure, and free of the tool catalog, so the Session line
// stays small: callers that name a tool pass its title in (`titleOf`).

/** D21: the switch, as a screen reader says it. */
export const AGENTS_SWITCH_LABEL = 'Let AI agents control Videorc'

/** The section's one sentence of help (S7). */
export const AGENTS_HELP =
  'Agents on this computer can run everything in Videorc: scenes, sounds, recording, going live, chat and your Library.'

/** Off, the section still says what turning it on does (plan 174 V-6). */
export const AGENTS_OFF_HINT =
  'Turn this on, then connect Claude, Cursor, Codex or another AI app on this computer.'

/** The backend's `bindError` carries the OS's raw words; this is the copy (docs/ui-copy.md). */
export const AGENTS_PORTS_BUSY =
  "Ports 7440 to 7449 are all in use, so agents can't reach Videorc. Quit the app using them, then turn this off and on again."

export const AGENT_BRIDGE_MISSING =
  "This copy of Videorc is missing its agent bridge, so agents can't connect. Reinstall Videorc, then try again."

export const CONNECT_AGENT_COMMAND = 'Connect an agent…'
export const STOP_AGENTS_COMMAND = 'Stop agents'

/** The bridge pings every 15 s; the backend calls an agent connected for 45 s after
 * it was last heard from, but publishes nothing when that lapses, so the
 * renderer reads the status again on this beat while one is connected. */
export const AGENTS_PRESENCE_POLL_MS = 15_000

/** Agents heard from in the last 45 s (`connected`, from the backend), while Agents is on. */
export function connectedAgents(status: AgentsStatus | null): AgentSummary[] {
  if (!status?.enabled) return []
  return status.agents.filter((agent) => agent.connected)
}

/** D12: "Claude Desktop connected", "2 agents connected", or null with none. */
export function agentsSessionLine(status: AgentsStatus | null): string | null {
  const connected = connectedAgents(status)
  if (connected.length === 0) return null
  return connected.length === 1
    ? `${connected[0].name} connected`
    : `${connected.length} agents connected`
}

/** How an action ended, as a status word and its dot's tone. Fine stays quiet. */
export function agentOutcomeView(outcome: AgentActivityOutcome): {
  label: string
  tone: 'neutral' | 'warn' | 'error'
} {
  switch (outcome) {
    case 'ok':
      return { label: 'Done', tone: 'neutral' }
    case 'refused':
      return { label: 'Refused', tone: 'warn' }
    case 'failed':
      return { label: 'Failed', tone: 'error' }
    case 'timeout':
      return { label: 'Timed out', tone: 'error' }
  }
}

/**
 * An agent row's facts: its last action and when ("Add a marker", "4m"),
 * when it was last heard from after a restart (the last action is kept in
 * memory only), or "Never used". The age is its own value, so a narrow row
 * cuts the action, never the name or the time.
 */
export function agentLastActionView(
  agent: AgentSummary,
  nowMs: number,
  titleOf: (tool: string) => string
): { what: string; when: string | null } {
  if (agent.lastAction) {
    return {
      what: titleOf(agent.lastAction.tool),
      when: formatRelativeTime(agent.lastAction.at, nowMs)
    }
  }
  if (agent.lastUsedAt) {
    return { what: 'Last seen', when: formatRelativeTime(agent.lastUsedAt, nowMs) }
  }
  return { what: 'Never used', when: null }
}

/**
 * An Activity row's arguments: the summary is the call's JSON (clipped to
 * 160 characters by the backend), read back as "bannerId: sponsor, shown:
 * false". A clipped or odd summary is shown as it came.
 */
export function activityArgumentsLabel(summary: string): string {
  const trimmed = summary.trim()
  if (!trimmed) return ''
  try {
    const parsed: unknown = JSON.parse(trimmed)
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      return Object.entries(parsed)
        .map(
          ([key, value]) => `${key}: ${typeof value === 'string' ? value : JSON.stringify(value)}`
        )
        .join(', ')
    }
  } catch {
    // Clipped JSON: show what came.
  }
  return trimmed
}

/** A refused Agents request: the backend's sentence when it is copy ("Name the agent first."), else null. */
export function agentRefusalMessage(error: unknown): string | null {
  if (!error || typeof error !== 'object') return null
  const { code, message } = error as { code?: unknown; message?: unknown }
  if (code !== 'agents' || typeof message !== 'string') return null
  // "Couldn't save the agent: <os error>" carries raw text: not copy.
  return /:\s/.test(message) ? null : message
}

/** An Activity row's time: the clock today ("14:02:11"), the day and time before. */
export function activityTimeLabel(at: string, nowMs: number): string {
  const when = new Date(at)
  if (Number.isNaN(when.getTime())) return ''
  return when.toDateString() === new Date(nowMs).toDateString() ? compactTime(at) : dayLabel(at)
}

/** The Connect row's line: the apps it works with, or how many are connected now. */
export function agentsSummaryLine(status: AgentsStatus): string {
  if (status.agents.length === 0) {
    return 'Claude Desktop, Claude Code, Cursor, Codex, VS Code or another AI app on this computer.'
  }
  const connected = connectedAgents(status).length
  return connected === 0 ? 'None connected right now.' : `${connected} connected right now.`
}
