import { useEffect, type ReactElement } from 'react'

import { CohostSettingsSection } from '@/components/cohost-settings-section'
import { ConfigGrid, PageStack } from '@/components/page'
import { AboutSettings } from '@/components/settings/about-settings'
import { GeneralSettings } from '@/components/settings/general-settings'
import { PermissionsSettings } from '@/components/settings/permissions-settings'
import { RecordingSettings } from '@/components/settings/recording-settings'
import { RemoteSettings } from '@/components/settings/remote-settings'
import { ShortcutsSettings } from '@/components/settings/shortcuts-settings'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { useStudioCore } from '@/hooks/use-studio'
import { SETTINGS_TABS, isSettingsTabId, type SettingsTabId } from '@/lib/settings-tabs'

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
 * Settings (plan 064): seven tabs in a segmented strip under the toolbar, one
 * tab's sections below it. The strip never scrolls away: Settings owns its
 * scroll (app-shell turns the pane body's off), and only the region under the
 * strip scrolls. The selected tab lives in app-shell, so links can open a
 * named tab and Settings reopens on the one used last.
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
    <Tabs
      className="min-h-0 flex-1 gap-0"
      value={tab}
      onValueChange={(value) => {
        if (isSettingsTabId(value)) {
          onTabChange(value)
        }
      }}
    >
      {/* Built like the Livestream page's Setup / Upcoming strip; the toolbar
          carries only the title (owner call, 2026-09-23). */}
      <div className="shrink-0 border-b border-border px-gutter py-2">
        <TabsList aria-label="Settings sections">
          {SETTINGS_TABS.map(({ id, label }) => (
            <TabsTrigger key={id} data-videorc-settings-tab={id} value={id}>
              {label}
            </TabsTrigger>
          ))}
        </TabsList>
      </div>
      {/* Keyed by tab, so every tab change (a click, the arrow keys, or a link
          that opens a named tab) starts the new tab at the top. A flex column,
          so a tab panel can fill the visible height (see SECTION_PAIR). */}
      <div
        key={tab}
        className="flex min-h-0 flex-1 flex-col overflow-y-auto overscroll-contain"
        data-slot="settings-scroll"
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
        <TabsContent className="flex flex-col" value="orcle">
          <PageStack>
            <CohostSettingsSection />
          </PageStack>
        </TabsContent>
        <TabsContent className="flex flex-col" value="about">
          <ConfigGrid className={SECTION_PAIR}>
            <AboutSettings onShowWhatsNew={onShowWhatsNew} />
          </ConfigGrid>
        </TabsContent>
      </div>
    </Tabs>
  )
}
