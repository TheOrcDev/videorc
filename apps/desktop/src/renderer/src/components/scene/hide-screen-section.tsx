import { LockIcon } from '@/components/icons'
import { useState, type ReactElement } from 'react'

import { KebabMenu } from '@/components/kebab-menu'
import { GroupedList, ListRow } from '@/components/list-row'
import { NavigableRow } from '@/components/navigable-row'
import { PanelSection } from '@/components/panel-section'
import { AppIconImage } from '@/components/scene/app-icon'
import { Button } from '@/components/ui/button'
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList
} from '@/components/ui/command'
import { FieldGroup, SettingsRow } from '@/components/ui/field'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { ShortcutKeys } from '@/components/ui/shortcut-keys'
import { Switch } from '@/components/ui/switch'
import { useAppChoices } from '@/hooks/use-app-choices'
import { useAppIcons } from '@/hooks/use-app-icons'
import { useStudioCore } from '@/hooks/use-studio'
import { isMacPlatform } from '@/lib/platform'
import {
  addPasswordManager,
  builtInPasswordManagersRemoved,
  canRemovePasswordManager,
  passwordManagerEntries,
  removePasswordManager,
  restoreBuiltInPasswordManagers,
  setHideForPasswordManagers,
  updatePrivacySettings,
  usePrivacySettings,
  type PasswordManagerEntry
} from '@/lib/privacy-settings'
import { screenHideAccelerator } from '@/lib/screen-privacy-view'
import { openWorkspaceTab } from '@/lib/workspace-navigation'

const LAST_APP_REASON =
  'One app stays on the list. To stop hiding for password managers, turn the switch off.'

/**
 * The Scene page's Hide screen section (plan 210 D9, D11): what viewers see,
 * the key and where to change it, then, on macOS, the password-manager hide
 * and its list (D12: absent elsewhere, not disabled). The action itself lives
 * on the Studio's Screen row; this is where it is set up.
 */
export function HideScreenSection(): ReactElement {
  const { settings, runtimeInfo } = useStudioCore()
  const platform = runtimeInfo?.platform
  const accelerator = screenHideAccelerator(settings.globalShortcuts?.screenHideToggle)
  const mac = isMacPlatform(platform)
  return (
    <PanelSection
      data-videorc-hide-screen=""
      description="Your screen turns into a frosted picture on the recording and every stream, so nothing on it can be read. Your camera and voice stay on."
      title="Hide screen"
    >
      <FieldGroup variant="grouped">
        <NavigableRow
          className="rounded-none"
          hint="Change it in Settings → Shortcuts. It works from any app."
          label="Shortcut"
          value={
            accelerator ? <ShortcutKeys accelerator={accelerator} platform={platform} /> : 'Not set'
          }
          onNavigate={() => openWorkspaceTab('settings', 'shortcuts')}
        />
        {mac ? <PasswordManagerSwitch /> : null}
      </FieldGroup>
      {mac ? <PasswordManagerList /> : null}
    </PanelSection>
  )
}

function PasswordManagerSwitch(): ReactElement {
  const privacy = usePrivacySettings()
  return (
    <SettingsRow
      description="Only while a whole screen is on stream. Your screen comes back when the app leaves the front, unless you hid it yourself."
      label="Hide when a password manager is in front"
    >
      <Switch
        checked={privacy.hideForPasswordManagers}
        data-videorc-password-manager-hide=""
        onCheckedChange={(checked) =>
          updatePrivacySettings((current) => setHideForPasswordManagers(current, checked))
        }
      />
    </SettingsRow>
  )
}

/**
 * The password managers (D11): the built-in ones by name, then the apps the
 * streamer added. Each row's ⋯ takes it off; Add app… offers the open apps.
 */
function PasswordManagerList(): ReactElement {
  const privacy = usePrivacySettings()
  const entries = passwordManagerEntries(privacy)
  const icons = useAppIcons(entries.flatMap((entry) => entry.bundleIds))
  const removable = canRemovePasswordManager(privacy)
  return (
    <div className="flex flex-col gap-2" data-videorc-password-managers="">
      <GroupedList label="Password managers">
        {entries.map((entry) => (
          <ListRow
            key={entry.id}
            className="group/kebab-host"
            data-password-manager={entry.id}
            icon={<PasswordManagerIcon entry={entry} icons={icons} />}
            title={entry.name}
          >
            <KebabMenu
              items={[
                {
                  id: 'remove',
                  label: 'Remove',
                  disabled: !removable,
                  disabledReason: removable ? null : LAST_APP_REASON,
                  onSelect: () =>
                    updatePrivacySettings((current) => removePasswordManager(current, entry.id))
                }
              ]}
              label={`Actions for ${entry.name}`}
              reveal="hover"
            />
          </ListRow>
        ))}
      </GroupedList>
      <div className="flex flex-wrap items-center gap-2">
        <AddPasswordManagerButton entries={entries} />
        {builtInPasswordManagersRemoved(privacy) ? (
          <Button
            variant="ghost"
            onClick={() => updatePrivacySettings(restoreBuiltInPasswordManagers)}
          >
            Restore built-in apps
          </Button>
        ) : null}
      </div>
    </div>
  )
}

/** The app's own icon when it is installed, else the lock. */
function PasswordManagerIcon({
  entry,
  icons
}: {
  entry: PasswordManagerEntry
  icons: ReadonlyMap<string, string | null>
}): ReactElement {
  const icon = entry.bundleIds.map((id) => icons.get(id)).find(Boolean)
  return icon ? (
    <AppIconImage icon={icon} />
  ) : (
    <LockIcon aria-hidden className="text-muted-foreground" weight="duotone" />
  )
}

/**
 * Add app…: the open apps (New scene…'s list, S5), minus those already on
 * the list, searchable. Choosing one stores its bundle id and name.
 */
function AddPasswordManagerButton({
  entries
}: {
  entries: readonly PasswordManagerEntry[]
}): ReactElement {
  const [open, setOpen] = useState(false)
  const { apps, loading, grantMissing } = useAppChoices(open)
  const listed = new Set(entries.flatMap((entry) => entry.bundleIds.map((id) => id.toLowerCase())))
  const offered = apps.filter((app) => !listed.has(app.bundleId.toLowerCase()))
  const icons = useAppIcons(open ? offered.map((app) => app.bundleId) : [])
  const status = loading
    ? 'Finding your open apps…'
    : grantMissing
      ? 'Videorc needs Screen Recording to list your open apps.'
      : offered.length === 0
        ? 'Every open app is on the list. Open the app first, then add it.'
        : null
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button data-testid="password-manager-add" variant="outline">
          Add app…
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="w-72 gap-0 p-0"
        data-testid="password-manager-picker"
      >
        <Command>
          <CommandInput aria-label="Search open apps" autoFocus placeholder="Search open apps…" />
          <CommandList label="Open apps">
            {offered.length > 0 ? <CommandEmpty>No open app matches.</CommandEmpty> : null}
            {offered.length > 0 ? (
              <CommandGroup className="p-1">
                {offered.map((app) => (
                  <CommandItem
                    key={app.bundleId}
                    keywords={[app.bundleId]}
                    value={app.name}
                    onSelect={() => {
                      updatePrivacySettings((current) =>
                        addPasswordManager(current, { bundleId: app.bundleId, name: app.name })
                      )
                      setOpen(false)
                    }}
                  >
                    <AppIconImage icon={icons.get(app.bundleId)} />
                    <span className="min-w-0 flex-1 truncate">{app.name}</span>
                  </CommandItem>
                ))}
              </CommandGroup>
            ) : null}
          </CommandList>
          {status ? (
            <p className="px-3 py-2 text-sm text-muted-foreground" role="status">
              {status}
            </p>
          ) : null}
        </Command>
      </PopoverContent>
    </Popover>
  )
}
