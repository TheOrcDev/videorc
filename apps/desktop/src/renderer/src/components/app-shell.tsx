import { lazy, Suspense, useCallback, useEffect, useRef, useState, type ReactElement } from 'react'

const CommandPalette = lazy(async () => ({
  default: (await import('@/components/command-palette')).CommandPalette
}))
import { Pane, PaneBody, Toolbar } from '@/components/pane'
import { Sidebar } from '@/components/sidebar'
import { StatusBar, StatusBarHint } from '@/components/status-bar'
import { StatusDot, type StatusDotTone } from '@/components/status-dot'
import {
  WORKSPACE_SHORTCUTS,
  WorkspaceNavContext,
  isStudioPanel,
  isWorkspaceTab,
  workspaceTabLabel,
  type StudioPanel,
  type WorkspaceTab
} from '@/components/workspace-nav'
import {
  useStudioAudio,
  useStudioCore,
  useStudioRecordingState,
  useStudioShell
} from '@/hooks/use-studio'
import { StudioMicVisualProvider } from '@/hooks/use-studio-mic-visual'
import { useWhatsNew } from '@/hooks/use-whats-new'
import { ONBOARDING_DISMISSED_VALUE, STORAGE_KEYS } from '@/lib/capture'
import {
  OPEN_CLEAN_CUT_EVENT,
  readCleanCutOpenRequest,
  type CleanCutOpenRequest,
  type CleanCutTabRequest
} from '@/lib/clean-cut-events'
import { displayKeyGlyph } from '@/lib/platform'
import { openBuddyPetCreator } from '@/lib/buddy-pet-creator-nav'
import {
  isBuddyTabId,
  readLastBuddyTab,
  writeLastBuddyTab,
  type BuddyTabId
} from '@/lib/buddy-tabs'
import {
  isSettingsTabId,
  readLastSettingsTab,
  writeLastSettingsTab,
  type SettingsTabId
} from '@/lib/settings-tabs'
import { isActiveRecordingState } from '@/lib/format'
import { sessionIsLive } from '../../../shared/capture-state'
import {
  isMediaAccessSnapshotReady,
  shouldShowPermissionsOnboarding,
  systemAccessRows
} from '@/lib/system-access'

// Workspace views are loaded only on first navigation, then retained by the
// browser module cache. Studio remains the launch surface, but its dashboard and
// heavier dependencies stay out of the shell's eager entry chunk.
const StudioTab = lazy(async () => ({
  default: (await import('@/components/tabs/studio-tab')).StudioTab
}))
const AssetsTab = lazy(async () => ({
  default: (await import('@/components/tabs/assets-tab')).AssetsTab
}))
const CaptionsTab = lazy(async () => ({
  default: (await import('@/components/tabs/captions-tab')).CaptionsTab
}))
const DiagnosticsTab = lazy(async () => ({
  default: (await import('@/components/tabs/diagnostics-tab')).DiagnosticsTab
}))
const loadLayoutTab = () => import('@/components/tabs/layout-tab')
const LayoutTab = lazy(async () => ({ default: (await loadLayoutTab()).LayoutTab }))
const LibraryTab = lazy(async () => ({
  default: (await import('@/components/tabs/library-tab')).LibraryTab
}))
const BuddyTab = lazy(async () => ({
  default: (await import('@/components/tabs/buddy-tab')).BuddyTab
}))
const RecordingTab = lazy(async () => ({
  default: (await import('@/components/tabs/recording-tab')).RecordingTab
}))
const loadSettingsTab = () => import('@/components/tabs/settings-tab')
const SettingsTab = lazy(async () => ({ default: (await loadSettingsTab()).SettingsTab }))
const loadSourcesTab = () => import('@/components/tabs/sources-tab')
const SourcesTab = lazy(async () => ({ default: (await loadSourcesTab()).SourcesTab }))
const StreamingTab = lazy(async () => ({
  default: (await import('@/components/tabs/streaming-tab')).StreamingTab
}))
const PermissionsOnboardingDialog = lazy(async () => ({
  default: (await import('@/components/permissions-onboarding-dialog')).PermissionsOnboardingDialog
}))
const WhatsNewDialog = lazy(async () => ({
  default: (await import('@/components/whats-new-dialog')).WhatsNewDialog
}))

function WorkspaceTabFallback(): ReactElement {
  return (
    <div
      aria-live="polite"
      className="flex min-h-40 items-center justify-center text-xs text-muted-foreground"
      role="status"
    >
      Loading workspace…
    </div>
  )
}

function PermissionsOnboardingGate({
  open,
  onOpen,
  onComplete
}: {
  open: boolean
  onOpen: () => void
  onComplete: () => void
}): ReactElement {
  const { wsStatus, deviceList, mediaAccess, runtimeInfo } = useStudioCore()
  const { audioMeter } = useStudioAudio()
  const evaluatedRef = useRef(false)
  const dialogMountedRef = useRef(open)
  const backendReady = wsStatus === 'connected' && deviceList.devices.length > 0
  const mediaAccessReady = runtimeInfo !== null && isMediaAccessSnapshotReady(mediaAccess)

  if (open) {
    dialogMountedRef.current = true
  }

  useEffect(() => {
    if (evaluatedRef.current || !backendReady || !mediaAccessReady) {
      return
    }
    evaluatedRef.current = true
    const dismissed = localStorage.getItem(STORAGE_KEYS.onboarding) !== null
    const rows = systemAccessRows({
      deviceList,
      audioMeter,
      platform: runtimeInfo?.platform,
      mediaAccess
    })
    if (shouldShowPermissionsOnboarding({ rows, dismissed, backendReady, mediaAccessReady })) {
      onOpen()
    }
  }, [
    audioMeter,
    backendReady,
    deviceList,
    mediaAccess,
    mediaAccessReady,
    onOpen,
    runtimeInfo?.platform
  ])

  return (
    <Suspense fallback={null}>
      {dialogMountedRef.current ? (
        <PermissionsOnboardingDialog open={open} onComplete={onComplete} />
      ) : null}
    </Suspense>
  )
}

export function AppShell(): ReactElement {
  const {
    wsStatus,
    backendConnected,
    recordingState,
    runtimeInfo,
    entitlementTier,
    previewWindowOpen,
    togglePreviewWindow,
    notesWindowOpen,
    openNotesWindow,
    closeNotesWindow,
    commentsWindowOpen,
    openCommentsWindow,
    closeCommentsWindow,
    toggleCommentsWindow,
    toggleCaptionsWindow
  } = useStudioShell()
  const { recording } = useStudioRecordingState()
  const [active, setActiveTab] = useState<WorkspaceTab>('studio')
  // Library's "Buddy report" opens the Buddy tab on one session's report (plan
  // 119 S3). Any other way to a page drops that ask, so the next visit to
  // Buddy shows the last stream again.
  const [buddyReportSessionId, setBuddyReportSessionId] = useState<string | null>(null)
  // Clean cut (plan 119 S14): Library's "Clean cut" selects a recording in
  // the Buddy tab, and the ready toast opens a cut's review there. The card's
  // "Open in Library" focuses the cut copy's row. Like the report ask, any
  // other way to a page drops them.
  const [cleanCutRequest, setCleanCutRequest] = useState<CleanCutTabRequest | null>(null)
  const [libraryFocusSessionId, setLibraryFocusSessionId] = useState<string | null>(null)
  const cleanCutNonceRef = useRef(0)
  // Plan 150: Buddy reopens on its tab used last, like Settings; the
  // Library's report and clean-cut asks select the tab that answers them.
  const [buddyTab, setBuddyTab] = useState<BuddyTabId>(readLastBuddyTab)
  const selectBuddyTab = useCallback((tab: BuddyTabId) => {
    setBuddyTab(tab)
    writeLastBuddyTab(tab)
  }, [])
  const setActive = useCallback((tab: WorkspaceTab) => {
    setBuddyReportSessionId(null)
    setCleanCutRequest(null)
    setLibraryFocusSessionId(null)
    setActiveTab(tab)
  }, [])
  const openBuddyReport = useCallback(
    (sessionId: string) => {
      setCleanCutRequest(null)
      setBuddyReportSessionId(sessionId)
      selectBuddyTab('reports')
      setActiveTab('ai')
    },
    [selectBuddyTab]
  )
  const openCleanCut = useCallback(
    (request: CleanCutOpenRequest) => {
      cleanCutNonceRef.current += 1
      setBuddyReportSessionId(null)
      setCleanCutRequest({ ...request, nonce: cleanCutNonceRef.current })
      selectBuddyTab('clean-cut')
      setActiveTab('ai')
    },
    [selectBuddyTab]
  )
  const openBuddy = useCallback(
    (tab?: BuddyTabId) => {
      if (tab) {
        selectBuddyTab(tab)
      }
      setActive('ai')
    },
    [selectBuddyTab, setActive]
  )
  const openLibrarySession = useCallback((sessionId: string) => {
    setBuddyReportSessionId(null)
    setCleanCutRequest(null)
    setLibraryFocusSessionId(sessionId)
    setActiveTab('library')
  }, [])
  const [commandOpen, setCommandOpen] = useState(false)
  const [onboardingOpen, setOnboardingOpen] = useState(false)
  const whatsNew = useWhatsNew(runtimeInfo?.version, runtimeInfo?.platform)
  const modKey = displayKeyGlyph('⌘', runtimeInfo?.platform)
  const shiftKey = displayKeyGlyph('⇧', runtimeInfo?.platform)

  // Keep first paint Studio-only, then warm the three most common setup pages
  // from local app assets once Chromium is idle. Navigation stays instant
  // without putting these modules into the eager entry chunk.
  useEffect(() => {
    const prefetch = (): void => {
      void Promise.allSettled([loadSourcesTab(), loadLayoutTab(), loadSettingsTab()])
    }
    if (typeof window.requestIdleCallback === 'function') {
      const requestId = window.requestIdleCallback(prefetch, { timeout: 5000 })
      return () => window.cancelIdleCallback(requestId)
    }
    const timer = window.setTimeout(prefetch, 2000)
    return () => window.clearTimeout(timer)
  }, [])

  // Studio control pages are ordinary tabs grouped under "Studio" in the sidebar.
  const openStudioPanel = useCallback(
    (panel: StudioPanel) => {
      setActive(panel)
    },
    [setActive]
  )

  const closeStudioPanel = useCallback(() => {
    setActive('studio')
  }, [setActive])

  // Plan 064: Settings reopens on the tab used last; a link that names a tab
  // (update chip, FFmpeg banner, ⌘K, toasts) selects it before opening.
  const [settingsTab, setSettingsTab] = useState<SettingsTabId>(readLastSettingsTab)
  const selectSettingsTab = useCallback((tab: SettingsTabId) => {
    setSettingsTab(tab)
    writeLastSettingsTab(tab)
  }, [])
  const openSettings = useCallback(
    (tab?: SettingsTabId) => {
      if (tab) {
        selectSettingsTab(tab)
      }
      setActive('settings')
    },
    [selectSettingsTab, setActive]
  )

  const completeOnboarding = useCallback(() => {
    localStorage.setItem(STORAGE_KEYS.onboarding, ONBOARDING_DISMISSED_VALUE)
    setOnboardingOpen(false)
  }, [])

  // Settings' "Set up permissions": force-open regardless of grants or the
  // dismissal flag — no flag clearing, closing just re-dismisses.
  const openPermissionsSetup = useCallback(() => {
    setOnboardingOpen(true)
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
        if (notesWindowOpen) {
          void closeNotesWindow()
        } else {
          void openNotesWindow()
        }
      }
      // Comments live ONLY in the separate window now (owner call,
      // 2026-08-19) — plain (cmd)J, which used to toggle the in-studio rail,
      // keeps working by toggling the window, same as (cmd)shift-J.
      if (
        runtimeInfo?.commentsWindowEnabled &&
        event.key.toLowerCase() === 'j' &&
        (event.metaKey || event.ctrlKey)
      ) {
        event.preventDefault()
        void toggleCommentsWindow()
      }
      if (event.key.toLowerCase() === 'c' && event.shiftKey && (event.metaKey || event.ctrlKey)) {
        event.preventDefault()
        void toggleCaptionsWindow()
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [
    closeNotesWindow,
    notesWindowOpen,
    openNotesWindow,
    runtimeInfo?.commentsWindowEnabled,
    runtimeInfo?.notesWindowEnabled,
    toggleCommentsWindow,
    toggleCaptionsWindow,
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
  }, [setActive])

  useEffect(() => {
    const onWorkspaceNavigate = (event: Event): void => {
      const detail = (
        event as CustomEvent<{ tab?: unknown; settingsTab?: unknown; buddyTab?: unknown }>
      ).detail
      const tab = detail?.tab
      if (tab === 'settings') {
        openSettings(isSettingsTabId(detail?.settingsTab) ? detail.settingsTab : undefined)
      } else if (tab === 'ai') {
        openBuddy(isBuddyTabId(detail?.buddyTab) ? detail.buddyTab : undefined)
      } else if (isWorkspaceTab(tab)) {
        setActive(tab)
      }
    }
    window.addEventListener('videorc:navigate-workspace', onWorkspaceNavigate)
    return () => window.removeEventListener('videorc:navigate-workspace', onWorkspaceNavigate)
  }, [openBuddy, openSettings, setActive])

  // Plan 170 D18: `videorc://buddy` opens the Buddy tab (main focused the
  // window and synced the library); Make it Alive also opens the creator
  // once main saw the avatar worn.
  useEffect(() => {
    const off = window.videorc?.onBuddyDeepLink?.((navigation) => {
      openBuddy('live')
      if (navigation.openCreator) openBuddyPetCreator({ reference: 'persona-idle' })
    })
    return off
  }, [openBuddy])

  useEffect(() => {
    const onOpenCleanCut = (event: Event): void => {
      const request = readCleanCutOpenRequest((event as CustomEvent<unknown>).detail)
      if (request) openCleanCut(request)
    }
    window.addEventListener(OPEN_CLEAN_CUT_EVENT, onOpenCleanCut)
    return () => window.removeEventListener(OPEN_CLEAN_CUT_EVENT, onOpenCleanCut)
  }, [openCleanCut])

  const live = isActiveRecordingState(recordingState)
  const statusTone: StatusDotTone = live
    ? 'error'
    : backendConnected
      ? 'good'
      : wsStatus === 'failed'
        ? 'error'
        : 'warn'
  // Go Live is record+stream, which the backend reports as `recording`: the
  // stream URL is what makes it on air (plan 095 S5).
  const statusLabel = live ? (sessionIsLive(recording) ? 'streaming' : recordingState) : wsStatus

  return (
    <WorkspaceNavContext.Provider
      value={{
        active,
        setActive,
        activeStudioPanel: isStudioPanel(active) ? active : null,
        openStudioPanel,
        closeStudioPanel,
        openSettings,
        openBuddy
      }}
    >
      {/* The window family's shell (plan 050, D4): the sidebar sits on the
          window coat, the content pane adds --glass-content, and both share
          one 40 px header band with the traffic lights. Only PaneBody
          scrolls. */}
      <div
        className="flex h-screen overflow-hidden text-foreground"
        data-videorc-active-tab={active}
      >
        <Sidebar
          active={active}
          activeStudioPanel={isStudioPanel(active) ? active : null}
          accountTier={entitlementTier}
          onSelect={setActive}
          onSelectStudioPanel={openStudioPanel}
          onOpenSettings={openSettings}
          statusTone={statusTone}
          statusLabel={statusLabel}
          live={live}
          onOpenCommand={() => setCommandOpen(true)}
          platform={runtimeInfo?.platform}
        />

        <main className="flex min-w-0 flex-1 flex-col bg-glass-content">
          <Pane>
            <Toolbar title={workspaceTabLabel(active)} />
            {/* Library manages its own scroll (pinned header and toolbar,
                  only the table scrolls), and so do Settings and Buddy (their
                  tab strips stay pinned, only the tab under it scrolls); every
                  other tab scrolls as one. */}
            <PaneBody scroll={active !== 'library' && active !== 'settings' && active !== 'ai'}>
              <StudioMicVisualProvider enabled={active === 'studio' || active === 'sources'}>
                <Suspense fallback={<WorkspaceTabFallback />}>
                  {active === 'studio' ? <StudioTab /> : null}
                  {active === 'sources' ? <SourcesTab /> : null}
                  {active === 'layouts' ? <LayoutTab /> : null}
                  {active === 'assets' ? <AssetsTab /> : null}
                  {active === 'live' ? <StreamingTab /> : null}
                  {active === 'captions' ? <CaptionsTab /> : null}
                  {active === 'recording' ? <RecordingTab /> : null}
                  {active === 'library' ? (
                    <LibraryTab
                      focusSessionId={libraryFocusSessionId}
                      onOpenCleanCut={(sessionId) => openCleanCut({ sessionId })}
                      onOpenBuddyReport={openBuddyReport}
                    />
                  ) : null}
                  {active === 'ai' ? (
                    <BuddyTab
                      cleanCutRequest={cleanCutRequest}
                      reportSessionId={buddyReportSessionId}
                      tab={buddyTab}
                      onOpenLibrarySession={openLibrarySession}
                      onTabChange={selectBuddyTab}
                    />
                  ) : null}
                  {active === 'diagnostics' ? <DiagnosticsTab /> : null}
                  {active === 'settings' ? (
                    <SettingsTab
                      tab={settingsTab}
                      onOpenPermissionsSetup={openPermissionsSetup}
                      onShowWhatsNew={whatsNew.showLatest}
                      onTabChange={selectSettingsTab}
                    />
                  ) : null}
                </Suspense>
              </StudioMicVisualProvider>
            </PaneBody>
          </Pane>
          {/* State on the left, the shell's real shortcuts on the right:
                keyboard-first, only quieter than the old footer bar. */}
          <StatusBar leading={<StatusDot label={statusLabel} pulse={live} tone={statusTone} />}>
            <StatusBarHint
              keys={`${modKey}K`}
              label="Search"
              onClick={() => setCommandOpen(true)}
            />
            <StatusBarHint
              keys={`${modKey}P`}
              label="Preview"
              pressed={previewWindowOpen}
              onClick={() => void togglePreviewWindow()}
            />
            {/* Flags default ON and runtimeInfo lands async: treating null as
                  enabled keeps the bar at its final width from the first paint. */}
            {runtimeInfo?.notesWindowEnabled !== false ? (
              <StatusBarHint
                keys={`${shiftKey}${modKey}N`}
                label="Notes"
                pressed={notesWindowOpen}
                onClick={() => (notesWindowOpen ? void closeNotesWindow() : void openNotesWindow())}
              />
            ) : null}
            {runtimeInfo?.commentsWindowEnabled !== false ? (
              <StatusBarHint
                keys={`${shiftKey}${modKey}J`}
                label="Stream Manager"
                pressed={commentsWindowOpen}
                onClick={() =>
                  commentsWindowOpen ? void closeCommentsWindow() : void openCommentsWindow()
                }
              />
            ) : null}
          </StatusBar>
        </main>

        <Suspense fallback={null}>
          {commandOpen ? <CommandPalette open={commandOpen} onOpenChange={setCommandOpen} /> : null}
        </Suspense>
        <PermissionsOnboardingGate
          open={onboardingOpen}
          onOpen={openPermissionsSetup}
          onComplete={completeOnboarding}
        />
        {/* Post-update highlights; suppressed behind onboarding on first run
            (first run initializes the last-seen version silently). */}
        <Suspense fallback={null}>
          {whatsNew.open && !onboardingOpen ? (
            <WhatsNewDialog entry={whatsNew.entry} open onClose={whatsNew.dismiss} />
          ) : null}
        </Suspense>
      </div>
    </WorkspaceNavContext.Provider>
  )
}
