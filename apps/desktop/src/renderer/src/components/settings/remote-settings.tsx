import { useState, type ReactElement } from 'react'

import { ConfirmDialog } from '@/components/confirm-dialog'
import { PanelSection } from '@/components/panel-section'
import { PhoneRemoteSection } from '@/components/phone-remote-section'
import { Button } from '@/components/ui/button'
import { FieldGroup, SettingsRow } from '@/components/ui/field'
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput
} from '@/components/ui/input-group'
import { Switch } from '@/components/ui/switch'
import { useStudioCore } from '@/hooks/use-studio'
import { platformCopy } from '@/lib/platform-copy'
import type { RemoteControlStatus } from '@/lib/backend'
import { useCopyText } from '@/lib/copy-text'
import { NO_VALUE } from '@/lib/format'

/**
 * Remote control is off by default, and an empty body made the card render as a
 * bare header. One muted line says what turning it on does, never "Off" again
 * beside the switch that already says so (plan 174 V-6).
 */
export const REMOTE_CONTROL_OFF_HINT =
  'Turning this on makes a pairing token for your remotes. The Stream Deck plugin pairs on its own.'

/** "1 client connected." / "No clients connected." */
export function connectedClientsLine(count: number): string {
  if (count === 0) return 'No clients connected.'
  return count === 1 ? '1 client connected.' : `${count} clients connected.`
}

/** "1 paired phone is" / "3 paired phones are". */
export function pairedPhonesClause(count: number): string {
  return count === 1 ? '1 paired phone is' : `${count} paired phones are`
}

/** The two questions this tab asks (plan 174 S0.3, I-15, I-16). */
export const REMOTE_CONFIRM_COPY = {
  regenerate: {
    title: 'Regenerate the pairing token?',
    body: (deviceNoun: string): string =>
      `Every paired client is disconnected and needs the new token to pair again. The Stream Deck plugin pairs again on its own on this ${deviceNoun}.`,
    confirm: 'Regenerate token'
  },
  off: {
    title: 'Turn off remote control?',
    confirm: 'Turn off remote control'
  }
} as const

/** Settings → Remote: a Stream Deck or local remote, and the phone remote. */
export function RemoteSettings(): ReactElement {
  const { remoteControl, runtimeInfo } = useStudioCore()
  // Plan 174 I-9: the computer by its own name, never "this Mac" on a PC.
  const { deviceNoun } = platformCopy(runtimeInfo?.platform)

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
  const { copied: tokenCopied, copy: copyToken } = useCopyText()
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
        description={`Start recordings, switch scenes and mute your microphone from a Stream Deck or another remote on this ${deviceNoun}.`}
        title="Remote control"
      >
        {remoteStatus?.enabled ? (
          <FieldGroup variant="grouped">
            <SettingsRow
              description={connectedClientsLine(remoteStatus.connectedClients)}
              label="Pairing token"
            >
              {/* A read-only value, not a styled box (plan 174 I-22): the label
                  names it and it can be selected and copied. */}
              <InputGroup className="w-48 shrink-0">
                <InputGroupInput
                  readOnly
                  className="font-mono text-xs"
                  id="remote-token"
                  value={
                    remoteStatus.token
                      ? `${remoteStatus.token.slice(0, 8)}…${remoteStatus.token.slice(-4)}`
                      : NO_VALUE
                  }
                />
                <InputGroupAddon align="inline-end">
                  <InputGroupButton
                    disabled={!remoteStatus.token}
                    onClick={() => {
                      if (remoteStatus.token) {
                        void copyToken(remoteStatus.token, "Couldn't copy the pairing token.")
                      }
                    }}
                  >
                    {tokenCopied ? 'Copied' : 'Copy'}
                  </InputGroupButton>
                </InputGroupAddon>
              </InputGroup>
            </SettingsRow>
            <SettingsRow
              description={`Disconnects every paired client. The Stream Deck plugin pairs again on its own on this ${deviceNoun}.`}
              label="New token"
            >
              <Button
                disabled={remotePending}
                variant="outline"
                onClick={() => setConfirmingRegenerate(true)}
              >
                Regenerate
              </Button>
            </SettingsRow>
          </FieldGroup>
        ) : (
          <p className="text-xs text-muted-foreground">{REMOTE_CONTROL_OFF_HINT}</p>
        )}
      </PanelSection>

      <PhoneRemoteSection />

      <ConfirmDialog
        confirmDisabled={remotePending}
        confirmLabel={REMOTE_CONFIRM_COPY.regenerate.confirm}
        description={REMOTE_CONFIRM_COPY.regenerate.body(deviceNoun)}
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
