import { lazy, Suspense, useCallback, useEffect, useRef, useState, type ReactElement } from 'react'

const CommandPalette = lazy(async () => ({
  default: (await import('@/components/command-palette')).CommandPalette
}))
import { AppErrorBoundary } from '@/components/app-error-boundary'
import { Pane, PaneBody, Toolbar } from '@/components/pane'
import { PageErrorBoundary } from '@/components/page-error-boundary'
import { Sidebar } from '@/components/sidebar'
import { StatusBar, StatusBarHint } from '@/components/status-bar'
import { StatusBarReplayState } from '@/components/status-bar-replay'
import { StatusBarSessionState } from '@/components/status-bar-session'
import { GoLiveDialogGate } from '@/components/go-live-dialog-gate'
import {
  WorkspaceNavContext,
  isStudioPanel,
  readFirstRunSetupRequest,
  readWorkspaceNavigation,
  workspaceTabLabel,
  workspaceWindowTitle,
  type StudioPanel,
  type WorkspaceTab
} from '@/components/workspace-nav'
import { useStudioRecordingState, useStudioShell } from '@/hooks/use-studio'
import { StudioMicVisualProvider } from '@/hooks/use-studio-mic-visual'
import { useWhatsNew } from '@/hooks/use-whats-new'
import {
  createFirstRunStartup,
  firstRunShellSurface,
  type FirstRunDecision,
  type FirstRunLeave,
  type FirstRunSetupMode
} from '@/lib/first-run'
import {
  OPEN_CLEAN_CUT_EVENT,
  readCleanCutOpenRequest,
  type CleanCutOpenRequest,
  type CleanCutTabRequest
} from '@/lib/clean-cut-events'
import { isModalOpen } from '@/lib/modal-open'
import { pageChunk, useRenderPageWhenLoaded, type PageLoad } from '@/lib/page-chunk'
import { navigationShortcutTab, shellShortcutAction } from '@/lib/shell-shortcuts'
import { shortcutAccelerator } from '@/lib/shortcuts'
import { openBuddyPetCreator } from '@/lib/buddy-pet-creator-nav'
import {
  isBuddyTabId,
  readLastBuddyTab,
  writeLastBuddyTab,
  type BuddyTabId
} from '@/lib/buddy-tabs'
import {
  readLastLivestreamView,
  writeLastLivestreamView,
  type LivestreamViewId
} from '@/lib/livestream-tabs'
import { readLastSettingsTab, writeLastSettingsTab, type SettingsTabId } from '@/lib/settings-tabs'
import {
  FIRST_RUN_SETUP_OPEN_EVENT,
  WORKSPACE_NAVIGATE_EVENT,
  type FirstRunSetupRequest
} from '@/lib/workspace-navigation'
import { sessionOwnsTransport } from '../../../shared/capture-state'
// Straight from the session view, not `state-labels`, so the other state
// tables stay out of the eager bundle (plan 174 S2.3a).
import {
  sessionStatusLabel,
  sessionStatusPulses,
  sessionStatusTone
} from '@/lib/studio-session-view'
import { WINDOW_NAMES } from '../../../shared/window-names'

// Workspace views are loaded only on first navigation, then retained by the
// browser module cache. Studio remains the launch surface, but its dashboard and
// heavier dependencies stay out of the shell's eager entry chunk. A page the
// shell is waiting on renders as soon as its chunk is in (page-chunk.ts).
const studioPage = pageChunk(async () => (await import('@/components/tabs/studio-tab')).StudioTab)
const assetsPage = pageChunk(async () => (await import('@/components/tabs/assets-tab')).AssetsTab)
const captionsPage = pageChunk(
  async () => (await import('@/components/tabs/captions-tab')).CaptionsTab
)
const diagnosticsPage = pageChunk(
  async () => (await import('@/components/tabs/diagnostics-tab')).DiagnosticsTab
)
const layoutPage = pageChunk(async () => (await import('@/components/tabs/layout-tab')).LayoutTab)
const libraryPage = pageChunk(
  async () => (await import('@/components/tabs/library-tab')).LibraryTab
)
const buddyPage = pageChunk(async () => (await import('@/components/tabs/buddy-tab')).BuddyTab)
const recordingPage = pageChunk(
  async () => (await import('@/components/tabs/recording-tab')).RecordingTab
)
const settingsPage = pageChunk(
  async () => (await import('@/components/tabs/settings-tab')).SettingsTab
)
const sourcesPage = pageChunk(
  async () => (await import('@/components/tabs/sources-tab')).SourcesTab
)
const streamingPage = pageChunk(
  async () => (await import('@/components/tabs/streaming-tab')).StreamingTab
)
const PAGE_CHUNKS: Record<WorkspaceTab, PageLoad> = {
  studio: studioPage,
  sources: sourcesPage,
  layouts: layoutPage,
  assets: assetsPage,
  live: streamingPage,
  captions: captionsPage,
  recording: recordingPage,
  library: libraryPage,
  ai: buddyPage,
  diagnostics: diagnosticsPage,
  settings: settingsPage
}
const StudioTab = studioPage.Page
const AssetsTab = assetsPage.Page
const CaptionsTab = captionsPage.Page
const DiagnosticsTab = diagnosticsPage.Page
const LayoutTab = layoutPage.Page
const LibraryTab = libraryPage.Page
const BuddyTab = buddyPage.Page
const RecordingTab = recordingPage.Page
const SettingsTab = settingsPage.Page
const SourcesTab = sourcesPage.Page
const StreamingTab = streamingPage.Page
// First-run setup (plan 203): its backdrop, player and card load only when
// setup opens, never in the eager bundle.
const firstRunSetupPage = pageChunk(
  async () => (await import('@/components/first-run/first-run-setup')).FirstRunSetup
)
const FirstRunSetup = firstRunSetupPage.Page
const WhatsNewDialog = lazy(async () => ({
  default: (await import('@/components/whats-new-dialog')).WhatsNewDialog
}))
// The root panel's export button (plan 174 A-7): loaded only when the shell
// crashed, from here rather than from the panel's own chunk, which every
// window shares and must not reach into use-studio.
const SupportBundleButton = lazy(async () => ({
  default: (await import('@/components/support-bundle-button')).SupportBundleButton
}))
// "End livestream?" (plan 174 S0.1): hosted here so every stop path asks
// from every page; loaded only when a livestream is asked to end.
const EndLivestreamDialog = lazy(async () => ({
  default: (await import('@/components/end-livestream-dialog')).EndLivestreamDialog
}))
// Plan 209 S7: the Agents status and the D11 notices on every page; the
// Agents store behind them stays out of the eager bundle.
const AgentsWatcher = lazy(async () => ({
  default: (await import('@/components/agents-watcher')).AgentsWatcher
}))

function WorkspaceTabFallback(): ReactElement {
  return (
    <div
      aria-live="polite"
      className="flex min-h-40 items-center justify-center text-xs text-muted-foreground"
      role="status"
    >
      Opening Videorc…
    </div>
  )
}

// Snapshot before the first render, before What's New can initialize its key.
// Writes wait for runtime info so suppressed smoke profiles remain untouched.
const firstRunStartup =
  typeof localStorage === 'undefined' ? null : createFirstRunStartup(localStorage)

/**
 * The window before the first-run decision is final, and while the setup
 * chunk loads (plan 203 S5): the solid tone and the title band. Nothing that
 * could mount and then vanish behind setup.
 */
function FirstRunPlaceholder(): ReactElement {
  // The band is empty, so it needs no traffic-light gutter: only the drag region.
  return (
    <div className="h-screen bg-glass-solid" data-first-run-surface="placeholder">
      <div className="h-toolbar [-webkit-app-region:drag]" />
    </div>
  )
}

/**
 * The main window. A crash in the shell itself shows the root panel with the
 * support bundle still reachable (plan 174 A-7); a page's crash stays inside
 * the page (PageErrorBoundary below).
 */
export function AppShell(): ReactElement {
  return (
    <AppErrorBoundary
      supportBundle={
        <Suspense fallback={null}>
          <SupportBundleButton />
        </Suspense>
      }
    >
      <AppShellContent />
    </AppErrorBoundary>
  )
}

function AppShellContent(): ReactElement {
  const {
    wsStatus,
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
    toggleCaptionsWindow,
    stopConfirmation,
    confirmStopSession,
    cancelStopSession,
    setFirstRunSetupOpen
  } = useStudioShell()
  const { recording } = useStudioRecordingState()
  const [active, setActiveTab] = useState<WorkspaceTab>('studio')
  // Set by every way to a page except a click on its sidebar row: the page
  // title takes the focus once the page is up (plan 174 A-18).
  const titleFocusPendingRef = useRef(false)
  // Library's "Buddy report" opens the Buddy tab on one session's report (plan
  // 119 S3). Any other way to a page drops that ask, so the next visit to
  // Buddy shows the last stream again.
  const [buddyReportSessionId, setBuddyReportSessionId] = useState<string | null>(null)
  // Clean cut (plan 119 S14): Library's "Make a clean cut…" selects a
  // recording in the Buddy tab, and the ready toast opens a cut's review
  // there. The card's "Open in Library" and the review's "Back to Library"
  // focus a row. Like the report ask, any other way to a page drops them.
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
  const setActive = useCallback((tab: WorkspaceTab, options?: { focusTitle?: boolean }) => {
    setBuddyReportSessionId(null)
    setCleanCutRequest(null)
    setLibraryFocusSessionId(null)
    titleFocusPendingRef.current = options?.focusTitle ?? true
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
  const [firstRunVisibility, setFirstRunVisibility] = useState<FirstRunDecision | null>(null)
  useEffect(() => {
    if (!runtimeInfo || firstRunVisibility !== null) return
    setFirstRunVisibility(firstRunStartup?.finalize(runtimeInfo) ?? 'hide')
  }, [firstRunVisibility, runtimeInfo])
  // Plan 203 S5: setup opens as soon as the decision says so (its rows handle
  // the backend still loading), and "Run setup again…" replays it over the
  // workspace. While it is open the provider holds preview and global keys.
  const [replay, setReplay] = useState<FirstRunSetupRequest | null>(null)
  const setupMode: FirstRunSetupMode | null = replay
    ? { kind: 'replay', returnTo: replay.returnTo }
    : firstRunVisibility === 'show'
      ? { kind: 'first-run' }
      : null
  const setupOpen = setupMode !== null
  const setupOpenRef = useRef(setupOpen)
  setupOpenRef.current = setupOpen
  const surface = firstRunShellSurface({
    snapshot: firstRunStartup?.snapshot ?? 'existing-install',
    decision: firstRunVisibility,
    setupOpen
  })
  // Load the visible page, not a workspace hidden behind setup. Once its
  // chunk is in, render before shell updates can starve React's retry.
  useRenderPageWhenLoaded(
    surface === 'workspace' ? PAGE_CHUNKS[active] : surface === 'setup' ? firstRunSetupPage : null
  )
  useEffect(() => {
    setFirstRunSetupOpen(setupOpen)
  }, [setFirstRunSetupOpen, setupOpen])
  // Main restores the launch Preview window only once the workspace shows,
  // so it never floats over first-run setup (main ignores the repeats).
  useEffect(() => {
    if (surface === 'workspace') void window.videorc?.workspaceShown?.()
  }, [surface])
  useEffect(() => {
    const onOpenSetup = (event: Event): void =>
      setReplay(readFirstRunSetupRequest((event as CustomEvent<unknown>).detail))
    window.addEventListener(FIRST_RUN_SETUP_OPEN_EVENT, onOpenSetup)
    return () => window.removeEventListener(FIRST_RUN_SETUP_OPEN_EVENT, onOpenSetup)
  }, [])
  // Do not let What's New write its first-launch marker until the setup
  // record has been persisted, or suppression has been confirmed.
  const whatsNew = useWhatsNew(
    firstRunVisibility === null ? undefined : runtimeInfo?.version,
    runtimeInfo?.platform
  )

  // Warm workspace pages only after the workspace is visible. Starting these
  // imports behind first-run setup competes with its own chunk and can leave
  // the fresh window blank while unrelated pages load.
  useEffect(() => {
    if (surface !== 'workspace') return
    const prefetch = (): void => {
      void Promise.allSettled([sourcesPage.preload(), layoutPage.preload(), settingsPage.preload()])
    }
    if (typeof window.requestIdleCallback === 'function') {
      const requestId = window.requestIdleCallback(prefetch, { timeout: 5000 })
      return () => window.cancelIdleCallback(requestId)
    }
    const timer = window.setTimeout(prefetch, 2000)
    return () => window.clearTimeout(timer)
  }, [surface])

  // The Setup pages are ordinary tabs, listed under "Setup" in the sidebar.
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

  // Plan 174 S1.6b (A-14): Livestream reopens on the view used last, like
  // Settings; ⌘K's "Upcoming events" names its view before opening.
  const [livestreamView, setLivestreamView] = useState<LivestreamViewId>(readLastLivestreamView)
  const selectLivestreamView = useCallback((view: LivestreamViewId) => {
    setLivestreamView(view)
    writeLastLivestreamView(view)
  }, [])
  const openLivestream = useCallback(
    (view?: LivestreamViewId) => {
      if (view) {
        selectLivestreamView(view)
      }
      setActive('live')
    },
    [selectLivestreamView, setActive]
  )

  // Continue or Skip for now, after the fade. The first launch writes the
  // record (every fresh install sees setup once, D2) and opens the Studio; a
  // replay writes nothing and returns to the page it came from.
  const leaveFirstRunSetup = useCallback(
    ({ completion, openTab }: FirstRunLeave) => {
      // "Open Livestream" (plan 207 D10) lands on Setup, where stream keys go.
      if (openTab === 'live') selectLivestreamView('setup')
      if (replay) {
        setReplay(null)
        setActive(openTab ?? replay.returnTo)
        return
      }
      firstRunStartup?.complete(completion)
      setFirstRunVisibility('hide')
      setActive(openTab ?? 'studio')
    },
    [replay, selectLivestreamView, setActive]
  )

  // The shell's chords (plan 174 S3.21): ⌘ on macOS, Ctrl elsewhere (A-17),
  // decided in shell-shortcuts.ts, and none of them from under a dialog or a
  // menu (A-2). ⌘J shows Stream Manager, ⇧⌘J toggles it (A-12); Comments
  // live ONLY in that window (owner call, 2026-08-19).
  const commandOpenRef = useRef(commandOpen)
  commandOpenRef.current = commandOpen
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      const action = shellShortcutAction(event, {
        platform: runtimeInfo?.platform,
        modalOpen: setupOpenRef.current || isModalOpen(document),
        searchOpen: commandOpenRef.current,
        notesWindowEnabled: Boolean(runtimeInfo?.notesWindowEnabled),
        commentsWindowEnabled: Boolean(runtimeInfo?.commentsWindowEnabled)
      })
      if (!action) return
      event.preventDefault()
      if (action === 'toggle-search') setCommandOpen((value) => !value)
      else if (action === 'close-search') setCommandOpen(false)
      else if (action === 'toggle-preview') void togglePreviewWindow()
      else if (action === 'toggle-notes')
        void (notesWindowOpen ? closeNotesWindow() : openNotesWindow())
      else if (action === 'show-stream-manager') void openCommentsWindow()
      else if (action === 'toggle-stream-manager') void toggleCommentsWindow()
      else if (action === 'toggle-captions') void toggleCaptionsWindow()
      else openSettings('shortcuts')
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [
    closeNotesWindow,
    notesWindowOpen,
    openCommentsWindow,
    openNotesWindow,
    openSettings,
    runtimeInfo?.commentsWindowEnabled,
    runtimeInfo?.notesWindowEnabled,
    runtimeInfo?.platform,
    toggleCommentsWindow,
    toggleCaptionsWindow,
    togglePreviewWindow
  ])

  // ⌘1–⌘9 / ⌘, arrive from the main process (Chromium swallows ⌘+digit before
  // the renderer keydown — see main's before-input-event handler). Map the raw
  // key to a page here, where navigation state lives. The IPC path bypasses
  // dialog focus entirely, so it asks the same `isModalOpen` as every other
  // key (plan 174 A-2).
  useEffect(() => {
    const off = window.videorc?.onShortcutNavigate?.((key) => {
      const tab = navigationShortcutTab(key, setupOpenRef.current || isModalOpen(document))
      if (tab) setActive(tab)
    })
    return off
  }, [setActive])

  // The window is named after its page, and after keyboard navigation the
  // page title takes the focus, so the new page is announced and the next
  // Tab starts at its top (plan 174 A-18).
  useEffect(() => {
    document.title = setupOpen ? 'Videorc' : workspaceWindowTitle(active)
    if (setupOpen || !titleFocusPendingRef.current) return
    titleFocusPendingRef.current = false
    document.querySelector<HTMLElement>('[data-slot="toolbar"] h1')?.focus()
  }, [active, setupOpen])

  // Pages opened from outside React arrive through `openWorkspaceTab`
  // (plan 174, I-PAT-12); a page id that does not exist is dropped here.
  useEffect(() => {
    const onWorkspaceNavigate = (event: Event): void => {
      const navigation = readWorkspaceNavigation((event as CustomEvent<unknown>).detail)
      if (!navigation) return
      if (navigation.tab === 'settings') openSettings(navigation.settingsTab)
      else if (navigation.tab === 'ai') openBuddy(navigation.buddyTab)
      else if (navigation.tab === 'live') openLivestream(navigation.livestreamView)
      else setActive(navigation.tab)
    }
    window.addEventListener(WORKSPACE_NAVIGATE_EVENT, onWorkspaceNavigate)
    return () => window.removeEventListener(WORKSPACE_NAVIGATE_EVENT, onWorkspaceNavigate)
  }, [openBuddy, openLivestream, openSettings, setActive])

  // Plan 170 D18: `videorc://buddy` opens the Buddy tab (main focused the
  // window and synced the library); Make it Alive also opens the creator
  // once main saw the avatar worn. Plan 174 S3.14a: the Stream Manager's
  // behaviour chips name a tab (Chat); an id this build does not know opens
  // the first tab.
  useEffect(() => {
    const off = window.videorc?.onBuddyDeepLink?.((navigation) => {
      openBuddy(isBuddyTabId(navigation.tab) ? navigation.tab : 'live')
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

  // Plan 181: the default ring is not a session to the shell's live chrome.
  const live = sessionOwnsTransport(recording)
  // The session's own words and tone, never the socket's enum (plan 174
  // S1.3, A-4); Go Live is record+stream, and its stream URL makes it on air.
  const statusLabel = sessionStatusLabel(recording, wsStatus)
  const statusTone = sessionStatusTone(recording, wsStatus)
  const statusPulse = sessionStatusPulses(recording, wsStatus)

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
      {surface === 'setup' && setupMode ? (
        // First-run setup (plan 203, D1) is the whole window: the backdrop, the
        // title band and the card, in place of the sidebar and the page. The
        // solid placeholder holds the window while its chunk loads.
        <Suspense fallback={<FirstRunPlaceholder />}>
          <FirstRunSetup
            mode={setupMode}
            initialStep={replay ? 'permissions' : firstRunStartup?.step}
            initialGoal={firstRunStartup?.goal ?? null}
            onEnterStep={(step) => firstRunStartup?.enterStep(step, setupMode)}
            onGoalChange={(goal) => firstRunStartup?.setGoal(goal, setupMode)}
            onLeave={leaveFirstRunSetup}
          />
        </Suspense>
      ) : surface === 'placeholder' ? (
        <FirstRunPlaceholder />
      ) : (
        // The window family's shell (plan 050, D4): the sidebar sits on the
        // window coat, the content pane adds --glass-content, and both share
        // one 40 px header band with the traffic lights. Only PaneBody
        // scrolls.
        <div
          className="flex h-screen overflow-hidden text-foreground"
          data-videorc-active-tab={active}
        >
          <Sidebar
            active={active}
            activeStudioPanel={isStudioPanel(active) ? active : null}
            accountTier={entitlementTier}
            // A click on a row keeps the focus on the row; every other way to
            // a page moves it to the page title.
            onSelect={(tab) => setActive(tab, { focusTitle: false })}
            onSelectStudioPanel={(panel) => setActive(panel, { focusTitle: false })}
            onOpenSettings={openSettings}
            statusTone={statusTone}
            statusLabel={statusLabel}
            statusPulse={statusPulse}
            sessionStartedAt={recording.startedAt}
            live={live}
            onOpenCommand={() => setCommandOpen(true)}
            platform={runtimeInfo?.platform}
          />

          <main className="flex min-w-0 flex-1 flex-col bg-glass-content">
            <Pane>
              <Toolbar title={workspaceTabLabel(active)} />
              {/* A page that owns its scroll says so on its root (pinned tab
                  strips, Library's pinned header): PaneBody stops scrolling
                  for it. Every other page scrolls as one. Keyed, so every page
                  opens at its top: a Scene page scrolled to its canvas left
                  Studio clipped, and the docked preview hid as scrolled away. */}
              <PaneBody key={active}>
                {/* A page crash, or a page chunk that failed to load, stays
                  inside the page (plan 174 A-7); keyed, so the next page
                  starts clean. */}
                <PageErrorBoundary key={active}>
                  <StudioMicVisualProvider enabled={active === 'studio' || active === 'sources'}>
                    <Suspense fallback={<WorkspaceTabFallback />}>
                      {active === 'studio' ? <StudioTab /> : null}
                      {active === 'sources' ? <SourcesTab /> : null}
                      {active === 'layouts' ? <LayoutTab /> : null}
                      {active === 'assets' ? <AssetsTab /> : null}
                      {active === 'live' ? (
                        <StreamingTab view={livestreamView} onViewChange={selectLivestreamView} />
                      ) : null}
                      {active === 'captions' ? <CaptionsTab /> : null}
                      {active === 'recording' ? <RecordingTab /> : null}
                      {active === 'library' ? (
                        <LibraryTab
                          focusSessionId={libraryFocusSessionId}
                          onOpenCleanCut={(sessionId) =>
                            openCleanCut({ sessionId, origin: 'library' })
                          }
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
                          onShowWhatsNew={whatsNew.showLatest}
                          onTabChange={selectSettingsTab}
                        />
                      ) : null}
                    </Suspense>
                  </StudioMicVisualProvider>
                </PageErrorBoundary>
              </PaneBody>
            </Pane>
            {/* State on the left, the shell's real shortcuts on the right:
                keyboard-first, only quieter than the old footer bar. */}
            <StatusBar
              leading={
                <>
                  <StatusBarSessionState recording={recording} wsStatus={wsStatus} />
                  <StatusBarReplayState />
                </>
              }
            >
              <StatusBarHint
                accelerator={shortcutAccelerator('search')}
                label="Search"
                onClick={() => setCommandOpen(true)}
              />
              <StatusBarHint
                accelerator={shortcutAccelerator('preview-window')}
                label={WINDOW_NAMES.preview}
                pressed={previewWindowOpen}
                onClick={() => void togglePreviewWindow()}
              />
              {/* Flags default ON and runtimeInfo lands async: treating null as
                  enabled keeps the bar at its final width from the first paint. */}
              {runtimeInfo?.notesWindowEnabled !== false ? (
                <StatusBarHint
                  accelerator={shortcutAccelerator('notes-window')}
                  label={WINDOW_NAMES.notes}
                  pressed={notesWindowOpen}
                  onClick={() =>
                    notesWindowOpen ? void closeNotesWindow() : void openNotesWindow()
                  }
                />
              ) : null}
              {runtimeInfo?.commentsWindowEnabled !== false ? (
                <StatusBarHint
                  accelerator={shortcutAccelerator('comments-window')}
                  label={WINDOW_NAMES.streamManager}
                  pressed={commentsWindowOpen}
                  onClick={() =>
                    commentsWindowOpen ? void closeCommentsWindow() : void openCommentsWindow()
                  }
                />
              ) : null}
            </StatusBar>
          </main>
        </div>
      )}

      {/* The Go Live confirmation opens over every page, not only Studio
          (plan 174 S0.6, B-5): Go Live can start from anywhere. */}
      <GoLiveDialogGate />

      <Suspense fallback={null}>
        {commandOpen ? <CommandPalette open={commandOpen} onOpenChange={setCommandOpen} /> : null}
      </Suspense>
      {/* Post-update highlights; they wait behind first-run setup (first run
            initializes the last-seen version silently). */}
      <Suspense fallback={null}>
        {whatsNew.open && firstRunVisibility === 'hide' && !setupOpen ? (
          <WhatsNewDialog
            entry={whatsNew.entry}
            open
            skippedVersions={whatsNew.skippedVersions}
            onClose={whatsNew.dismiss}
          />
        ) : null}
      </Suspense>
      <Suspense fallback={null}>
        <AgentsWatcher />
      </Suspense>
      <Suspense fallback={null}>
        {stopConfirmation ? (
          <EndLivestreamDialog
            confirmation={stopConfirmation}
            onCancel={cancelStopSession}
            onConfirm={confirmStopSession}
          />
        ) : null}
      </Suspense>
    </WorkspaceNavContext.Provider>
  )
}
