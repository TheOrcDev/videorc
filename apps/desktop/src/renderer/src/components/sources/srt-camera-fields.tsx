import { useId, useState, type ReactElement } from 'react'

import { ConfirmDialog } from '@/components/confirm-dialog'
import { CopyIcon, RefreshIcon } from '@/components/icons'
import { Button } from '@/components/ui/button'
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldError,
  FieldTitle,
  SettingsRow
} from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { useSrtInput, useSrtInputChange, type SrtInputControls } from '@/hooks/use-srt-input'
import { useStudioCore } from '@/hooks/use-studio'
import type { SrtInputConnection } from '@/lib/backend'
import { useCopyText } from '@/lib/copy-text'
import {
  SRT_CONNECTION_OPTIONS,
  SRT_INPUT_LIP_SYNC_NOTE,
  SRT_PASSPHRASE_MISSING,
  parseSrtPort,
  srtInputHidden
} from '@/lib/srt-input-view'

/**
 * The SRT Camera's own settings on its row in Sources → Video → Camera
 * (plan 250, option B): the port, the passphrase every sender needs, the
 * Connection and the lip-sync note. The row shows them only while the SRT
 * Camera is the picked camera; the Settings opt-in adds it to the list.
 */
export function SrtCameraFields(): ReactElement | null {
  const controls = useSrtInput()
  const { refreshDevices } = useStudioCore()
  return <SrtCameraFieldsView controls={controls} onCameraListChanged={refreshDevices} />
}

export function SrtCameraFieldsView({
  controls,
  onCameraListChanged
}: {
  controls: SrtInputControls
  /** A new port renames the camera entry: the camera list reads again. */
  onCameraListChanged: () => unknown
}): ReactElement | null {
  const { state, connected } = controls
  const change = useSrtInputChange(onCameraListChanged)
  const [renewOpen, setRenewOpen] = useState(false)
  if (!state || srtInputHidden(state) || !state.enabled) return null
  const locked = !connected || change.pending

  // The renewal keeps its dialog up until the save settles: closing at once
  // handed focus back to a "New passphrase" the pending save had just
  // disabled. A failed save stays up with its reason.
  const renewing = renewOpen && change.pending
  const renew = async (): Promise<void> => {
    if (await change.run(() => controls.renewPassphrase(), false)) setRenewOpen(false)
  }

  return (
    <div className="flex min-w-0 flex-col gap-3" data-testid="srt-camera-fields">
      {change.problem && !renewOpen ? <FieldError>{change.problem}</FieldError> : null}
      <PortRow
        disabled={locked}
        port={state.port}
        onCommit={(port) => void change.run(() => controls.set({ port }), true)}
      />
      <PassphraseField
        disabled={locked}
        passphrase={state.passphrase}
        onRenew={() => setRenewOpen(true)}
      />
      <SettingsRow
        description="How the sender reaches this computer. A slower link needs more time."
        label="Connection"
      >
        <Select
          disabled={locked}
          items={SRT_CONNECTION_OPTIONS}
          value={state.connection}
          onValueChange={(value: SrtInputConnection | null) => {
            if (value !== null) void change.run(() => controls.set({ connection: value }), false)
          }}
        >
          <SelectTrigger className="w-52 shrink-0" data-testid="srt-input-connection">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {SRT_CONNECTION_OPTIONS.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </SettingsRow>
      <p className="text-meta text-muted-foreground">{SRT_INPUT_LIP_SYNC_NOTE}</p>
      <ConfirmDialog
        cancelDisabled={renewing}
        cancelLabel="Keep passphrase"
        confirmDisabled={renewing || !connected}
        confirmLabel={renewing ? 'Saving…' : 'New passphrase'}
        confirmVariant="default"
        description="Every sender needs the new one. A sender with the old one is refused."
        open={renewOpen}
        testId="srt-input-renew"
        title="Make a new passphrase?"
        onCancel={() => {
          if (renewing) return
          setRenewOpen(false)
          change.reset()
        }}
        onConfirm={() => void renew()}
      >
        {change.problem ? <FieldError>{change.problem}</FieldError> : null}
      </ConfirmDialog>
    </div>
  )
}

function PortRow({
  port,
  disabled,
  onCommit
}: {
  port: number
  disabled: boolean
  onCommit: (port: number) => void
}): ReactElement {
  const id = useId()
  const [draft, setDraft] = useState<string | null>(null)
  const [refused, setRefused] = useState<string | null>(null)
  const commit = (): void => {
    if (draft === null) return
    setDraft(null)
    const parsed = parseSrtPort(draft)
    if (parsed.kind === 'refused') {
      setRefused(parsed.message)
      return
    }
    setRefused(null)
    if (parsed.port !== port) onCommit(parsed.port)
  }
  return (
    <SettingsRow
      description="Senders connect to this computer on this port."
      error={refused}
      label="Port"
    >
      <Input
        aria-invalid={refused ? true : undefined}
        aria-label="Port"
        className="w-24 shrink-0"
        data-testid="srt-input-port"
        disabled={disabled}
        id={id}
        inputMode="numeric"
        value={draft ?? String(port)}
        onBlur={commit}
        onChange={(event) => {
          setDraft(event.target.value)
          setRefused(null)
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault()
            commit()
          } else if (event.key === 'Escape' && draft !== null) {
            event.preventDefault()
            setDraft(null)
            setRefused(null)
          }
        }}
      />
    </SettingsRow>
  )
}

/**
 * The passphrase and its two buttons sit on their own line under the label
 * and wrap, so the row's width never cuts "New passphrase" off or squeezes
 * the description to one word a line.
 */
function PassphraseField({
  passphrase,
  disabled,
  onRenew
}: {
  passphrase: string
  disabled: boolean
  onRenew: () => void
}): ReactElement {
  const titleId = useId()
  const { copied, copy } = useCopyText()
  return (
    <Field aria-labelledby={titleId} data-testid="srt-input-passphrase-field">
      <FieldContent>
        <FieldTitle id={titleId}>Passphrase</FieldTitle>
        <FieldDescription>Every sender needs it. Senders without it are refused.</FieldDescription>
      </FieldContent>
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        {/* The secret store gave none at launch: there is nothing to copy. */}
        {passphrase ? (
          <code
            className="rounded-chip bg-inset text-foreground max-w-full min-w-0 truncate px-1.5 py-0.5 font-mono text-xs select-text"
            data-testid="srt-input-passphrase"
          >
            {passphrase}
          </code>
        ) : (
          <FieldError data-testid="srt-input-passphrase-missing">
            {SRT_PASSPHRASE_MISSING}
          </FieldError>
        )}
        <span className="flex items-center gap-2">
          <Button
            disabled={!passphrase}
            size="xs"
            type="button"
            variant="ghost"
            onClick={() => void copy(passphrase, "Couldn't copy the passphrase.")}
          >
            <CopyIcon data-icon="inline-start" />
            {copied ? 'Copied' : 'Copy'}
          </Button>
          <Button disabled={disabled} size="xs" type="button" variant="outline" onClick={onRenew}>
            <RefreshIcon data-icon="inline-start" />
            New passphrase
          </Button>
        </span>
      </div>
    </Field>
  )
}
