import type { AgentRoomProgram } from '@/lib/talk-show-managed'

// Plan 249 S6: the room's program projection for agents. The Show stage
// (a lazy chunk, mounted only while a room is open) computes it and puts it
// here; the agents' surface publisher reads it. A module store, so the
// eager Studio never imports the room's layout code to describe it.

let current: AgentRoomProgram | undefined
const listeners = new Set<() => void>()

export function setAgentRoomProgram(next: AgentRoomProgram | undefined): void {
  if (JSON.stringify(next) === JSON.stringify(current)) return
  current = next
  for (const listener of listeners) listener()
}

export function agentRoomProgram(): AgentRoomProgram | undefined {
  return current
}

export function subscribeAgentRoomProgram(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}
