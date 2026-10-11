import { findAcceleratorOwner } from '../../../../shared/accelerator'
import { withGlobalShortcut } from '../../../../shared/global-shortcut-bindings'
import {
  globalShortcutEntries,
  globalShortcutLayout,
  type GlobalShortcutAction
} from '../../../../shared/global-shortcuts'
import { useSyncExternalStore, type ReactElement } from 'react'

import { PanelSection } from '@/components/panel-section'
import { SectionLabel } from '@/components/section-label'
import { ShortcutRecorderField } from '@/components/shortcut-recorder'
import { FieldGroup, FieldLegend, FieldSet } from '@/components/ui/field'
import { KbdGroup } from '@/components/ui/kbd'
import { ShortcutKeys } from '@/components/ui/shortcut-keys'
import { useStudioCore } from '@/hooks/use-studio'
import { globalShortcutRegistration } from '@/lib/global-shortcuts'
import { BUILTIN_LAYOUTS } from '@/lib/layout-framing-memory'
import { shortcutsByGroup } from '@/lib/shortcuts'

const GLOBAL_ACTION_ROWS = [
  'record-toggle',
  'stream-toggle',
  'mic-toggle',
  'system-audio-toggle',
  'clip-mark',
  'layout-next',
  'layout-previous'
] as const satisfies readonly GlobalShortcutAction[]

const GLOBAL_ACTION_LABELS: Record<(typeof GLOBAL_ACTION_ROWS)[number], string> = {
  'record-toggle': 'Start / stop recording',
  'stream-toggle': 'Go live / end stream',
  'mic-toggle': 'Mute / unmute mic',
  'system-audio-toggle': 'Turn system audio on/off',
  'clip-mark': 'Mark a clip',
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
            <FieldLegend className="mb-1.5 px-1" variant="label">
              <SectionLabel>
                {orientation === 'horizontal' ? 'Horizontal layouts' : 'Vertical layouts'}
              </SectionLabel>
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
          <ShortcutKeys accelerator="Escape" platform={runtimeInfo?.platform} /> cancels,{' '}
          <ShortcutKeys accelerator="Backspace" platform={runtimeInfo?.platform} /> clears.
        </p>
      </PanelSection>

      <PanelSection description="Keys that work while Videorc is in front." title="App shortcuts">
        <div className="flex flex-col gap-3">
          {[...shortcutsByGroup().entries()].map(([group, entries]) => (
            <div key={group} className="flex flex-col gap-1">
              <SectionLabel>{group}</SectionLabel>
              {entries.map((entry) => (
                <div
                  key={entry.id}
                  className="flex items-center gap-3 rounded-row px-2.5 py-1.5 text-sm"
                >
                  <span className="flex-1 truncate text-muted-foreground">{entry.label}</span>
                  <KbdGroup>
                    {entry.accelerators.map((accelerator) => (
                      <ShortcutKeys
                        key={accelerator}
                        accelerator={accelerator}
                        platform={runtimeInfo?.platform}
                      />
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
