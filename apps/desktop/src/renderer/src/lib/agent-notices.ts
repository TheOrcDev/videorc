import type { AgentsStore } from '@/lib/agents-store'
import type { AgentActivityEntry } from '@/lib/backend'
import { toast } from '@/lib/toast'

// Plan 209 D11: an agent action that changes what the world sees, or is hard
// to undo, shows a plain notice in the Studio naming the agent ("Claude
// Desktop ended the livestream."), and `notify` shows its message signed with
// the agent's name. Everything else stays in Activity, so a busy agent never
// buries the streamer in toasts. Notices are neutral (`info`): the type
// colours the icon only (owner rule).
//
// The backend writes the sentence: for a successful `onAir` call it fills the
// catalog's `notice` from the arguments and the result (`stop` names what it
// stopped, which only the result knows) and puts it on the `agents.activity`
// event as `notice`. The Studio shows that sentence as it came, and nothing
// for a row without one.

/** The notice for one Activity row, or null. A toast title takes no period. */
export function agentNoticeTitle(entry: AgentActivityEntry): string | null {
  const notice = entry.notice?.trim()
  return notice ? notice.replace(/\.$/, '') : null
}

/** One id per agent and tool: a newer notice replaces the older (docs/ui-copy.md). */
export function agentNoticeId(entry: AgentActivityEntry): string {
  return `agent-notice:${entry.agentId}:${entry.tool}`
}

/** Shows the D11 notices from `store` until the returned function is called. */
export function startAgentNotices(
  store: Pick<AgentsStore, 'onEvent'>,
  { show = (title: string, id: string) => void toast.info(title, { id }) } = {}
): () => void {
  return store.onEvent((event) => {
    const title = agentNoticeTitle(event.entry)
    if (title) show(title, agentNoticeId(event.entry))
  })
}
