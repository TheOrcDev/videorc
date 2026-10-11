import { ExternalLinkIcon, RefreshIcon } from '@/components/icons'
import type { ReactElement } from 'react'

import logoUrl from '@/assets/videorc-logo.png'
import { GroupedList, ListRow } from '@/components/list-row'
import { PanelSection } from '@/components/panel-section'
import { SupportBundleButton } from '@/components/support-bundle-button'
import { Alert, AlertAction, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { DisabledReason } from '@/components/ui/disabled-reason'
import { FieldGroup, SettingsRow } from '@/components/ui/field'
import { Progress } from '@/components/ui/progress'
import { Spinner } from '@/components/ui/spinner'
import { useStudioCore, useStudioRecordingState } from '@/hooks/use-studio'
import { useUpdater } from '@/hooks/use-updater'
import { updateRowView, type UpdateRowControl } from '@/lib/about-update-view'
import { isActiveRecordingState, NO_VALUE } from '@/lib/format'
import { releaseTrackLabel } from '@/lib/release-track'
import {
  openVideorcWebLink,
  VIDEORC_SOURCE_CODE_URL,
  VIDEORC_WEB_LINKS
} from '@/lib/videorc-web-links'

/**
 * Where Videorc lives on the web (plan 174 I-21). "Contact support" waits for
 * a support address the app does not have yet.
 */
const ABOUT_LINKS: ReadonlyArray<{ title: string; context: string; url: string }> = [
  { title: 'Website', context: 'videorc.com', url: VIDEORC_WEB_LINKS.home },
  { title: 'Privacy policy', context: '', url: VIDEORC_WEB_LINKS.privacy },
  { title: 'Terms of service', context: '', url: VIDEORC_WEB_LINKS.terms },
  { title: 'Source code and licenses', context: 'AGPL-3.0', url: VIDEORC_SOURCE_CODE_URL }
]

/** Settings → About: the version and its updates, and getting help. */
export function AboutSettings({ onShowWhatsNew }: { onShowWhatsNew: () => void }): ReactElement {
  return (
    <>
      <AboutAndUpdates onShowWhatsNew={onShowWhatsNew} />

      <PanelSection description="Get help or report a problem." title="Support">
        <FieldGroup variant="grouped">
          <SettingsRow
            description="Redacted logs and Health's checks in one file, to send with a problem report."
            label="Support bundle"
          >
            <SupportBundleButton />
          </SettingsRow>
        </FieldGroup>
        <GroupedList label="Links">
          {ABOUT_LINKS.map((link) => (
            <ListRow
              key={link.title}
              as="button"
              context={link.context || undefined}
              statusIcons={<ExternalLinkIcon aria-hidden />}
              title={link.title}
              onClick={() => openVideorcWebLink(link.url)}
            />
          ))}
        </GroupedList>
      </PanelSection>
    </>
  )
}

function AboutAndUpdates({ onShowWhatsNew }: { onShowWhatsNew: () => void }): ReactElement {
  const { runtimeInfo } = useStudioCore()
  const { recording } = useStudioRecordingState()
  const { status, check, install } = useUpdater()
  const view = updateRowView(status, isActiveRecordingState(recording.state))

  return (
    <PanelSection description="Your version of Videorc and its updates." title="About & updates">
      {/* The app's identity, like a macOS About panel: the icon, the name,
          and the version with its release track. The PNG carries its own
          rounded tile and transparent margin, so it needs no mask or shadow. */}
      <div className="flex items-center gap-3">
        <img alt="" className="size-16 shrink-0" src={logoUrl} />
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <span className="text-sm font-semibold text-foreground">Videorc</span>
          <span className="flex items-center gap-2 text-xs text-muted-foreground">
            <span>
              Version <span className="font-mono">{runtimeInfo?.version ?? NO_VALUE}</span>
            </span>
            {runtimeInfo ? (
              <Badge variant="outline">
                {releaseTrackLabel(runtimeInfo.platform, runtimeInfo.isPackaged)}
              </Badge>
            ) : null}
          </span>
        </div>
        <Button size="sm" variant="outline" onClick={onShowWhatsNew}>
          What&apos;s new…
        </Button>
      </div>

      {view.kind === 'error' ? (
        // Plan 174 I-20: a failed update is an Alert with its one fix, never
        // the updater's raw text in a warning line.
        <Alert data-testid="update-error" variant="warning">
          <AlertTitle>{view.title}</AlertTitle>
          <AlertDescription>{view.description}</AlertDescription>
          <AlertAction>
            <Button size="xs" variant="outline" onClick={check}>
              Try again
            </Button>
          </AlertAction>
        </Alert>
      ) : (
        <FieldGroup variant="grouped">
          <SettingsRow description={view.description} label="Updates">
            {view.control ? (
              <UpdateControl control={view.control} onCheck={check} onInstall={install} />
            ) : null}
          </SettingsRow>
        </FieldGroup>
      )}
    </PanelSection>
  )
}

function UpdateControl({
  control,
  onCheck,
  onInstall
}: {
  control: UpdateRowControl
  onCheck: () => void
  onInstall: () => void
}): ReactElement {
  switch (control.kind) {
    case 'check':
      return (
        <Button size="sm" variant="outline" onClick={onCheck}>
          <RefreshIcon data-icon="inline-start" />
          {control.label}
        </Button>
      )
    case 'checking':
      return (
        <Button disabled size="sm" variant="outline">
          <Spinner aria-hidden data-icon="inline-start" />
          Checking…
        </Button>
      )
    case 'progress':
      return (
        <Progress
          aria-label="Update download"
          className="w-32 shrink-0 self-center"
          value={control.percent}
        />
      )
    case 'install':
      return (
        <DisabledReason reason={control.disabledReason}>
          <Button disabled={control.disabledReason !== null} size="sm" onClick={onInstall}>
            <RefreshIcon data-icon="inline-start" />
            {control.label}
          </Button>
        </DisabledReason>
      )
    case 'link':
      return (
        <Button
          size="sm"
          variant="outline"
          onClick={() => openVideorcWebLink(VIDEORC_WEB_LINKS[control.link])}
        >
          {control.label}
          <ExternalLinkIcon data-icon="inline-end" />
        </Button>
      )
  }
}
