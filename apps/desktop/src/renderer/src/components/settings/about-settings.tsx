import {
  BugIcon,
  DownloadIcon,
  RefreshIcon,
  SparkleIcon,
  SpinnerIcon,
  SuccessIcon,
  WarningIcon
} from '@/components/icons'
import type { ReactElement } from 'react'

import logoUrl from '@/assets/videorc-logo.png'
import { PanelSection } from '@/components/panel-section'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { useStudioCore, useStudioRecordingState } from '@/hooks/use-studio'
import { useUpdater } from '@/hooks/use-updater'
import type { UpdateStatus } from '@/lib/backend'
import { isActiveRecordingState } from '@/lib/format'
import { releaseTrackLabel } from '@/lib/release-track'
import { isUpdateInstallable } from '@/lib/update-ui'

/** Settings → About: the version and its updates, and getting help. */
export function AboutSettings({ onShowWhatsNew }: { onShowWhatsNew: () => void }): ReactElement {
  const { exportSupportBundle, supportBundleExportPending } = useStudioCore()

  return (
    <>
      <AboutAndUpdates onShowWhatsNew={onShowWhatsNew} />

      <PanelSection description="Get help or report a problem." icon={BugIcon} title="Support">
        <div className="flex flex-col gap-2">
          <div className="flex flex-wrap gap-2">
            <Button
              disabled={supportBundleExportPending}
              size="sm"
              variant="outline"
              onClick={() => void exportSupportBundle()}
            >
              <BugIcon data-icon="inline-start" />
              {supportBundleExportPending ? 'Exporting…' : 'Export support bundle'}
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            Reporting a problem? Export a support bundle (redacted logs + diagnostics) to share with
            us.
          </p>
        </div>
      </PanelSection>
    </>
  )
}

function AboutAndUpdates({ onShowWhatsNew }: { onShowWhatsNew: () => void }): ReactElement {
  const { runtimeInfo } = useStudioCore()
  const { recording } = useStudioRecordingState()
  const { status, check, install } = useUpdater()
  const captureActive = isActiveRecordingState(recording.state)

  return (
    <PanelSection
      description="Check for new versions of Videorc and install them."
      icon={SparkleIcon}
      title="About & updates"
    >
      <div className="flex flex-col gap-4">
        {/* The app's identity, like a macOS About panel: the icon, the name,
            and the version with its release track. The PNG carries its own
            rounded tile and transparent margin, so it needs no mask or shadow. */}
        <div className="flex items-center gap-3">
          <img alt="" className="size-16 shrink-0" src={logoUrl} />
          <div className="flex min-w-0 flex-col gap-1">
            <span className="text-sm font-semibold text-foreground">Videorc</span>
            <span className="flex items-center gap-2 text-xs text-muted-foreground">
              <span>
                Version <span className="font-mono">{runtimeInfo?.version ?? '-'}</span>
              </span>
              {runtimeInfo ? (
                <Badge variant="outline">
                  {releaseTrackLabel(runtimeInfo.platform, runtimeInfo.isPackaged)}
                </Badge>
              ) : null}
            </span>
          </div>
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
          {status.reason === 'windows-feed-unpublished'
            ? 'No Windows update is published for you yet. Sign in to get Windows Alpha pilot updates automatically, or download the newest build from your account page.'
            : 'Automatic updates aren’t available for this build yet. Grab new versions from the downloads page.'}
        </p>
      )
    case 'checking':
      return (
        <Button disabled className="w-fit" size="sm" variant="outline">
          <SpinnerIcon className="animate-spin" data-icon="inline-start" />
          Checking for updates…
        </Button>
      )
    case 'available':
      return (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <DownloadIcon className="size-4 shrink-0" />
          <span>Version {status.version} available. Starting download…</span>
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
            <RefreshIcon data-icon="inline-start" />
            Restart &amp; install {status.version}
          </Button>
          <p className="text-xs text-muted-foreground">
            {captureActive
              ? 'Finish your recording first. Installing restarts Videorc.'
              : 'Videorc will restart to finish updating.'}
          </p>
        </div>
      )
    case 'not-available':
      return (
        <div className="flex flex-col gap-2">
          <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <SuccessIcon className="size-3.5 shrink-0 text-success" weight="fill" />
            <span>You’re on the latest version ({status.currentVersion}).</span>
          </div>
          <Button className="w-fit" size="sm" variant="outline" onClick={onCheck}>
            <RefreshIcon data-icon="inline-start" />
            Check again
          </Button>
        </div>
      )
    case 'error':
      return (
        <div className="flex flex-col gap-2">
          <div className="flex items-start gap-1.5 text-xs text-warning-foreground dark:text-warning">
            <WarningIcon className="size-3.5 shrink-0" weight="fill" />
            <span>Couldn’t check for updates: {status.message}</span>
          </div>
          <Button className="w-fit" size="sm" variant="outline" onClick={onCheck}>
            <RefreshIcon data-icon="inline-start" />
            Try again
          </Button>
        </div>
      )
    default:
      return (
        <Button className="w-fit" size="sm" variant="outline" onClick={onCheck}>
          <RefreshIcon data-icon="inline-start" />
          Check for updates
        </Button>
      )
  }
}
