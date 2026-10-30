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
import { useUpdater } from '@/hooks/use-updater'
import { shortcutAriaKeys } from '@/lib/platform'
import { shortcutAccelerator } from '@/lib/shortcuts'
import { shortcutChipProps } from '@/lib/shortcut-overlay'
import { sessionClockLabel } from '@/lib/studio-session-view'
import { updateChip } from '@/lib/update-ui'
import {
  STUDIO_PANELS,
  WORKSPACE_TABS,
  shortcutDigitFor,
  sidebarOrderFor,
  type StudioPanel,
  type WorkspaceTab
} from '@/components/workspace-nav'
import type { EntitlementTier } from '@/lib/backend'
import type { SettingsTabId } from '@/lib/settings-tabs'
import { cn } from '@/lib/utils'

function NavRow({
  icon: RowIcon,
  label,
  isActive,
  triggerId,
  shortcutDigit,
  platform,
  shortcutVisible,
  shortcutIndex,
  trailing,
  onClick
}: {
  icon: AppIcon
  label: string
  isActive: boolean
  triggerId: string
  shortcutDigit?: string
  platform?: string
  shortcutVisible: boolean
  shortcutIndex: number
  /** What the row shows at its end while the shortcut chips are hidden. */
  trailing?: ReactNode
  onClick: () => void
}): ReactElement {
  const chip = shortcutChipProps(shortcutVisible, shortcutIndex)
  const trailingShown = Boolean(trailing) && !shortcutVisible
  return (
    <button
      type="button"
      aria-current={isActive ? 'page' : undefined}
      aria-keyshortcuts={
        shortcutDigit ? shortcutAriaKeys(`CmdOrCtrl+${shortcutDigit}`, platform) : undefined
      }
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
      {trailingShown ? trailing : null}
      {shortcutDigit ? (
        // Mounted whether or not it shows: reserving the width stops every
        // row from reflowing the instant ⌘ goes down. `aria-keyshortcuts` on
        // the button already tells assistive tech about the shortcut, so the
        // hidden chip is decoration and stays out of the accessibility tree.
        // A row with a trailing clock lends the chip its slot while ⌘ is held.
        <ShortcutKeys
          accelerator={`CmdOrCtrl+${shortcutDigit}`}
          platform={platform}
          {...chip}
          className={cn(chip.className, trailingShown && 'hidden')}
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
  return (
    <span
      aria-hidden
      className="flex shrink-0 items-center gap-1.5 text-xs tabular-nums text-muted-foreground"
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
            <TooltipTrigger asChild>
              <button
                aria-description={chip.detail}
                className="flex h-row-compact w-full items-center gap-2.5 rounded-row px-2.5 text-left text-sm text-foreground hover:bg-accent"
                type="button"
                onClick={() => (chip.action === 'install' ? install() : onOpenSettings())}
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
              </button>
            </TooltipTrigger>
            <TooltipContent side="top">{chip.detail}</TooltipContent>
          </Tooltip>
        </div>
      </div>
    </div>
  )
}

export function Sidebar({
  active,
  activeStudioPanel,
  accountTier,
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
  accountTier: EntitlementTier | null
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
  const tabsIn = (group: string): typeof WORKSPACE_TABS =>
    WORKSPACE_TABS.filter((tab) => tab.group === group)
  // Chips reveal while the command modifier is held — the shortcut layer
  // surfaces exactly when the user reaches for it (videorc-design keeps the
  // app keyboard-first; this keeps it quiet too).
  const shortcutVisible = useModifierHeld(platform)
  // The cascade is an inline delay, so no CSS variant can drop it for us.
  const reducedMotion = useReducedMotion()
  const trafficLightGutter = useTrafficLightGutter()

  const row = (
    tab: { id: WorkspaceTab; label: string; icon: AppIcon },
    trailing?: ReactNode
  ): ReactElement => (
    <NavRow
      key={tab.id}
      icon={tab.icon}
      label={tab.label}
      isActive={active === tab.id}
      triggerId={tab.id}
      shortcutDigit={shortcutDigitFor(tab.id)}
      shortcutIndex={reducedMotion ? 0 : sidebarOrderFor(tab.id)}
      platform={platform}
      shortcutVisible={shortcutVisible}
      trailing={trailing}
      onClick={() => onSelect(tab.id)}
    />
  )

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

      {/* Three zones (plan 174 D8): the stage rows, Setup (the one labelled
          group) and Library; Settings sits in a bottom block above the
          account row. Buddy stays second, directly under Studio, on ⌘9
          (owner call): it sells Premium. */}
      <nav
        aria-label="Primary"
        className="flex flex-1 flex-col gap-4 overflow-y-auto px-3 pt-1 pb-2"
      >
        <div className="flex flex-col gap-0.5">
          {tabsIn('stage').map((tab) =>
            row(
              tab,
              tab.id === 'studio' && statusPulse ? (
                <SessionClock startedAt={sessionStartedAt ?? undefined} tone={statusTone} />
              ) : undefined
            )
          )}
        </div>

        <div className="flex flex-col gap-0.5">
          <SectionLabel className="px-2.5 pb-1 leading-none">Setup</SectionLabel>
          {STUDIO_PANELS.map((panel) => (
            <NavRow
              key={panel.id}
              icon={panel.icon}
              label={panel.label}
              isActive={activeStudioPanel === panel.id}
              triggerId={panel.legacyTabId}
              shortcutDigit={shortcutDigitFor(panel.id)}
              shortcutIndex={reducedMotion ? 0 : sidebarOrderFor(panel.id)}
              platform={platform}
              shortcutVisible={shortcutVisible}
              onClick={() => onSelectStudioPanel(panel.id)}
            />
          ))}
        </div>

        <div className="flex flex-col gap-0.5">{tabsIn('library').map((tab) => row(tab))}</div>

        {/* Health (Diagnostics) is dev/forensic — kept out of the sidebar
            entirely. It stays reachable via ⌘K, the status bar and the account
            menu; the support-bundle export lives there. */}
        <div className="mt-auto flex flex-col gap-0.5" data-testid="sidebar-bottom">
          {tabsIn('system')
            .filter((tab) => tab.id !== 'diagnostics')
            .map((tab) => row(tab))}
        </div>
      </nav>

      <SidebarUpdateChip captureActive={live} onOpenSettings={() => onOpenSettings('about')} />

      <div className="flex min-h-11 items-center justify-between gap-2 border-t px-3 py-1.5">
        {/* Videorc product-account control. Backend status is secondary (a small
            dot on the trigger + the Health row); Health stays reachable here. */}
        <AccountMenu
          tier={accountTier}
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
