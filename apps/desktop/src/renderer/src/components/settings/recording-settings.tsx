import {
  ChevronDownIcon,
  ClapperboardIcon,
  FolderIcon,
  LivestreamIcon,
  SettingsIcon,
  SuccessIcon,
  WarningIcon
} from '@/components/icons'
import { useEffect, useState, type ReactElement } from 'react'

import { NavigableRow } from '@/components/navigable-row'
import { PanelSection } from '@/components/panel-section'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { Field, FieldGroup, FieldLabel } from '@/components/ui/field'
import { Switch } from '@/components/ui/switch'
import { useWorkspaceNav } from '@/components/workspace-nav'
import { useStudioCore } from '@/hooks/use-studio'
import type { DirectoryFacts } from '@/lib/backend'
import { recordingQuality, streamingSummary } from '@/lib/studio-session-view'

/**
 * Settings → Recording: where recordings go and what Record keeps ready.
 *
 * ST1 (UX rework): Settings holds app-level facts and tools only. Session
 * capture settings have ONE home each (Output ⌘7, Livestream ⌘5), so the
 * preset and destination rows NAVIGATE there instead of duplicating the
 * controls, which is what the old "Defaults" selects did (they edited the live
 * captureConfig).
 */
export function RecordingSettings(): ReactElement {
  const { settings, setSettings, health, captureConfig } = useStudioCore()
  const { openStudioPanel } = useWorkspaceNav()

  // ST2: validate the output directory as it changes — a typo here used to
  // fail silently at record time. Blank means the platform default.
  const [directoryFacts, setDirectoryFacts] = useState<DirectoryFacts | null>(null)
  const outputDirectory = settings.outputDirectory.trim()
  const outputDirectoryHandle = settings.outputDirectoryHandle
  useEffect(() => {
    if (!outputDirectoryHandle || !window.videorc?.checkDirectory) {
      setDirectoryFacts(null)
      return
    }
    let cancelled = false
    const timer = setTimeout(() => {
      void window.videorc?.checkDirectory?.(outputDirectoryHandle).then((facts) => {
        if (!cancelled) {
          setDirectoryFacts(facts)
        }
      })
    }, 350)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [outputDirectoryHandle])

  const browseOutputDirectory = async (): Promise<void> => {
    const selection = await window.videorc?.pickDirectory?.()
    if (selection) {
      setSettings((current) => ({
        ...current,
        outputDirectory: selection.displayName,
        outputDirectoryHandle: selection.directoryHandleId
      }))
    }
  }

  return (
    <PanelSection
      description="Where recordings are written and what new sessions use."
      icon={SettingsIcon}
      title="Recording & storage"
    >
      <FieldGroup variant="grouped">
        <Field>
          <FieldLabel htmlFor="output-directory">Output directory</FieldLabel>
          <div className="flex gap-2">
            <div
              id="output-directory"
              className="flex h-control min-w-0 flex-1 items-center truncate rounded-chip border border-border bg-foreground/[0.03] px-2.5 text-sm text-muted-foreground"
            >
              {outputDirectory || 'Videorc default recordings folder'}
            </div>
            <Button size="sm" variant="outline" onClick={() => void browseOutputDirectory()}>
              <FolderIcon data-icon="inline-start" />
              Browse
            </Button>
            <Button
              disabled={!directoryFacts?.exists}
              size="sm"
              variant="outline"
              onClick={() => {
                if (outputDirectoryHandle) {
                  void window.videorc?.revealSelectedResource?.(outputDirectoryHandle)
                }
              }}
            >
              <FolderIcon data-icon="inline-start" />
              Reveal
            </Button>
          </div>
          {!outputDirectory ? (
            <p className="text-xs text-muted-foreground">
              Blank uses the default: ~/Movies/Videorc/Recordings.
            </p>
          ) : directoryFacts && !directoryFacts.exists ? (
            <div className="flex flex-wrap items-center gap-2 text-xs text-warning">
              <WarningIcon className="size-3.5 shrink-0" weight="fill" />
              <span>This folder authorization expired. Choose it again.</span>
            </div>
          ) : directoryFacts && !directoryFacts.writable ? (
            <p className="flex items-center gap-1.5 text-xs text-warning">
              <WarningIcon className="size-3.5 shrink-0" weight="fill" />
              This folder is not writable. Recordings will fail to save here.
            </p>
          ) : directoryFacts ? (
            <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <SuccessIcon className="size-3.5 shrink-0 text-success" weight="fill" />
              Folder writable
              {typeof directoryFacts.freeBytes === 'number'
                ? ` · ${formatFreeSpace(directoryFacts.freeBytes)} free`
                : ''}
            </p>
          ) : null}
        </Field>
        <Field>
          <div className="flex items-center justify-between gap-3">
            <div className="flex min-w-0 flex-col gap-0.5">
              <FieldLabel htmlFor="keep-original-recording">Keep original recording</FieldLabel>
              <p className="text-xs text-muted-foreground">
                Keeps the capture MKV (lossless audio) next to the exported MP4 instead of deleting
                it. Uses more disk space.
              </p>
            </div>
            <Switch
              checked={settings.keepOriginalRecording}
              id="keep-original-recording"
              onCheckedChange={(checked) =>
                setSettings((current) => ({ ...current, keepOriginalRecording: checked }))
              }
            />
          </div>
        </Field>
        <Field>
          <div className="flex items-center justify-between gap-3">
            <div className="flex min-w-0 flex-col gap-0.5">
              <FieldLabel htmlFor="keep-microphone-warm">
                Keep microphone ready while Studio is visible
              </FieldLabel>
              <p className="text-xs text-muted-foreground">
                Opens the selected microphone as soon as Studio is on screen so Record starts
                instantly. macOS shows its microphone indicator while Studio is visible; hiding the
                window releases the microphone.
              </p>
            </div>
            <Switch
              checked={settings.keepMicrophoneWarm !== false}
              id="keep-microphone-warm"
              onCheckedChange={(checked) =>
                setSettings((current) => ({ ...current, keepMicrophoneWarm: checked }))
              }
            />
          </div>
        </Field>
      </FieldGroup>

      <div className="flex flex-col divide-y divide-border overflow-hidden rounded-row border border-border bg-foreground/[0.03]">
        <NavigableRow
          icon={ClapperboardIcon}
          label="Recording preset"
          value={recordingQuality(captureConfig.video)}
          onNavigate={() => openStudioPanel('recording')}
        />
        <NavigableRow
          icon={LivestreamIcon}
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
          <SuccessIcon className="size-3.5 shrink-0 text-success" weight="fill" />
          <span className="truncate">
            FFmpeg ready{health.ffmpeg.version ? ` · ${health.ffmpeg.version}` : ''}
          </span>
        </div>
      ) : health ? (
        <Alert variant="warning">
          <WarningIcon weight="fill" />
          <AlertTitle>Recording needs FFmpeg</AlertTitle>
          <AlertDescription>
            {import.meta.env.DEV
              ? 'For local development, install it with “brew install ffmpeg”.'
              : 'FFmpeg ships with Videorc, so this usually means the install is damaged. Reinstall Videorc.'}
          </AlertDescription>
        </Alert>
      ) : (
        <p className="text-xs text-muted-foreground">Checking for FFmpeg…</p>
      )}

      <Collapsible>
        <CollapsibleTrigger className="group flex w-fit items-center gap-2 rounded-row px-2 py-1.5 text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground">
          <ChevronDownIcon className="size-3.5 shrink-0 transition-transform group-data-[state=open]:rotate-180" />
          <span>Advanced</span>
        </CollapsibleTrigger>
        <CollapsibleContent className="flex flex-col gap-3 pt-2">
          <div className="flex items-center gap-2 rounded-row border border-border bg-foreground/[0.03] px-3 py-2 text-xs">
            <span className="shrink-0 font-medium">Session database</span>
            <span className="min-w-0 flex-1 truncate text-muted-foreground">
              Managed privately in Videorc app data
            </span>
          </div>
        </CollapsibleContent>
      </Collapsible>
    </PanelSection>
  )
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
