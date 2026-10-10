import { useEffect, type ReactElement } from 'react'

import { ConfigGrid, PageStack } from '@/components/page'
import { AboutSettings } from '@/components/settings/about-settings'
import { GeneralSettings } from '@/components/settings/general-settings'
import { PermissionsSettings } from '@/components/settings/permissions-settings'
import { RecordingSettings } from '@/components/settings/recording-settings'
import { RemoteSettings } from '@/components/settings/remote-settings'
import { ShortcutsSettings } from '@/components/settings/shortcuts-settings'
import { PageTabs } from '@/components/page-tabs'
import { TabsContent } from '@/components/ui/tabs'
import { useStudioCore } from '@/hooks/use-studio'
import { SETTINGS_TABS, type SettingsTabId } from '@/lib/settings-tabs'

/**
 * A tab with two sections: side by side at `lg`, stacked below it with a
 * hairline between them. At `lg` the pair fills the visible height and its one
 * row stretches, so the config grid's column hairline runs the full height
 * however short the tab is, and neither section needs its bottom hairline.
 * Stacked, the rows keep their content height (stretching two rows would push
 * the hairline between them down the page).
 */
const SECTION_PAIR = 'flex-1 content-start lg:content-stretch lg:[&>*]:border-b-0'

/**
 * Settings (plan 064): six tabs in a segmented strip under the toolbar, one
 * tab's sections below it (Buddy's moved to the Buddy tab, plan 119). The
 * strip never scrolls away (`PageTabs`: the page owns its scroll and only the
 * region under the strip scrolls). The selected tab lives in app-shell, so
 * links can open a named tab and Settings reopens on the one used last.
 */
export function SettingsTab({
  tab,
  onTabChange,
  onOpenPermissionsSetup,
  onShowWhatsNew
}: {
  tab: SettingsTabId
  onTabChange: (tab: SettingsTabId) => void
  onOpenPermissionsSetup: () => void
  onShowWhatsNew: () => void
}): ReactElement {
  const { refreshBackend } = useStudioCore()

  // ST3: permission grants change in System Settings while we're backgrounded —
  // re-enumerate when the window comes back so the chips stay honest.
  useEffect(() => {
    const onFocus = (): void => void refreshBackend()
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [refreshBackend])

  return (
    <PageTabs
      label="Settings sections"
      tabs={SETTINGS_TABS}
      triggerAttribute="data-videorc-settings-tab"
      value={tab}
      onValueChange={onTabChange}
    >
      <TabsContent className="flex flex-col" value="general">
        <ConfigGrid className={SECTION_PAIR}>
          <GeneralSettings />
        </ConfigGrid>
      </TabsContent>
      <TabsContent className="flex flex-col" value="recording">
        <PageStack>
          <RecordingSettings />
        </PageStack>
      </TabsContent>
      <TabsContent className="flex flex-col" value="permissions">
        <PageStack>
          <PermissionsSettings onOpenPermissionsSetup={onOpenPermissionsSetup} />
        </PageStack>
      </TabsContent>
      <TabsContent className="flex flex-col" value="shortcuts">
        <ConfigGrid className={SECTION_PAIR}>
          <ShortcutsSettings />
        </ConfigGrid>
      </TabsContent>
      <TabsContent className="flex flex-col" value="remote">
        <ConfigGrid className={SECTION_PAIR}>
          <RemoteSettings />
        </ConfigGrid>
      </TabsContent>
      <TabsContent className="flex flex-col" value="about">
        <ConfigGrid className={SECTION_PAIR}>
          <AboutSettings onShowWhatsNew={onShowWhatsNew} />
        </ConfigGrid>
      </TabsContent>
    </PageTabs>
  )
}
