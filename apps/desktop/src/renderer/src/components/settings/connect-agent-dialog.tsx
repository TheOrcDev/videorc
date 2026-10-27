import { CopyIcon, PreviewIcon } from '@/components/icons'
import { useState, type ReactElement } from 'react'

import { Alert, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { SectionLabel } from '@/components/section-label'
import type { AgentsActions } from '@/lib/agents-store'
import {
  AGENT_APPS,
  agentBridgePathWarning,
  agentConnectLine,
  agentConnectLineDisplay,
  defaultAgentName,
  type AgentConnectLine
} from '@/lib/agent-connect-lines'
import { AGENT_BRIDGE_MISSING, agentRefusalMessage } from '@/lib/agents-view'
import type { AgentBridgeInfo, AgentClientKind } from '@/lib/backend'
import { useCopyText } from '@/lib/copy-text'
import { inlineUserError } from '@/lib/user-error'

/** The backend keeps 40 characters of a name (agent_registry.rs). */
export const AGENT_NAME_MAX_CHARS = 40

type Step =
  | { kind: 'choose' }
  | { kind: 'show'; name: string; token: string; line: AgentConnectLine }

/**
 * Connect an agent… (plan 209 S7, D6): pick the app, name it, then the exact
 * line for that app with the bridge's path and the agent's own token. The
 * token exists only here, once: the dialog never hands it to a store, and
 * draws it masked until "Show token", since Settings may be on stream.
 * Connecting turns Agents on when it is off (the ⌘K way in).
 */
export function ConnectAgentDialog({
  enabled,
  bridge,
  actions,
  onClose
}: {
  enabled: boolean
  bridge: AgentBridgeInfo | null
  actions: Pick<AgentsActions, 'create' | 'enable' | 'prepareBridge'>
  onClose: () => void
}): ReactElement {
  const [step, setStep] = useState<Step>({ kind: 'choose' })
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent data-testid="connect-agent-dialog" size="lg">
        {step.kind === 'choose' ? (
          <ChooseStep
            actions={actions}
            bridge={bridge}
            enabled={enabled}
            onCancel={onClose}
            onCreated={(next) => setStep({ kind: 'show', ...next })}
          />
        ) : (
          <ShowStep line={step.line} name={step.name} token={step.token} onDone={onClose} />
        )}
      </DialogContent>
    </Dialog>
  )
}

function ChooseStep({
  enabled,
  bridge,
  actions,
  onCancel,
  onCreated
}: {
  enabled: boolean
  bridge: AgentBridgeInfo | null
  actions: Pick<AgentsActions, 'create' | 'enable' | 'prepareBridge'>
  onCancel: () => void
  onCreated: (created: { name: string; token: string; line: AgentConnectLine }) => void
}): ReactElement {
  const [app, setApp] = useState<AgentClientKind>('claude-desktop')
  // The name follows the app until the streamer types one.
  const [typedName, setTypedName] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const name = typedName ?? defaultAgentName(app)
  const bridgeMissing = bridge !== null && !bridge.exists
  const pathWarning = bridge?.exists ? agentBridgePathWarning(bridge.path) : null
  const canConnect = name.trim().length > 0 && !pending && !bridgeMissing

  const connect = async (): Promise<void> => {
    setPending(true)
    setError(null)
    try {
      // The Linux copy first (D20): a token is never minted for a line
      // whose path does not exist.
      const prepared = await actions.prepareBridge()
      if (!prepared.exists) {
        setError(AGENT_BRIDGE_MISSING)
        return
      }
      if (!enabled) await actions.enable()
      const created = await actions.create(name.trim(), app)
      onCreated({
        name: created.agent.name,
        token: created.token,
        line: agentConnectLine(app, { bridgePath: prepared.path, token: created.token })
      })
    } catch (caught) {
      setError(
        agentRefusalMessage(caught) ??
          inlineUserError(caught, { action: 'connect', object: 'the agent' }, 'agents')
      )
    } finally {
      setPending(false)
    }
  }

  return (
    <form
      className="flex min-h-0 flex-col gap-5"
      onSubmit={(event) => {
        event.preventDefault()
        if (canConnect) void connect()
      }}
    >
      <DialogHeader>
        <DialogTitle>Connect an agent</DialogTitle>
        <DialogDescription>
          Choose the app and name it. Videorc then shows the line to paste into that app.
        </DialogDescription>
      </DialogHeader>
      <DialogBody>
        <FieldGroup>
          <Field>
            <FieldLabel htmlFor="connect-agent-app">App</FieldLabel>
            <Select
              disabled={pending}
              value={app}
              onValueChange={(value) => setApp(value as AgentClientKind)}
            >
              <SelectTrigger className="w-full" id="connect-agent-app">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  {AGENT_APPS.map((option) => (
                    <SelectItem key={option.id} value={option.id}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
          </Field>
          <Field data-invalid={error ? true : undefined}>
            <FieldLabel htmlFor="connect-agent-name">Name</FieldLabel>
            <Input
              disabled={pending}
              id="connect-agent-name"
              maxLength={AGENT_NAME_MAX_CHARS}
              value={name}
              onChange={(event) => setTypedName(event.target.value)}
            />
            <FieldDescription>
              {enabled
                ? 'Activity and the Studio show it by this name.'
                : 'Activity and the Studio show it by this name. Connecting turns Agents on.'}
            </FieldDescription>
            {error ? <FieldError>{error}</FieldError> : null}
          </Field>
        </FieldGroup>
        {bridgeMissing ? (
          <Alert className="mt-4" variant="warning">
            <AlertTitle>{AGENT_BRIDGE_MISSING}</AlertTitle>
          </Alert>
        ) : pathWarning ? (
          <Alert className="mt-4" variant="warning">
            <AlertTitle>{pathWarning}</AlertTitle>
          </Alert>
        ) : null}
      </DialogBody>
      <DialogFooter>
        <Button disabled={pending} type="button" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button data-testid="connect-agent-create" disabled={!canConnect} type="submit">
          {pending ? 'Connecting…' : 'Connect'}
        </Button>
      </DialogFooter>
    </form>
  )
}

function ShowStep({
  name,
  token,
  line,
  onDone
}: {
  name: string
  token: string
  line: AgentConnectLine
  onDone: () => void
}): ReactElement {
  const [shown, setShown] = useState(false)
  const { copied, copy } = useCopyText()
  return (
    <>
      <DialogHeader>
        <DialogTitle>{`Connect ${name}`}</DialogTitle>
        <DialogDescription>{line.where}</DialogDescription>
      </DialogHeader>
      <DialogBody className="flex flex-col gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <SectionLabel className="min-w-0 flex-1 truncate">{line.label}</SectionLabel>
          <Badge variant="outline">Shown once</Badge>
          <Button
            aria-pressed={shown}
            size="xs"
            type="button"
            variant="ghost"
            onClick={() => setShown((current) => !current)}
          >
            <PreviewIcon data-icon="inline-start" />
            {shown ? 'Hide token' : 'Show token'}
          </Button>
          <Button
            data-testid="connect-agent-copy"
            size="xs"
            type="button"
            variant="outline"
            onClick={() => void copy(line.text, "Couldn't copy the line.")}
          >
            <CopyIcon data-icon="inline-start" />
            {copied ? 'Copied' : 'Copy'}
          </Button>
        </div>
        <pre
          className="max-h-72 overflow-y-auto rounded-row border border-border bg-inset p-3 font-mono text-xs leading-relaxed break-all whitespace-pre-wrap text-foreground select-text"
          data-testid="connect-agent-line"
        >
          {agentConnectLineDisplay(line, token, shown)}
        </pre>
        <p className="text-meta text-muted-foreground">
          The line holds this agent&apos;s token, and Videorc shows it only now. Lost it? Remove the
          agent and connect it again.
        </p>
      </DialogBody>
      <DialogFooter>
        <Button type="button" onClick={onDone}>
          Done
        </Button>
      </DialogFooter>
    </>
  )
}
