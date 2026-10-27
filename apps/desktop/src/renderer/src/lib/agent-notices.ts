import { agentTool, agentToolNotice } from '../../../shared/agent-tools'
import type { AgentsStore } from '@/lib/agents-store'
import type { AgentActivityEntry, AgentIntentEvent } from '@/lib/backend'
import { toast } from '@/lib/toast'

// Plan 209 D11: an agent action that changes what the world sees, or is hard
// to undo, shows a plain notice in the Studio naming the agent ("Claude
// Desktop ended the livestream."), and `notify` shows its message signed with
// the agent's name. Which tools, and the sentence, are the catalog's (`onAir`,
// `notice`). Everything else stays in Activity, so a busy agent never buries
// the streamer in toasts. Notices are neutral (`info`): the type colours the
// icon only (owner rule).
//
// The notice follows the `agents.activity` row, so it says only what
// happened (outcome `ok`), for Studio and backend tools alike. The row's
// argument summary is clipped at 160 characters, so a Studio tool's
// arguments come from its `agent.intent`, remembered until its row arrives.

/** The backend's `summarize_arguments` (agent_call.rs): the call's JSON, clipped. */
const SUMMARY_MAX_CHARS = 160
const REMEMBERED_INTENTS = 32
const REMEMBER_MS = 120_000

export function summarizeAgentArguments(args: unknown): string {
  const isEmptyObject =
    typeof args === 'object' &&
    args !== null &&
    !Array.isArray(args) &&
    Object.keys(args).length === 0
  const text = isEmptyObject ? '' : JSON.stringify(args)
  const chars = [...text]
  return chars.length <= SUMMARY_MAX_CHARS
    ? text
    : `${chars.slice(0, SUMMARY_MAX_CHARS - 1).join('')}…`
}

type Remembered = { intent: AgentIntentEvent; summary: string; at: number }

/** The arguments of recent Studio intents, until their Activity rows arrive. */
export class AgentIntentArguments {
  private remembered: Remembered[] = []

  remember(intent: AgentIntentEvent, nowMs: number): void {
    this.remembered = [
      ...this.remembered.filter((entry) => nowMs - entry.at < REMEMBER_MS),
      { intent, summary: summarizeAgentArguments(intent.args), at: nowMs }
    ].slice(-REMEMBERED_INTENTS)
  }

  /** The intent's arguments for this row: the same agent, tool and summary first. */
  take(entry: AgentActivityEntry, nowMs: number): Record<string, unknown> | null {
    const fresh = this.remembered.filter((item) => nowMs - item.at < REMEMBER_MS)
    const sameCall = (item: Remembered): boolean =>
      item.intent.agentId === entry.agentId && item.intent.tool === entry.tool
    const match =
      fresh.find((item) => sameCall(item) && item.summary === entry.summary) ?? fresh.find(sameCall)
    this.remembered = fresh.filter((item) => item !== match)
    return match ? match.intent.args : null
  }
}

function parsedSummary(summary: string): Record<string, unknown> | null {
  if (!summary.trim()) return {}
  try {
    const parsed: unknown = JSON.parse(summary)
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}

/**
 * The notice for one Activity row, or null: only an action that worked, of
 * a tool whose catalog entry is `onAir`. A toast title takes no period.
 */
export function agentNoticeTitle(
  entry: AgentActivityEntry,
  args: Record<string, unknown> | null
): string | null {
  if (entry.outcome !== 'ok') return null
  const tool = agentTool(entry.tool)
  if (!tool?.onAir) return null
  const values = args ?? parsedSummary(entry.summary) ?? {}
  // A placeholder the arguments can't fill names the action instead.
  const unfilled = [...(tool.notice ?? '').matchAll(/\{(\w+)\}/g)].some(
    ([, key]) => key !== 'agent' && !(key in values)
  )
  const text = unfilled
    ? `${entry.agentName}: ${tool.title}`
    : (agentToolNotice(tool, entry.agentName, values) ?? `${entry.agentName}: ${tool.title}`)
  return text.trim().replace(/\.$/, '')
}

/** One id per agent and tool: a newer notice replaces the older (docs/ui-copy.md). */
export function agentNoticeId(entry: AgentActivityEntry): string {
  return `agent-notice:${entry.agentId}:${entry.tool}`
}

/** Shows the D11 notices from `store` until the returned function is called. */
export function startAgentNotices(
  store: Pick<AgentsStore, 'onEvent'>,
  {
    now = Date.now,
    show = (title: string, id: string) => void toast.info(title, { id })
  }: { now?: () => number; show?: (title: string, id: string) => void } = {}
): () => void {
  const intents = new AgentIntentArguments()
  return store.onEvent((event) => {
    if (event.kind === 'intent') {
      intents.remember(event.intent, now())
      return
    }
    const args = intents.take(event.entry, now())
    const title = agentNoticeTitle(event.entry, args)
    if (title) show(title, agentNoticeId(event.entry))
  })
}
