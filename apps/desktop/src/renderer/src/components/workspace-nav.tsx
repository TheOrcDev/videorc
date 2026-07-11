import {
  Broadcast,
  ClosedCaptioning,
  FilmReel,
  GearSix,
  ImageSquare,
  Monitor,
  Pulse,
  Record,
  Sparkle,
  SquaresFour,
  VideoCamera,
  type Icon
} from '@phosphor-icons/react'
import { createContext, useContext } from 'react'

// Studio control pages, grouped under "Studio" in the sidebar: one click away, but
// they are FULL pages — studio content renders only on the Studio tab (user decision
// 2026-06-09, overriding the earlier push-rail idea). Sources is the single home for
// every capture device — screen/window, camera, AND microphone — so changing what
// gets captured never requires hunting across pages (UI rewrite plan, 2026-06-10).
export type StudioPanel = 'sources' | 'layouts' | 'assets' | 'live' | 'captions' | 'recording'

// Full pages: they replace the workspace content area.
export type WorkspaceTab = 'studio' | StudioPanel | 'library' | 'ai' | 'diagnostics' | 'settings'

// Sidebar zones (ux-ia-refactor-plan): the stage row, then SETUP (the studio
// panels), then LIBRARY, then SYSTEM. 'setup' rows come from STUDIO_PANELS.
export type WorkspaceTabGroup = 'stage' | 'library' | 'system'

export type WorkspaceTabMeta = {
  id: WorkspaceTab
  label: string
  icon: Icon
  group: WorkspaceTabGroup
}

export type StudioPanelMeta = {
  id: StudioPanel
  label: string
  icon: Icon
  // The pre-rail tab id; kept as the `data-videorc-tab-trigger` value so smokes and
  // automation keep working across the C1 shell change.
  legacyTabId: string
}

export const WORKSPACE_TABS: WorkspaceTabMeta[] = [
  { id: 'studio', label: 'Studio', icon: VideoCamera, group: 'stage' },
  { id: 'library', label: 'Library', icon: FilmReel, group: 'library' },
  { id: 'ai', label: 'Publish', icon: Sparkle, group: 'library' },
  { id: 'settings', label: 'Settings', icon: GearSix, group: 'system' },
  { id: 'diagnostics', label: 'Health', icon: Pulse, group: 'system' }
]

// Sidebar order mirrors the live workflow: pick sources, compose, go live, output.
// There is no Audio page — the microphone and mixer live on Sources with every
// other capture device. Labels renamed 2026-06-13 (ux-ia-refactor-plan); ids and
// legacyTabId stay so smokes and deep links keep working.
export const STUDIO_PANELS: StudioPanelMeta[] = [
  { id: 'sources', label: 'Sources', icon: Monitor, legacyTabId: 'sources' },
  { id: 'layouts', label: 'Scene', icon: SquaresFour, legacyTabId: 'layout' },
  { id: 'assets', label: 'Assets', icon: ImageSquare, legacyTabId: 'assets' },
  { id: 'live', label: 'Livestream', icon: Broadcast, legacyTabId: 'streaming' },
  { id: 'captions', label: 'Captions', icon: ClosedCaptioning, legacyTabId: 'captions' },
  { id: 'recording', label: 'Output', icon: Record, legacyTabId: 'recording' }
]

// Page shortcuts in sidebar order. Studio + the Setup pages + Library take ⌘1–⌘8,
// AI takes ⌘9, and Settings keeps the platform-standard ⌘,. Health intentionally has NO
// digit — it stays reachable via ⌘K (and the account menu). The main process emits
// the raw key ('1'–'9' or ',') and AppShell maps whatever is listed here.
export const WORKSPACE_SHORTCUTS: { digit: string; tab: WorkspaceTab }[] = [
  { digit: '1', tab: 'studio' },
  { digit: '2', tab: 'sources' },
  { digit: '3', tab: 'layouts' },
  { digit: '4', tab: 'assets' },
  { digit: '5', tab: 'live' },
  { digit: '6', tab: 'captions' },
  { digit: '7', tab: 'recording' },
  { digit: '8', tab: 'library' },
  { digit: '9', tab: 'ai' },
  { digit: ',', tab: 'settings' }
]

export function shortcutDigitFor(tab: WorkspaceTab): string | undefined {
  return WORKSPACE_SHORTCUTS.find((entry) => entry.tab === tab)?.digit
}

export function workspaceTabLabel(tab: WorkspaceTab): string {
  return (
    WORKSPACE_TABS.find((entry) => entry.id === tab)?.label ??
    STUDIO_PANELS.find((entry) => entry.id === tab)?.label ??
    tab
  )
}

export function isStudioPanel(value: unknown): value is StudioPanel {
  return STUDIO_PANELS.some((panel) => panel.id === value)
}

export function isWorkspaceTab(value: unknown): value is WorkspaceTab {
  return WORKSPACE_TABS.some((tab) => tab.id === value) || isStudioPanel(value)
}

type WorkspaceNavValue = {
  active: WorkspaceTab
  setActive: (tab: WorkspaceTab) => void
  activeStudioPanel: StudioPanel | null
  openStudioPanel: (panel: StudioPanel) => void
  closeStudioPanel: () => void
}

export const WorkspaceNavContext = createContext<WorkspaceNavValue | null>(null)

export function useWorkspaceNav(): WorkspaceNavValue {
  const value = useContext(WorkspaceNavContext)
  if (!value) {
    throw new Error('useWorkspaceNav must be used within a WorkspaceNavContext provider')
  }
  return value
}
