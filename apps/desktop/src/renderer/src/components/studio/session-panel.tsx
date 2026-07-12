import {
  Broadcast,
  CaretRight,
  FrameCorners,
  ImageSquare,
  Info,
  Record,
  StopCircle,
  type Icon
} from '@phosphor-icons/react'
import type { ReactElement, ReactNode } from 'react'

import { PanelSection } from '@/components/panel-section'
import { Button } from '@/components/ui/button'
import { Kbd } from '@/components/ui/kbd'
import { useWorkspaceNav } from '@/components/workspace-nav'
import { useStudioCore } from '@/hooks/use-studio'
import { outputSummary, streamingSummary } from '@/lib/studio-session-view'

// The session's primary actions rendered as a matched pair of glassy hero
// controls: taller, translucent, specular-shined (videorc-design glass tokens).
// Record/Stop keep the brand-red record accent; Stream is neutral glass.
const HERO_CONTROL = 'glass-shine h-11 flex-1 rounded-lg border font-semibold shadow-soft'

/**
 * Session panel (SD1): the glanceable session facts as a label→value list, plus
 * the Session Controls. Facts come straight from useStudio; the controls reuse
 * the transport handlers StudioTab owns (no second session state machine). The
 * Storage row is intentionally absent until F1 (disk-free space) lands — no
 * fake number. Navigable rows deep-link to the page that owns the setting.
 */
export function SessionPanel({
  active,
  startRequestPending,
  recordBlockedReason,
  liveStreamBlockedReason,
  blockedReason = null,
  blockedJump = null,
  canStop,
  stopLabel,
  onRecord,
  onLiveStream,
  onStop
}: {
  active: boolean
  startRequestPending: boolean
  recordBlockedReason: string | null
  liveStreamBlockedReason: string | null
  /** Why the session cannot start right now (hard block); rendered as a quiet
   * inline line next to the disabled controls — the former yellow top banner
   * (post-0.9.4 fix batch F8). */
  blockedReason?: string | null
  blockedJump?: {
    label: string
    to: Parameters<ReturnType<typeof useWorkspaceNav>['setActive']>[0]
  } | null
  canStop: boolean
  stopLabel: string
  onRecord: () => void
  onLiveStream: () => void
  onStop: () => void
}): ReactElement {
  const { captureConfig } = useStudioCore()
  const { openStudioPanel, setActive } = useWorkspaceNav()
  const video = captureConfig.video

  return (
    <PanelSection>
      <div className="flex flex-col gap-0.5">
        <SessionRow
          icon={Broadcast}
          label="Streaming"
          value={streamingSummary(captureConfig.streamEnabled, captureConfig.streaming.targets)}
          onNavigate={() => openStudioPanel('live')}
        />
        <SessionRow
          icon={FrameCorners}
          label="Output"
          value={outputSummary(video)}
          onNavigate={() => openStudioPanel('recording')}
        />
      </div>

      <div className="flex flex-col gap-2 border-t border-border pt-4">
        <div className="flex gap-2">
          {active ? (
            <Button
              className={`${HERO_CONTROL} border-destructive/30`}
              disabled={!canStop}
              variant="destructive"
              onClick={onStop}
            >
              <StopCircle data-icon="inline-start" weight="fill" />
              {stopLabel}
            </Button>
          ) : (
            <>
              <Button
                className={`${HERO_CONTROL} border-destructive/30`}
                disabled={Boolean(recordBlockedReason) || startRequestPending}
                title={recordBlockedReason ?? undefined}
                variant="destructive"
                onClick={onRecord}
              >
                <Record data-icon="inline-start" weight="fill" />
                Record
                <Kbd className="ml-1.5">␣</Kbd>
              </Button>
              <Button
                className={`${HERO_CONTROL} border-border bg-card/60 hover:border-foreground/20 hover:bg-[color-mix(in_oklch,var(--card),var(--foreground)_8%)]`}
                disabled={Boolean(liveStreamBlockedReason) || startRequestPending}
                title={liveStreamBlockedReason ?? undefined}
                variant="outline"
                onClick={onLiveStream}
              >
                <Broadcast data-icon="inline-start" weight="fill" />
                Stream
              </Button>
            </>
          )}
        </div>
        {!active && blockedReason ? (
          <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <Info className="size-3.5 shrink-0" />
            <span className="min-w-0">{blockedReason}</span>
            {blockedJump ? (
              <button
                className="shrink-0 font-medium text-foreground underline-offset-2 hover:underline"
                type="button"
                onClick={() => setActive(blockedJump.to)}
              >
                {blockedJump.label}
              </button>
            ) : null}
          </div>
        ) : null}
      </div>

      <TakeoverControls onOpenAssets={() => setActive('assets')} />
    </PanelSection>
  )
}

// The takeover on-air switch (its ONE home — the Assets grid manages images,
// this flips them). Live-safe: activation only needs the backend socket, so it
// works mid-session; a takeover replaces the output regardless of scene.
function TakeoverControls({ onOpenAssets }: { onOpenAssets: () => void }): ReactElement {
  const { activateScreen, activeScreen, clearActiveScreen, screens, wsStatus } = useStudioCore()
  const ready = screens.filter((screen) => screen.status !== 'missing')
  const disconnected = wsStatus !== 'connected'

  return (
    <div className="flex flex-col gap-2 border-t border-border pt-4">
      <span className="text-xs font-medium text-muted-foreground">Takeover</span>
      {ready.length === 0 ? (
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <ImageSquare className="size-3.5 shrink-0" weight="duotone" />
          <span className="min-w-0">No takeover screens yet.</span>
          <button
            className="shrink-0 font-medium text-foreground underline-offset-2 hover:underline"
            type="button"
            onClick={onOpenAssets}
          >
            Add in Assets
          </button>
        </div>
      ) : (
        <>
          <div className="flex flex-wrap gap-1.5">
            {ready.map((screen) => {
              const isActive = activeScreen?.id === screen.id
              return (
                <Button
                  aria-pressed={isActive}
                  disabled={disconnected}
                  key={screen.id}
                  size="sm"
                  title={
                    disconnected
                      ? `Backend socket is ${wsStatus}.`
                      : isActive
                        ? `Take ${screen.name} off the output`
                        : `Put ${screen.name} on the output`
                  }
                  variant={isActive ? 'default' : 'outline'}
                  onClick={() => void (isActive ? clearActiveScreen() : activateScreen(screen.id))}
                >
                  <ImageSquare data-icon="inline-start" weight={isActive ? 'fill' : 'duotone'} />
                  {screen.name}
                </Button>
              )
            })}
          </div>
          <span className="text-xs text-muted-foreground">
            {disconnected
              ? `Backend socket is ${wsStatus} — takeovers need the backend.`
              : activeScreen
                ? `${activeScreen.name} is covering the output. Click it to go back to the scene.`
                : 'Click a takeover to cover the output — works while live.'}
          </span>
        </>
      )}
    </div>
  )
}

// Label→value row. Navigable rows render as a button with a trailing caret and
// deep-link to the owning page; static facts (Status, Mode) render as a div.
function SessionRow({
  icon: RowIcon,
  label,
  value,
  onNavigate
}: {
  icon: Icon
  label: string
  value: ReactNode
  onNavigate?: () => void
}): ReactElement {
  const body = (
    <>
      <RowIcon className="size-4 shrink-0 text-muted-foreground" weight="duotone" />
      <span className="flex-1 truncate text-left text-muted-foreground">{label}</span>
      <span className="flex min-w-0 items-center gap-1.5 font-medium text-foreground">
        {typeof value === 'string' ? <span className="truncate">{value}</span> : value}
        {onNavigate ? <CaretRight className="size-3.5 shrink-0 text-muted-foreground" /> : null}
      </span>
    </>
  )

  if (onNavigate) {
    return (
      <button
        className="flex items-center gap-3 rounded-row px-2.5 py-2 text-sm transition-colors hover:bg-accent"
        type="button"
        onClick={onNavigate}
      >
        {body}
      </button>
    )
  }
  return <div className="flex items-center gap-3 rounded-row px-2.5 py-2 text-sm">{body}</div>
}
