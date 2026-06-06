import { useCallback, useEffect, useState, type ReactElement } from 'react'

import { CommandPalette } from '@/components/command-palette'
import { OnboardingDialog } from '@/components/onboarding-dialog'
import { Sidebar } from '@/components/sidebar'
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
import { WorkspaceNavContext, type WorkspaceTab } from '@/components/workspace-nav'
import { useStudio } from '@/hooks/use-studio'
import { ONBOARDING_VERSION, STORAGE_KEYS } from '@/lib/capture'

export function AppShell(): ReactElement {
  const { connection, wsStatus, recording, refreshBackend } = useStudio()
  const [active, setActive] = useState<WorkspaceTab>('studio')
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null)
  const [commandOpen, setCommandOpen] = useState(false)
  const [onboardingOpen, setOnboardingOpen] = useState(
    () => localStorage.getItem(STORAGE_KEYS.onboarding) !== ONBOARDING_VERSION
  )

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
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [])

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
    <WorkspaceNavContext.Provider value={{ active, setActive }}>
      <div className="flex min-h-screen bg-background text-foreground">
        <Sidebar
          active={active}
          onSelect={setActive}
          statusTone={statusTone}
          statusLabel={statusLabel}
          live={live}
          onRefresh={refreshBackend}
          onOpenCommand={() => setCommandOpen(true)}
        />

        <main className="flex h-screen flex-1 flex-col overflow-y-auto">
          <div className="mx-auto w-full max-w-[1600px] flex-1 px-8 py-6">
            {active === 'studio' ? <StudioTab /> : null}
            {active === 'sources' ? <SourcesTab /> : null}
            {active === 'layout' ? <LayoutTab /> : null}
            {active === 'screens' ? <ScreensTab /> : null}
            {active === 'recording' ? <RecordingTab /> : null}
            {active === 'streaming' ? <StreamingTab /> : null}
            {active === 'library' ? <LibraryTab onOpenInAi={openInAi} /> : null}
            {active === 'ai' ? (
              <AiTab selectedSessionId={selectedSessionId} setSelectedSessionId={setSelectedSessionId} />
            ) : null}
            {active === 'diagnostics' ? <DiagnosticsTab /> : null}
            {active === 'settings' ? <SettingsTab onResetOnboarding={resetOnboarding} /> : null}
          </div>
        </main>

        <CommandPalette open={commandOpen} onOpenChange={setCommandOpen} />
        <OnboardingDialog open={onboardingOpen} onComplete={completeOnboarding} />
      </div>
    </WorkspaceNavContext.Provider>
  )
}
