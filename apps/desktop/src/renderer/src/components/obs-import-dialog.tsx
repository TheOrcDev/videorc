import { DownloadIcon, ErrorIcon, SuccessIcon, WarningIcon } from '@/components/icons'
import { useEffect, useId, useMemo, useRef, useState, type ReactElement } from 'react'
import { toast } from '@/lib/toast'

import { useBackgroundAssets } from '@/hooks/use-background-assets'
import { useStudioCore } from '@/hooks/use-studio'
import type { ObsDiscovery, ObsSetup } from '@/lib/backend'
import { unattendedImportSlot } from '@/lib/background-assets'
import { ipcErrorMessage } from '@/lib/ipc-error-message'
import { mergeObsImportIntoConfig, withObsBackground } from '@/lib/obs-import-apply'
import { mapObsSetup, type ObsImportPlanResult, type ObsImportVerdict } from '@/lib/obs-import-map'
import { ObsImportReadAuthority, type ObsImportReadTicket } from '@/lib/obs-import-read-authority'
import { Alert, AlertAction, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Field, FieldLabel } from '@/components/ui/field'
import { ScrollArea } from '@/components/ui/scroll-area'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'

// OBS import O4 (plan: vault "2026-07-07 - Videorc OBS Import Plan"): pick
// collection+profile (defaults = OBS's currents) → the truthful three-verdict
// report BEFORE anything applies → one atomic apply. The report is the
// product: it explains Videorc in terms of the user's own OBS setup.
//
// Plan 174 (C-7, C-29): the report resolves the background's Assets slot and
// apply does exactly what it says; a failed discovery or read says so with
// Try again instead of "Looking for…" or "Reading…" forever.

const VERDICT_META: Record<
  ObsImportVerdict,
  { title: string; icon: typeof SuccessIcon; iconClassName: string }
> = {
  imported: { title: 'Will import', icon: SuccessIcon, iconClassName: 'text-success' },
  approximated: { title: 'Approximated', icon: WarningIcon, iconClassName: 'text-warning' },
  skipped: { title: "Won't import", icon: ErrorIcon, iconClassName: 'text-muted-foreground' }
}

/** Why a read failed when OBS's files gave no reason of their own. */
export const OBS_PROFILE_UNREADABLE =
  'Its scene collection or profile is missing, or its files are unreadable.'
const OBS_IMPORT_UNAVAILABLE = 'OBS import needs the Videorc app.'

type Discovery =
  | { state: 'looking' }
  | { state: 'found'; discovery: ObsDiscovery }
  | { state: 'failed'; reason: string }

export function ObsImportDialog({
  open,
  onOpenChange
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}): ReactElement {
  const { deviceList, setCaptureConfig, setSettings } = useStudioCore()
  const { registry, setRegistry } = useBackgroundAssets()
  const collectionId = useId()
  const profileId = useId()
  const [discovery, setDiscovery] = useState<Discovery>({ state: 'looking' })
  const [discoveryAttempt, setDiscoveryAttempt] = useState(0)
  const [collection, setCollection] = useState<string | undefined>()
  const [profile, setProfile] = useState<string | undefined>()
  const [setup, setSetup] = useState<ObsSetup | null>(null)
  const [setupTicket, setSetupTicket] = useState<ObsImportReadTicket | null>(null)
  const [reading, setReading] = useState(false)
  const [readFailure, setReadFailure] = useState<string | null>(null)
  const [readAttempt, setReadAttempt] = useState(0)
  const [applying, setApplying] = useState(false)
  const readAuthority = useRef(new ObsImportReadAuthority())

  useEffect(() => {
    if (!open) {
      return
    }
    let cancelled = false
    setDiscovery({ state: 'looking' })
    const discover = window.videorc?.obsDiscover
    if (!discover) {
      setDiscovery({ state: 'failed', reason: OBS_IMPORT_UNAVAILABLE })
      return
    }
    discover().then(
      (found) => {
        if (cancelled) {
          return
        }
        if (!found) {
          setDiscovery({ state: 'failed', reason: 'No answer came back.' })
          return
        }
        setDiscovery({ state: 'found', discovery: found })
        setCollection((current) => current ?? found.currentCollection)
        setProfile((current) => current ?? found.currentProfile)
      },
      (error: unknown) => {
        if (!cancelled) {
          setDiscovery({ state: 'failed', reason: ipcErrorMessage(error) })
        }
      }
    )
    return () => {
      cancelled = true
    }
  }, [open, discoveryAttempt])

  useEffect(() => {
    if (!open || !collection || !profile) {
      readAuthority.current.invalidate()
      setSetup(null)
      setSetupTicket(null)
      setReading(false)
      setReadFailure(null)
      return
    }
    const ticket = readAuthority.current.begin(collection, profile)
    setSetup(null)
    setSetupTicket(null)
    setReadFailure(null)
    setReading(true)
    let cancelled = false
    const current = (): boolean => !cancelled && readAuthority.current.accepts(ticket)
    const pendingRead = window.videorc?.obsRead?.(collection, profile)
    if (!pendingRead) {
      setReading(false)
      setReadFailure(OBS_IMPORT_UNAVAILABLE)
      return
    }
    void pendingRead
      .then((read) => {
        if (!current()) {
          return
        }
        setSetup(read)
        setSetupTicket(read ? ticket : null)
        if (!read) {
          setReadFailure(OBS_PROFILE_UNREADABLE)
        }
      })
      .catch((error: unknown) => {
        if (current()) {
          setSetup(null)
          setSetupTicket(null)
          setReadFailure(ipcErrorMessage(error))
        }
      })
      .finally(() => {
        if (current()) {
          setReading(false)
        }
      })
    return () => {
      cancelled = true
    }
  }, [open, collection, profile, readAttempt])

  const plan: ObsImportPlanResult | null = useMemo(
    () =>
      setup &&
      setupTicket &&
      readAuthority.current.accepts(setupTicket) &&
      setupTicket.collection === collection &&
      setupTicket.profile === profile
        ? mapObsSetup(setup, deviceList.devices, unattendedImportSlot(registry))
        : null,
    [collection, profile, setup, setupTicket, deviceList.devices, registry]
  )

  const invalidateSetup = (): void => {
    readAuthority.current.invalidate()
    setSetup(null)
    setSetupTicket(null)
    setReadFailure(null)
    setReading(true)
  }

  const apply = async (): Promise<void> => {
    const ticket = setupTicket
    if (!plan || !profile || !ticket || reading || !readAuthority.current.accepts(ticket)) {
      return
    }
    setApplying(true)
    try {
      // The key is fetched exactly once, at apply, and rides the same
      // legacy-typed-key path the streaming secret migration converts to a
      // backend secret ref. Never logged, never toasted.
      const rawKey =
        plan.stream?.kind === 'rtmp-custom' && plan.stream.hasKey
          ? ((await window.videorc?.obsReadStreamKey?.(profile)) ?? null)
          : null
      if (!readAuthority.current.accepts(ticket)) {
        return
      }
      setCaptureConfig((current) => mergeObsImportIntoConfig(current, plan, rawKey))
      if (plan.outputDirectory) {
        const directory = plan.outputDirectory
        setSettings((current) => ({
          ...current,
          outputDirectory: directory.displayName,
          outputDirectoryHandle: directory.directoryHandleId
        }))
      }
      // Exactly the background the report promised: into its slot, and on.
      setRegistry((current) => withObsBackground(current, plan))
      toast.success('OBS setup imported', {
        description: 'Check Sources and Scene.'
      })
      onOpenChange(false)
    } finally {
      setApplying(false)
    }
  }

  const groups = useMemo(() => {
    if (!plan) {
      return []
    }
    return (['imported', 'approximated', 'skipped'] as const)
      .map((verdict) => ({
        verdict,
        lines: plan.report.filter((line) => line.verdict === verdict)
      }))
      .filter((group) => group.lines.length > 0)
  }, [plan])

  const found = discovery.state === 'found' ? discovery.discovery : null

  return (
    <Dialog open={open} onOpenChange={(nextOpen) => !applying && onOpenChange(nextOpen)}>
      <DialogContent size="lg">
        <DialogHeader>
          <DialogTitle>Import from OBS</DialogTitle>
          <DialogDescription>
            Nothing changes until you import. The list below is exactly what will happen.
          </DialogDescription>
        </DialogHeader>

        {discovery.state === 'failed' ? (
          <Alert variant="destructive">
            <AlertTitle>Couldn&apos;t look for OBS Studio. {discovery.reason}</AlertTitle>
            <AlertAction>
              <Button
                size="xs"
                type="button"
                variant="outline"
                onClick={() => setDiscoveryAttempt((attempt) => attempt + 1)}
              >
                Try again
              </Button>
            </AlertAction>
          </Alert>
        ) : found?.available ? (
          <div className="flex flex-col gap-3">
            <div className="grid gap-3 sm:grid-cols-2">
              <Field>
                <FieldLabel htmlFor={collectionId}>Scene collection</FieldLabel>
                <Select
                  disabled={applying}
                  value={collection}
                  onValueChange={(value) => {
                    invalidateSetup()
                    setCollection(value)
                  }}
                >
                  <SelectTrigger className="w-full" id={collectionId}>
                    <SelectValue placeholder="Pick a scene collection" />
                  </SelectTrigger>
                  <SelectContent>
                    {found.collections.map((name) => (
                      <SelectItem key={name} value={name}>
                        {name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
              <Field>
                <FieldLabel htmlFor={profileId}>Profile</FieldLabel>
                <Select
                  disabled={applying}
                  value={profile}
                  onValueChange={(value) => {
                    invalidateSetup()
                    setProfile(value)
                  }}
                >
                  <SelectTrigger className="w-full" id={profileId}>
                    <SelectValue placeholder="Pick a profile" />
                  </SelectTrigger>
                  <SelectContent>
                    {found.profiles.map((name) => (
                      <SelectItem key={name} value={name}>
                        {name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
            </div>

            {readFailure ? (
              <Alert variant="destructive">
                <AlertTitle>Couldn&apos;t read this OBS profile. {readFailure}</AlertTitle>
                <AlertAction>
                  <Button
                    size="xs"
                    type="button"
                    variant="outline"
                    onClick={() => setReadAttempt((attempt) => attempt + 1)}
                  >
                    Try again
                  </Button>
                </AlertAction>
              </Alert>
            ) : !collection || !profile ? (
              <p className="text-sm text-muted-foreground">
                {found.profiles.length === 0
                  ? 'OBS has no profile to read.'
                  : 'Pick a scene collection and a profile.'}
              </p>
            ) : reading || groups.length === 0 ? (
              <p className="text-sm text-muted-foreground" role="status">
                Reading your OBS setup…
              </p>
            ) : (
              // The viewport carries the bound: Radix only scrolls a viewport
              // whose own height is limited.
              <ScrollArea className="rounded-row border *:data-[slot=scroll-area-viewport]:max-h-80">
                <div className="flex flex-col gap-4 p-3">
                  {groups.map(({ verdict, lines }) => {
                    const meta = VERDICT_META[verdict]
                    const Icon = meta.icon
                    return (
                      <div key={verdict} className="flex flex-col gap-1.5">
                        <div className="flex items-center gap-1.5 text-xs font-medium text-subtle">
                          <Icon className={`size-3.5 ${meta.iconClassName}`} weight="fill" />
                          {meta.title}
                        </div>
                        {lines.map((line) => (
                          <div
                            key={`${line.subject}:${line.note}`}
                            className="flex items-baseline gap-2 text-sm"
                          >
                            <span className="shrink-0 font-medium">{line.subject}</span>
                            <span className="min-w-0 text-muted-foreground">{line.note}</span>
                          </div>
                        ))}
                      </div>
                    )
                  })}
                </div>
              </ScrollArea>
            )}
          </div>
        ) : found ? (
          <p className="text-sm text-muted-foreground">
            No OBS Studio installation with scene collections was found on this device.
          </p>
        ) : (
          <p className="text-sm text-muted-foreground" role="status">
            Looking for OBS Studio…
          </p>
        )}

        <DialogFooter>
          <Button disabled={applying} variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            disabled={!plan || !found || Boolean(readFailure) || reading || applying}
            onClick={() => void apply()}
          >
            <DownloadIcon data-icon="inline-start" />
            {applying ? 'Importing…' : 'Import setup'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
