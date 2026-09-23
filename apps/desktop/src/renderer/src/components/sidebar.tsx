import { type AppIcon, SearchIcon, SyncIcon } from '@/components/icons'
import { useEffect, useState, type ReactElement } from 'react'

import logoUrl from '@/assets/videorc-logo.png'
import { AccountMenu } from '@/components/account-menu'
import { type StatusDotTone } from '@/components/status-dot'
import { ThemeToggle } from '@/components/theme-toggle'
import { Button } from '@/components/ui/button'
import { Kbd } from '@/components/ui/kbd'
import { useTrafficLightGutter } from '@/components/window-frame'
import { useModifierHeld } from '@/hooks/use-modifier-held'
import { usePrefersReducedMotion } from '@/hooks/use-reduced-motion'
import { displayKeyGlyph } from '@/lib/platform'
import { shortcutChipProps } from '@/lib/shortcut-overlay'
import { useUpdater } from '@/hooks/use-updater'
import { updateChip } from '@/lib/update-ui'
import {
  STUDIO_PANELS,
  WORKSPACE_TABS,
  shortcutDigitFor,
  shortcutOrderFor,
  type StudioPanel,
  type WorkspaceTab
} from '@/components/workspace-nav'
import type { EntitlementTier } from '@/lib/backend'
import { cn } from '@/lib/utils'

function NavRow({
  icon: RowIcon,
  label,
  isActive,
  triggerId,
  shortcutDigit,
  modKey,
  shortcutVisible,
  shortcutIndex,
  onClick
}: {
  icon: AppIcon
  label: string
  isActive: boolean
  triggerId: string
  shortcutDigit?: string
  modKey: string
  shortcutVisible: boolean
  shortcutIndex: number
  onClick: () => void
}): ReactElement {
  return (
    <button
      type="button"
      aria-current={isActive ? 'page' : undefined}
      aria-keyshortcuts={shortcutDigit ? `Meta+${shortcutDigit}` : undefined}
      data-videorc-tab-trigger={triggerId}
      onClick={onClick}
      className={cn(
        'group flex h-row-compact items-center gap-2.5 rounded-row px-2.5 text-sm',
        isActive
          ? 'bg-sidebar-accent font-medium text-sidebar-accent-foreground'
          : 'text-muted-foreground hover:bg-sidebar-accent/60 hover:text-sidebar-foreground'
      )}
    >
      <RowIcon
        weight={isActive ? 'fill' : 'regular'}
        className={cn('size-4 shrink-0', isActive && 'text-primary')}
      />
      <span className="flex-1 truncate text-left">{label}</span>
      {shortcutDigit ? (
        // Mounted whether or not it shows: reserving the width stops every
        // row from reflowing the instant ⌘ goes down. `aria-keyshortcuts` on
        // the button already tells assistive tech about the shortcut, so the
        // hidden chip is decoration and stays out of the accessibility tree.
        <Kbd {...shortcutChipProps(shortcutVisible, shortcutIndex)}>
          {modKey}
          {shortcutDigit}
        </Kbd>
      ) : null}
    </button>
  )
}

function GroupLabel({ children }: { children: string }): ReactElement {
  return (
    <span className="px-2.5 pb-1 text-[11px] leading-none font-semibold text-subtle">
      {children}
    </span>
  )
}

/**
 * Update chip above the account row (post-0.9.4 fix batch F6): appears only
 * while an update is in flight or ready. Clicking installs when that is safe
 * (downloaded + no live capture); otherwise it jumps to Settings → About,
 * which owns the full update story.
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
          <button
            className="flex h-row-compact w-full items-center gap-2.5 rounded-row px-2.5 text-left text-sm text-foreground hover:bg-accent"
            type="button"
            onClick={() => (chip.action === 'install' ? install() : onOpenSettings())}
          >
            <span className="relative flex size-4 shrink-0 items-center justify-center">
              <SyncIcon className="size-4 text-muted-foreground" />
              <span className="absolute -right-0.5 -top-0.5 size-1.5 rounded-full glass-dot tone-success" />
            </span>
            <span className="min-w-0 flex-1 truncate">{chip.label}</span>
          </button>
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
  statusTone,
  statusLabel,
  live,
  onOpenCommand,
  platform
}: {
  active: WorkspaceTab
  activeStudioPanel: StudioPanel | null
  accountTier: EntitlementTier | null
  onSelect: (tab: WorkspaceTab) => void
  onSelectStudioPanel: (panel: StudioPanel) => void
  statusTone: StatusDotTone
  statusLabel: string
  live: boolean
  onOpenCommand: () => void
  platform?: string
}): ReactElement {
  const tabsIn = (group: string): typeof WORKSPACE_TABS =>
    WORKSPACE_TABS.filter((tab) => tab.group === group)
  const modKey = displayKeyGlyph('⌘', platform)
  // Chips reveal while the command modifier is held — the shortcut layer
  // surfaces exactly when the user reaches for it (videorc-design keeps the
  // app keyboard-first; this keeps it quiet too).
  const shortcutVisible = useModifierHeld(platform)
  // The cascade is an inline delay, so no CSS variant can drop it for us.
  const reducedMotion = usePrefersReducedMotion()
  const trafficLightGutter = useTrafficLightGutter()

  return (
    // No fill of its own: the sidebar sits on the window coat alone, which is
    // what makes it read lighter than the content pane (plan 050 D3). A white
    // tint here dropped secondary text under 4.5:1 over a bright desktop.
    <aside className="flex w-52 shrink-0 flex-col border-r text-sidebar-foreground">
      {/* The top row shares the window's 40 px header band with the toolbar.
          macOS: traffic lights, then search; the brand lives in About and the
          Dock. Windows has no traffic lights, and its title bars lead with the
          app icon and name, so the row does too (the win32 variant, from the
          first paint). */}
      <div
        className={cn(
          'flex h-toolbar shrink-0 items-center justify-end pr-2 [-webkit-app-region:drag]',
          trafficLightGutter
        )}
      >
        <span className="mr-auto hidden items-center gap-2 text-xs win32:flex">
          <img alt="" className="size-4" src={logoUrl} />
          Videorc
        </span>
        <Button
          aria-keyshortcuts="Meta+K"
          aria-label={`Search (${modKey}K)`}
          className="text-muted-foreground [-webkit-app-region:no-drag]"
          size="icon-sm"
          title={`Search (${modKey}K)`}
          type="button"
          variant="ghost"
          onClick={onOpenCommand}
        >
          <SearchIcon className="size-4" />
        </Button>
      </div>

      {/* Four zones (ux-ia-refactor-plan): stage row, SETUP, LIBRARY, SYSTEM. */}
      <nav
        aria-label="Primary"
        className="flex flex-1 flex-col gap-4 overflow-y-auto px-3 pt-1 pb-2"
      >
        <div className="flex flex-col gap-0.5">
          {tabsIn('stage').map((tab) => (
            <NavRow
              key={tab.id}
              icon={tab.icon}
              label={tab.label}
              isActive={active === tab.id}
              triggerId={tab.id}
              shortcutDigit={shortcutDigitFor(tab.id)}
              shortcutIndex={reducedMotion ? 0 : shortcutOrderFor(tab.id)}
              modKey={modKey}
              shortcutVisible={shortcutVisible}
              onClick={() => onSelect(tab.id)}
            />
          ))}
        </div>

        <div className="flex flex-col gap-0.5">
          <GroupLabel>Setup</GroupLabel>
          {STUDIO_PANELS.map((panel) => (
            <NavRow
              key={panel.id}
              icon={panel.icon}
              label={panel.label}
              isActive={activeStudioPanel === panel.id}
              triggerId={panel.legacyTabId}
              shortcutDigit={shortcutDigitFor(panel.id)}
              shortcutIndex={reducedMotion ? 0 : shortcutOrderFor(panel.id)}
              modKey={modKey}
              shortcutVisible={shortcutVisible}
              onClick={() => onSelectStudioPanel(panel.id)}
            />
          ))}
        </div>

        <div className="flex flex-col gap-0.5">
          <GroupLabel>Library</GroupLabel>
          {tabsIn('library').map((tab) => (
            <NavRow
              key={tab.id}
              icon={tab.icon}
              label={tab.label}
              isActive={active === tab.id}
              triggerId={tab.id}
              shortcutDigit={shortcutDigitFor(tab.id)}
              shortcutIndex={reducedMotion ? 0 : shortcutOrderFor(tab.id)}
              modKey={modKey}
              shortcutVisible={shortcutVisible}
              onClick={() => onSelect(tab.id)}
            />
          ))}
        </div>

        <div className="flex flex-col gap-0.5">
          <GroupLabel>System</GroupLabel>
          {/* Health (Diagnostics) is dev/forensic — kept out of the sidebar
              entirely. It stays reachable via ⌘K and the account menu; the
              support-bundle export lives in Settings. */}
          {tabsIn('system')
            .filter((tab) => tab.id !== 'diagnostics')
            .map((tab) => (
              <NavRow
                key={tab.id}
                icon={tab.icon}
                label={tab.label}
                isActive={active === tab.id}
                triggerId={tab.id}
                shortcutDigit={shortcutDigitFor(tab.id)}
                shortcutIndex={reducedMotion ? 0 : shortcutOrderFor(tab.id)}
                modKey={modKey}
                shortcutVisible={shortcutVisible}
                onClick={() => onSelect(tab.id)}
              />
            ))}
        </div>
      </nav>

      <SidebarUpdateChip captureActive={live} onOpenSettings={() => onSelect('settings')} />

      <div className="flex min-h-11 items-center justify-between gap-2 border-t px-3 py-1.5">
        {/* Videorc product-account control. Backend status is secondary (a small
            dot on the trigger + the Health row); Health stays reachable here. */}
        <AccountMenu
          tier={accountTier}
          statusTone={statusTone}
          statusLabel={statusLabel}
          live={live}
          onOpenHealth={() => onSelect('diagnostics')}
          onOpenSettings={() => onSelect('settings')}
        />
        <ThemeToggle />
      </div>
    </aside>
  )
}
