import { useCallback, useEffect, useState, type ReactElement } from 'react'

import { CommandPalette } from '@/components/command-palette'
import { FooterActionBar, FooterActionDivider } from '@/components/footer-action-bar'
import { OnboardingDialog } from '@/components/onboarding-dialog'
import { Sidebar } from '@/components/sidebar'
import { Button } from '@/components/ui/button'
import { Kbd, KbdGroup } from '@/components/ui/kbd'
import type { StatusDotTone } from '@/components/status-dot'
import { AiTab } from '@/components/tabs/ai-tab'
import { DiagnosticsTab } from '@/components/tabs/diagnostics-tab'
import { LayoutTab } from '@/components/tabs/layout-tab'
import { LibraryTab } from '@/components/tabs/library-tab'
import { RecordingTab } from '@/components/tabs/recording-tab'
import { ScreensTab } from '@/components/tabs/screens-tab'
import { SettingsTab } from '@/components/tabs/settings-tab'
import { SourcesTab } from '@/components/tabs/sources-tab'
import { StreamingTab } from '@/components/tabs/streaming-tab'
import { StudioTab } from '@/components/tabs/studio-tab'
import {
  WorkspaceNavContext,
  isStudioPanel,
  type StudioPanel,
  type WorkspaceTab
} from '@/components/workspace-nav'
import { useStudio } from '@/hooks/use-studio'
import { ONBOARDING_VERSION, STORAGE_KEYS } from '@/lib/capture'

export function AppShell(): ReactElement {
  const {
    connection,
    wsStatus,
    recording,
    refreshBackend,
    previewWindow,
    openPreviewWindow,
    closePreviewWindow
  } = useStudio()
  const [active, setActive] = useState<WorkspaceTab>('studio')
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null)
  const [commandOpen, setCommandOpen] = useState(false)
  const [onboardingOpen, setOnboardingOpen] = useState(
    () => localStorage.getItem(STORAGE_KEYS.onboarding) !== ONBOARDING_VERSION
  )

  // Studio control pages are ordinary tabs grouped under "Studio" in the sidebar.
  const openStudioPanel = useCallback((panel: StudioPanel) => {
    setActive(panel)
  }, [])

  const closeStudioPanel = useCallback(() => {
    setActive('studio')
  }, [])

  const completeOnboarding = useCallback((target?: WorkspaceTab) => {
    localStorage.setItem(STORAGE_KEYS.onboarding, ONBOARDING_VERSION)
    setOnboardingOpen(false)
    if (target) {
      setActive(target)
    }
  }, [])

  const resetOnboarding = useCallback(() => {
    localStorage.removeItem(STORAGE_KEYS.onboarding)
    setOnboardingOpen(true)
  }, [])

  const openInAi = useCallback((sessionId: string) => {
    setSelectedSessionId(sessionId)
    setActive('ai')
  }, [])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key.toLowerCase() === 'k' && (event.metaKey || event.ctrlKey)) {
        event.preventDefault()
        setCommandOpen((value) => !value)
      }
      if (event.key.toLowerCase() === 'p' && (event.metaKey || event.ctrlKey)) {
        event.preventDefault()
        if (previewWindow.open) {
          void closePreviewWindow()
        } else {
          void openPreviewWindow()
        }
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [closePreviewWindow, openPreviewWindow, previewWindow.open])

  const live = recording.state === 'recording' || recording.state === 'streaming'
  const statusTone: StatusDotTone = live
    ? 'error'
    : connection && wsStatus === 'connected'
      ? 'good'
      : wsStatus === 'failed'
        ? 'error'
        : 'warn'
  const statusLabel = live ? recording.state : wsStatus

  return (
    <WorkspaceNavContext.Provider
      value={{
        active,
        setActive,
        activeStudioPanel: isStudioPanel(active) ? active : null,
        openStudioPanel,
        closeStudioPanel
      }}
    >
      {/* hiddenInset hides the OS title bar; this strip is the window's drag
          handle (the traffic lights sit inside it) and the shell pads below. */}
      <div aria-hidden className="fixed inset-x-0 top-0 z-50 h-9 [-webkit-app-region:drag]" />
      {/* No bg here: body already wears the one translucent glass coat, and a
          second 75% layer would stack to near-opaque and hide the vibrancy. */}
      <div className="flex min-h-screen pt-9 text-foreground" data-videorc-active-tab={active}>
        <Sidebar
          active={active}
          activeStudioPanel={isStudioPanel(active) ? active : null}
          onSelect={setActive}
          onSelectStudioPanel={openStudioPanel}
          statusTone={statusTone}
          statusLabel={statusLabel}
          live={live}
          onRefresh={refreshBackend}
          onOpenCommand={() => setCommandOpen(true)}
        />

        <main className="flex h-[calc(100vh-2.25rem)] flex-1 flex-col">
          <div className="flex-1 overflow-y-auto">
            <div className="mx-auto w-full max-w-[1600px] px-8 py-6">
              {active === 'studio' ? <StudioTab /> : null}
              {active === 'sources' ? <SourcesTab /> : null}
              {active === 'layouts' ? (
                <div className="flex flex-col gap-4">
                  <LayoutTab />
                  <ScreensTab />
                </div>
              ) : null}
              {active === 'live' ? <StreamingTab /> : null}
              {active === 'recording' ? <RecordingTab /> : null}
              {active === 'library' ? <LibraryTab onOpenInAi={openInAi} /> : null}
              {active === 'ai' ? (
                <AiTab
                  selectedSessionId={selectedSessionId}
                  setSelectedSessionId={setSelectedSessionId}
                />
              ) : null}
              {active === 'diagnostics' ? <DiagnosticsTab /> : null}
              {active === 'settings' ? <SettingsTab onResetOnboarding={resetOnboarding} /> : null}
            </div>
          </div>
          {/* Global footer action bar: the shell's real shortcuts, always
              advertised (videorc-design keyboard-first rule). */}
          <FooterActionBar
            leading={<span className="capitalize">{active}</span>}
            className="bg-background/60"
          >
            <Button size="sm" variant="ghost" onClick={() => setCommandOpen(true)}>
              Search
              <KbdGroup>
                <Kbd>⌘</Kbd>
                <Kbd>K</Kbd>
              </KbdGroup>
            </Button>
            <FooterActionDivider />
            <Button
              size="sm"
              variant="ghost"
              onClick={() =>
                previewWindow.open ? void closePreviewWindow() : void openPreviewWindow()
              }
            >
              {previewWindow.open ? 'Close Preview' : 'Open Preview'}
              <KbdGroup>
                <Kbd>⌘</Kbd>
                <Kbd>P</Kbd>
              </KbdGroup>
            </Button>
          </FooterActionBar>
        </main>

        <CommandPalette open={commandOpen} onOpenChange={setCommandOpen} />
        <OnboardingDialog open={onboardingOpen} onComplete={completeOnboarding} />
      </div>
    </WorkspaceNavContext.Provider>
  )
}
