import { useCallback, useEffect, useState, type ReactElement } from 'react'

import { LockAlert } from '@/components/lock-alert'
import { PanelSection } from '@/components/panel-section'
import { Button } from '@/components/ui/button'
import { FieldGroup, SettingsRow } from '@/components/ui/field'
import { SegmentedControl } from '@/components/ui/segmented-control'
import { Switch } from '@/components/ui/switch'
import { useStudioCloud, useStudioDiagnostics } from '@/hooks/use-studio'
import type { WatchdogSettings, WatchdogSettingsPatch } from '@/lib/backend'
import { useCopyText } from '@/lib/copy-text'
import { qrCodePath } from '@/lib/phone-remote-view'
import { toastUserError } from '@/lib/user-error'
import { VIDEORC_PREMIUM_URL, VIDEORC_WEB_LINKS } from '@/lib/videorc-web-links'

// The Livestream page's Watchdog section (plan 223 D7): every check as a row
// with its switch, "Alert me after" for the muted microphone, System
// notifications, the phone (Premium: the link and QR to videorc.com/live and
// the device count), and "AI reads chat for problems" (Premium, B2). Every
// check is on by default; an empty list never means silence. The black
// picture check ships on the desktop (A7's measurement passed), so no
// "Videorc Cloud only" note is needed.

/** The rows, in the catalogue's order, with the words a streamer reads. */
export const WATCHDOG_CHECK_ROWS: readonly { id: string; label: string; description: string }[] = [
  { id: 'mic-muted', label: 'Microphone muted', description: 'You muted and forgot.' },
  { id: 'mic-silent', label: 'Microphone silent', description: 'The device sends only silence.' },
  {
    id: 'no-voice',
    label: 'No voice',
    description: 'Nothing has reached the microphone for 5 minutes.'
  },
  {
    id: 'program-silent',
    label: 'Viewers hear nothing',
    description: 'No sound leaves the stream for 20 seconds.'
  },
  {
    id: 'picture-black',
    label: 'Black picture',
    description: 'The stream is black for 10 seconds.'
  },
  {
    id: 'picture-stopped',
    label: 'Picture stopped',
    description: 'No new frame reaches the stream. A still screen is fine.'
  },
  {
    id: 'destination-down',
    label: 'Destination down',
    description: 'A platform stops receiving the stream.'
  },
  {
    id: 'platform-health',
    label: 'Platform reports a problem',
    description: "YouTube's own health report, X's broadcast state."
  },
  {
    id: 'bitrate-floor',
    label: 'Connection too slow',
    description: 'The stream sits at half its bitrate for 2 minutes.'
  },
  {
    id: 'av-drift',
    label: 'Sound and picture drift',
    description: 'Videorc Cloud measures them apart (cloud shows).'
  },
  {
    id: 'chat-says',
    label: 'Chat says there is a problem',
    description: 'Two people report no sound, a frozen picture or lag.'
  },
  {
    id: 'brb-long',
    label: 'Long Be right back',
    description: 'A takeover has been up for 10 minutes.'
  },
  {
    id: 'still-there',
    label: 'Still there?',
    description: 'No voice and no input for 10 minutes. A quiet reminder.'
  }
]

const MIC_MUTED_AFTER_OPTIONS = [
  { value: '15', label: '15 s' },
  { value: '30', label: '30 s' },
  { value: '60', label: '1 min' },
  { value: '120', label: '2 min' }
]

const LIVE_URL = VIDEORC_WEB_LINKS.live
const PHONE_PREMIUM_REASON = 'Alerts on your phone come with Premium.'

function PhoneCode({ url }: { url: string }): ReactElement {
  const { path, size } = qrCodePath(url)
  return (
    // A QR code is dark-on-light in both themes: scanners need the contrast.
    <svg
      aria-label="Phone alerts QR code"
      className="size-28 rounded-row bg-white p-1"
      role="img"
      shapeRendering="crispEdges"
      viewBox={`0 0 ${size} ${size}`}
    >
      <path d={path} fill="#000" />
    </svg>
  )
}

export function WatchdogSection(): ReactElement | null {
  const { client } = useStudioDiagnostics()
  const { cloudStatus } = useStudioCloud()
  const [settings, setSettings] = useState<WatchdogSettings | null>(null)
  const [devices, setDevices] = useState<number | null>(null)
  const [showCode, setShowCode] = useState(false)
  const { copied, copy } = useCopyText()
  // Premium's own gate (D5): the cloud block says the account is entitled.
  const premium = Boolean(cloudStatus?.entitled || cloudStatus?.plan)

  useEffect(() => {
    if (!client) return
    let cancelled = false
    void client
      .requestTyped('watchdog.settings.get')
      .then((next) => {
        if (!cancelled) setSettings(next)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [client])

  useEffect(() => {
    if (!client || !premium) return
    let cancelled = false
    void client
      .requestTyped('watchdog.phone.devices')
      .then((view) => {
        if (!cancelled) setDevices(view.devices.length)
      })
      .catch(() => {
        if (!cancelled) setDevices(null)
      })
    return () => {
      cancelled = true
    }
  }, [client, premium])

  const patch = useCallback(
    async (next: WatchdogSettingsPatch) => {
      if (!client) return
      try {
        const saved = await client.requestTyped('watchdog.settings.set', next)
        setSettings(saved)
        const surface = await import('@/lib/watchdog-surface')
        surface.noteWatchdogSettings(saved)
      } catch (error) {
        toastUserError(error, { action: 'save', object: 'the watchdog settings' })
      }
    },
    [client]
  )

  // An older backend never answers: the section stays away.
  if (!settings) return null

  return (
    <PanelSection
      description="While you're live, Videorc notices what viewers see and you don't, and tells you where you'll see it."
      title="Watchdog"
    >
      <FieldGroup variant="grouped">
        {WATCHDOG_CHECK_ROWS.map((row) => (
          <SettingsRow
            key={row.id}
            data-testid={`watchdog-check-${row.id}`}
            description={row.description}
            label={row.label}
          >
            <Switch
              checked={settings.checks[row.id]?.enabled ?? true}
              onCheckedChange={(enabled) => void patch({ checks: { [row.id]: { enabled } } })}
            />
          </SettingsRow>
        ))}
      </FieldGroup>
      <FieldGroup variant="grouped">
        <SettingsRow
          data-testid="watchdog-mic-muted-after"
          description="How long a muted microphone waits before the alert."
          label="Alert me after"
        >
          <SegmentedControl
            options={MIC_MUTED_AFTER_OPTIONS}
            size="sm"
            value={String(settings.micMutedAfterSeconds)}
            onValueChange={(value) => void patch({ micMutedAfterSeconds: Number(value) })}
          />
        </SettingsRow>
        <SettingsRow
          data-testid="watchdog-system-notifications"
          description="When Videorc isn't the front window, or a critical alert stays open."
          label="System notifications"
        >
          <Switch
            checked={settings.systemNotifications}
            onCheckedChange={(systemNotifications) => void patch({ systemNotifications })}
          />
        </SettingsRow>
      </FieldGroup>
      {!premium ? (
        <LockAlert
          action={{ kind: 'view-premium', url: VIDEORC_PREMIUM_URL }}
          reason={PHONE_PREMIUM_REASON}
        />
      ) : null}
      <FieldGroup variant="grouped">
        <SettingsRow
          data-testid="watchdog-phone"
          description={
            premium
              ? devices === null
                ? `Open ${LIVE_URL} on your phone and tap Get alerts on this phone.`
                : devices === 0
                  ? `No phone yet. Open ${LIVE_URL} on your phone and tap Get alerts on this phone.`
                  : `Alerts reach ${devices} ${devices === 1 ? 'device' : 'devices'}.`
              : 'A push to your phone when something is wrong, from videorc.com/live.'
          }
          label="Phone"
        >
          <Switch
            checked={settings.phonePush}
            disabled={!premium}
            onCheckedChange={(phonePush) => void patch({ phonePush })}
          />
        </SettingsRow>
        {premium ? (
          <div className="flex items-center gap-3 px-3 py-2">
            {showCode ? <PhoneCode url={LIVE_URL} /> : null}
            <div className="flex flex-col gap-1">
              <Button
                size="xs"
                type="button"
                variant="outline"
                onClick={() => setShowCode((current) => !current)}
              >
                {showCode ? 'Hide code' : 'Show QR code'}
              </Button>
              <Button size="xs" type="button" variant="ghost" onClick={() => void copy(LIVE_URL)}>
                {copied ? 'Copied' : 'Copy link'}
              </Button>
            </div>
          </div>
        ) : null}
        <SettingsRow
          data-testid="watchdog-ai-chat-read"
          description="When the phrase list isn't sure, AI reads the last messages for a sound, picture or lag report. Buddy never posts about it."
          label="AI reads chat for problems"
        >
          <Switch
            checked={settings.aiChatRead}
            disabled={!premium}
            onCheckedChange={(aiChatRead) => void patch({ aiChatRead })}
          />
        </SettingsRow>
      </FieldGroup>
    </PanelSection>
  )
}
