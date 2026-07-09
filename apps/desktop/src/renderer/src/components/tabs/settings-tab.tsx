import {
  ArrowClockwise,
  Broadcast,
  Keyboard,
  Eye,
  FolderPlus,
  Bug,
  CaretDown,
  CheckCircle,
  CircleNotch,
  Database,
  DownloadSimple,
  FilmSlate,
  FolderOpen,
  GearSix,
  LockKey,
  PaintBrush,
  Sparkle,
  Warning
} from '@phosphor-icons/react'
import { useTheme } from 'next-themes'
import { useEffect, useState, type ReactElement } from 'react'

import { NavigableRow } from '@/components/navigable-row'
import { StatusBadge } from '@/components/status-badge'
import { Kbd, KbdGroup } from '@/components/ui/kbd'
import { ConfigGrid } from '@/components/page'
import { ObsImportDialog } from '@/components/obs-import-dialog'
import { PanelSection } from '@/components/panel-section'
import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { Field, FieldGroup, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { useWorkspaceNav } from '@/components/workspace-nav'
import { useStudio } from '@/hooks/use-studio'
import { useUpdater } from '@/hooks/use-updater'
import type { DirectoryFacts, UpdateStatus } from '@/lib/backend'
import { isActiveRecordingState } from '@/lib/format'
import { recordingQuality, streamingSummary } from '@/lib/studio-session-view'
import { shortcutsByGroup } from '@/lib/shortcuts'
import { displayKeyGlyphs, osSettingsName } from '@/lib/platform'
import { systemAccessRows } from '@/lib/system-access'
import { isUpdateInstallable } from '@/lib/update-ui'

// ST1 (UX rework): Settings holds app-level facts and tools only. Session
// capture settings have ONE home each (Output ⌘6, Livestream ⌘5) — the rows
// below NAVIGATE there instead of duplicating the controls, which is what the
// old "Defaults" selects did (they edited the live captureConfig).
export function SettingsTab({
  onOpenPermissionsSetup,
  onShowWhatsNew
}: {
  onOpenPermissionsSetup: () => void
  onShowWhatsNew: () => void
}): ReactElement {
  const {
    settings,
    setSettings,
    health,
    captureConfig,
    deviceList,
    audioMeter,
    refreshBackend,
    openSystemPermission,
    exportSupportBundle,
    supportBundleExportPending,
    runtimeInfo
  } = useStudio()
  const { openStudioPanel } = useWorkspaceNav()
  const { theme, setTheme } = useTheme()

  const locateFfmpeg = async (): Promise<void> => {
    const path = await window.videorc?.pickFile?.()
    if (path) {
      setSettings((current) => ({ ...current, ffmpegPath: path }))
    }
  }

  // ST2: validate the output directory as it changes — a typo here used to
  // fail silently at record time. Blank means the platform default.
  const [directoryFacts, setDirectoryFacts] = useState<DirectoryFacts | null>(null)
  const [obsImportOpen, setObsImportOpen] = useState(false)
  const outputDirectory = settings.outputDirectory.trim()
  useEffect(() => {
    if (!outputDirectory || !window.videorc?.checkDirectory) {
      setDirectoryFacts(null)
      return
    }
    let cancelled = false
    const timer = setTimeout(() => {
      void window.videorc?.checkDirectory?.(outputDirectory).then((facts) => {
        if (!cancelled) {
          setDirectoryFacts(facts)
        }
      })
    }, 350)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [outputDirectory])

  const browseOutputDirectory = async (): Promise<void> => {
    const path = await window.videorc?.pickDirectory?.()
    if (path) {
      setSettings((current) => ({ ...current, outputDirectory: path }))
    }
  }

  // ST3: permission grants change in System Settings while we're backgrounded —
  // re-enumerate when the window comes back so the chips stay honest.
  useEffect(() => {
    const onFocus = (): void => void refreshBackend()
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [refreshBackend])

  const accessRows = systemAccessRows({ deviceList, audioMeter, platform: runtimeInfo?.platform })

  const createOutputDirectory = async (): Promise<void> => {
    if (!outputDirectory) {
      return
    }
    const facts = await window.videorc?.createDirectory?.(outputDirectory)
    if (facts) {
      setDirectoryFacts(facts)
    }
  }

  return (
    <div className="flex flex-col gap-5">
      <ConfigGrid>
        <PanelSection
          description="Where recordings are written and what new sessions use."
          icon={GearSix}
          title="Recording & storage"
        >
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="output-directory">Output directory</FieldLabel>
              <div className="flex gap-2">
                <Input
                  id="output-directory"
                  className="min-w-0 flex-1"
                  placeholder="~/Movies/Videorc/Recordings"
                  value={settings.outputDirectory}
                  onChange={(event) =>
                    setSettings((current) => ({ ...current, outputDirectory: event.target.value }))
                  }
                />
                <Button size="sm" variant="outline" onClick={() => void browseOutputDirectory()}>
                  <FolderOpen data-icon="inline-start" />
                  Browse
                </Button>
                <Button
                  disabled={!directoryFacts?.exists}
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    if (outputDirectory) {
                      void window.videorc?.revealPath?.(outputDirectory)
                    }
                  }}
                >
                  <Eye data-icon="inline-start" />
                  Reveal
                </Button>
              </div>
              {!outputDirectory ? (
                <p className="text-xs text-muted-foreground">
                  Blank uses the default: ~/Movies/Videorc/Recordings.
                </p>
              ) : directoryFacts && !directoryFacts.exists ? (
                <div className="flex flex-wrap items-center gap-2 text-xs text-warning">
                  <Warning className="size-3.5 shrink-0" weight="fill" />
                  <span>This folder does not exist yet.</span>
                  <Button size="xs" variant="outline" onClick={() => void createOutputDirectory()}>
                    <FolderPlus data-icon="inline-start" />
                    Create folder
                  </Button>
                </div>
              ) : directoryFacts && !directoryFacts.writable ? (
                <p className="flex items-center gap-1.5 text-xs text-warning">
                  <Warning className="size-3.5 shrink-0" weight="fill" />
                  This folder is not writable — recordings will fail to save here.
                </p>
              ) : directoryFacts ? (
                <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  <CheckCircle className="size-3.5 shrink-0 text-success" weight="fill" />
                  Folder writable
                  {typeof directoryFacts.freeBytes === 'number'
                    ? ` · ${formatFreeSpace(directoryFacts.freeBytes)} free`
                    : ''}
                </p>
              ) : null}
            </Field>
          </FieldGroup>

          <div className="flex flex-col gap-0.5">
            <NavigableRow
              icon={FilmSlate}
              label="Recording preset"
              value={recordingQuality(captureConfig.video)}
              onNavigate={() => openStudioPanel('recording')}
            />
            <NavigableRow
              icon={Broadcast}
              label="Stream destinations"
              value={streamingSummary(captureConfig.streamEnabled, captureConfig.streaming.targets)}
              onNavigate={() => openStudioPanel('live')}
            />
          </div>

          {/* FFmpeg ships bundled with the packaged app, so normal users never set
            a path. Show a quiet status; surface a friendly, actionable card only
            when it is genuinely missing; keep the manual override in Advanced. */}
          {health?.ffmpeg.available ? (
            <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <CheckCircle className="size-3.5 shrink-0 text-success" weight="fill" />
              <span className="truncate">
                FFmpeg ready{health.ffmpeg.version ? ` · ${health.ffmpeg.version}` : ''}
              </span>
            </div>
          ) : health ? (
            <div className="flex flex-col gap-2 rounded-row border border-warning/40 bg-warning/10 p-3">
              <div className="flex items-center gap-2 text-sm font-medium text-warning-foreground dark:text-warning">
                <Warning className="size-4 shrink-0" weight="fill" />
                Recording needs FFmpeg
              </div>
              <p className="text-xs text-muted-foreground">
                {import.meta.env.DEV
                  ? 'For local development, install it with \u201cbrew install ffmpeg\u201d \u2014 or locate an existing binary.'
                  : 'FFmpeg ships with Videorc, so this usually means the install is damaged. Reinstall Videorc, or locate the binary manually.'}
              </p>
              <Button
                className="w-fit"
                size="sm"
                variant="outline"
                onClick={() => void locateFfmpeg()}
              >
                <FolderOpen data-icon="inline-start" />
                Locate FFmpeg\u2026
              </Button>
            </div>
          ) : (
            <p className="text-xs text-muted-foreground">Checking for FFmpeg\u2026</p>
          )}

          <Collapsible>
            <CollapsibleTrigger className="group flex w-fit items-center gap-2 rounded-row px-2 py-1.5 text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground">
              <CaretDown className="size-3.5 shrink-0 transition-transform group-data-[state=open]:rotate-180" />
              <span>Advanced</span>
            </CollapsibleTrigger>
            <CollapsibleContent className="flex flex-col gap-3 pt-2">
              <Field>
                <FieldLabel htmlFor="ffmpeg-path">FFmpeg path override</FieldLabel>
                <Input
                  id="ffmpeg-path"
                  placeholder="ffmpeg (bundled)"
                  value={settings.ffmpegPath}
                  onChange={(event) =>
                    setSettings((current) => ({ ...current, ffmpegPath: event.target.value }))
                  }
                />
              </Field>
              <div className="flex items-center gap-2 rounded-row border bg-muted/40 px-3 py-2 text-xs">
                <Database className="size-4 shrink-0 text-muted-foreground" weight="duotone" />
                <span className="shrink-0 font-medium">Session database</span>
                <span
                  className="min-w-0 flex-1 truncate text-muted-foreground"
                  title={health?.databasePath ?? undefined}
                >
                  {health?.databasePath ?? 'Waiting for SQLite path.'}
                </span>
                <Button
                  disabled={!health?.databasePath}
                  size="xs"
                  variant="ghost"
                  onClick={() => {
                    if (health?.databasePath) {
                      void navigator.clipboard.writeText(health.databasePath)
                    }
                  }}
                >
                  Copy
                </Button>
                <Button
                  disabled={!health?.databasePath}
                  size="xs"
                  variant="ghost"
                  onClick={() => {
                    if (health?.databasePath) {
                      void window.videorc?.revealPath?.(health.databasePath)
                    }
                  }}
                >
                  Reveal
                </Button>
              </div>
            </CollapsibleContent>
          </Collapsible>
        </PanelSection>

        <PanelSection
          description={`What ${osSettingsName(runtimeInfo?.platform)} lets Videorc capture right now.`}
          icon={LockKey}
          title="System access"
          action={
            <Button size="sm" variant="ghost" onClick={() => void refreshBackend()}>
              <ArrowClockwise data-icon="inline-start" />
              Refresh
            </Button>
          }
        >
          <div className="flex flex-col gap-1">
            {accessRows.map((row) => (
              <div
                key={row.id}
                className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-row px-2.5 py-2 text-sm"
              >
                <span className="w-32 shrink-0 font-medium">{row.label}</span>
                <StatusBadge
                  tone={
                    row.state === 'granted'
                      ? 'good'
                      : row.state === 'not-granted'
                        ? 'warn'
                        : 'neutral'
                  }
                  value={
                    row.state === 'granted'
                      ? 'Granted'
                      : row.state === 'not-granted'
                        ? 'Not granted'
                        : 'Checked on first use'
                  }
                />
                {/* Q4 (plan 022): the permission TARGET is the actionable part —
                    truncation clipped it to "Captur…"/"Voice a…". The row
                    flex-wraps, so let the detail take a full line when tight
                    instead of truncating; tooltip keeps the hover affordance. */}
                <span
                  className="min-w-0 flex-1 basis-56 text-xs text-muted-foreground"
                  title={`${row.purpose} ${row.detail}`}
                >
                  {row.purpose} {row.detail}
                </span>
                <Button
                  size="xs"
                  variant="outline"
                  onClick={() => void openSystemPermission(row.id)}
                >
                  Open settings
                </Button>
              </div>
            ))}
          </div>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <Button size="sm" variant="outline" onClick={onOpenPermissionsSetup}>
              <LockKey data-icon="inline-start" />
              Set up permissions
            </Button>
            <p className="text-xs text-muted-foreground">
              Grants live in {osSettingsName(runtimeInfo?.platform)}. After changing one, come back
              here — rows refresh automatically.
            </p>
          </div>
        </PanelSection>
      </ConfigGrid>

      {/* Lower region: the three short cards stack in one column beside the tall
        Shortcuts card, so the columns read as balanced. */}
      <div className="grid items-start gap-5 lg:grid-cols-2">
        <div className="flex flex-col gap-5">
          <PanelSection
            description="How Videorc looks and behaves on this device."
            icon={PaintBrush}
            title="Appearance & behavior"
          >
            <Field>
              <FieldLabel>Theme</FieldLabel>
              <ToggleGroup
                type="single"
                value={theme ?? 'system'}
                variant="outline"
                onValueChange={(value) => value && setTheme(value)}
              >
                <ToggleGroupItem value="light">Light</ToggleGroupItem>
                <ToggleGroupItem value="dark">Dark</ToggleGroupItem>
                <ToggleGroupItem value="system">System</ToggleGroupItem>
              </ToggleGroup>
            </Field>
          </PanelSection>

          <PanelSection
            description="Coming from OBS Studio? Bring your scenes and settings across."
            icon={DownloadSimple}
            title="Import"
          >
            {/* O4 (OBS import plan): the wizard previews the truthful
                imported/approximated/skipped report BEFORE anything applies. */}
            <div>
              <Button size="sm" variant="outline" onClick={() => setObsImportOpen(true)}>
                <DownloadSimple data-icon="inline-start" />
                Import from OBS…
              </Button>
            </div>
            <ObsImportDialog open={obsImportOpen} onOpenChange={setObsImportOpen} />
          </PanelSection>

          <PanelSection description="Get help or report a problem." icon={Bug} title="Support">
            <div className="flex flex-col gap-2">
              <div className="flex flex-wrap gap-2">
                <Button
                  disabled={supportBundleExportPending}
                  size="sm"
                  variant="outline"
                  onClick={() => void exportSupportBundle()}
                >
                  <Bug data-icon="inline-start" />
                  {supportBundleExportPending ? 'Exporting\u2026' : 'Export support bundle'}
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">
                Reporting a problem? Export a support bundle (redacted logs + diagnostics) to share
                with us.
              </p>
            </div>
          </PanelSection>

          <AboutAndUpdates onShowWhatsNew={onShowWhatsNew} />
        </div>

        <PanelSection
          description="Every keyboard shortcut in Videorc."
          icon={Keyboard}
          title="Shortcuts"
        >
          <div className="flex flex-col gap-3">
            {[...shortcutsByGroup().entries()].map(([group, entries]) => (
              <div key={group} className="flex flex-col gap-1">
                <span className="text-[12.5px] leading-none font-medium text-subtle">{group}</span>
                {entries.map((entry) => (
                  <div
                    key={entry.id}
                    className="flex items-center gap-3 rounded-row px-2.5 py-1.5 text-sm"
                  >
                    <span className="flex-1 truncate text-muted-foreground">{entry.label}</span>
                    <KbdGroup>
                      {displayKeyGlyphs(entry.keys, runtimeInfo?.platform).map((key, index) => (
                        <Kbd key={`${entry.id}-${index}`}>{key}</Kbd>
                      ))}
                    </KbdGroup>
                  </div>
                ))}
              </div>
            ))}
          </div>
        </PanelSection>
      </div>
    </div>
  )
}

function AboutAndUpdates({ onShowWhatsNew }: { onShowWhatsNew: () => void }): ReactElement {
  const { runtimeInfo, recording } = useStudio()
  const { status, check, install } = useUpdater()
  const captureActive = isActiveRecordingState(recording.state)

  return (
    <PanelSection
      description="Check for new versions of Videorc and install them."
      icon={Sparkle}
      title="About & updates"
    >
      <div className="flex flex-col gap-4">
        <div className="flex items-center justify-between gap-3">
          <span className="text-sm text-muted-foreground">Current version</span>
          <span className="font-mono text-sm text-foreground">{runtimeInfo?.version ?? '—'}</span>
        </div>
        <UpdateControl
          captureActive={captureActive}
          status={status}
          onCheck={check}
          onInstall={install}
        />
        <div className="flex items-center justify-between gap-3">
          <span className="text-sm text-muted-foreground">Release notes</span>
          <Button size="sm" variant="outline" onClick={onShowWhatsNew}>
            What&apos;s new
          </Button>
        </div>
      </div>
    </PanelSection>
  )
}

function UpdateControl({
  status,
  captureActive,
  onCheck,
  onInstall
}: {
  status: UpdateStatus
  captureActive: boolean
  onCheck: () => void
  onInstall: () => void
}): ReactElement {
  switch (status.phase) {
    case 'unsupported':
      return (
        <p className="text-xs text-muted-foreground">
          Automatic updates aren’t available for this build yet. Grab new versions from the
          downloads page.
        </p>
      )
    case 'checking':
      return (
        <Button disabled className="w-fit" size="sm" variant="outline">
          <CircleNotch className="animate-spin" data-icon="inline-start" />
          Checking for updates…
        </Button>
      )
    case 'available':
      return (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <DownloadSimple className="size-4 shrink-0" />
          <span>Version {status.version} available — starting download…</span>
        </div>
      )
    case 'downloading':
      return (
        <div className="flex flex-col gap-2">
          <div className="flex items-center justify-between text-xs text-muted-foreground">
            <span>Downloading update…</span>
            <span className="font-mono">{status.percent}%</span>
          </div>
          <div
            aria-label="Update download progress"
            aria-valuemax={100}
            aria-valuemin={0}
            aria-valuenow={status.percent}
            className="h-1.5 w-full overflow-hidden rounded-full bg-muted"
            role="progressbar"
          >
            <div
              className="h-full rounded-full bg-primary transition-[width] duration-200"
              style={{ width: `${status.percent}%` }}
            />
          </div>
        </div>
      )
    case 'downloaded':
      return (
        <div className="flex flex-col gap-2">
          <Button
            className="w-fit"
            disabled={!isUpdateInstallable(status, captureActive)}
            size="sm"
            onClick={onInstall}
          >
            <ArrowClockwise data-icon="inline-start" />
            Restart &amp; install {status.version}
          </Button>
          <p className="text-xs text-muted-foreground">
            {captureActive
              ? 'Finish your recording first — installing restarts Videorc.'
              : 'Videorc will restart to finish updating.'}
          </p>
        </div>
      )
    case 'not-available':
      return (
        <div className="flex flex-col gap-2">
          <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <CheckCircle className="size-3.5 shrink-0 text-success" weight="fill" />
            <span>You’re on the latest version ({status.currentVersion}).</span>
          </div>
          <Button className="w-fit" size="sm" variant="outline" onClick={onCheck}>
            <ArrowClockwise data-icon="inline-start" />
            Check again
          </Button>
        </div>
      )
    case 'error':
      return (
        <div className="flex flex-col gap-2">
          <div className="flex items-start gap-1.5 text-xs text-warning-foreground dark:text-warning">
            <Warning className="size-3.5 shrink-0" weight="fill" />
            <span>Couldn’t check for updates: {status.message}</span>
          </div>
          <Button className="w-fit" size="sm" variant="outline" onClick={onCheck}>
            <ArrowClockwise data-icon="inline-start" />
            Try again
          </Button>
        </div>
      )
    default:
      return (
        <Button className="w-fit" size="sm" variant="outline" onClick={onCheck}>
          <ArrowClockwise data-icon="inline-start" />
          Check for updates
        </Button>
      )
  }
}

function formatFreeSpace(bytes: number): string {
  const gb = bytes / 1024 ** 3
  if (gb >= 100) {
    return `${Math.round(gb)} GB`
  }
  if (gb >= 1) {
    return `${gb.toFixed(1)} GB`
  }
  return `${Math.max(1, Math.round(bytes / 1024 ** 2))} MB`
}
