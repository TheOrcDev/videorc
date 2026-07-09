import { ArrowRight, CheckCircle, DownloadSimple, Warning, XCircle } from '@phosphor-icons/react'
import { useEffect, useMemo, useState, type ReactElement } from 'react'
import { toast } from 'sonner'

import { useBackgroundAssets } from '@/hooks/use-background-assets'
import { useStudio } from '@/hooks/use-studio'
import type { ObsDiscovery, ObsSetup } from '@/lib/backend'
import { createImportedAsset, firstEmptySlotId, importIntoSlot } from '@/lib/background-assets'
import { mergeObsImportIntoConfig } from '@/lib/obs-import-apply'
import { mapObsSetup, type ObsImportPlanResult, type ObsImportVerdict } from '@/lib/obs-import-map'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
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

const VERDICT_META: Record<
  ObsImportVerdict,
  { title: string; icon: typeof CheckCircle; className: string }
> = {
  imported: { title: 'Will import', icon: CheckCircle, className: 'text-success' },
  approximated: { title: 'Approximated', icon: Warning, className: 'text-warning' },
  skipped: { title: "Won't import", icon: XCircle, className: 'text-muted-foreground' }
}

export function ObsImportDialog({
  open,
  onOpenChange
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}): ReactElement {
  const { deviceList, setCaptureConfig, setSettings } = useStudio()
  const { registry, setRegistry } = useBackgroundAssets()
  const [discovery, setDiscovery] = useState<ObsDiscovery | null>(null)
  const [collection, setCollection] = useState<string | undefined>()
  const [profile, setProfile] = useState<string | undefined>()
  const [setup, setSetup] = useState<ObsSetup | null>(null)
  const [applying, setApplying] = useState(false)

  useEffect(() => {
    if (!open) {
      return
    }
    let cancelled = false
    void window.videorc?.obsDiscover?.().then((found) => {
      if (cancelled || !found) {
        return
      }
      setDiscovery(found)
      setCollection((current) => current ?? found.currentCollection)
      setProfile((current) => current ?? found.currentProfile)
    })
    return () => {
      cancelled = true
    }
  }, [open])

  useEffect(() => {
    if (!open || !collection || !profile) {
      return
    }
    let cancelled = false
    void window.videorc?.obsRead?.(collection, profile).then((read) => {
      if (!cancelled) {
        setSetup(read)
      }
    })
    return () => {
      cancelled = true
    }
  }, [open, collection, profile])

  const plan: ObsImportPlanResult | null = useMemo(
    () => (setup ? mapObsSetup(setup, deviceList.devices) : null),
    [setup, deviceList.devices]
  )

  const apply = async (): Promise<void> => {
    if (!plan || !profile) {
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
      setCaptureConfig((current) => mergeObsImportIntoConfig(current, plan, rawKey))
      if (plan.outputDirectory) {
        const directory = plan.outputDirectory
        setSettings((current) => ({ ...current, outputDirectory: directory }))
      }
      if (plan.backgroundImagePath && window.videorc?.importBackgroundImagePath) {
        const slot = firstEmptySlotId(registry)
        const imported = await window.videorc.importBackgroundImagePath(plan.backgroundImagePath)
        if (imported && slot) {
          const now = new Date().toISOString()
          const asset = createImportedAsset({
            id: imported.id,
            name: imported.name,
            assetPath: imported.assetPath,
            thumbnailPath: imported.thumbnailPath,
            createdAt: now,
            updatedAt: now
          })
          setRegistry((current) => importIntoSlot(current, slot, asset))
        }
      }
      toast.success('OBS setup imported', {
        description: 'Review Sources and the Scene stage — the report told you what changed.'
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

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>Import from OBS</DialogTitle>
          <DialogDescription>
            Nothing changes until you apply. The list below is exactly what will happen.
          </DialogDescription>
        </DialogHeader>

        {discovery?.available ? (
          <div className="flex flex-col gap-3">
            <div className="grid gap-3 sm:grid-cols-2">
              <Select value={collection} onValueChange={setCollection}>
                <SelectTrigger aria-label="OBS scene collection">
                  <SelectValue placeholder="Scene collection" />
                </SelectTrigger>
                <SelectContent>
                  {discovery.collections.map((name) => (
                    <SelectItem key={name} value={name}>
                      {name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Select value={profile} onValueChange={setProfile}>
                <SelectTrigger aria-label="OBS profile">
                  <SelectValue placeholder="Profile" />
                </SelectTrigger>
                <SelectContent>
                  {discovery.profiles.map((name) => (
                    <SelectItem key={name} value={name}>
                      {name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="flex max-h-80 flex-col gap-4 overflow-y-auto rounded-row border p-3">
              {groups.length === 0 ? (
                <p className="text-sm text-muted-foreground">Reading your OBS setup…</p>
              ) : (
                groups.map(({ verdict, lines }) => {
                  const meta = VERDICT_META[verdict]
                  const Icon = meta.icon
                  return (
                    <div key={verdict} className="flex flex-col gap-1.5">
                      <div className="flex items-center gap-1.5 text-xs font-medium text-subtle">
                        <Icon className={`size-3.5 ${meta.className}`} weight="fill" />
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
                })
              )}
            </div>
          </div>
        ) : discovery ? (
          <p className="text-sm text-muted-foreground">
            No OBS Studio installation with scene collections was found on this device.
          </p>
        ) : (
          <p className="text-sm text-muted-foreground">Looking for OBS Studio…</p>
        )}

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button disabled={!plan || applying} onClick={() => void apply()}>
            <DownloadSimple data-icon="inline-start" />
            {applying ? 'Importing…' : 'Import setup'}
            <ArrowRight data-icon="inline-end" />
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
