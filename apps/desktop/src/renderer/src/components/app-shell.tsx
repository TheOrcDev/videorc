import { ArrowsClockwise } from '@phosphor-icons/react'
import { useCallback, useState, type ReactElement } from 'react'

import logoUrl from '@/assets/videorc-logo.png'
import { OnboardingDialog } from '@/components/onboarding-dialog'
import { StatusBadge } from '@/components/status-badge'
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
import { ThemeToggle } from '@/components/theme-toggle'
import { Button } from '@/components/ui/button'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { WORKSPACE_TABS, WorkspaceNavContext, type WorkspaceTab } from '@/components/workspace-nav'
import { useStudio } from '@/hooks/use-studio'
import { ONBOARDING_VERSION, STORAGE_KEYS } from '@/lib/capture'

export function AppShell(): ReactElement {
  const { connection, wsStatus, recording, refreshBackend } = useStudio()
  const [active, setActive] = useState<WorkspaceTab>('studio')
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null)
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

  const sessionLive = recording.state === 'recording' || recording.state === 'streaming'

  return (
    <WorkspaceNavContext.Provider value={{ active, setActive }}>
      <div className="flex min-h-screen flex-col bg-background text-foreground">
        <header className="sticky top-0 z-10 flex items-center justify-between gap-4 border-b bg-background/95 px-6 py-3 backdrop-blur">
          <div className="flex items-center gap-2.5">
            <img alt="Videorc" className="size-9 object-contain" src={logoUrl} />
            <div className="flex flex-col leading-tight">
              <span className="font-heading text-lg font-bold">Videorc</span>
              <span className="text-xs text-muted-foreground">AI recording studio</span>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <StatusBadge
              label="Backend"
              tone={connection ? 'good' : 'warn'}
              value={connection ? `${connection.host}:${connection.port}` : 'launching'}
            />
            <StatusBadge label="Socket" tone={wsStatus === 'connected' ? 'good' : 'warn'} value={wsStatus} />
            {sessionLive ? (
              <StatusBadge
                tone={recording.state === 'streaming' ? 'good' : 'error'}
                value={recording.state}
              />
            ) : null}
            <Button aria-label="Refresh backend" size="icon" title="Refresh backend" variant="ghost" onClick={refreshBackend}>
              <ArrowsClockwise />
            </Button>
            <ThemeToggle />
          </div>
        </header>

        <Tabs
          className="flex w-full flex-1 flex-col gap-4 px-6 py-5"
          value={active}
          onValueChange={(value) => setActive(value as WorkspaceTab)}
        >
          <TabsList className="w-full justify-start overflow-x-auto">
            {WORKSPACE_TABS.map((tab) => (
              <TabsTrigger key={tab.id} value={tab.id}>
                <tab.icon data-icon="inline-start" weight="duotone" />
                {tab.label}
              </TabsTrigger>
            ))}
          </TabsList>

          <TabsContent value="studio">
            <StudioTab />
          </TabsContent>
          <TabsContent value="sources">
            <SourcesTab />
          </TabsContent>
          <TabsContent value="layout">
            <LayoutTab />
          </TabsContent>
          <TabsContent value="screens">
            <ScreensTab />
          </TabsContent>
          <TabsContent value="recording">
            <RecordingTab />
          </TabsContent>
          <TabsContent value="streaming">
            <StreamingTab />
          </TabsContent>
          <TabsContent value="library">
            <LibraryTab onOpenInAi={openInAi} />
          </TabsContent>
          <TabsContent value="ai">
            <AiTab selectedSessionId={selectedSessionId} setSelectedSessionId={setSelectedSessionId} />
          </TabsContent>
          <TabsContent value="diagnostics">
            <DiagnosticsTab />
          </TabsContent>
          <TabsContent value="settings">
            <SettingsTab onResetOnboarding={resetOnboarding} />
          </TabsContent>
        </Tabs>

        <OnboardingDialog open={onboardingOpen} onComplete={completeOnboarding} />
      </div>
    </WorkspaceNavContext.Provider>
  )
}
