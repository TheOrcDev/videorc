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

type MicLevelMeterProps = Omit<
  ComponentProps<typeof LcdMeter>,
  'source' | 'peakDb' | 'rmsDb' | 'channels' | 'ballistics' | 'className' | 'children'
> & {
  meter: MeterInput
  /** The screen's place in the caller's layout (it lands on the bezel). */
  className?: string
}

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
function ZonedRows(): ReactElement {
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
      <LcdMeterScale />
      <LcdMeterClip className="data-clipping:bg-meter-clip" />
    </>
  )
}

/**
 * One microphone, System audio or Sounds level, whatever drives it (plans 092,
 * 093 and 196), on audiocn's LCD screen: segments, a held peak, the level in
 * digits, a printed scale and a CLIP flag. `LcdDisplay` keeps its defaults,
 * so the ink is Videorc's `--primary` and the screen follows the theme; the
 * segments turn amber and red where the old meter did. A live source moves
 * with `peak` ballistics; a plain reading arrives once a second at most, so
 * `vu` ballistics glide between readings. Shared by the Studio Microphone
 * section and the Sources rows, so they never drift apart.
 */
export function MicLevelMeter({ meter, className, ...props }: MicLevelMeterProps): ReactElement {
  return (
    <LcdDisplay className={className}>
      {meter.kind === 'source' ? (
        <LcdMeter ballistics="peak" source={meter.source} {...props}>
          <ZonedRows />
        </LcdMeter>
      ) : (
        <LcdMeter ballistics="vu" peakDb={meter.peakDb} {...props}>
          <ZonedRows />
        </LcdMeter>
      )}
    </LcdDisplay>
  )
}
