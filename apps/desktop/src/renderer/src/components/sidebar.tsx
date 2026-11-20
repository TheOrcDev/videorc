import { type AppIcon, SearchIcon, SyncIcon } from '@/components/icons'
import { useEffect, useState, type ReactElement, type ReactNode } from 'react'

import { AccountMenu } from '@/components/account-menu'
import { SectionLabel } from '@/components/section-label'
import { StatusDot, type StatusDotTone } from '@/components/status-dot'
import { ThemeToggle } from '@/components/theme-toggle'
import { Button } from '@/components/ui/button'
import { ShortcutKeys } from '@/components/ui/shortcut-keys'
import { ShortcutTooltip } from '@/components/ui/shortcut-tooltip'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useTrafficLightGutter } from '@/components/window-frame'
import { useModifierHeld } from '@/hooks/use-modifier-held'
import { useReducedMotion } from '@/hooks/use-reduced-motion'
import { useSessionElapsedMs } from '@/hooks/use-session-elapsed'
import { useStudioCloud } from '@/hooks/use-studio'
import { useUpdater } from '@/hooks/use-updater'
import { guestsVisible } from '@/lib/livestream-tabs'
import { shortcutAriaKeys } from '@/lib/platform'
import { shortcutAccelerator } from '@/lib/shortcuts'
import { shortcutChipProps } from '@/lib/shortcut-overlay'
import { sessionClockLabel } from '@/lib/studio-session-view'
import { updateChip } from '@/lib/update-ui'
import {
  SIDEBAR_ZONES,
  STUDIO_PANELS,
  pageShortcutFor,
  sidebarOrderFor,
  workspacePageMeta,
  type StudioPanel,
  type WorkspaceTab
} from '@/components/workspace-nav'
import type { EntitlementPlan, EntitlementTier } from '@/lib/backend'
import type { SettingsTabId } from '@/lib/settings-tabs'
import { cn } from '@/lib/utils'

function NavRow({
  icon: RowIcon,
  label,
  isActive,
  triggerId,
  shortcut,
  platform,
  shortcutVisible,
  shortcutIndex,
  onClick
}: {
  icon: AppIcon
  label: string
  isActive: boolean
  triggerId: string
  /** The page's shortcut as an accelerator (`pageShortcutFor`). */
  shortcut?: string
  platform?: string
  shortcutVisible: boolean
  shortcutIndex: number
  onClick: () => void
}): ReactElement {
  const chip = shortcutChipProps(shortcutVisible, shortcutIndex)
  return (
    <button
      type="button"
      aria-current={isActive ? 'page' : undefined}
      aria-keyshortcuts={shortcut ? shortcutAriaKeys(shortcut, platform) : undefined}
      data-videorc-tab-trigger={triggerId}
      onClick={onClick}
      className={cn(
        'group flex h-row-compact items-center gap-2.5 rounded-row px-2.5 text-sm',
        // The page you're on wears the chrome plate (plan 208 S4); hover stays
        // the flat block, so rows highlight instantly.
        isActive
          ? 'chrome-plate font-medium text-sidebar-accent-foreground'
          : 'text-muted-foreground hover:bg-sidebar-accent/60 hover:text-sidebar-foreground'
      )}
    >
      <RowIcon
        weight={isActive ? 'fill' : 'regular'}
        className={cn('size-4 shrink-0', isActive && 'text-primary')}
      />
      <span className="flex-1 truncate text-left">{label}</span>
      {shortcut ? (
        // Mounted whether or not it shows: reserving the width stops every
        // row from reflowing the instant ⌘ goes down. `aria-keyshortcuts` on
        // the button already tells assistive tech about the shortcut, so the
        // hidden chip is decoration and stays out of the accessibility tree.
        <ShortcutKeys accelerator={shortcut} platform={platform} {...chip} />
      ) : null}
    </button>
  )
}

/**
 * On the slab the gray glass keycap would read at about 1.5:1, so the chip
 * takes the slab's own ink on a faint fill of it, as it does inside the
 * chrome primary (`KBD_ON_FILLED_BUTTON` in ui/kbd.tsx). Important, so the
 * keycap's own glass never wins on source order.
 */
const KBD_ON_SLAB = 'border-current/30! bg-current/10 bg-none! text-current shadow-none!'

/**
 * The Studio row (plan 235 D5): the way home, so it is the sidebar's big
 * button. A 40 px slab of the chrome primary's metal (`chrome-fill`: polished
 * silver in dark, black chrome in light) that it wears on every page; its
 * icon fills while Studio is the page you're on. The shortcut chip and the
 * session clock sit where a row keeps them, in the slab's ink. Red metal stays
 * Record's and live's alone (plan 208 D8).
 */
function StudioNavButton({
  icon: SlabIcon,
  label,
  isActive,
  shortcut,
  platform,
  shortcutVisible,
  trailing,
  onClick
}: {
  icon: AppIcon
  label: string
  isActive: boolean
  shortcut?: string
  platform?: string
  shortcutVisible: boolean
  /** The session clock, shown while the shortcut chips are hidden. */
  trailing?: ReactNode
  onClick: () => void
}): ReactElement {
  const chip = shortcutChipProps(shortcutVisible, 0)
  const trailingShown = Boolean(trailing) && !shortcutVisible
  return (
    <button
      type="button"
      aria-current={isActive ? 'page' : undefined}
      aria-keyshortcuts={shortcut ? shortcutAriaKeys(shortcut, platform) : undefined}
      data-videorc-tab-trigger="studio"
      data-testid="sidebar-studio-slab"
      onClick={onClick}
      className="chrome-fill flex h-10 items-center gap-2.5 rounded-row px-2.5 text-sm font-medium"
    >
      <SlabIcon weight={isActive ? 'fill' : 'regular'} className="size-5 shrink-0" />
      <span className="flex-1 truncate text-left">{label}</span>
      {trailingShown ? trailing : null}
      {shortcut ? (
        // The clock lends the chip its slot while ⌘ is held.
        <ShortcutKeys
          accelerator={shortcut}
          platform={platform}
          {...chip}
          className={cn(chip.className, KBD_ON_SLAB, trailingShown && 'hidden')}
        />
      ) : null}
    </button>
  )
}

/**
 * The Studio row's clock while a session runs (plan 174 D8): the live dot
 * and the elapsed time, so the state shows from every page. It ticks here,
 * so only this leaf re-renders each second. The status bar announces the
 * state; this is a repeat for the eye, hidden from assistive tech.
 */
function SessionClock({
  startedAt,
  tone
}: {
  startedAt: string | undefined
  tone: StatusDotTone
}): ReactElement {
  const elapsedMs = useSessionElapsedMs(startedAt)
  // It sits on the Studio slab, so it takes the slab's ink (plan 235 D5).
  return (
    <span
      aria-hidden
      className="flex shrink-0 items-center gap-1.5 text-xs font-medium tabular-nums"
      data-testid="sidebar-session-clock"
    >
      <StatusDot pulse tone={tone} />
      {sessionClockLabel(elapsedMs)}
    </span>
  )
}

/**
 * Update chip above the account row (post-0.9.4 fix batch F6): appears only
 * while an update is in flight or ready. Clicking installs when that is safe
 * (downloaded + no live capture); otherwise it jumps to Settings → About,
 * which owns the full update story. Its name is its visible words, with the
 * version in the description and the tooltip (plan 174 A-25), and the dot is
 * green only when a click installs.
 */
function SidebarUpdateChip({
  captureActive,
  onOpenSettings
}: {
  captureActive: boolean
  onOpenSettings: () => void
}): ReactElement | null {
  const { status, install } = useUpdater()
  const chip = updateChip(status, captureActive)
  const hasChip = Boolean(chip)
  // The chip appears mid-session (updater status lands after launch); sliding
  // it open keeps the account row from teleporting down when it mounts.
  const [expanded, setExpanded] = useState(false)
  useEffect(() => {
    setExpanded(hasChip)
  }, [hasChip])
  if (!chip) {
    return null
  }
  return (
    <div
      className={cn(
        'grid transition-[grid-template-rows] duration-150 ease-out',
        expanded ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]'
      )}
    >
      <div className="overflow-hidden">
        <div className="px-3 pb-1">
          <Tooltip>
            <TooltipTrigger
              render={
                <button
                  aria-description={chip.detail}
                  className="flex h-row-compact w-full items-center gap-2.5 rounded-row px-2.5 text-left text-sm text-foreground hover:bg-accent"
                  type="button"
                  onClick={() => (chip.action === 'install' ? install() : onOpenSettings())}
                />
              }
            >
              <span className="relative flex size-4 shrink-0 items-center justify-center">
                <SyncIcon className="size-4 text-muted-foreground" />
                <span
                  className={cn(
                    'absolute -right-0.5 -top-0.5 size-1.5 rounded-full glass-dot',
                    chip.tone === 'good' ? 'tone-success' : 'tone-neutral'
                  )}
                />
              </span>
              <span className="min-w-0 flex-1 truncate">{chip.label}</span>
            </TooltipTrigger>
            <TooltipContent side="top">{chip.detail}</TooltipContent>
          </Tooltip>
        </div>
      </div>
    </div>
  )
}

/**
 * The Guests row shows only with talk shows (plan 224 D16), the same rule as
 * ⌘K. Its own component, so only it follows the cloud's status.
 */
function GuestsRow({ children }: { children: ReactElement }): ReactElement | null {
  return guestsVisible(useStudioCloud().cloudStatus) ? children : null
}

export function Sidebar({
  active,
  activeStudioPanel,
  accountPlan = null,
  accountTier,
  accountNeedsSignIn = false,
  onSelect,
  onSelectStudioPanel,
  onOpenSettings,
  statusTone,
  statusLabel,
  statusPulse,
  sessionStartedAt,
  live,
  onOpenCommand,
  platform
}: {
  active: WorkspaceTab
  activeStudioPanel: StudioPanel | null
  /** `max` labels the account Max (plan 185 T4). */
  accountPlan?: EntitlementPlan | null
  accountTier: EntitlementTier | null
  /** Chat or Buddy waits on the Videorc sign-in (plan 215 A5): a dot on the account button. */
  accountNeedsSignIn?: boolean
  onSelect: (tab: WorkspaceTab) => void
  onSelectStudioPanel: (panel: StudioPanel) => void
  /** Opens Settings on a named tab (plan 064), or on the one used last. */
  onOpenSettings: (tab?: SettingsTabId) => void
  statusTone: StatusDotTone
  statusLabel: string
  /** Only while recording or on air (plan 174 S1.3). */
  statusPulse: boolean
  /** When the running session started; the Studio row's clock counts from it. */
  sessionStartedAt?: string | null
  live: boolean
  onOpenCommand: () => void
  platform?: string
}): ReactElement {
  // Chips reveal while the command modifier is held — the shortcut layer
  // surfaces exactly when the user reaches for it (videorc-design keeps the
  // app keyboard-first; this keeps it quiet too).
  const shortcutVisible = useModifierHeld(platform)
  // The cascade is an inline delay, so no CSS variant can drop it for us.
  const reducedMotion = useReducedMotion()
  const trafficLightGutter = useTrafficLightGutter()

  const pageRow = (tab: WorkspaceTab): ReactElement => {
    const page = workspacePageMeta(tab)
    const panel = STUDIO_PANELS.find((entry) => entry.id === tab)
    return (
      <NavRow
        key={tab}
        icon={page.icon}
        label={page.label}
        isActive={panel ? activeStudioPanel === panel.id : active === tab}
        // The panels keep their pre-rail trigger ids (`streaming` for
        // Destinations), so smokes and automation keep working.
        triggerId={panel?.legacyTabId ?? tab}
        shortcut={pageShortcutFor(tab)}
        shortcutIndex={reducedMotion ? 0 : sidebarOrderFor(tab)}
        platform={platform}
        shortcutVisible={shortcutVisible}
        onClick={() => (panel ? onSelectStudioPanel(panel.id) : onSelect(tab))}
      />
    )
  }
  const studio = workspacePageMeta('studio')
  const zones = SIDEBAR_ZONES.filter((zone) => zone.id !== 'stage' && zone.id !== 'system')
  const system = SIDEBAR_ZONES.find((zone) => zone.id === 'system')?.pages ?? []

  return (
    // The sidebar coat (plan 091, D3/D4): the delta that takes the body's
    // cover up to the sidebar's, so the sidebar is the heavier, more covered
    // region, as in Ghostex. The pane's own tone comes from the same base as
    // the window coat; this is never a white tint (plan 050 found one dropped
    // secondary text under 4.5:1 over a bright desktop).
    <aside className="flex w-52 shrink-0 flex-col border-r bg-glass-sidebar text-sidebar-foreground">
      {/* The top row shares the window's 40 px header band with the toolbar:
          the traffic lights, then Search. The brand lives in About and the
          Dock; on Windows the native title bar already carries it, so the row
          repeats nothing (plan 174 D18). */}
      <div
        className={cn(
          'flex h-toolbar shrink-0 items-center justify-end pr-2 [-webkit-app-region:drag]',
          trafficLightGutter
        )}
      >
        <ShortcutTooltip
          accelerator={shortcutAccelerator('search')}
          label="Search"
          platform={platform}
        >
          <Button
            aria-keyshortcuts={shortcutAriaKeys(shortcutAccelerator('search'), platform)}
            aria-label="Search"
            className="text-muted-foreground [-webkit-app-region:no-drag]"
            size="icon"
            type="button"
            variant="ghost"
            onClick={onOpenCommand}
          >
            <SearchIcon className="size-4" />
          </Button>
        </ShortcutTooltip>
      </div>

      {/* The zones (plan 174 D8, plan 235): Studio leads as the chrome slab,
          then the two labelled groups, Setup and Livestream (Destinations,
          Guests, Avatar and Sidekick, which keeps every feature: it sells
          Premium); Library and Settings sit in a bottom block above the
          account row (owner 2026-11-20). ⌘1–⌘9 run down the top rows in
          order; Library is ⇧⌘L and Settings ⌘,. */}
      <nav
        aria-label="Primary"
        className="flex flex-1 flex-col gap-4 overflow-y-auto px-3 pt-1 pb-2"
      >
        <StudioNavButton
          icon={studio.icon}
          label={studio.label}
          isActive={active === 'studio'}
          shortcut={pageShortcutFor('studio')}
          platform={platform}
          shortcutVisible={shortcutVisible}
          trailing={
            statusPulse ? (
              <SessionClock startedAt={sessionStartedAt ?? undefined} tone={statusTone} />
            ) : undefined
          }
          onClick={() => onSelect('studio')}
        />

        {zones.map((zone) => (
          <div key={zone.id} className="flex flex-col gap-0.5" data-sidebar-zone={zone.id}>
            {zone.label ? (
              <SectionLabel className="px-2.5 pb-1 leading-none">{zone.label}</SectionLabel>
            ) : null}
            {zone.pages.map((tab) =>
              tab === 'guests' ? <GuestsRow key={tab}>{pageRow(tab)}</GuestsRow> : pageRow(tab)
            )}
          </div>
        ))}

        {/* Health (Diagnostics) is dev/forensic — kept out of the sidebar
            entirely. It stays reachable via ⌘K, the status bar and the account
            menu; the support-bundle export lives there. */}
        <div className="mt-auto flex flex-col gap-0.5" data-testid="sidebar-bottom">
          {system.map((tab) => pageRow(tab))}
        </div>
      </nav>

      <SidebarUpdateChip captureActive={live} onOpenSettings={() => onOpenSettings('about')} />

      <div className="flex min-h-11 items-center justify-between gap-2 border-t px-3 py-1.5">
        {/* Videorc product-account control. Backend status is secondary (a small
            dot on the trigger + the Health row); Health stays reachable here. */}
        <AccountMenu
          plan={accountPlan}
          tier={accountTier}
          needsSignIn={accountNeedsSignIn}
          statusTone={statusTone}
          statusLabel={statusLabel}
          statusPulse={statusPulse}
          live={live}
          onOpenHealth={() => onSelect('diagnostics')}
          onOpenSettings={() => onSelect('settings')}
        />
        <ThemeToggle />
      </div>
    </aside>
  )
}
