import { openWorkspaceTab } from '@/lib/workspace-navigation'

// Health stays out of the sidebar (plan 174 D9), so every place that sends
// the streamer there uses one door with one name: the status bar, the
// Studio's Degraded alert, an error toast with no known cause, About →
// Support and ⌘K.

/** The door's one label. */
export const OPEN_HEALTH_LABEL = 'Open Health'

/** Opens the Health page (id `diagnostics`). */
export function openHealth(): void {
  openWorkspaceTab('diagnostics')
}

/** A toast action that opens Health. */
export function openHealthToastAction(): { label: string; onClick: () => void } {
  return { label: OPEN_HEALTH_LABEL, onClick: openHealth }
}

/** What ⌘K matches to Health besides its name. */
export const HEALTH_SEARCH_KEYWORDS: readonly string[] = [
  'diagnostics',
  'support bundle',
  'logs',
  'problem',
  'bug',
  'report',
  'checks'
]
