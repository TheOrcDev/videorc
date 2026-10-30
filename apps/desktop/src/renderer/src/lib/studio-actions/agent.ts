// Agent intents (plan 209): an agent's tool call, relayed by the backend as an
// `agent.intent` event, runs here against the same Studio context as a Stream
// Deck key. The outcome is the body S6 acks with `agent.intent.ack`
// (`{intentId, ok, message?, result?}`). Nothing here acks or notifies: the
// subscription in hooks/use-studio.tsx does, with the catalog's notice.

import { agentTool } from '../../../../shared/agent-tools'
import type { StudioActionContext, StudioActionFields, StudioActionOutcome } from './context'
import { STUDIO_AGENT_TOOLS } from './tools'

/** Buddy's built-in caller (plan 209 S18): never a registry agent, whose ids
 * are uuids. */
export const BUDDY_AGENT_ID = 'buddy'

/** One tool call as the backend relays it. */
export interface AgentIntent {
  intentId: string
  agentId: string
  /** The name the streamer gave the agent ("Claude Desktop"), for notices and Activity. */
  agentName: string
  /** The catalog's tool name, snake_case (`start_recording`). */
  tool: string
  args: StudioActionFields
  /** Epoch ms: the agent stops waiting then (plan 209 review fix 1). */
  deadlineAt?: number
  /** The cancel generation the backend sent it in. */
  generation?: number
  /** Never on the wire: the Studio's link (lib/agent-studio-link.ts) sets it,
   * and it turns true once Stop agents, Off or Remove cancelled this call. */
  cancelled?: () => boolean
}

/** What a tool call resolves to; `result` is the tool's structured output
 * when its catalog entry has an `outputSchema`. */
export interface AgentIntentOutcome extends StudioActionOutcome {
  result?: unknown
}

/** One tool's Studio executor. A remote executor fits as it is
 * (`start_recording: recordStart`); a tool that answers adds `result`. */
export type AgentToolExecutor = (
  context: StudioActionContext,
  args: StudioActionFields,
  intent: AgentIntent
) => Promise<AgentIntentOutcome>

/** What an agent reads when the Studio cannot run its call at all. */
export const AGENT_INTENT_COPY = {
  unknownTool: "Videorc can't run that tool from the Studio.",
  notBuddys: "Buddy can't use that tool.",
  failed: 'Something went wrong in Videorc.',
  cancelled: 'Agents were stopped in Videorc, so that never ran.',
  late: 'Videorc was busy too long, so that never ran.'
} as const

/** Why an intent the Studio hasn't started never runs (plan 209 review fix
 * 1): Stop agents, Off or Remove cancelled it, or the agent already stopped
 * waiting. Checked when its turn on the agents' lane comes. */
export function agentIntentDropReason(intent: AgentIntent, now = Date.now()): string | null {
  if (intent.cancelled?.()) return AGENT_INTENT_COPY.cancelled
  if (intent.deadlineAt !== undefined && now >= intent.deadlineAt) return AGENT_INTENT_COPY.late
  return null
}

/** The Studio's tools by catalog name (tools.ts); a call to any other name
 * is refused. */
export const AGENT_TOOL_EXECUTORS: Readonly<Record<string, AgentToolExecutor>> = STUDIO_AGENT_TOOLS

/** Runs one agent intent to the body of its ack. Never throws. Called when
 * the intent's turn on the agents' lane comes, so a cancelled or late one is
 * dropped here before anything runs. */
export async function executeAgentIntent(
  intent: AgentIntent,
  context: StudioActionContext,
  executors: Readonly<Record<string, AgentToolExecutor>> = AGENT_TOOL_EXECUTORS
): Promise<AgentIntentOutcome> {
  const dropped = agentIntentDropReason(intent)
  if (dropped) return { ok: false, message: dropped }
  const executor = Object.hasOwn(executors, intent.tool) ? executors[intent.tool] : undefined
  if (!executor) return { ok: false, message: AGENT_INTENT_COPY.unknownTool }
  // D15, a second time: the backend already refused anything outside Buddy's
  // subset; a Buddy intent for any other tool never reaches a handler here.
  if (intent.agentId === BUDDY_AGENT_ID && agentTool(intent.tool)?.buddy !== true) {
    return { ok: false, message: AGENT_INTENT_COPY.notBuddys }
  }
  // The record-latency probe's click, as a deck key notes it.
  if (intent.tool === 'start_recording') context.noteRecordClick?.('start')
  else if (intent.tool === 'stop') context.noteRecordClick?.('stop')
  try {
    const outcome = await executor(context, intent.args ?? {}, intent)
    return {
      ok: outcome.ok,
      ...(outcome.message ? { message: outcome.message } : {}),
      ...(outcome.result !== undefined ? { result: outcome.result } : {})
    }
  } catch (error) {
    // The raw error is for the console; the agent reads plain copy.
    console.error('[agents] tool failed', intent.tool, error)
    return { ok: false, message: AGENT_INTENT_COPY.failed }
  }
}
