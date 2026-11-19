import { HiddenIcon } from '@/components/icons'
import type { ReactElement } from 'react'

import { StatusBadge } from '@/components/status-badge'
import { useStudioCore } from '@/hooks/use-studio'
import {
  roomPrivacyLabel,
  screenHideAccelerator,
  screenPrivacyDisabledReason
} from '@/lib/screen-privacy-view'
import { toastUserError } from '@/lib/user-error'

// Plan 210 S8b: the Studio's one Hide screen state, for every Studio surface
// that shows the control: the scene on stream's Screen field and its Retro
// LCD row (plan 231 D8), and the Show stage's Screens while a room replaces
// the Preview (plan 254 D4). A mirror reads and acts through this hook, never
// a second state. Its own small module, so the Show stage's chunk takes the
// control without the Scenes section's.

/** What every Studio Hide screen control shows and does. */
export interface ScreenPrivacyControl {
  /** Plan 249: the room's own privacy state, while it says more than Hidden. */
  statusLabel?: string
  /** Plan 249: what the room confirmed, as the chip's tooltip. */
  observationDetail?: string
  hidden: boolean
  /** The bound key, absent when the streamer cleared it. */
  accelerator?: string
  platform?: string
  /** Why the action is off (a refused hide, Videorc offline), or null. */
  disabledReason: string | null
  toggle: () => void
}

/**
 * Plan 210 S8b: the one Studio Hide screen action, by the state it shows. A
 * failure says so; a refused hide is the hook's warning, and success is silent.
 */
export function useScreenPrivacyControl(): ScreenPrivacyControl {
  const {
    screenPrivacy: privacy,
    roomScreenPrivacy,
    hideScreen,
    showScreen,
    settings,
    runtimeInfo,
    wsStatus
  } = useStudioCore()
  // Plan 249: a room's screen share hides too; it holds whichever hid it.
  const hiddenNow = privacy.hidden || roomScreenPrivacy?.hidden === true
  return {
    statusLabel: roomPrivacyLabel(roomScreenPrivacy?.status),
    observationDetail: roomScreenPrivacy?.hidden
      ? `Source blocked: ${roomScreenPrivacy.sourceBlockedAt ?? 'unavailable'}. Applied frost observations: ${Object.keys(roomScreenPrivacy.observations).join(', ') || 'none'}. Other receivers remain unconfirmed.`
      : undefined,
    hidden: hiddenNow,
    accelerator: screenHideAccelerator(settings.globalShortcuts?.screenHideToggle),
    platform: runtimeInfo?.platform,
    disabledReason: screenPrivacyDisabledReason(
      { ...privacy, hidden: hiddenNow },
      wsStatus === 'connected'
    ),
    toggle: () => {
      const hidden = hiddenNow
      void (hidden ? showScreen() : hideScreen()).catch((error: unknown) =>
        toastUserError(
          error,
          { action: hidden ? 'show' : 'hide', object: 'your screen' },
          { id: 'screen-privacy' }
        )
      )
    }
  }
}

/**
 * The privacy chip beside a Hide screen control. In a room (plan 249) it can
 * say more than Hidden, and what the room confirmed is its tooltip.
 */
export function ScreenHiddenChip({
  value,
  detail
}: {
  value: string
  detail?: string
}): ReactElement {
  const chip = <StatusBadge icon={HiddenIcon} tone="warn" value={value} />
  return detail ? (
    <span className="flex" title={detail}>
      {chip}
    </span>
  ) : (
    chip
  )
}
