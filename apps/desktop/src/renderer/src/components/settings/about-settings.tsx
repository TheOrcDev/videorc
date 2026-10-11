import { DownloadIcon, RefreshIcon, SuccessIcon, WarningIcon } from '@/components/icons'
import type { ReactElement } from 'react'

import logoUrl from '@/assets/videorc-logo.png'
import { PanelSection } from '@/components/panel-section'
import { SupportBundleButton } from '@/components/support-bundle-button'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Progress } from '@/components/ui/progress'
import { Spinner } from '@/components/ui/spinner'
import { useStudioCore, useStudioRecordingState } from '@/hooks/use-studio'
import { useUpdater } from '@/hooks/use-updater'
import type { UpdateStatus } from '@/lib/backend'
import { isActiveRecordingState } from '@/lib/format'
import { releaseTrackLabel } from '@/lib/release-track'
import { isUpdateInstallable } from '@/lib/update-ui'

/** Settings → About: the version and its updates, and getting help. */
export function AboutSettings({ onShowWhatsNew }: { onShowWhatsNew: () => void }): ReactElement {
  return (
    <>
      <AboutAndUpdates onShowWhatsNew={onShowWhatsNew} />

      <PanelSection description="Get help or report a problem." title="Support">
        <div className="flex flex-col gap-2">
          <div className="flex flex-wrap gap-2">
            <SupportBundleButton />
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
          <Spinner data-icon="inline-start" />
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
          <Progress aria-label="Update download progress" value={status.percent} />
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
          <div className="flex items-start gap-1.5 text-xs text-foreground">
            <WarningIcon className="mt-px size-3.5 shrink-0 text-warning" weight="fill" />
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
