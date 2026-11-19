import {
  type AppIcon,
  AccountIcon,
  AssetsIcon,
  AvatarPageIcon,
  BuddyPageIcon,
  CaptionsIcon,
  HealthIcon,
  LibraryIcon,
  LivestreamIcon,
  OutputIcon,
  SceneIcon,
  SettingsIcon,
  SourcesIcon,
  StudioIcon
} from '@/components/icons'
import { createContext, useContext } from 'react'

import { AVATAR_TAB_LABEL, isAvatarTabId, type AvatarTabId } from '@/lib/avatar-tabs'
import { BUDDY_TAB_LABEL, isBuddyTabId, type BuddyTabId } from '@/lib/buddy-tabs'
import { isLivestreamViewId } from '@/lib/livestream-tabs'
import { migrateSettingsTabId, type SettingsTabId } from '@/lib/settings-tabs'
import type { FirstRunSetupRequest, WorkspaceNavigation } from '@/lib/workspace-navigation'

// The panel pages: one click away, but they are FULL pages — studio content
// renders only on the Studio tab (user decision 2026-06-09, overriding the
// earlier push-rail idea). Sources is the single home for every capture device
// — screen/window, camera, AND microphone — so changing what gets captured
// never requires hunting across pages (UI rewrite plan, 2026-06-10). Most sit
// under the sidebar's "Setup" label; Destinations (`live`) sits under
// "Livestream" with Buddy (plan 235 D6), and stays a panel so
// `openStudioPanel('live')` keeps working.
export type StudioPanel = 'sources' | 'layouts' | 'assets' | 'live' | 'captions' | 'recording'

// Full pages: they replace the workspace content area.
export type WorkspaceTab =
  | 'studio'
  | StudioPanel
  | 'library'
  | 'avatar'
  | 'guests'
  | 'ai'
  | 'diagnostics'
  | 'settings'

export type WorkspaceTabMeta = {
  id: WorkspaceTab
  label: string
  icon: AppIcon
}

export type StudioPanelMeta = {
  id: StudioPanel
  label: string
  icon: AppIcon
  // The pre-rail tab id; kept as the `data-videorc-tab-trigger` value so smokes and
  // automation keep working across the C1 shell change.
  legacyTabId: string
}

// Sidekick (plan 119) keeps the id `ai`, the id deep links, smokes and the
// `data-videorc-tab-trigger` value already use. Its row wears a plain glyph,
// `BuddyPageIcon` (plan 235 D7). The avatar, the character on the stream,
// has its own page in Setup since plan 239, with its own glyph. Guests, the
// talk show's room (plan 224 D16), is its own page since 0.31.1. (No comments
// inside these arrays: the eager build ships them.)
export const WORKSPACE_TABS: WorkspaceTabMeta[] = [
  { id: 'studio', label: 'Studio', icon: StudioIcon },
  { id: 'avatar', label: AVATAR_TAB_LABEL, icon: AvatarPageIcon },
  { id: 'guests', label: 'Guests', icon: AccountIcon },
  { id: 'ai', label: BUDDY_TAB_LABEL, icon: BuddyPageIcon },
  { id: 'library', label: 'Library', icon: LibraryIcon },
  { id: 'settings', label: 'Settings', icon: SettingsIcon },
  { id: 'diagnostics', label: 'Health', icon: HealthIcon }
]

// The panel pages in sidebar order. There is no Audio page — the microphone and
// mixer live on Sources with every other capture device. Labels renamed
// 2026-06-13 (ux-ia-refactor-plan) and 2026-11-14 (plan 235 D6: Livestream →
// Destinations); ids and legacyTabId stay so smokes and deep links keep working.
export const STUDIO_PANELS: StudioPanelMeta[] = [
  { id: 'sources', label: 'Sources', icon: SourcesIcon, legacyTabId: 'sources' },
  { id: 'layouts', label: 'Scene', icon: SceneIcon, legacyTabId: 'layout' },
  { id: 'assets', label: 'Assets', icon: AssetsIcon, legacyTabId: 'assets' },
  { id: 'captions', label: 'Captions', icon: CaptionsIcon, legacyTabId: 'captions' },
  { id: 'recording', label: 'Output', icon: OutputIcon, legacyTabId: 'recording' },
  { id: 'live', label: 'Destinations', icon: LivestreamIcon, legacyTabId: 'streaming' }
]

export type SidebarZoneId = 'stage' | 'setup' | 'livestream' | 'library' | 'system'

export type SidebarZone = {
  id: SidebarZoneId
  /** A labelled group's `SectionLabel`; a zone of one row carries none. */
  label?: string
  pages: readonly WorkspaceTab[]
}

// The sidebar, top to bottom (plan 174 D8, plan 235 D6): Studio leads alone as
// the chrome slab, then the two labelled groups, Setup and Livestream, then
// Library. The avatar is part of the picture, so it sits in Setup (plan 239,
// owner 2026-11-15); Sidekick stays under Livestream, with Guests beside
// Destinations (0.31.1; shown only with talk shows). The 'system' rows sit
// in a bottom block above the account row. Health has no row at all: the
// status bar's state is its door (D9).
export const SIDEBAR_ZONES: readonly SidebarZone[] = [
  { id: 'stage', pages: ['studio'] },
  {
    id: 'setup',
    label: 'Setup',
    pages: ['sources', 'layouts', 'assets', 'captions', 'avatar', 'recording']
  },
  { id: 'livestream', label: 'Livestream', pages: ['live', 'guests', 'ai'] },
  { id: 'library', pages: ['library'] },
  { id: 'system', pages: ['settings'] }
]

// Page shortcuts run down the sidebar (plan 235 D8): ⌘1–⌘9, then ⌘0 for the
// tenth page, Library (plan 239 D6). Settings keeps the platform-standard ⌘,.
// Guests has none either (0.31.1): it shows only with talk shows, and the
// digits keep their rows. Health intentionally has NO digit — it stays reachable via ⌘K (and the
// account menu). The main process emits the raw key ('0'–'9' or ',') and
// AppShell maps whatever is listed here.
export const WORKSPACE_SHORTCUTS: { digit: string; tab: WorkspaceTab }[] = [
  { digit: '1', tab: 'studio' },
  { digit: '2', tab: 'sources' },
  { digit: '3', tab: 'layouts' },
  { digit: '4', tab: 'assets' },
  { digit: '5', tab: 'captions' },
  { digit: '6', tab: 'avatar' },
  { digit: '7', tab: 'recording' },
  { digit: '8', tab: 'live' },
  { digit: '9', tab: 'ai' },
  { digit: '0', tab: 'library' },
  { digit: ',', tab: 'settings' }
]

export function shortcutDigitFor(tab: WorkspaceTab): string | undefined {
  return WORKSPACE_SHORTCUTS.find((entry) => entry.tab === tab)?.digit
}

/** Every page the sidebar shows, top to bottom (Health has no row). */
const SIDEBAR_ORDER: WorkspaceTab[] = SIDEBAR_ZONES.flatMap((zone) => zone.pages)

/**
 * A page's position down the sidebar. The reveal cascade uses it so the
 * shortcut chips arrive top-to-bottom, whichever sidebar group a row sits in.
 */
export function sidebarOrderFor(tab: WorkspaceTab): number {
  const index = SIDEBAR_ORDER.indexOf(tab)
  return index === -1 ? 0 : index
}

/** A page's name and icon, whichever table holds it. */
export function workspacePageMeta(tab: WorkspaceTab): WorkspaceTabMeta {
  const meta =
    WORKSPACE_TABS.find((entry) => entry.id === tab) ??
    STUDIO_PANELS.find((entry) => entry.id === tab)
  if (!meta) throw new Error(`No workspace page ${tab}`)
  return { id: meta.id, label: meta.label, icon: meta.icon }
}

export function workspaceTabLabel(tab: WorkspaceTab): string {
  return (
    WORKSPACE_TABS.find((entry) => entry.id === tab)?.label ??
    STUDIO_PANELS.find((entry) => entry.id === tab)?.label ??
    tab
  )
}

/**
 * The main window's title for a page (plan 174 S3.21, A-18): "Studio –
 * Videorc", read by Mission Control, the Windows taskbar and screen readers.
 * An en dash: app copy never uses an em dash (docs/ui-copy.md).
 */
export function workspaceWindowTitle(tab: WorkspaceTab): string {
  return `${workspaceTabLabel(tab)} – Videorc`
}

export function isStudioPanel(value: unknown): value is StudioPanel {
  return STUDIO_PANELS.some((panel) => panel.id === value)
}

export function isWorkspaceTab(value: unknown): value is WorkspaceTab {
  return WORKSPACE_TABS.some((tab) => tab.id === value) || isStudioPanel(value)
}

/**
 * The page a `videorc:navigate-workspace` event asks for (sent by
 * `openWorkspaceTab`), or null for a page that does not exist. A sub-tab that
 * does not exist opens the page on its remembered tab.
 */
export function readWorkspaceNavigation(detail: unknown): WorkspaceNavigation | null {
  if (!detail || typeof detail !== 'object') return null
  const { tab, settingsTab, buddyTab, avatarTab, livestreamView, sessionId, destinationId } =
    detail as Record<string, unknown>
  if (tab === 'settings') {
    // A link to a retired tab opens the tab that replaced it (plan 174 S3.6).
    const current = migrateSettingsTabId(settingsTab)
    return current ? { tab, settingsTab: current } : { tab }
  }
  if (tab === 'ai') return isBuddyTabId(buddyTab) ? { tab, buddyTab } : { tab }
  if (tab === 'avatar') return isAvatarTabId(avatarTab) ? { tab, avatarTab } : { tab }
  if (tab === 'live') {
    // A named destination opens its card, which lives in Setup (plan 250 S4).
    if (typeof destinationId === 'string' && destinationId) {
      return { tab, livestreamView: 'setup', destinationId }
    }
    return isLivestreamViewId(livestreamView) ? { tab, livestreamView } : { tab }
  }
  if (tab === 'library') return typeof sessionId === 'string' ? { tab, sessionId } : { tab }
  return isWorkspaceTab(tab) ? { tab } : null
}

/** The replay request behind `openFirstRunSetup` (plan 203 S5): an unknown page returns to Settings. */
export function readFirstRunSetupRequest(detail: unknown): FirstRunSetupRequest {
  const returnTo =
    detail && typeof detail === 'object' ? (detail as Record<string, unknown>).returnTo : undefined
  return { returnTo: isWorkspaceTab(returnTo) ? returnTo : 'settings' }
}

type WorkspaceNavValue = {
  active: WorkspaceTab
  setActive: (tab: WorkspaceTab) => void
  activeStudioPanel: StudioPanel | null
  openStudioPanel: (panel: StudioPanel) => void
  closeStudioPanel: () => void
  /** Opens Settings on `tab`, or on the tab used last when none is named. */
  openSettings: (tab?: SettingsTabId) => void
  /** Opens Sidekick on `tab`, or on the tab used last when none is named (plan 150). */
  openBuddy: (tab?: BuddyTabId) => void
  /** Opens Avatar on `tab`, or on the tab used last when none is named (plan 239). */
  openAvatar: (tab?: AvatarTabId) => void
}

export const WorkspaceNavContext = createContext<WorkspaceNavValue | null>(null)

export function useWorkspaceNav(): WorkspaceNavValue {
  const value = useContext(WorkspaceNavContext)
  if (!value) {
    throw new Error('useWorkspaceNav must be used within a WorkspaceNavContext provider')
  }
  return value
}
