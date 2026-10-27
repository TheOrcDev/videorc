// Agent intents (plan 209): an agent's tool call, relayed by the backend as an
// `agent.intent` event, runs here against the same Studio context as a Stream
// Deck key. The outcome is the body S6 acks with `agent.intent.ack`
// (`{intentId, ok, message?, result?}`). Nothing here acks or notifies: the
// subscription in hooks/use-studio.tsx does, with the catalog's notice.

import type { StudioActionContext, StudioActionFields, StudioActionOutcome } from './context'
import { STUDIO_AGENT_TOOLS } from './tools'

/** One tool call as the backend relays it. */
export interface AgentIntent {
  intentId: string
  agentId: string
  /** The name the streamer gave the agent ("Claude Desktop"), for notices and Activity. */
  agentName: string
  /** The catalog's tool name, snake_case (`start_recording`). */
  tool: string
  args: StudioActionFields
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
  failed: 'Something went wrong in Videorc.'
} as const

/** The Studio's tools by catalog name (tools.ts); a call to any other name
 * is refused. */
export const AGENT_TOOL_EXECUTORS: Readonly<Record<string, AgentToolExecutor>> = STUDIO_AGENT_TOOLS

/** Runs one agent intent to the body of its ack. Never throws. */
export async function executeAgentIntent(
  intent: AgentIntent,
  context: StudioActionContext,
  executors: Readonly<Record<string, AgentToolExecutor>> = AGENT_TOOL_EXECUTORS
): Promise<AgentIntentOutcome> {
  const executor = Object.hasOwn(executors, intent.tool) ? executors[intent.tool] : undefined
  if (!executor) return { ok: false, message: AGENT_INTENT_COPY.unknownTool }
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
