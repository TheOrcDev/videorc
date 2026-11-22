// Its own module so the agents' link (lib/agent-studio-link.ts), loaded with
// every Studio socket, does not load the agent executors and their 60 KB tool
// catalog (performance finding PH-09); a tool call loads them when it runs.

/** Buddy's built-in caller (plan 209 S18): never a registry agent, whose ids
 * are uuids. */
export const BUDDY_AGENT_ID = 'buddy'
