import {
  AccountIcon,
  BuddyIcon,
  DownloadIcon,
  HealthIcon,
  LivestreamIcon,
  OutputIcon,
  RefreshIcon
} from '@/components/icons'
import { useTheme } from 'next-themes'
import { useState, type ReactElement } from 'react'

import { GroupedList } from '@/components/list-row'
import { NavigableRow } from '@/components/navigable-row'
import { ObsImportDialog } from '@/components/obs-import-dialog'
import { PageStack } from '@/components/page'
import { PanelSection } from '@/components/panel-section'
import { ChatEmoteSettingsFields } from '@/components/settings/seventv-emotes-field'
import { PrivacySettingsSection } from '@/components/settings/usage-stats-field'
import { StatusBadge } from '@/components/status-badge'
import { Button } from '@/components/ui/button'
import { DisabledReason } from '@/components/ui/disabled-reason'
import { FieldGroup, SettingsRow } from '@/components/ui/field'
import { SegmentedControl } from '@/components/ui/segmented-control'
import { Switch } from '@/components/ui/switch'
import { workspaceTabLabel } from '@/components/workspace-nav'
import { useVideorcAccount } from '@/hooks/use-account'
import { useStudioCore, useStudioRecordingState } from '@/hooks/use-studio'
import { accountDisplayName, isSignedIn } from '@/lib/account'
import type { RuntimeInfo } from '@/lib/backend'
import { FIRST_RUN_REPLAY_LOCKED_REASON, firstRunReplayLocked } from '@/lib/first-run'
import { gpuFallbackAge, gpuRenderingLabel } from '@/lib/gpu-fallback-view'
import { platformCopy } from '@/lib/platform-copy'
import { studioChatOn } from '@/lib/studio-chat'
import { openFirstRunSetup, openWorkspaceTab } from '@/lib/workspace-navigation'

const THEME_OPTIONS = [
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
  { value: 'system', label: 'System' }
]

/**
 * Settings → General (plan 174 S3.17, I-27): how Videorc looks, chat in the
 * Studio and the Stream Manager (plan 204), first-run setup again (plan 203
 * S6), bringing a setup across, what Videorc shares, and where every other
 * setting lives. Six sections in two columns: Appearance over Chat over
 * Setup, Import over Privacy over Elsewhere, so they stack in that order on a
 * narrow window.
 */
export function GeneralSettings(): ReactElement {
  const { settings, setSettings, runtimeInfo, scheduleHardwareAccelerationRetry } = useStudioCore()
  const { theme, setTheme } = useTheme()
  const [obsImportOpen, setObsImportOpen] = useState(false)
  const { deviceNoun } = platformCopy(runtimeInfo?.platform)

  return (
    <>
      {/* Stacked, the hairline under this column splits it from the next;
          side by side, the pair drops it for the column rule. */}
      <PageStack className="border-b">
        <PanelSection description="How Videorc looks on this device." title="Appearance">
          <FieldGroup variant="grouped">
            <SettingsRow
              description={`System follows your ${deviceNoun}'s light or dark appearance.`}
              label="Theme"
            >
              <SegmentedControl
                options={THEME_OPTIONS}
                value={theme ?? 'system'}
                onValueChange={setTheme}
              />
            </SettingsRow>
            <SettingsRow
              description="Draws the Studio's controls on LCD screens, like a hardware recorder."
              label="Retro LCD"
            >
              <Switch
                checked={settings.retroLcdStudio === true}
                id="retro-lcd-studio"
                onCheckedChange={(checked) =>
                  setSettings((current) => ({ ...current, retroLcdStudio: checked }))
                }
              />
            </SettingsRow>
            {/* "Animate scene changes" changes what viewers see, so its one home
                is the Scene page (plan 174 S3.9, D17); this row points there. */}
            <NavigableRow
              className="rounded-none"
              label="Animate scene changes"
              value="Scene"
              onNavigate={() => openWorkspaceTab('layouts')}
            />
            {runtimeInfo?.platform === 'win32' ? (
              <SettingsRow
                description={graphicsAccelerationDescription(runtimeInfo)}
                label="Graphics acceleration"
              >
                <div className="flex shrink-0 flex-col items-end gap-2">
                  <StatusBadge
                    tone={runtimeInfo.hardwareAccelerationDisabled ? 'warn' : 'good'}
                    value={gpuRenderingLabel(runtimeInfo)}
                  />
                  {runtimeInfo.hardwareAccelerationDisabled &&
                  runtimeInfo.gpuFallback.source !== 'env' ? (
                    <Button
                      disabled={runtimeInfo.gpuFallback.retryScheduled}
                      variant="outline"
                      onClick={() => void scheduleHardwareAccelerationRetry()}
                    >
                      <RefreshIcon data-icon="inline-start" />
                      {runtimeInfo.gpuFallback.retryScheduled
                        ? 'Retry scheduled'
                        : 'Retry on next launch'}
                    </Button>
                  ) : null}
                </div>
              </SettingsRow>
            ) : null}
          </FieldGroup>
        </PanelSection>

        {/* Chat (plan 204): the livestream's chat in the Studio and in the
            Stream Manager, and how both draw emotes. Chat in Studio is this
            row's one home; ⌘K and the section's hide button mirror it. */}
        <PanelSection
          description="Your livestream's chat, in the Studio and in the Stream Manager."
          title="Chat"
        >
          <ChatEmoteSettingsFields>
            <SettingsRow
              description="While you're on air, the Studio shows your chat under Session. Click a message to show it on stream."
              label="Chat in Studio"
            >
              <Switch
                checked={studioChatOn(settings)}
                id="studio-chat"
                onCheckedChange={(checked) =>
                  setSettings((current) => ({ ...current, studioChat: checked }))
                }
              />
            </SettingsRow>
            {runtimeInfo?.commentsWindowEnabled !== false ? (
              <SettingsRow
                description="Chat, viewers, followers and activity for the whole stream, in their own window."
                label="Open Stream Manager when you go live"
              >
                <Switch
                  checked={settings.openStreamManagerOnLive === true}
                  id="open-stream-manager-on-live"
                  onCheckedChange={(checked) =>
                    setSettings((current) => ({ ...current, openStreamManagerOnLive: checked }))
                  }
                />
              </SettingsRow>
            ) : null}
          </ChatEmoteSettingsFields>
        </PanelSection>

        <SetupSection />
      </PageStack>

      <PageStack>
        <PanelSection
          description="Coming from OBS Studio? Bring your scenes and settings across."
          title="Import"
        >
          {/* O4 (OBS import plan): the wizard previews the truthful
              imported/approximated/skipped report BEFORE anything applies. */}
          <FieldGroup variant="grouped">
            <SettingsRow
              description="You see what comes across, and what doesn't, before anything changes."
              label="OBS Studio"
            >
              <Button variant="outline" onClick={() => setObsImportOpen(true)}>
                <DownloadIcon data-icon="inline-start" />
                Import from OBS…
              </Button>
            </SettingsRow>
          </FieldGroup>
          <ObsImportDialog open={obsImportOpen} onOpenChange={setObsImportOpen} />
        </PanelSection>

        <PrivacySettingsSection />

        <PanelSection description="Settings that live with the page they change." title="Elsewhere">
          <ElsewhereList />
        </PanelSection>
      </PageStack>
    </>
  )
}

/**
 * First-run setup again (plan 203 D5): the same screen over the workspace,
 * returning here. Setup holds capture back, so it waits for a session to end.
 */
function SetupSection(): ReactElement {
  const { recording } = useStudioRecordingState()
  const locked = firstRunReplayLocked(recording)
  return (
    <PanelSection description="The steps from the first time Videorc opened." title="Setup">
      <FieldGroup variant="grouped">
        <SettingsRow
          description="Go through the welcome steps again, starting with permissions."
          label="First-run setup"
        >
          <DisabledReason reason={locked ? FIRST_RUN_REPLAY_LOCKED_REASON : null}>
            <Button
              disabled={locked}
              variant="outline"
              onClick={() => openFirstRunSetup({ returnTo: 'settings' })}
            >
              Run setup again…
            </Button>
          </DisabledReason>
        </SettingsRow>
      </FieldGroup>
    </PanelSection>
  )
}

/**
 * Pointers to the settings that live on their own pages (plan 174 I-27):
 * Settings is where a streamer looks first, so it says where the rest went.
 */
function ElsewhereList(): ReactElement {
  const { account, signIn, openAccount } = useVideorcAccount()
  const signedIn = isSignedIn(account)
  return (
    <GroupedList aria-label="Settings on other pages" data-testid="settings-elsewhere">
      <NavigableRow
        icon={AccountIcon}
        label="Account and Premium"
        value={signedIn ? accountDisplayName(account) : 'Sign in'}
        onNavigate={signedIn ? openAccount : signIn}
      />
      <NavigableRow
        icon={BuddyIcon}
        label="Buddy, chat posting and Clean cut"
        value={workspaceTabLabel('ai')}
        onNavigate={() => openWorkspaceTab('ai')}
      />
      <NavigableRow
        icon={OutputIcon}
        label="Recording quality and files"
        value={workspaceTabLabel('recording')}
        onNavigate={() => openWorkspaceTab('recording')}
      />
      <NavigableRow
        icon={LivestreamIcon}
        label="Destinations and stream details"
        value={workspaceTabLabel('live')}
        onNavigate={() => openWorkspaceTab('live')}
      />
      <NavigableRow
        icon={HealthIcon}
        label="Checks and the support bundle"
        value={workspaceTabLabel('diagnostics')}
        onNavigate={() => openWorkspaceTab('diagnostics')}
      />
    </GroupedList>
  )
}

function graphicsAccelerationDescription(runtimeInfo: RuntimeInfo): string {
  const age = gpuFallbackAge(runtimeInfo.gpuFallback.updatedAt)
  const fallbackAge = age ? ` ${age}` : ''

  if (runtimeInfo.gpuFallback.source === 'retry') {
    return `This launch is testing hardware acceleration after a fallback${fallbackAge}. Two graphics crashes restore software rendering automatically; a stable minute clears the fallback.`
  }
  if (runtimeInfo.gpuFallback.source === 'env') {
    return 'Software rendering was requested when Videorc started. Remove that launch setting and reopen Videorc to use hardware acceleration.'
  }
  if (runtimeInfo.hardwareAccelerationDisabled) {
    if (runtimeInfo.gpuFallback.retryScheduled) {
      return `The fallback began${fallbackAge}. Hardware acceleration is retried after you quit and reopen Videorc; this launch stays in software rendering.`
    }
    return `Videorc switched to software rendering${fallbackAge} after ${runtimeInfo.gpuFallback.crashCount} graphics crashes. A retry affects only the next launch, and repeated crashes restore this safe mode.`
  }
  return 'Hardware acceleration is on. If graphics keep crashing, Videorc switches to software rendering on the next launch.'
}
