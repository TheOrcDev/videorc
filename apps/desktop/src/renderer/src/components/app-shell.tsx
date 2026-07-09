import { ChatCircle } from '@phosphor-icons/react'
import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react'

import { CommandPalette } from '@/components/command-palette'
import { FooterActionBar, FooterActionDivider } from '@/components/footer-action-bar'
import { PermissionsOnboardingDialog } from '@/components/permissions-onboarding-dialog'
import { Sidebar } from '@/components/sidebar'
import { Button } from '@/components/ui/button'
import { Kbd, KbdGroup } from '@/components/ui/kbd'

import type { StatusDotTone } from '@/components/status-dot'
import { AiTab } from '@/components/tabs/ai-tab'
import { AssetsTab } from '@/components/tabs/assets-tab'
import { DiagnosticsTab } from '@/components/tabs/diagnostics-tab'
import { LayoutTab } from '@/components/tabs/layout-tab'
import { LibraryTab } from '@/components/tabs/library-tab'
import { RecordingTab } from '@/components/tabs/recording-tab'
import { SettingsTab } from '@/components/tabs/settings-tab'
import { SourcesTab } from '@/components/tabs/sources-tab'
import { StreamingTab } from '@/components/tabs/streaming-tab'
import { StudioTab } from '@/components/tabs/studio-tab'
import {
  WORKSPACE_SHORTCUTS,
  WorkspaceNavContext,
  isStudioPanel,
  isWorkspaceTab,
  workspaceTabLabel,
  type StudioPanel,
  type WorkspaceTab
} from '@/components/workspace-nav'
import { WhatsNewDialog } from '@/components/whats-new-dialog'
import { useStudio } from '@/hooks/use-studio'
import { useWhatsNew } from '@/hooks/use-whats-new'
import { ONBOARDING_DISMISSED_VALUE, STORAGE_KEYS } from '@/lib/capture'
import { displayKeyGlyph } from '@/lib/platform'
import { shouldShowPermissionsOnboarding, systemAccessRows } from '@/lib/system-access'
import { cn } from '@/lib/utils'

export function AppShell(): ReactElement {
  const {
    connection,
    wsStatus,
    deviceList,
    audioMeter,
    recording,
    runtimeInfo,
    entitlements,
    previewWindow,
    togglePreviewWindow,
    notesWindow,
    openNotesWindow,
    closeNotesWindow,
    commentsWindow,
    openCommentsWindow,
    closeCommentsWindow,
    toggleCommentsWindow
  } = useStudio()
  const [active, setActive] = useState<WorkspaceTab>('studio')
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null)
  const [commandOpen, setCommandOpen] = useState(false)
  const [onboardingOpen, setOnboardingOpen] = useState(false)
  const whatsNew = useWhatsNew(runtimeInfo?.version)
  const modKey = displayKeyGlyph('⌘', runtimeInfo?.platform)
  const shiftKey = displayKeyGlyph('⇧', runtimeInfo?.platform)

  // Permissions onboarding gate: evaluated ONCE per launch, and only after the
  // backend has connected and real device enumeration arrived — before that
  // every state reads first-use and the dialog would flash on machines that
  // already granted everything. The check is passive (last-known audio meter,
  // current device list); it must never itself open a device and trigger an
  // uninvited TCC prompt.
  const onboardingEvaluatedRef = useRef(false)
  const backendReady = wsStatus === 'connected' && deviceList.devices.length > 0
  useEffect(() => {
    if (onboardingEvaluatedRef.current || !backendReady) {
      return
    }
    onboardingEvaluatedRef.current = true
    const dismissed = localStorage.getItem(STORAGE_KEYS.onboarding) !== null
    const rows = systemAccessRows({ deviceList, audioMeter, platform: runtimeInfo?.platform })
    if (shouldShowPermissionsOnboarding({ rows, dismissed, backendReady })) {
      setOnboardingOpen(true)
    }
  }, [audioMeter, backendReady, deviceList, runtimeInfo?.platform])

  // Studio control pages are ordinary tabs grouped under "Studio" in the sidebar.
  const openStudioPanel = useCallback((panel: StudioPanel) => {
    setActive(panel)
  }, [])

  const closeStudioPanel = useCallback(() => {
    setActive('studio')
  }, [])

  const completeOnboarding = useCallback(() => {
    localStorage.setItem(STORAGE_KEYS.onboarding, ONBOARDING_DISMISSED_VALUE)
    setOnboardingOpen(false)
  }, [])

  // Settings' "Set up permissions": force-open regardless of grants or the
  // dismissal flag — no flag clearing, closing just re-dismisses.
  const openPermissionsSetup = useCallback(() => {
    setOnboardingOpen(true)
  }, [])

  const openInAi = useCallback((sessionId: string) => {
    setSelectedSessionId(sessionId)
    setActive('ai')
  }, [])

  // D6: the post-recording toast funnels here; clearing the selection lets
  // Publish preselect the newest completed session (the one just saved).
  useEffect(() => {
    const onOpenPublish = (): void => {
      setSelectedSessionId(null)
      setActive('ai')
    }
    window.addEventListener('videorc:open-publish', onOpenPublish)
    return () => window.removeEventListener('videorc:open-publish', onOpenPublish)
  }, [])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key.toLowerCase() === 'k' && (event.metaKey || event.ctrlKey)) {
        event.preventDefault()
        setCommandOpen((value) => !value)
      }
      if (event.key.toLowerCase() === 'p' && (event.metaKey || event.ctrlKey)) {
        event.preventDefault()
        void togglePreviewWindow()
      }
      if (
        runtimeInfo?.notesWindowEnabled &&
        event.key.toLowerCase() === 'n' &&
        event.shiftKey &&
        (event.metaKey || event.ctrlKey)
      ) {
        event.preventDefault()
        if (notesWindow.open) {
          void closeNotesWindow()
        } else {
          void openNotesWindow()
        }
      }
      if (
        runtimeInfo?.commentsWindowEnabled &&
        event.key.toLowerCase() === 'j' &&
        event.shiftKey &&
        (event.metaKey || event.ctrlKey)
      ) {
        event.preventDefault()
        void toggleCommentsWindow()
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [
    closeNotesWindow,
    notesWindow.open,
    openNotesWindow,
    runtimeInfo?.commentsWindowEnabled,
    runtimeInfo?.notesWindowEnabled,
    toggleCommentsWindow,
    togglePreviewWindow
  ])

  // ⌘1–⌘9 / ⌘, arrive from the main process (Chromium swallows ⌘+digit before
  // the renderer keydown — see main's before-input-event handler). Map the raw
  // key to a page here, where navigation state lives. FX6: the IPC path
  // bypasses dialog focus entirely, so navigating behind an open modal has to
  // be gated here explicitly (ref — the subscription outlives renders).
  const modalOpenRef = useRef(false)
  modalOpenRef.current = onboardingOpen || whatsNew.open
  useEffect(() => {
    const off = window.videorc?.onShortcutNavigate?.((key) => {
      if (modalOpenRef.current) {
        return
      }
      const shortcut = WORKSPACE_SHORTCUTS.find((entry) => entry.digit === key)
      if (shortcut) {
        setActive(shortcut.tab)
      }
    })
    return off
  }, [])

  useEffect(() => {
    const onWorkspaceNavigate = (event: Event): void => {
      const tab = (event as CustomEvent<{ tab?: unknown }>).detail?.tab
      if (isWorkspaceTab(tab)) {
        setActive(tab)
      }
    }
    window.addEventListener('videorc:navigate-workspace', onWorkspaceNavigate)
    return () => window.removeEventListener('videorc:navigate-workspace', onWorkspaceNavigate)
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
          accountTier={entitlements?.tier ?? null}
          onSelect={setActive}
          onSelectStudioPanel={openStudioPanel}
          statusTone={statusTone}
          statusLabel={statusLabel}
          live={live}
          onOpenCommand={() => setCommandOpen(true)}
          platform={runtimeInfo?.platform}
        />

        <main className="flex h-[calc(100vh-2.25rem)] flex-1 flex-col">
          {/* Library manages its own scroll (pinned header/toolbar, only the
              table scrolls), so it fills the bounded height instead of the
              shell scrolling the whole tab. Every other tab scrolls as one. */}
          <div
            className={cn(
              'min-h-0 flex-1',
              active === 'library' ? 'flex flex-col' : 'overflow-y-auto'
            )}
          >
            {/* pt-4 matches the sidebar header's py-4 so every tab's content
                top-aligns with the start of the sidebar. */}
            <div
              className={cn(
                'mx-auto w-full max-w-[1600px] px-10 pt-4',
                active === 'library' ? 'flex min-h-0 flex-1 flex-col pb-4' : 'pb-8'
              )}
            >
              {active === 'studio' ? <StudioTab /> : null}
              {active === 'sources' ? <SourcesTab /> : null}
              {active === 'layouts' ? <LayoutTab /> : null}
              {active === 'assets' ? <AssetsTab /> : null}
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
              {active === 'settings' ? (
                <SettingsTab
                  onOpenPermissionsSetup={openPermissionsSetup}
                  onShowWhatsNew={whatsNew.showLatest}
                />
              ) : null}
            </div>
          </div>
          {/* Global footer action bar: the shell's real shortcuts, always
              advertised (videorc-design keyboard-first rule). */}
          <FooterActionBar
            leading={<span>{workspaceTabLabel(active)}</span>}
            className="bg-background/60"
          >
            <Button size="sm" variant="ghost" onClick={() => setCommandOpen(true)}>
              Search
              <KbdGroup>
                <Kbd>{modKey}</Kbd>
                <Kbd>K</Kbd>
              </KbdGroup>
            </Button>
            <FooterActionDivider />
            <Button size="sm" variant="ghost" onClick={() => void togglePreviewWindow()}>
              {previewWindow.open ? 'Close Preview' : 'Open Preview'}
              <KbdGroup>
                <Kbd>{modKey}</Kbd>
                <Kbd>P</Kbd>
              </KbdGroup>
            </Button>
            {/* Flags default ON and runtimeInfo lands async — treating null
                as enabled keeps the footer at its final width from the first
                paint instead of growing when the fetch resolves. */}
            {runtimeInfo?.notesWindowEnabled !== false ? (
              <>
                <FooterActionDivider />
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() =>
                    notesWindow.open ? void closeNotesWindow() : void openNotesWindow()
                  }
                >
                  {notesWindow.open ? 'Close Notes' : 'Open Notes'}
                  <KbdGroup>
                    <Kbd>{modKey}</Kbd>
                    <Kbd>{shiftKey}</Kbd>
                    <Kbd>N</Kbd>
                  </KbdGroup>
                </Button>
              </>
            ) : null}
            {runtimeInfo?.commentsWindowEnabled !== false ? (
              <>
                <FooterActionDivider />
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() =>
                    commentsWindow.open ? void closeCommentsWindow() : void openCommentsWindow()
                  }
                >
                  <ChatCircle data-icon="inline-start" />
                  {commentsWindow.open ? 'Close Comments' : 'Open Comments'}
                  <KbdGroup>
                    <Kbd>{modKey}</Kbd>
                    <Kbd>{shiftKey}</Kbd>
                    <Kbd>J</Kbd>
                  </KbdGroup>
                </Button>
              </>
            ) : null}
          </FooterActionBar>
        </main>

        <CommandPalette open={commandOpen} onOpenChange={setCommandOpen} />
        <PermissionsOnboardingDialog open={onboardingOpen} onComplete={completeOnboarding} />
        {/* Post-update highlights; suppressed behind onboarding on first run
            (first run initializes the last-seen version silently). */}
        <WhatsNewDialog
          entry={whatsNew.entry}
          open={whatsNew.open && !onboardingOpen}
          onClose={whatsNew.dismiss}
        />
      </div>
    </WorkspaceNavContext.Provider>
  )
}
