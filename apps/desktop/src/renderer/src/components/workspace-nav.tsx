import {
  type AppIcon,
  AccountIcon,
  AssetsRowIcon,
  AvatarPageIcon,
  BuddyPageRowIcon,
  CaptionsRowIcon,
  HealthRowIcon,
  LibraryRowIcon,
  LivestreamRowIcon,
  OutputIcon,
  SceneRowIcon,
  SettingsIcon,
  SoundsPageIcon,
  SourcesIcon,
  StudioRowIcon
} from '@/components/icons'
import { createContext, useContext } from 'react'

import { isAvatarTabId, type AvatarTabId } from '@/lib/avatar-tabs'
import { isBuddyTabId, type BuddyTabId } from '@/lib/buddy-tabs'
import { isLivestreamViewId } from '@/lib/livestream-tabs'
import { migrateSettingsTabId, type SettingsTabId } from '@/lib/settings-tabs'
import type { FirstRunSetupRequest, WorkspaceNavigation } from '@/lib/workspace-navigation'
import {
  PAGE_KEYS,
  SIDEBAR_LAYOUT,
  SIDEBAR_PAGE_LABELS,
  pageKeyAccelerator,
  pageKeyFor,
  type PageKey,
  type SidebarZoneId
} from '../../../shared/sidebar-pages'

// The panel pages: one click away, but they are FULL pages — studio content
// renders only on the Studio tab (user decision 2026-06-09, overriding the
// earlier push-rail idea). Sources is the single home for every capture device
// — screen/window, camera, AND microphone — so changing what gets captured
// never requires hunting across pages (UI rewrite plan, 2026-06-10). Most sit
// under the sidebar's "Setup" label; Destinations (`live`) sits under
// "Livestream" with Buddy (plan 235 D6), and stays a panel so
// `openStudioPanel('live')` keeps working. Images (id `assets`, the page that
// was Assets) and Sounds sit under "Assets" (owner 2026-11-20).
export type StudioPanel =
  | 'sources'
  | 'layouts'
  | 'assets'
  | 'sounds'
  | 'live'
  | 'captions'
  | 'recording'

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
// `BuddyPageRowIcon` (plan 235 D7). The avatar, the character on the stream,
// has its own page since plan 239, with its own glyph, in Livestream. Guests, the
// talk show's room (plan 224 D16), is its own page since 0.31.1. (No comments
// inside these arrays: the eager build ships them.)
export const WORKSPACE_TABS: WorkspaceTabMeta[] = [
  { id: 'studio', label: SIDEBAR_PAGE_LABELS.studio, icon: StudioRowIcon },
  { id: 'avatar', label: SIDEBAR_PAGE_LABELS.avatar, icon: AvatarPageIcon },
  { id: 'guests', label: SIDEBAR_PAGE_LABELS.guests, icon: AccountIcon },
  { id: 'ai', label: SIDEBAR_PAGE_LABELS.ai, icon: BuddyPageRowIcon },
  { id: 'library', label: SIDEBAR_PAGE_LABELS.library, icon: LibraryRowIcon },
  { id: 'settings', label: SIDEBAR_PAGE_LABELS.settings, icon: SettingsIcon },
  { id: 'diagnostics', label: 'Health', icon: HealthRowIcon }
]

// The panel pages in sidebar order. There is no Audio page — the microphone and
// mixer live on Sources with every other capture device. Labels renamed
// 2026-06-13 (ux-ia-refactor-plan) and 2026-11-14 (plan 235 D6: Livestream →
// Destinations; 2026-11-20: Assets → Images, its sounds moved to Sounds); ids
// and legacyTabId stay so smokes and deep links keep working.
const L = SIDEBAR_PAGE_LABELS
export const STUDIO_PANELS: StudioPanelMeta[] = [
  { id: 'sources', label: L.sources, icon: SourcesIcon, legacyTabId: 'sources' },
  { id: 'layouts', label: L.layouts, icon: SceneRowIcon, legacyTabId: 'layout' },
  { id: 'assets', label: L.assets, icon: AssetsRowIcon, legacyTabId: 'assets' },
  { id: 'sounds', label: L.sounds, icon: SoundsPageIcon, legacyTabId: 'sounds' },
  { id: 'captions', label: L.captions, icon: CaptionsRowIcon, legacyTabId: 'captions' },
  { id: 'recording', label: L.recording, icon: OutputIcon, legacyTabId: 'recording' },
  { id: 'live', label: L.live, icon: LivestreamRowIcon, legacyTabId: 'streaming' }
]

export type { SidebarZoneId }

export type SidebarZone = {
  id: SidebarZoneId
  /** A labelled group's `SectionLabel`; a zone of one row carries none. */
  label?: string
  pages: readonly WorkspaceTab[]
}

// The sidebar, top to bottom, and its keys live in shared/sidebar-pages (one
// home for the order and the key map, owner 2026-11-20): Studio, the Setup,
// Livestream and Assets groups, then Library and Settings in the bottom
// block above the account row. Guests shows only with talk shows. Health has
// no row at all: the status bar's state is its door (D9).
export const SIDEBAR_ZONES: readonly SidebarZone[] = SIDEBAR_LAYOUT

// Page shortcuts, derived there: ⌘1–⌘9 down the nine rows above the Assets
// group after visibility filtering, ⇧⌘G Images, ⇧⌘S Sounds,
// ⌘0 Library, ⌘, Settings. Health has NO key: it stays reachable via ⌘K, the
// status bar and the account menu. Main forwards the key and AppShell maps it
// here.
export const WORKSPACE_SHORTCUTS: readonly { key: PageKey; tab: WorkspaceTab }[] = PAGE_KEYS.map(
  ({ key, page }) => ({ key, tab: page })
)

/** A page's shortcut as an Electron accelerator (`CmdOrCtrl+7`, `CmdOrCtrl+Shift+G`), if it has one. */
export function pageShortcutFor(tab: WorkspaceTab, guestsShown = true): string | undefined {
  const key = pageKeyFor(tab, guestsShown)
  return key ? pageKeyAccelerator(key) : undefined
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
