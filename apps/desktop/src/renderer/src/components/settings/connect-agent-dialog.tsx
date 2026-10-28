import { CopyIcon, PreviewIcon } from '@/components/icons'
import { useState, type ReactElement } from 'react'

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
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
  AGENT_BRIDGE_MOVE_FIRST_DETAIL,
  agentAppLabel,
  agentBridgePathRefusal,
  agentConnectLine,
  agentConnectLineDisplay,
  defaultAgentName,
  type AgentConnectLine
} from '@/lib/agent-connect-lines'
import { AGENT_BRIDGE_MISSING, agentRefusalMessage } from '@/lib/agents-view'
import type { AgentAddResult, AgentBridgeInfo, AgentClientKind } from '@/lib/backend'
import { useCopyText } from '@/lib/copy-text'
import { inlineUserError } from '@/lib/user-error'

/** The backend keeps 40 characters of a name (agent_registry.rs). */
export const AGENT_NAME_MAX_CHARS = 40

type Step =
  | { kind: 'choose' }
  | { kind: 'show'; client: AgentClientKind; name: string; token: string; line: AgentConnectLine }

type ConnectActions = Pick<AgentsActions, 'create' | 'enable' | 'prepareBridge' | 'addToApp'>

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
  actions: ConnectActions
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
          <ShowStep
            client={step.client}
            line={step.line}
            name={step.name}
            token={step.token}
            onAdd={actions.addToApp}
            onDone={onClose}
          />
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
  actions: Pick<ConnectActions, 'create' | 'enable' | 'prepareBridge'>
  onCancel: () => void
  onCreated: (created: {
    client: AgentClientKind
    name: string
    token: string
    line: AgentConnectLine
  }) => void
}): ReactElement {
  const [app, setApp] = useState<AgentClientKind>('claude-desktop')
  // The name follows the app until the streamer types one.
  const [typedName, setTypedName] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const name = typedName ?? defaultAgentName(app)
  const bridgeMissing = bridge !== null && !bridge.exists
  // Review #19: a path that moves never gets a token or a line.
  const pathRefusal = bridge?.exists ? agentBridgePathRefusal(bridge.path) : null
  const canConnect = name.trim().length > 0 && !pending && !bridgeMissing && !pathRefusal

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
      const refusal = agentBridgePathRefusal(prepared.path)
      if (refusal) {
        setError(refusal)
        return
      }
      if (!enabled) await actions.enable()
      const created = await actions.create(name.trim(), app)
      onCreated({
        client: app,
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
        ) : pathRefusal ? (
          <Alert className="mt-4" data-testid="connect-agent-move-first" variant="warning">
            <AlertTitle>{pathRefusal}</AlertTitle>
            <AlertDescription>{AGENT_BRIDGE_MOVE_FIRST_DETAIL}</AlertDescription>
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
  client,
  name,
  token,
  line,
  onAdd,
  onDone
}: {
  client: AgentClientKind
  name: string
  token: string
  line: AgentConnectLine
  onAdd: ConnectActions['addToApp']
  onDone: () => void
}): ReactElement {
  const [shown, setShown] = useState(false)
  const { copied, copy } = useCopyText()
  // S22: "Add to …" writes this line into the app's own config from main.
  const [adding, setAdding] = useState(false)
  const [added, setAdded] = useState<AgentAddResult | null>(null)
  const appLabel = agentAppLabel(client)

  const add = async (): Promise<void> => {
    if (client === 'other') return
    setAdding(true)
    try {
      setAdded(await onAdd(client, token))
    } catch (caught) {
      console.warn('[agents] Add to app failed:', caught)
      setAdded({
        added: false,
        message: `Couldn't add Videorc to ${appLabel}. Copy the line instead.`
      })
    } finally {
      setAdding(false)
    }
  }

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
        {added ? (
          <Alert
            className="mt-2"
            data-testid="connect-agent-add-result"
            variant={added.added ? 'success' : 'warning'}
          >
            <AlertTitle>{added.message}</AlertTitle>
          </Alert>
        ) : null}
      </DialogBody>
      <DialogFooter>
        {client === 'other' ? null : (
          <Button
            data-testid="connect-agent-add"
            disabled={adding}
            type="button"
            variant="outline"
            onClick={() => void add()}
          >
            {adding ? 'Adding…' : `Add to ${appLabel}`}
          </Button>
        )}
        <Button type="button" onClick={onDone}>
          Done
        </Button>
      </DialogFooter>
    </>
  )
}
