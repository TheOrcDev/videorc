import { findAcceleratorOwner } from '../../../../shared/accelerator'
import {
  globalShortcutEntries,
  globalShortcutLayout,
  withGlobalShortcut,
  type GlobalShortcutAction
} from '../../../../shared/global-shortcuts'
import { KeyboardIcon, SettingsIcon } from '@/components/icons'
import { useSyncExternalStore, type ReactElement } from 'react'

import { PanelSection } from '@/components/panel-section'
import { ShortcutRecorderField } from '@/components/shortcut-recorder'
import { FieldGroup, FieldLegend, FieldSet } from '@/components/ui/field'
import { Kbd, KbdGroup } from '@/components/ui/kbd'
import { useStudioCore } from '@/hooks/use-studio'
import { globalShortcutRegistration } from '@/lib/global-shortcuts'
import { BUILTIN_LAYOUTS } from '@/lib/layout-framing-memory'
import { displayKeyGlyphs, isMacPlatform } from '@/lib/platform'
import { shortcutsByGroup } from '@/lib/shortcuts'

const GLOBAL_ACTION_ROWS = [
  'record-toggle',
  'stream-toggle',
  'mic-toggle',
  'layout-next',
  'layout-previous'
] as const satisfies readonly GlobalShortcutAction[]

const GLOBAL_ACTION_LABELS: Record<(typeof GLOBAL_ACTION_ROWS)[number], string> = {
  'record-toggle': 'Start / stop recording',
  'stream-toggle': 'Go live / end stream',
  'mic-toggle': 'Mute / unmute mic',
  'layout-next': 'Next layout',
  'layout-previous': 'Previous layout'
}

function globalShortcutActionLabel(action: GlobalShortcutAction): string {
  const layout = globalShortcutLayout(action)
  if (layout) {
    return BUILTIN_LAYOUTS.find(({ id }) => id === layout)?.label ?? layout
  }
  return GLOBAL_ACTION_LABELS[action as (typeof GLOBAL_ACTION_ROWS)[number]]
}

/**
 * Settings → Shortcuts: the global shortcuts you record, beside every key that
 * works inside Videorc. The recorders are the only home of a global binding,
 * so the in-app list does not repeat them.
 */
export function ShortcutsSettings(): ReactElement {
  const { settings, setSettings, runtimeInfo } = useStudioCore()

  // Plan 062: shortcuts are recorded by pressing them, not typed.
  const shortcutRegistration = useSyncExternalStore(
    globalShortcutRegistration.subscribe,
    globalShortcutRegistration.getSnapshot
  )
  const globalShortcutValue = (action: GlobalShortcutAction): string | undefined =>
    globalShortcutEntries(settings.globalShortcuts ?? {}).find(([id]) => id === action)?.[1]
  const setGlobalShortcut = (action: GlobalShortcutAction, accelerator: string): void =>
    setSettings((current) => ({
      ...current,
      globalShortcuts: withGlobalShortcut(current.globalShortcuts, action, accelerator)
    }))
  const validateGlobalShortcut =
    (action: GlobalShortcutAction) =>
    (accelerator: string): string | null => {
      const owner = findAcceleratorOwner(
        settings.globalShortcuts ?? {},
        accelerator,
        action,
        runtimeInfo?.platform
      )
      return owner ? `Already used by ${globalShortcutActionLabel(owner)}.` : null
    }

  return (
    <>
      <PanelSection
        description="Work system-wide, even when Videorc is in the background. Click a field and press the keys. Stream Deck hotkeys and F13 to F24 work too."
        icon={SettingsIcon}
        title="Global shortcuts"
      >
        <FieldGroup variant="grouped">
          {GLOBAL_ACTION_ROWS.map((action) => (
            <ShortcutRecorderField
              key={action}
              id={`global-shortcut-${action}`}
              label={globalShortcutActionLabel(action)}
              platform={runtimeInfo?.platform}
              validate={validateGlobalShortcut(action)}
              registrationFailed={shortcutRegistration[action] === false}
              value={globalShortcutValue(action)}
              onChange={(accelerator) => setGlobalShortcut(action, accelerator)}
            />
          ))}
        </FieldGroup>
        {/* One inset group per orientation, rows shaped like the ones
            above: the headers and fields used to sit loose inside the
            group, flush against its border. */}
        {(['horizontal', 'vertical'] as const).map((orientation) => (
          <FieldSet key={orientation} className="min-w-0 gap-0">
            <FieldLegend className="mb-1.5 px-1 text-xs text-muted-foreground" variant="label">
              {orientation === 'horizontal' ? 'Horizontal layouts' : 'Vertical layouts'}
            </FieldLegend>
            <FieldGroup variant="grouped">
              {BUILTIN_LAYOUTS.filter(
                ({ id }) => id.startsWith('vertical-') === (orientation === 'vertical')
              ).map(({ id, label }) => {
                const action = `layout:${id}` as const
                return (
                  <ShortcutRecorderField
                    key={id}
                    id={`global-layout-${id}`}
                    label={label}
                    platform={runtimeInfo?.platform}
                    validate={validateGlobalShortcut(action)}
                    registrationFailed={shortcutRegistration[action] === false}
                    value={globalShortcutValue(action)}
                    onChange={(accelerator) => setGlobalShortcut(action, accelerator)}
                  />
                )
              })}
            </FieldGroup>
          </FieldSet>
        ))}
        <p className="flex flex-wrap items-center gap-1 px-1 text-xs text-muted-foreground">
          <Kbd>Esc</Kbd> cancels,{' '}
          <Kbd>{isMacPlatform(runtimeInfo?.platform) ? '⌫' : 'Backspace'}</Kbd> clears.
        </p>
      </PanelSection>

      <PanelSection
        description="Keys that work while Videorc is in front."
        icon={KeyboardIcon}
        title="App shortcuts"
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
    </>
  )
}
