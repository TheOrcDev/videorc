import { CopyIcon, DeleteIcon, EditIcon, MobileIcon, WarningIcon } from '@/components/icons'
import { useState, useSyncExternalStore, type ReactElement } from 'react'

import { ConfirmDialog } from '@/components/confirm-dialog'
import { KebabMenu } from '@/components/kebab-menu'
import { GroupedList, ListRow } from '@/components/list-row'
import { PanelSection } from '@/components/panel-section'
import { StatusDot } from '@/components/status-dot'
import { Alert, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { DisabledReason } from '@/components/ui/disabled-reason'
import { Field, FieldDescription, FieldGroup, FieldLabel, SettingsRow } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { SegmentedControl } from '@/components/ui/segmented-control'
import { useStudioCore } from '@/hooks/use-studio'
import type { RemoteLanDevice, RemoteLanPairing } from '@/lib/backend'
import {
  PAIRING_TROUBLE_HINT_AFTER_MS,
  PHONE_NAME_MAX_CHARS,
  PHONE_REMOTE_OFF_HINT,
  deviceActivityLabel,
  formatCountdown,
  pairingSecondsLeft,
  phoneDisplayNames,
  phoneRemoteSummary,
  qrCodePath,
  renamedPhoneName
} from '@/lib/phone-remote-view'
import { useCopyText } from '@/lib/copy-text'

// One shared 1 Hz clock for the countdown and "seen N min ago" labels. An
// external store instead of an effect: nothing ticks unless a subscriber is
// mounted, and every subscriber reads the same second.
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
    }, 1000)
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

// A QR code is content, not chrome: dark modules on light paper in both
// themes, because scanners need the contrast (the style guard allowlists it).
const QR_INK = '#000'

function PairingCode({ url }: { url: string }): ReactElement {
  const { path, size } = qrCodePath(url)
  return (
    // A QR code is dark-on-light in both themes: scanners need the contrast.
    <svg
      aria-label="Pairing QR code"
      className="size-56 rounded-row bg-white p-1"
      role="img"
      shapeRendering="crispEdges"
      viewBox={`0 0 ${size} ${size}`}
    >
      <path d={path} fill={QR_INK} />
    </svg>
  )
}

function PairingDialog({
  pairing,
  pairedSince,
  onAddress,
  onClose
}: {
  pairing: RemoteLanPairing
  pairedSince: number
  onAddress: (address: string) => void
  onClose: () => void
}): ReactElement {
  const now = useNow()
  const [revealed, setRevealed] = useState(false)
  const { copied: linkCopied, copy: copyLink } = useCopyText()
  const secondsLeft = pairingSecondsLeft(pairing.expiresAt, now)
  const expired = secondsLeft === 0
  const showTrouble = !expired && now - pairedSince > PAIRING_TROUBLE_HINT_AFTER_MS

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Pair a phone</DialogTitle>
          <DialogDescription>
            Scan with your phone&apos;s camera while it is on the same Wi-Fi as this computer. The
            code works once.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col items-center gap-4">
          {expired ? (
            <div className="flex size-56 flex-col items-center justify-center gap-3 rounded-row border border-border text-center text-[13px] text-muted-foreground">
              This code expired.
              <Button size="sm" variant="outline" onClick={() => onAddress(pairing.address)}>
                New code
              </Button>
            </div>
          ) : revealed ? (
            <PairingCode url={pairing.url} />
          ) : (
            <button
              className="flex size-56 flex-col items-center justify-center gap-2 rounded-row border border-border bg-inset px-6 text-center text-[13px] text-muted-foreground transition-colors duration-100 hover:bg-muted/50 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
              type="button"
              onClick={() => setRevealed(true)}
            >
              <MobileIcon className="size-6" weight="duotone" />
              <span className="font-medium text-foreground">Show code</span>
              Hidden so it never lands on your stream by accident.
            </button>
          )}

          {!expired ? (
            <p className="text-xs text-muted-foreground tabular-nums">
              Expires in {formatCountdown(secondsLeft)}
            </p>
          ) : null}

          {pairing.addresses.length > 1 ? (
            <div className="flex w-full flex-col items-center gap-2">
              <p className="text-xs text-muted-foreground">
                This computer is on more than one network. Pick the one your phone is on.
              </p>
              <SegmentedControl
                aria-label="Network"
                options={pairing.addresses.map((address) => ({
                  value: address,
                  label: address,
                  className: 'font-mono'
                }))}
                size="sm"
                value={pairing.address}
                onValueChange={onAddress}
              />
            </div>
          ) : null}

          {revealed && !expired ? (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => void copyLink(pairing.url, "Couldn't copy the pairing link.")}
            >
              <CopyIcon data-icon="inline-start" />
              {linkCopied ? 'Copied' : 'Copy link instead'}
            </Button>
          ) : null}

          {showTrouble ? (
            <div className="flex w-full gap-2 rounded-row border border-border bg-inset p-3 text-xs text-muted-foreground">
              <WarningIcon className="mt-0.5 size-4 shrink-0" />
              <p>
                Nothing connected yet. Check that the phone is on the same Wi-Fi (guest and office
                networks often block devices from seeing each other), and allow incoming connections
                if your firewall asked.
              </p>
            </div>
          ) : null}
        </div>
      </DialogContent>
    </Dialog>
  )
}

/**
 * Rename… a paired phone (plan 174 I-28): every iPhone pairs as
 * "iPhone · Safari", so the streamer names them. Saving an unchanged or
 * empty name does nothing.
 */
function RenamePhoneDialog({
  device,
  onRename,
  onClose
}: {
  device: RemoteLanDevice
  onRename: (name: string) => void
  onClose: () => void
}): ReactElement {
  const [name, setName] = useState(device.name)
  const next = renamedPhoneName(device.name, name)
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent aria-describedby={undefined} data-testid="phone-rename-dialog" size="sm">
        <form
          className="flex flex-col gap-5"
          onSubmit={(event) => {
            event.preventDefault()
            if (next !== null) onRename(next)
          }}
        >
          <DialogHeader>
            <DialogTitle>Rename phone</DialogTitle>
          </DialogHeader>
          <Field>
            <FieldLabel htmlFor="phone-rename-name">Name</FieldLabel>
            <Input
              autoFocus
              id="phone-rename-name"
              maxLength={PHONE_NAME_MAX_CHARS}
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
            <FieldDescription>So you can tell your phones apart.</FieldDescription>
          </Field>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button data-testid="phone-rename-save" disabled={next === null} type="submit">
              Save
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

/**
 * Settings → Phone remote. Status is pushed (remote.lan.status) into the
 * studio context — this section only renders it and fires actions.
 */
export function PhoneRemoteSection(): ReactElement {
  const {
    remoteControl: { phone }
  } = useStudioCore()
  const now = useNow()
  const [pending, setPending] = useState(false)
  const [pairing, setPairing] = useState<{ value: RemoteLanPairing; since: number } | null>(null)
  // Plan 174 S0.3 (I-15): removing a phone disconnects it at once, so it asks.
  const [removing, setRemoving] = useState<RemoteLanDevice | null>(null)
  const [renaming, setRenaming] = useState<RemoteLanDevice | null>(null)
  const status = phone.status
  // A successful scan consumes the ticket: the pushed status drops
  // pairingExpiresAt while our countdown is still running — close the dialog.
  // (begin_pairing publishes its status BEFORE answering, so a fresh code is
  // never mistaken for a consumed one.)
  const pairingConsumed =
    pairing !== null &&
    status !== null &&
    !status.pairingExpiresAt &&
    pairingSecondsLeft(pairing.value.expiresAt, now) > 0
  const shownPairing = pairingConsumed ? null : pairing

  const run = async (action: () => Promise<unknown>): Promise<void> => {
    setPending(true)
    try {
      await action()
    } finally {
      setPending(false)
    }
  }
  const beginPairing = (address?: string): Promise<void> =>
    run(async () => {
      const next = await phone.beginPairing(address)
      setPairing(next ? { value: next, since: Date.now() } : null)
    })
  const closePairing = (): void => {
    setPairing(null)
    void phone.cancelPairing()
  }

  const summary = status?.enabled ? phoneRemoteSummary(status) : null
  // A network problem locks pairing (plan 174 I-8): the reason leads the
  // section as an Alert and stays on the disabled button, not only as a
  // change of text colour.
  const blocked = summary?.tone === 'warning' ? summary.text : null
  // Two phones with one name read as one: number the repeats (I-28).
  const names = phoneDisplayNames(status?.devices ?? [])

  return (
    <PanelSection
      action={
        <Switch
          aria-label="Enable phone remote"
          checked={status?.enabled ?? false}
          disabled={pending}
          onCheckedChange={(checked) => void run(checked ? phone.enable : phone.disable)}
        />
      }
      description="Read chat, put a message on stream with a tap and switch scenes from a phone on the same Wi-Fi."
      title="Phone remote"
    >
      {status?.enabled && summary ? (
        <>
          {blocked ? (
            <Alert variant="warning">
              <AlertTitle>{blocked}</AlertTitle>
            </Alert>
          ) : null}
          <FieldGroup variant="grouped">
            <SettingsRow
              description={
                blocked ? 'Pairing works again once the problem above is fixed.' : summary.text
              }
              label="Phones"
            >
              <DisabledReason reason={blocked}>
                <Button
                  disabled={pending || blocked !== null}
                  size="sm"
                  variant="outline"
                  onClick={() => void beginPairing()}
                >
                  Pair a phone…
                </Button>
              </DisabledReason>
            </SettingsRow>
          </FieldGroup>

          {status.devices.length > 0 ? (
            <GroupedList label="Paired phones">
              {status.devices.map((device) => {
                const name = names.get(device.id) ?? device.name
                return (
                  <ListRow
                    key={device.id}
                    context={
                      <StatusDot
                        label={deviceActivityLabel(device, now)}
                        tone={device.connected ? 'good' : 'neutral'}
                      />
                    }
                    icon={<MobileIcon className="text-muted-foreground" />}
                    title={name}
                  >
                    <KebabMenu
                      busy={pending}
                      items={[
                        {
                          id: 'rename',
                          group: 'edit',
                          icon: EditIcon,
                          label: 'Rename…',
                          onSelect: () => setRenaming(device)
                        },
                        {
                          id: 'remove',
                          destructive: true,
                          icon: DeleteIcon,
                          label: 'Remove…',
                          onSelect: () => setRemoving(device)
                        }
                      ]}
                      label={`More actions for ${name}`}
                    />
                  </ListRow>
                )
              })}
            </GroupedList>
          ) : null}
        </>
      ) : (
        <p className="text-xs text-muted-foreground">{PHONE_REMOTE_OFF_HINT}</p>
      )}

      <ConfirmDialog
        confirmDisabled={pending}
        confirmLabel="Remove phone"
        description="It is disconnected now and needs a new pairing to come back. Your Stream Deck is not affected."
        open={removing !== null}
        testId="phone-remove"
        title={`Remove ${(removing && names.get(removing.id)) ?? removing?.name ?? 'this phone'}?`}
        onCancel={() => setRemoving(null)}
        onConfirm={() => {
          const device = removing
          setRemoving(null)
          if (device) void run(() => phone.revokeDevice(device.id))
        }}
      />

      {renaming ? (
        <RenamePhoneDialog
          key={renaming.id}
          device={renaming}
          onClose={() => setRenaming(null)}
          onRename={(next) => {
            const device = renaming
            setRenaming(null)
            void run(() => phone.renameDevice(device.id, next))
          }}
        />
      ) : null}

      {shownPairing ? (
        <PairingDialog
          key={shownPairing.value.url}
          pairedSince={shownPairing.since}
          pairing={shownPairing.value}
          onAddress={(address) => void beginPairing(address)}
          onClose={closePairing}
        />
      ) : null}
    </PanelSection>
  )
}
