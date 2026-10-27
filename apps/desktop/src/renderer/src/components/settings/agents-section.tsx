import { DeleteIcon, TerminalIcon } from '@/components/icons'
import { useCallback, useState, useSyncExternalStore, type ReactElement } from 'react'

import { ConfirmDialog } from '@/components/confirm-dialog'
import { KebabMenu } from '@/components/kebab-menu'
import { GroupedList, ListRow } from '@/components/list-row'
import { PanelSection } from '@/components/panel-section'
import { SectionLabel } from '@/components/section-label'
import { ConnectAgentDialog } from '@/components/settings/connect-agent-dialog'
import { StatusDot } from '@/components/status-dot'
import { Alert, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { DisabledReason } from '@/components/ui/disabled-reason'
import { Empty, EmptyDescription } from '@/components/ui/empty'
import { FieldGroup, SettingsRow } from '@/components/ui/field'
import { ScrollArea } from '@/components/ui/scroll-area'
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { useAgents, useAgentsActions } from '@/hooks/use-agents'
import {
  AGENT_BRIDGE_MISSING,
  AGENTS_HELP,
  AGENTS_OFF_HINT,
  AGENTS_SWITCH_LABEL,
  CONNECT_AGENT_COMMAND,
  activityArgumentsLabel,
  activityTimeLabel,
  agentLastActionView,
  agentOutcomeView,
  agentsBindErrorCopy,
  agentsSummaryLine
} from '@/lib/agents-view'
import type { AgentActivityEntry, AgentSummary } from '@/lib/backend'
import { toastUserError } from '@/lib/user-error'
import { agentTool } from '../../../../shared/agent-tools'

// One shared clock for "4m" ages, ticking only while a list is on screen. An
// external store instead of an effect, like Phone remote's.
const CLOCK_MS = 15_000
const clockListeners = new Set<() => void>()
let clockTimer: ReturnType<typeof setInterval> | null = null
let clockNow = Date.now()
function subscribeClock(listener: () => void): () => void {
  clockListeners.add(listener)
  if (clockTimer === null) {
    clockNow = Date.now()
    clockTimer = setInterval(() => {
      clockNow = Date.now()
      for (const notify of clockListeners) notify()
    }, CLOCK_MS)
  }
  return () => {
    clockListeners.delete(listener)
    if (clockListeners.size === 0 && clockTimer !== null) {
      clearInterval(clockTimer)
      clockTimer = null
    }
  }
}
function useNow(): number {
  return useSyncExternalStore(subscribeClock, () => clockNow)
}

/** A tool's title from the catalog ("Add a marker"); its name when the catalog lacks it. */
export function agentToolTitle(name: string): string {
  return agentTool(name)?.title ?? name
}

const ALL_AGENTS = 'all'

/**
 * Settings → Remote → Agents (plan 209 S7): the switch, Connect an agent…,
 * the agents with their last action, and Activity. The list and Activity
 * stay readable while Agents is off, because after Stop (D12) is exactly
 * when the streamer reads what happened and removes an agent.
 */
export function AgentsSection(): ReactElement {
  const { status, activity, activityAgentId, activityLoaded, bridge, connectOpen, connectRequest } =
    useAgents()
  const actions = useAgentsActions()
  const now = useNow()
  const [pending, setPending] = useState(false)
  const [removing, setRemoving] = useState<AgentSummary | null>(null)
  const enabled = status?.enabled ?? false
  const bindErrorKind = enabled ? status?.bindErrorKind : undefined
  const agents = status?.agents ?? []
  const bridgeMissing = bridge !== null && !bridge.exists

  // ⌘K's "Connect an agent…" brings the section into view under its dialog.
  const revealOnRequest = useCallback(
    (node: HTMLSpanElement | null) => {
      if (node && connectRequest > 0) node.scrollIntoView?.({ block: 'nearest' })
    },
    [connectRequest]
  )

  const run = async (action: () => Promise<void>, context: { action: string; object: string }) => {
    setPending(true)
    try {
      await action()
    } catch (error) {
      toastUserError(error, context)
    } finally {
      setPending(false)
    }
  }

  return (
    <PanelSection
      action={
        <Switch
          aria-label={AGENTS_SWITCH_LABEL}
          checked={enabled}
          data-testid="agents-switch"
          disabled={pending || status === null}
          onCheckedChange={(checked) =>
            void run(checked ? actions.enable : actions.disable, {
              action: checked ? 'turn on' : 'turn off',
              object: 'Agents'
            })
          }
        />
      }
      data-videorc-agents=""
      description={AGENTS_HELP}
      title="Agents"
    >
      <span ref={revealOnRequest} aria-hidden className="sr-only" />
      {bindErrorKind ? (
        <Alert
          data-testid={bindErrorKind === 'ports-busy' ? 'agents-ports-busy' : 'agents-bind-failed'}
          variant="warning"
        >
          <AlertTitle>{agentsBindErrorCopy(bindErrorKind)}</AlertTitle>
        </Alert>
      ) : null}
      {bridgeMissing ? (
        <Alert data-testid="agents-bridge-missing" variant="warning">
          <AlertTitle>{AGENT_BRIDGE_MISSING}</AlertTitle>
        </Alert>
      ) : null}

      {enabled && status ? (
        <FieldGroup variant="grouped">
          <SettingsRow description={agentsSummaryLine(status)} label="Agent apps">
            <DisabledReason reason={bridgeMissing ? AGENT_BRIDGE_MISSING : null}>
              <Button
                data-testid="agents-connect"
                disabled={pending || bridgeMissing}
                variant="outline"
                onClick={actions.openConnect}
              >
                {CONNECT_AGENT_COMMAND}
              </Button>
            </DisabledReason>
          </SettingsRow>
        </FieldGroup>
      ) : (
        <p className="text-xs text-muted-foreground">
          {agents.length > 0
            ? 'Agents is off. Your agents connect again when you turn it on.'
            : AGENTS_OFF_HINT}
        </p>
      )}

      {agents.length > 0 ? (
        <GroupedList data-testid="agents-list" label="Your agents">
          {agents.map((agent) => {
            const last = agentLastActionView(agent, now, agentToolTitle)
            return (
              <ListRow
                key={agent.id}
                context={last.what}
                icon={<TerminalIcon className="text-muted-foreground" />}
                title={agent.name}
              >
                {/* Quiet when fine: a dot, with the words for screen readers.
                  The line above says how many are connected in words. */}
                {enabled && agent.connected ? (
                  <span className="flex items-center" data-testid="agent-connected">
                    <StatusDot tone="good" />
                    <span className="sr-only">Connected</span>
                  </span>
                ) : null}
                {last.when ? (
                  <span className="text-meta text-muted-foreground tabular-nums">{last.when}</span>
                ) : null}
                <KebabMenu
                  busy={pending}
                  items={[
                    {
                      id: 'remove',
                      destructive: true,
                      icon: DeleteIcon,
                      label: 'Remove…',
                      onSelect: () => setRemoving(agent)
                    }
                  ]}
                  label={`More actions for ${agent.name}`}
                />
              </ListRow>
            )
          })}
        </GroupedList>
      ) : null}

      {agents.length > 0 || activity.length > 0 ? (
        <AgentActivity
          activity={activity}
          agentId={activityAgentId}
          agents={agents}
          loaded={activityLoaded}
          now={now}
          onAgentChange={(agentId) =>
            void actions
              .showActivityFor(agentId)
              .catch((error: unknown) =>
                toastUserError(error, { action: 'show', object: 'the activity' })
              )
          }
        />
      ) : null}

      <ConfirmDialog
        confirmDisabled={pending}
        confirmLabel="Remove agent"
        description="Its token stops working at once, so the app can't reach Videorc. Connect it again for a new token."
        open={removing !== null}
        testId="agent-remove"
        title={`Remove ${removing?.name ?? 'this agent'}?`}
        onCancel={() => setRemoving(null)}
        onConfirm={() => {
          const agent = removing
          setRemoving(null)
          if (agent)
            void run(() => actions.remove(agent.id), { action: 'remove', object: 'the agent' })
        }}
      />

      {connectOpen ? (
        <ConnectAgentDialog
          actions={actions}
          bridge={bridge}
          enabled={enabled}
          onClose={actions.closeConnect}
        />
      ) : null}
    </PanelSection>
  )
}

/** Activity (S7): the newest 100 actions, by agent or all, newest first. */
function AgentActivity({
  activity,
  agentId,
  agents,
  loaded,
  now,
  onAgentChange
}: {
  activity: AgentActivityEntry[]
  agentId: string | null
  agents: AgentSummary[]
  loaded: boolean
  now: number
  onAgentChange: (agentId: string | null) => void
}): ReactElement {
  return (
    <div className="flex flex-col gap-1.5" data-testid="agents-activity">
      <div className="flex min-w-0 items-center justify-between gap-2 px-1">
        <SectionLabel>Activity</SectionLabel>
        <Select
          value={agentId ?? ALL_AGENTS}
          onValueChange={(value) => onAgentChange(value === ALL_AGENTS ? null : value)}
        >
          <SelectTrigger aria-label="Activity from" className="w-44" size="xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              <SelectItem value={ALL_AGENTS}>All agents</SelectItem>
              {agents.map((agent) => (
                <SelectItem key={agent.id} value={agent.id}>
                  {agent.name}
                </SelectItem>
              ))}
            </SelectGroup>
          </SelectContent>
        </Select>
      </div>
      {activity.length > 0 ? (
        <GroupedList aria-label="Agent activity">
          <ScrollArea viewportClassName="max-h-96">
            <div className="flex flex-col divide-y divide-border">
              {activity.map((entry) => (
                <AgentActivityRow key={entry.id} entry={entry} now={now} />
              ))}
            </div>
          </ScrollArea>
        </GroupedList>
      ) : (
        <Empty className="py-4">
          <EmptyDescription>{loaded ? 'No actions yet.' : 'Loading activity…'}</EmptyDescription>
        </Empty>
      )}
    </div>
  )
}

/** One action: what, who, how it ended and when; then its arguments, or why it didn't run. */
function AgentActivityRow({
  entry,
  now
}: {
  entry: AgentActivityEntry
  now: number
}): ReactElement {
  const outcome = agentOutcomeView(entry.outcome)
  const detail =
    entry.outcome === 'ok' ? activityArgumentsLabel(entry.summary) : (entry.message ?? '')
  return (
    <div
      className="flex min-w-0 flex-col gap-0.5 px-3 py-1.5 text-sm"
      data-slot="agent-activity-row"
    >
      <div className="flex min-w-0 items-center gap-2">
        <span className="truncate font-medium text-foreground">{agentToolTitle(entry.tool)}</span>
        <span className="truncate text-muted-foreground">{entry.agentName}</span>
        <span className="ml-auto flex shrink-0 items-center gap-2">
          <StatusDot label={outcome.label} tone={outcome.tone} />
          <span className="text-meta text-muted-foreground tabular-nums">
            {activityTimeLabel(entry.at, now)}
          </span>
        </span>
      </div>
      {detail ? (
        <p className="line-clamp-2 text-meta break-words text-muted-foreground select-text">
          {detail}
        </p>
      ) : null}
    </div>
  )
}
