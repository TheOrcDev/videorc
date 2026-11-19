// Plan 250 (D4): "Quiet while recording or live", the one switch in
// Settings, General. On by default: an absent key is on.

import type { SettingsState } from '@/lib/capture'

export const QUIET_WHILE_LIVE_LABEL = 'Quiet while recording or live'
export const QUIET_WHILE_LIVE_DESCRIPTION =
  'Only urgent problems pop up. Everything else waits in Notifications.'

export function quietWhileLiveOn(settings: Pick<SettingsState, 'quietWhileLive'>): boolean {
  return settings.quietWhileLive !== false
}

/** The line under the list: what the rule is doing right now. */
export function quietFooterLine(settings: Pick<SettingsState, 'quietWhileLive'>): string {
  return quietWhileLiveOn(settings)
    ? 'Quiet while recording or live.'
    : 'Quiet is off while recording or live.'
}
