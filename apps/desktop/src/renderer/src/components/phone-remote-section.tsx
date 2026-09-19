import { CopyIcon, DeleteIcon, MobileIcon, WarningIcon } from '@/components/icons'
import { useState, useSyncExternalStore, type ReactElement } from 'react'

import { PanelSection } from '@/components/panel-section'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Switch } from '@/components/ui/switch'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { useStudioCore } from '@/hooks/use-studio'
import type { RemoteLanPairing } from '@/lib/backend'
import {
  PAIRING_TROUBLE_HINT_AFTER_MS,
  PHONE_REMOTE_OFF_HINT,
  deviceActivityLabel,
  formatCountdown,
  pairingSecondsLeft,
  phoneRemoteSummary,
  qrCodePath
} from '@/lib/phone-remote-view'
import { cn } from '@/lib/utils'

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
      <path d={path} fill="#000" />
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
  const secondsLeft = pairingSecondsLeft(pairing.expiresAt, now)
  const expired = secondsLeft === 0
  const showTrouble = !expired && now - pairedSince > PAIRING_TROUBLE_HINT_AFTER_MS

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-md">
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
              className="flex size-56 flex-col items-center justify-center gap-2 rounded-row border border-border bg-muted/30 px-6 text-center text-[13px] text-muted-foreground transition-colors duration-100 hover:bg-muted/50 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
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
              <ToggleGroup
                size="sm"
                type="single"
                value={pairing.address}
                variant="outline"
                onValueChange={(address) => address && onAddress(address)}
              >
                {pairing.addresses.map((address) => (
                  <ToggleGroupItem key={address} className="font-mono text-xs" value={address}>
                    {address}
                  </ToggleGroupItem>
                ))}
              </ToggleGroup>
            </div>
          ) : null}

          {revealed && !expired ? (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => void navigator.clipboard.writeText(pairing.url)}
            >
              <CopyIcon data-icon="inline-start" />
              Copy link instead
            </Button>
          ) : null}

          {showTrouble ? (
            <div className="flex w-full gap-2 rounded-row border border-border bg-muted/30 p-3 text-xs text-muted-foreground">
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
      description="Read live comments, put one on stream with a tap, and switch scenes from a phone on the same Wi-Fi. Turning this on also turns on Remote control."
      icon={MobileIcon}
      title="Phone remote"
    >
      {status?.enabled && summary ? (
        <div className="flex flex-col gap-4">
          <div className="flex items-center justify-between gap-3">
            <p
              className={cn(
                'min-w-0 text-xs text-muted-foreground',
                summary.tone === 'warning' && 'text-foreground'
              )}
            >
              {summary.text}
            </p>
            <Button
              disabled={pending || summary.tone === 'warning'}
              size="sm"
              variant="outline"
              onClick={() => void beginPairing()}
            >
              Pair a phone
            </Button>
          </div>

          {status.devices.length > 0 ? (
            <ul className="flex flex-col">
              {status.devices.map((device) => (
                <li
                  key={device.id}
                  className="flex h-11 items-center gap-3 rounded-row px-2 hover:bg-foreground/[0.06]"
                >
                  <MobileIcon className="size-4 shrink-0 text-muted-foreground" />
                  <span className="min-w-0 truncate text-sm font-medium">{device.name}</span>
                  <span className="flex-1" />
                  <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                    {device.connected ? (
                      <span aria-hidden className="size-1.5 rounded-full bg-success" />
                    ) : null}
                    {deviceActivityLabel(device, now)}
                  </span>
                  <Button
                    aria-label={`Remove ${device.name}`}
                    disabled={pending}
                    size="icon-sm"
                    variant="ghost"
                    onClick={() => void run(() => phone.revokeDevice(device.id))}
                  >
                    <DeleteIcon />
                  </Button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-xs text-muted-foreground">
              No phones paired yet. Removing a phone later disconnects it immediately and leaves
              your Stream Deck alone.
            </p>
          )}
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">{PHONE_REMOTE_OFF_HINT}</p>
      )}

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
