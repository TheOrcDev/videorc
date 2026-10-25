import type { ComponentProps, CSSProperties, ReactElement } from 'react'

import { LcdDisplay } from '@/components/ui/lcd-display'
import {
  LcdMeter,
  LcdMeterBar,
  LcdMeterChannel,
  LcdMeterClip,
  LcdMeterHold,
  LcdMeterLabel,
  LcdMeterScale,
  LcdMeterTrack,
  LcdMeterValue
} from '@/components/ui/lcd-meter'
import { useLevelMeter } from '@/components/ui/level-meter'
import type { MeterZone, MeterZoneName, Taper } from '@/lib/audio/types'
import type { MeterInput } from '@/lib/mic-meter-input'
import { cn } from '@/lib/utils'

type MicLevelMeterProps = Omit<
  ComponentProps<typeof LcdMeter>,
  'source' | 'peakDb' | 'rmsDb' | 'channels' | 'ballistics' | 'className' | 'children'
> & {
  meter: MeterInput
  /** The screen's place in the caller's layout (it lands on the bezel). */
  className?: string
  /** Print the dB numbers and the clip bracket under the segments. Default true. */
  scale?: boolean
}

/**
 * The screen on Videorc's glass. The bezel is a glass chip in both themes (the
 * chip tokens: fill, rim, top highlight, drop). In dark the screen lets the
 * window glass through instead of an opaque black well, with a softer recess
 * and fainter scanlines. Each base variable is set again under `dark:` so it
 * replaces the screen's own dark value.
 */
const ON_GLASS = [
  '[--lcd-display-bezel:var(--chip-fill-top)] dark:[--lcd-display-bezel:var(--chip-fill-top)]',
  '[--lcd-display-bezel-edge:var(--chip-fill-bottom)] dark:[--lcd-display-bezel-edge:var(--chip-fill-bottom)]',
  '[--lcd-display-bezel-ring:var(--chip-rim)] dark:[--lcd-display-bezel-ring:var(--chip-rim)]',
  '[--lcd-display-bezel-shadow:inset_0_1px_0_var(--chip-highlight),0_1px_2px_var(--chip-drop)] dark:[--lcd-display-bezel-shadow:inset_0_1px_0_var(--chip-highlight),0_1px_2px_var(--chip-drop)]',
  'dark:[--lcd-display-glass:color-mix(in_oklab,var(--glass-solid)_35%,transparent)]',
  'dark:[--lcd-display-recess:inset_0_1px_3px_var(--chip-drop),inset_0_0_0_1px_var(--chip-drop)]',
  'dark:[--lcd-display-scanline:color-mix(in_oklab,var(--chip-drop)_30%,transparent)]'
].join(' ')

/**
 * The colours of the segmented meter the LCD replaced: the screen's own ink
 * below −20 dB, the meter's warning amber from −20 and its red from −9
 * (`DEFAULT_ZONES`).
 */
const ZONE_INK: Record<MeterZoneName, string> = {
  ok: 'var(--lcd-display-lit)',
  warn: 'var(--meter-warn)',
  clip: 'var(--meter-clip)'
}

/** Hard stops along the track, so each segment lights in its zone's colour. */
function zoneFill(zones: MeterZone[], taper: Taper): string {
  const sorted = [...zones].sort((left, right) => left.fromDb - right.fromDb)
  const starts = sorted.map((zone) => Number((taper.toPosition(zone.fromDb) * 100).toFixed(3)))
  const stops = sorted.map(
    (zone, index) => `${ZONE_INK[zone.zone]} ${starts[index] ?? 0}% ${starts[index + 1] ?? 100}%`
  )
  return `linear-gradient(to right, ${stops.join(', ')})`
}

/**
 * The held peak as one segment of the full-width zone fill, clipped where
 * `LcdMeterHold` would sit, so it takes the colour of the zone it holds in.
 */
const HELD_IN_ZONE =
  'left-0 w-full bg-(image:--mic-meter-zones) [clip-path:inset(0_calc(100%_-_round(up,_var(--meter-hold)_*_100%,_var(--lcd-meter-period))_+_var(--lcd-meter-gap))_0_calc(round(up,_var(--meter-hold)_*_100%,_var(--lcd-meter-period))_-_var(--lcd-meter-period)))]'

/** The digits take the zone of the level they print. */
const VALUE_IN_ZONE =
  'data-[zone=clip]:text-meter-clip-foreground data-[zone=warn]:text-meter-warn-foreground'

/** L and R for a pair, numbers for more, nothing for one, as `LcdMeter` labels them. */
function channelLabel(index: number, count: number): string | null {
  if (count === 2) return index === 0 ? 'L' : 'R'
  return count > 2 ? String(index + 1) : null
}

/** `LcdMeter`'s own rows, with the segments, held peak and digits in zone colours. */
function ZonedRows({ scale }: { scale: boolean }): ReactElement {
  const { channelCount, taper, zones } = useLevelMeter('MicLevelMeter')
  const track = { '--mic-meter-zones': zoneFill(zones, taper) } as CSSProperties
  return (
    <>
      {Array.from({ length: channelCount }, (_, index) => {
        const label = channelLabel(index, channelCount)
        return (
          <LcdMeterChannel index={index} key={`channel-${index}`}>
            {label ? <LcdMeterLabel>{label}</LcdMeterLabel> : null}
            <LcdMeterTrack style={track}>
              <LcdMeterBar className="bg-(image:--mic-meter-zones)" />
              <LcdMeterHold className={HELD_IN_ZONE} />
            </LcdMeterTrack>
            <LcdMeterValue className={VALUE_IN_ZONE} zones={zones} />
          </LcdMeterChannel>
        )
      })}
      {scale ? <LcdMeterScale /> : null}
      {/* The lit flag's words in the opaque solid: the dark screen colour is
          translucent now, so it would let the red through. */}
      <LcdMeterClip className="data-clipping:bg-meter-clip data-clipping:text-(--glass-solid)" />
    </>
  )
}

/**
 * One microphone, System audio or Sounds level, whatever drives it (plans 092,
 * 093 and 196), on audiocn's LCD screen: segments, a held peak, the level in
 * digits, a printed scale (unless `scale` is off) and a CLIP flag. The ink
 * is Videorc's `--primary` and the screen follows the theme, on the app's
 * glass (`ON_GLASS`); the segments turn amber and red where the old meter
 * did. A live source moves with `peak` ballistics; a plain reading arrives
 * once a second at most, so `vu` ballistics glide between readings. Shared by
 * the Studio Microphone section and the Sources rows, so they never drift
 * apart.
 */
export function MicLevelMeter({
  meter,
  className,
  scale = true,
  ...props
}: MicLevelMeterProps): ReactElement {
  return (
    <LcdDisplay className={cn(ON_GLASS, className)}>
      {meter.kind === 'source' ? (
        <LcdMeter ballistics="peak" source={meter.source} {...props}>
          <ZonedRows scale={scale} />
        </LcdMeter>
      ) : (
        <LcdMeter ballistics="vu" peakDb={meter.peakDb} {...props}>
          <ZonedRows scale={scale} />
        </LcdMeter>
      )}
    </LcdDisplay>
  )
}
