// The Studio's link to agents (plan 209 S6), one per Studio socket: the
// agents' projection (lib/agent-surface.ts), published only while Agents is
// on, and the agents' lane of Studio tool calls. hooks/use-studio.tsx loads
// it lazily with its socket, so none of it is in the eager bundle.
//
// Only a socket that says `agent.intent.listen` receives `agent.intent` and
// counts as "the Studio is open", so the Agents store's own socket never
// stalls an agent's call. A new socket starts without it: `markConnected`
// asks again on every (re)connect.

import type { BackendClient } from '@/backendClient'
import { AgentSurfacePublisher, type AgentSurfaceInput } from '@/lib/agent-surface'
import type { AgentsStatus } from '@/lib/backend'
import type { AgentIntent, AgentIntentOutcome } from '@/lib/studio-actions/agent'

export interface AgentStudioLinkHooks {
  /** Runs an agent's Studio tool on the agents' lane of the intent queue. */
  run: (intent: AgentIntent) => Promise<AgentIntentOutcome>
  /** An agent renamed a recording in the backend: the Library refreshes. */
  recordingRenamed: () => void
  reportError: (error: unknown) => void
}

type LinkClient = Pick<BackendClient, 'on' | 'request' | 'requestTyped'>

export class AgentStudioLink {
  private readonly publisher: AgentSurfacePublisher
  private readonly unsubscribers: (() => void)[]

  constructor(
    private readonly client: LinkClient,
    hooks: AgentStudioLinkHooks,
    publisher = new AgentSurfacePublisher()
  ) {
    this.publisher = publisher
    publisher.attach(client)
    this.unsubscribers = [
      // An agent's Studio tool, relayed by the backend, runs on the agents'
      // lane through lib/studio-actions and is always acked: the agent is
      // waiting on the answer.
      client.on('agent.intent', (payload) => {
        const intent = payload as AgentIntent
        const ack = (outcome: AgentIntentOutcome): Promise<unknown> =>
          client
            .request('agent.intent.ack', { intentId: intent.intentId, ...outcome })
            .catch(() => undefined)
        hooks.run(intent).then(ack, (error: unknown) => {
          hooks.reportError(error)
          return ack({ ok: false, message: 'Something went wrong in Videorc.' })
        })
      }),
      client.on('agents.status', (payload) => {
        publisher.setEnabled((payload as AgentsStatus).enabled)
      }),
      // Plan 209 S15: an agent renamed a recording in the backend; the
      // Library shows the new title like its own rename does.
      client.on('agents.activity', (payload) => {
        const entry = payload as { tool?: string; outcome?: string } | null
        if (entry?.outcome === 'ok' && entry.tool === 'rename_recording') {
          hooks.recordingRenamed()
        }
      })
    ]
  }

  /** The Studio's latest inputs; safe from a render body. */
  sync(input: AgentSurfaceInput): void {
    this.publisher.sync(input)
  }

  /** The socket is live (`backend.ready`): republish, run agent intents on
   * this socket, and read whether Agents is on. */
  markConnected(): void {
    this.publisher.markConnected()
    void this.client
      .requestTyped('agent.intent.listen')
      .catch((error: unknown) => console.warn('[agents] Could not run agent intents:', error))
    // Non-fatal: the next `agents.status` event turns the projection on.
    void this.client
      .request<AgentsStatus>('agents.status')
      .then((status) => this.publisher.setEnabled(status.enabled))
      .catch((error: unknown) => console.warn('[agents] status unavailable', error))
  }

  detach(): void {
    for (const unsubscribe of this.unsubscribers) unsubscribe()
    this.publisher.detach()
  }
}
