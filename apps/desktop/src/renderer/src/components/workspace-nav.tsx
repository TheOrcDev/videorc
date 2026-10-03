import {
  type AppIcon,
  AssetsIcon,
  CaptionsIcon,
  HealthIcon,
  LibraryIcon,
  LivestreamIcon,
  OrcleIcon,
  OutputIcon,
  SceneIcon,
  SettingsIcon,
  SourcesIcon,
  StudioIcon
} from '@/components/icons'
import { createContext, useContext } from 'react'

import type { SettingsTabId } from '@/lib/settings-tabs'

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
  icon: AppIcon
  group: WorkspaceTabGroup
}

export type StudioPanelMeta = {
  id: StudioPanel
  label: string
  icon: AppIcon
  // The pre-rail tab id; kept as the `data-videorc-tab-trigger` value so smokes and
  // automation keep working across the C1 shell change.
  legacyTabId: string
}

// Orcle (plan 119) replaced Publish and joined the stage row, right under
// Studio. Its id stays `ai`, so deep links, smokes, ⌘9 and the
// `data-videorc-tab-trigger` value keep working.
export const WORKSPACE_TABS: WorkspaceTabMeta[] = [
  { id: 'studio', label: 'Studio', icon: StudioIcon, group: 'stage' },
  { id: 'ai', label: 'Orcle', icon: OrcleIcon, group: 'stage' },
  { id: 'library', label: 'Library', icon: LibraryIcon, group: 'library' },
  { id: 'settings', label: 'Settings', icon: SettingsIcon, group: 'system' },
  { id: 'diagnostics', label: 'Health', icon: HealthIcon, group: 'system' }
]

// Sidebar order mirrors the live workflow: pick sources, compose, go live, output.
// There is no Audio page — the microphone and mixer live on Sources with every
// other capture device. Labels renamed 2026-06-13 (ux-ia-refactor-plan); ids and
// legacyTabId stay so smokes and deep links keep working.
export const STUDIO_PANELS: StudioPanelMeta[] = [
  { id: 'sources', label: 'Sources', icon: SourcesIcon, legacyTabId: 'sources' },
  { id: 'layouts', label: 'Scene', icon: SceneIcon, legacyTabId: 'layout' },
  { id: 'assets', label: 'Assets', icon: AssetsIcon, legacyTabId: 'assets' },
  { id: 'live', label: 'Livestream', icon: LivestreamIcon, legacyTabId: 'streaming' },
  { id: 'captions', label: 'Captions', icon: CaptionsIcon, legacyTabId: 'captions' },
  { id: 'recording', label: 'Output', icon: OutputIcon, legacyTabId: 'recording' }
]

// Page shortcuts. Studio, the Setup pages and Library take ⌘1–⌘8 in sidebar
// order. Orcle keeps ⌘9, the key Publish had, although it now sits under Studio
// (plan 119): muscle memory and deep links outrank a strict sidebar order.
// Settings keeps the platform-standard ⌘,. Health intentionally has NO digit — it
// stays reachable via ⌘K (and the account menu). The main process emits the raw
// key ('1'–'9' or ',') and AppShell maps whatever is listed here.
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

const tabIdsIn = (group: WorkspaceTabGroup): WorkspaceTab[] =>
  WORKSPACE_TABS.filter((tab) => tab.group === group).map((tab) => tab.id)

/** Every page the sidebar shows, top to bottom (Health has no row). */
const SIDEBAR_ORDER: WorkspaceTab[] = [
  ...tabIdsIn('stage'),
  ...STUDIO_PANELS.map((panel) => panel.id),
  ...tabIdsIn('library'),
  ...tabIdsIn('system').filter((tab) => tab !== 'diagnostics')
]

/**
 * A page's position down the sidebar. The reveal cascade uses it so the
 * shortcut chips arrive top-to-bottom, regardless of which sidebar group a row
 * sits in and of its digit (Orcle's ⌘9 sits second).
 */
export function sidebarOrderFor(tab: WorkspaceTab): number {
  const index = SIDEBAR_ORDER.indexOf(tab)
  return index === -1 ? 0 : index
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
  /** Opens Settings on `tab`, or on the tab used last when none is named. */
  openSettings: (tab?: SettingsTabId) => void
}

export const WorkspaceNavContext = createContext<WorkspaceNavValue | null>(null)

export function useWorkspaceNav(): WorkspaceNavValue {
  const value = useContext(WorkspaceNavContext)
  if (!value) {
    throw new Error('useWorkspaceNav must be used within a WorkspaceNavContext provider')
  }
  return value
}
