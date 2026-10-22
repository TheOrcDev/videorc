import type { WorkspaceTab } from '@/components/workspace-nav'
import type { BuddyTabId } from '@/lib/buddy-tabs'
import type { LivestreamViewId } from '@/lib/livestream-tabs'
import type { SettingsTabId } from '@/lib/settings-tabs'

// Opening a page from outside React (a toast action, a lib): one typed call
// instead of a hand-built CustomEvent, so a page id that does not exist is a
// compile error (plan 174, I-NEW: a toast sent `streaming`, which no page is
// called, and its button did nothing). AppShell reads the event back through
// `readWorkspaceNavigation` in workspace-nav.tsx.
//
// Type imports only: buddy-tabs, livestream-tabs and settings-tabs open their pages through
// here, so a runtime import back into them would be a cycle.

export const WORKSPACE_NAVIGATE_EVENT = 'videorc:navigate-workspace'

/** A page with no sub-tab of its own. */
export type PlainWorkspaceTab = Exclude<WorkspaceTab, 'settings' | 'ai' | 'library' | 'live'>

export type WorkspaceNavigation =
  | { tab: 'settings'; settingsTab?: SettingsTabId }
  | { tab: 'ai'; buddyTab?: BuddyTabId }
  | { tab: 'live'; livestreamView?: LivestreamViewId }
  | {
      tab: 'library'
      /** The session the action is about. The Library does not scroll to it yet. */
      sessionId?: string
    }
  | { tab: PlainWorkspaceTab }

/** Opens Settings on `settingsTab`, or on the tab used last. */
export function openWorkspaceTab(tab: 'settings', settingsTab?: SettingsTabId): void
/** Opens the Buddy page (id `ai`) on `buddyTab`, or on the tab used last. */
export function openWorkspaceTab(tab: 'ai', buddyTab?: BuddyTabId): void
/** Opens Livestream on `livestreamView` (Setup or Upcoming), or on the view used last. */
export function openWorkspaceTab(tab: 'live', livestreamView?: LivestreamViewId): void
/** Opens the Library, about `sessionId` when there is one. */
export function openWorkspaceTab(tab: 'library', sessionId?: string): void
export function openWorkspaceTab(tab: PlainWorkspaceTab): void
export function openWorkspaceTab(tab: WorkspaceTab, subTab?: string): void {
  window.dispatchEvent(
    new CustomEvent<WorkspaceNavigation>(WORKSPACE_NAVIGATE_EVENT, {
      detail: workspaceNavigation(tab, subTab)
    })
  )
}

function workspaceNavigation(tab: WorkspaceTab, subTab: string | undefined): WorkspaceNavigation {
  if (subTab === undefined) return { tab }
  switch (tab) {
    case 'settings':
      return { tab, settingsTab: subTab as SettingsTabId }
    case 'ai':
      return { tab, buddyTab: subTab as BuddyTabId }
    case 'live':
      return { tab, livestreamView: subTab as LivestreamViewId }
    case 'library':
      return { tab, sessionId: subTab }
    default:
      return { tab }
  }
}
