import type { ReactElement } from 'react'

import { PowerSlider } from '@/components/power-slider'
import { useBackgroundAssets } from '@/hooks/use-background-assets'
import { useStudioCore } from '@/hooks/use-studio'
import type { EffectiveSceneBackground } from '@/lib/backend'
import { setLiveBackgroundSettings } from '@/lib/background-library'
import { isLiveBackgroundId } from '../../../../shared/live-background-ids'

/** Visibility's range in Assets (0–40) as the screen's share of the canvas. */
export const SCREEN_SIZE_MIN = 60
export const SCREEN_SIZE_MAX = 100
/** The background's default Visibility, 20: an 80% screen. */
const SCREEN_SIZE_DEFAULT = 80

/** The screen's share of the canvas for a background's Visibility. */
export function screenSizeOf(visibilityPercent: number): number {
  return SCREEN_SIZE_MAX - Math.min(Math.max(visibilityPercent, 0), 40)
}

/** The Visibility that gives the screen `screenSize` percent of the canvas. */
export function visibilityForScreenSize(screenSize: number): number {
  return SCREEN_SIZE_MAX - Math.min(Math.max(screenSize, SCREEN_SIZE_MIN), SCREEN_SIZE_MAX)
}

/**
 * "Screen size" (plan 213 G4): the scene background's Visibility, shown on
 * the Scene page beside the screen as what it does to the screen. It is the
 * same setting as Assets' Visibility, never a second one: Visibility 20 there
 * is an 80% screen here, and an edit here is an edit there. A live background
 * keeps it in its library settings, an image in the scene's background.
 */
export function ScreenSizeField({
  background,
  disabledReason
}: {
  background: EffectiveSceneBackground
  /** Why it can't change now (a recording or a livestream), or null. */
  disabledReason: string | null
}): ReactElement {
  const { applyWorkingBackgroundStyle } = useStudioCore()
  const { setRegistry } = useBackgroundAssets()
  const liveId =
    background.live && isLiveBackgroundId(background.live.id) ? background.live.id : null
  const setScreenSize = (screenSize: number): void => {
    const visibilityPercent = visibilityForScreenSize(screenSize)
    if (liveId)
      setRegistry((current) => setLiveBackgroundSettings(current, liveId, { visibilityPercent }))
    else applyWorkingBackgroundStyle({ visibilityPercent })
  }

  return (
    <div className="flex flex-col gap-1.5" data-videorc-screen-size>
      <PowerSlider
        defaultValue={SCREEN_SIZE_DEFAULT}
        disabled={disabledReason !== null}
        disabledReason={disabledReason ?? undefined}
        label="Screen size"
        max={SCREEN_SIZE_MAX}
        min={SCREEN_SIZE_MIN}
        numericInput
        suffix="%"
        value={screenSizeOf(background.visibilityPercent)}
        onChange={setScreenSize}
      />
      <p className="text-xs text-muted-foreground">
        How much of the canvas your screen fills. The background shows around it. This is the
        background&apos;s Visibility in Assets.
      </p>
    </div>
  )
}
