import { SaveIcon } from '@/components/icons'
import type { ReactElement } from 'react'

import { sessionOwnsTransport } from '../../../../shared/capture-state'
import { StatusDot } from '@/components/status-dot'
import { Button } from '@/components/ui/button'
import { DisabledReason } from '@/components/ui/disabled-reason'
import { Field, FieldLabel } from '@/components/ui/field'
import { ShortcutKeys } from '@/components/ui/shortcut-keys'
import { Switch } from '@/components/ui/switch'
import { useStudioCore, useStudioRecordingState, useStudioReplay } from '@/hooks/use-studio'
import { REPLAY_BUFFER_LABEL, SAVE_REPLAY_LABEL, replayStatusLine } from '@/lib/replay-buffer'
import { openSettingsTab } from '@/lib/settings-tabs'
import { connectionBlockedReason } from '@/lib/state-labels'

/**
 * The replay buffer's one home in the Studio (plan 181 S5.1): the switch,
 * what the ring holds, and Save replay with its key. It sits right under
 * Record and Go Live…, because it is the third thing a session can do with
 * the program. The Output page keeps the settings (length, launch, the
 * shortcut recorder, where replays go) and never a second switch.
 *
 * The switch is the intent; the dot and its words are the backend's truth:
 * "0:12 / 0:30" while the ring fills and holds, "Starting…" while a session
 * starts, "Starts after this session" when armed mid-recording, "Off".
 */
export function ReplayBufferRow(): ReactElement {
  const { settings, runtimeInfo, recordBlockedReason, wsStatus } = useStudioCore()
  const { recording } = useStudioRecordingState()
  const replayBuffer = useStudioReplay()
  const ring = replayBuffer.state
  const transportActive = sessionOwnsTransport(recording)
  const line = replayStatusLine(ring, replayBuffer.armed, transportActive)
  const shortcut = settings.globalShortcuts?.replaySave
  // Turning the ring on composes a session at the Output quality, so what
  // blocks Record blocks arming too; turning it off is always allowed.
  const switchBlockedReason =
    connectionBlockedReason(wsStatus) ??
    (!replayBuffer.armed && !transportActive ? recordBlockedReason : null)
  const showSave = ring.state === 'on'
  // D5: the key ships unbound; a game's keys are never stolen. Until it is
  // set, the row says where to set it.
  const showSetShortcut = replayBuffer.armed && !shortcut
  // The switch, the label and the ring's words always share one line. The
  // actions sit at its end while the inspector is wide enough and wrap under
  // it, right-aligned, when it is not, so the words never paint over Save
  // replay.
  return (
    <section
      aria-label={REPLAY_BUFFER_LABEL}
      className="flex min-h-10 flex-wrap items-center gap-x-3 gap-y-1 border-b border-border px-gutter py-1.5"
      data-slot="replay-buffer"
    >
      <Field className="min-w-[14rem] flex-1 items-center gap-2" orientation="horizontal">
        <DisabledReason reason={switchBlockedReason}>
          <Switch
            checked={replayBuffer.armed}
            data-testid="replay-buffer-switch"
            disabled={Boolean(switchBlockedReason)}
            onCheckedChange={replayBuffer.setArmed}
          />
        </DisabledReason>
        <FieldLabel className="min-w-0 truncate">{REPLAY_BUFFER_LABEL}</FieldLabel>
        <StatusDot className="shrink-0" label={line.label} tone={line.tone} />
      </Field>
      {showSave || showSetShortcut ? (
        <div className="ml-auto flex shrink-0 items-center gap-1">
          {showSave ? (
            <Button
              data-testid="replay-save-button"
              variant="outline"
              onClick={() => void replayBuffer.save()}
            >
              <SaveIcon data-icon="inline-start" />
              {SAVE_REPLAY_LABEL}
              {shortcut ? (
                <ShortcutKeys
                  accelerator={shortcut}
                  className="ml-0.5"
                  platform={runtimeInfo?.platform}
                />
              ) : null}
            </Button>
          ) : null}
          {showSetShortcut ? (
            <Button
              data-testid="replay-set-shortcut"
              variant="ghost"
              onClick={() => openSettingsTab('shortcuts')}
            >
              Set shortcut
            </Button>
          ) : null}
        </div>
      ) : null}
    </section>
  )
}
