import { useState, type ReactElement } from 'react'

import { ConfirmDialog } from '@/components/confirm-dialog'
import { PanelSection } from '@/components/panel-section'
import { PhoneRemoteSection } from '@/components/phone-remote-section'
import { Button } from '@/components/ui/button'
import { Field, FieldGroup, FieldLabel } from '@/components/ui/field'
import { Switch } from '@/components/ui/switch'
import { useStudioCore } from '@/hooks/use-studio'
import type { RemoteControlStatus } from '@/lib/backend'

/**
 * Remote control is off by default, and an empty body made the card render as a
 * bare header. One muted line says what the switch is for instead.
 */
export const REMOTE_CONTROL_OFF_HINT = 'Off. Turn on to pair a Stream Deck or the Videorc remote.'

/** "1 paired phone is" / "3 paired phones are". */
export function pairedPhonesClause(count: number): string {
  return count === 1 ? '1 paired phone is' : `${count} paired phones are`
}

/** The two questions this tab asks (plan 174 S0.3, I-15, I-16). */
export const REMOTE_CONFIRM_COPY = {
  regenerate: {
    title: 'Regenerate the pairing token?',
    body: 'Every paired client is disconnected and needs the new token to pair again. The Stream Deck plugin pairs again on its own on this Mac.',
    confirm: 'Regenerate token'
  },
  off: {
    title: 'Turn off remote control?',
    confirm: 'Turn off remote control'
  }
} as const

/** Settings → Remote: a Stream Deck or local remote, and the phone remote. */
export function RemoteSettings(): ReactElement {
  const { remoteControl } = useStudioCore()

  // Remote-control status is pushed into the studio context by the backend
  // (remote.control.status events) — this tab only renders it and fires
  // actions; the switch settles when the backend confirms.
  const remoteStatus = remoteControl.status
  const phoneStatus = remoteControl.phone.status
  const [remotePending, setRemotePending] = useState(false)
  // Plan 174 S0.3 (I-15, I-16): regenerating the token and turning remote
  // control off while phones are paired both disconnect devices, so they ask.
  const [confirmingRegenerate, setConfirmingRegenerate] = useState(false)
  const [confirmingOff, setConfirmingOff] = useState(false)
  const pairedPhones = phoneStatus?.enabled ? phoneStatus.devices.length : 0
  const runRemoteAction = async (
    action: () => Promise<RemoteControlStatus | null>
  ): Promise<void> => {
    setRemotePending(true)
    try {
      await action()
    } finally {
      setRemotePending(false)
    }
  }

  return (
    <>
      <PanelSection
        action={
          <Switch
            aria-label="Enable remote control"
            checked={remoteStatus?.enabled ?? false}
            disabled={remotePending}
            onCheckedChange={(checked) => {
              if (checked) {
                void runRemoteAction(remoteControl.enable)
              } else if (pairedPhones > 0) {
                setConfirmingOff(true)
              } else {
                void runRemoteAction(remoteControl.disable)
              }
            }}
          />
        }
        description="Let a Stream Deck or other local remote start recordings, switch scenes, and mute your mic. Off by default; clients pair with the token below on this Mac only."
        title="Remote control"
      >
        {remoteStatus?.enabled ? (
          <FieldGroup variant="grouped">
            <Field>
              <FieldLabel htmlFor="remote-token">Pairing token</FieldLabel>
              <div className="flex gap-2">
                <div
                  id="remote-token"
                  className="flex h-control min-w-0 flex-1 items-center truncate rounded-chip border border-border bg-inset px-2.5 font-mono text-xs text-muted-foreground"
                >
                  {remoteStatus.token
                    ? `${remoteStatus.token.slice(0, 8)}…${remoteStatus.token.slice(-4)}`
                    : '-'}
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    if (remoteStatus.token) {
                      void navigator.clipboard.writeText(remoteStatus.token)
                    }
                  }}
                >
                  Copy
                </Button>
                <Button
                  disabled={remotePending}
                  size="sm"
                  variant="outline"
                  onClick={() => setConfirmingRegenerate(true)}
                >
                  Regenerate
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">
                {remoteStatus.connectedClients > 0
                  ? `${remoteStatus.connectedClients} client${remoteStatus.connectedClients === 1 ? '' : 's'} connected.`
                  : 'No clients connected.'}{' '}
                Regenerating disconnects every paired client. The Stream Deck plugin pairs
                automatically on this Mac.
              </p>
            </Field>
          </FieldGroup>
        ) : (
          <p className="text-xs text-muted-foreground">{REMOTE_CONTROL_OFF_HINT}</p>
        )}
      </PanelSection>

      <PhoneRemoteSection />

      <ConfirmDialog
        confirmDisabled={remotePending}
        confirmLabel={REMOTE_CONFIRM_COPY.regenerate.confirm}
        description={REMOTE_CONFIRM_COPY.regenerate.body}
        open={confirmingRegenerate}
        testId="remote-token-regenerate"
        title={REMOTE_CONFIRM_COPY.regenerate.title}
        onCancel={() => setConfirmingRegenerate(false)}
        onConfirm={() => {
          setConfirmingRegenerate(false)
          void runRemoteAction(remoteControl.regenerate)
        }}
      />
      <ConfirmDialog
        confirmDisabled={remotePending}
        confirmLabel={REMOTE_CONFIRM_COPY.off.confirm}
        description={`Phone remote turns off with it: ${pairedPhonesClause(pairedPhones)} disconnected, and so is every Stream Deck.`}
        open={confirmingOff}
        testId="remote-control-off"
        title={REMOTE_CONFIRM_COPY.off.title}
        onCancel={() => setConfirmingOff(false)}
        onConfirm={() => {
          setConfirmingOff(false)
          void runRemoteAction(remoteControl.disable)
        }}
      />
    </>
  )
}
