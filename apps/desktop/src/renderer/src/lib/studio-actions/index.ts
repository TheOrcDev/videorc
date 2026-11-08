// Studio actions (plan 209 S5): one executor per action, behind one context,
// for everything that drives the Studio from away from the desk.
//
// The shape:
// - `StudioActionContext` (context.ts): what `studioActionContext`
//   (studio-context.ts) builds per intent from the latest render's handlers
//   hooks/use-studio.tsx hands over. Remote intents and agent tools run
//   against the same one.
// - One pure executor per action (session.ts, audio.ts, scene.ts, banners.ts,
//   sounds.ts, windows.ts, comments.ts, clips.ts):
//   `(context, fields) => Promise<{ok, message?}>`. None acks or toasts.
// - `executeRemoteIntent` (remote.ts): the `remote.intent` envelope to its
//   `remote.intent.ack`, through `REMOTE_INTENT_EXECUTORS`, keyed by kind.
// - `executeAgentIntent` (agent.ts): an agent's `{intentId, agentId,
//   agentName, tool, args}` to `{ok, message?, result?}`, through
//   `AGENT_TOOL_EXECUTORS`, keyed by the catalog's tool name: the Studio
//   tools in tools.ts (S6), each a remote executor plus the sentence and
//   result the agent reads. hooks/use-studio.tsx hands the agents' lane of
//   lib/remote-intent-queue.ts a `runAgent` that builds the context and calls
//   `executeAgentIntent`, and acks what the lane resolves with
//   `agent.intent.ack`.
//
// Loaded lazily by the Studio (a dynamic import), like the remote surface:
// nothing here belongs in the eager renderer bundle.

export {
  AGENT_INTENT_COPY,
  AGENT_TOOL_EXECUTORS,
  agentIntentDropReason,
  executeAgentIntent,
  type AgentIntent,
  type AgentIntentOutcome,
  type AgentToolExecutor
} from './agent'
export {
  micMute,
  micToggle,
  micUnmute,
  systemAudioOff,
  systemAudioOn,
  systemAudioToggle
} from './audio'
export { bannerHide, bannerShow, bannerToggle } from './banners'
export { clipMark } from './clips'
export { commentHighlight, commentHighlightClear } from './comments'
export type {
  StudioActionClient,
  StudioActionContext,
  StudioActionExecutor,
  StudioActionFields,
  StudioActionOutcome
} from './context'
export { REMOTE_INTENT_COPY } from './copy'
export { REMOTE_INTENT_EXECUTORS, executeRemoteIntent } from './remote'
export { sceneApply, takeoverHide, takeoverShow } from './scene'
export { recordStart, recordStop, recordToggle, streamStart, streamStop } from './session'
export { soundPlay, soundStop } from './sounds'
export {
  executeStudioAgentIntent,
  studioActionContext,
  type StudioActionSource
} from './studio-context'
export { AGENT_TOOL_COPY, STUDIO_AGENT_TOOLS } from './tools'
export { windowFront } from './windows'
