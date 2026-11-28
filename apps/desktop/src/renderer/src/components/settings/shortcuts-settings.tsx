import { guestsVisible } from '@/lib/livestream-tabs'
import { withGlobalShortcut } from '../../../../shared/global-shortcut-bindings'
import {
  globalShortcutEntries,
  type GlobalShortcutAction
} from '../../../../shared/global-shortcuts'
import { useSyncExternalStore, type ReactElement } from 'react'

import { GroupedList, ListRow } from '@/components/list-row'
import { PanelSection } from '@/components/panel-section'
import { SectionLabel } from '@/components/section-label'
import { ShortcutRecorderField } from '@/components/shortcut-recorder'
import { Alert, AlertTitle } from '@/components/ui/alert'
import { FieldGroup, FieldLegend, FieldSet } from '@/components/ui/field'
import { KbdGroup } from '@/components/ui/kbd'
import { ShortcutKeys } from '@/components/ui/shortcut-keys'
import { useStudioCloud, useStudioCore } from '@/hooks/use-studio'
import { globalShortcutLabel, globalShortcutRegistration } from '@/lib/global-shortcuts'
import { globalShortcutTakenReason } from '@/lib/global-shortcut-owner'
import { sceneShortcutRows } from '@/lib/scene-shortcuts'
import type { ShortcutRecorderAppKey } from '@/lib/shortcut-recorder'
import { shortcutAccelerator, shortcutsByGroup } from '@/lib/shortcuts'
import { systemAudioDevice } from '@/lib/system-audio'

const GLOBAL_ACTION_ROWS = [
  'screen-hide-toggle',
  'record-toggle',
  'stream-toggle',
  'mic-toggle',
  'system-audio-toggle',
  'clip-mark',
  // Plan 199: the 1-minute clip, unbound by default like the 30-second one.
  'clip-mark-long',
  'layout-next',
  'layout-previous'
] as const satisfies readonly GlobalShortcutAction[]

/**
 * Keys that already do a row's action inside Videorc. Space records on the
 * Studio page (plan 174 D1), so the Record row shows it until a global key is
 * recorded; Space keeps working there either way.
 */
export const GLOBAL_ROW_APP_KEYS: Partial<Record<GlobalShortcutAction, ShortcutRecorderAppKey>> = {
  'record-toggle': { accelerator: shortcutAccelerator('record-toggle'), where: 'in Studio' }
}

/**
 * The global shortcut rows this computer can act on. System audio has no
 * producer on Linux, so its shortcut only ever toasted "isn't available"
 * (Linux plan 0019); a binding saved elsewhere stays visible so it can be
 * cleared.
 */
export function globalShortcutRows(input: {
  systemAudioAvailable: boolean
  systemAudioBound: boolean
}): readonly GlobalShortcutAction[] {
  return GLOBAL_ACTION_ROWS.filter(
    (action) =>
      action !== 'system-audio-toggle' || input.systemAudioAvailable || input.systemAudioBound
  )
}

/**
 * Settings → Shortcuts: the global shortcuts you record, beside every key that
 * works inside Videorc. The recorders are the only home of a global binding,
 * so the in-app list does not repeat them.
 */
export function ShortcutsSettings(): ReactElement {
  const guestsShown = guestsVisible(useStudioCloud().cloudStatus)
  const { settings, setSettings, runtimeInfo, deviceList, savedScenes } = useStudioCore()
  // Linux on Wayland: main registers nothing and says why.
  const unavailable = runtimeInfo?.globalShortcutsUnavailable
  const systemAudio = systemAudioDevice(deviceList)
  const actionRows = globalShortcutRows({
    systemAudioAvailable: Boolean(systemAudio && systemAudio.status !== 'unavailable'),
    systemAudioBound: Boolean(settings.globalShortcuts?.systemAudioToggle)
  })

  // Plan 062: shortcuts are recorded by pressing them, not typed.
  const shortcutRegistration = useSyncExternalStore(
    globalShortcutRegistration.subscribe,
    globalShortcutRegistration.getSnapshot
  )
  const globalShortcutValue = (action: GlobalShortcutAction): string | undefined =>
    globalShortcutEntries(settings.globalShortcuts ?? {}, runtimeInfo?.platform).find(
      ([id]) => id === action
    )?.[1]
  const setGlobalShortcut = (action: GlobalShortcutAction, accelerator: string): void =>
    setSettings((current) => ({
      ...current,
      globalShortcuts: withGlobalShortcut(current.globalShortcuts, action, accelerator)
    }))
  const validateGlobalShortcut =
    (action: GlobalShortcutAction) =>
    (accelerator: string): string | null =>
      globalShortcutTakenReason({
        config: settings.globalShortcuts ?? {},
        accelerator,
        action,
        platform: runtimeInfo?.platform,
        scenes: savedScenes
      })

  return (
    <>
      <PanelSection
        description={
          unavailable
            ? 'Kept for sessions that allow them, such as X11. Click a field and press the keys.'
            : 'Work system-wide, even when Videorc is in the background. Click a field and press the keys. Stream Deck hotkeys and F13 to F24 work too.'
        }
        title="Global shortcuts"
      >
        {unavailable ? (
          <Alert data-testid="global-shortcuts-unavailable" variant="warning">
            <AlertTitle>{unavailable}</AlertTitle>
          </Alert>
        ) : null}
        <FieldGroup variant="grouped">
          {actionRows.map((action) => (
            <ShortcutRecorderField
              key={action}
              id={`global-shortcut-${action}`}
              label={globalShortcutLabel(action)}
              platform={runtimeInfo?.platform}
              validate={validateGlobalShortcut(action)}
              registrationFailed={shortcutRegistration[action] === false}
              value={globalShortcutValue(action)}
              appKey={GLOBAL_ROW_APP_KEYS[action]}
              onChange={(accelerator) => setGlobalShortcut(action, accelerator)}
            />
          ))}
        </FieldGroup>
        <FieldSet className="min-w-0 gap-0">
          <FieldLegend className="mb-1.5 px-1" variant="label">
            <SectionLabel>Scenes</SectionLabel>
          </FieldLegend>
          <FieldGroup variant="grouped">
            {sceneShortcutRows(
              savedScenes,
              settings.globalShortcuts ?? {},
              runtimeInfo?.platform
            ).map(({ action, label, accelerator }) => (
              <ShortcutRecorderField
                key={action}
                id={`global-shortcut-${action}`}
                label={label}
                platform={runtimeInfo?.platform}
                validate={validateGlobalShortcut(action)}
                registrationFailed={shortcutRegistration[action] === false}
                value={accelerator}
                onChange={(accelerator) => setGlobalShortcut(action, accelerator)}
              />
            ))}
          </FieldGroup>
        </FieldSet>
        <p className="flex flex-wrap items-center gap-1 px-1 text-xs text-muted-foreground">
          <ShortcutKeys accelerator="Escape" platform={runtimeInfo?.platform} /> cancels,{' '}
          <ShortcutKeys accelerator="Backspace" platform={runtimeInfo?.platform} /> clears.
        </p>
      </PanelSection>

      <PanelSection description="Keys that work while Videorc is in front." title="App shortcuts">
        {/* One grouped list per group, labelled like the Scenes group above
            (plan 174 S3.17, I-33): the rows used to be loose text. */}
        {[...shortcutsByGroup(guestsShown).entries()].map(([group, entries]) => (
          <GroupedList key={group} label={group}>
            {entries.map((entry) => (
              <ListRow key={entry.id} compact title={entry.label}>
                <KbdGroup>
                  {entry.accelerators.map((accelerator) => (
                    <ShortcutKeys
                      key={accelerator}
                      accelerator={accelerator}
                      platform={runtimeInfo?.platform}
                    />
                  ))}
                </KbdGroup>
              </ListRow>
            ))}
          </GroupedList>
        ))}
      </PanelSection>
    </>
  )
}
