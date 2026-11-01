import { useContext, type ComponentProps, type CSSProperties, type ReactElement } from 'react'

import { LCD_ON_GLASS, StudioLookContext, type StudioLook } from '@/components/lcd-panel'
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
import { LevelMeter, useLevelMeter } from '@/components/ui/level-meter'
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
  /** On the LCD, print the dB numbers and the clip bracket under the segments. Default true. */
  scale?: boolean
  /** The segmented bar, or the LCD screen (Retro LCD). Default: the page's look. */
  look?: StudioLook
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
 * The meter alone, for a screen that holds other rows too: the Studio's
 * Microphone screen puts it under the microphone's dropdown (plan 197). It
 * takes the screen's size and ink.
 */
export function MicLcdMeter({
  meter,
  scale = true,
  ...props
}: Omit<MicLevelMeterProps, 'className'>): ReactElement {
  return meter.kind === 'source' ? (
    <LcdMeter ballistics="peak" source={meter.source} {...props}>
      <ZonedRows scale={scale} />
    </LcdMeter>
  ) : (
    <LcdMeter ballistics="vu" peakDb={meter.peakDb} {...props}>
      <ZonedRows scale={scale} />
    </LcdMeter>
  )
}

/**
 * One microphone, System audio or Sounds level, whatever drives it (plans 092
 * and 093): a live source moves with `peak` ballistics; a plain reading
 * arrives once a second at most, so `vu` ballistics glide between readings.
 * Shared by the Studio Microphone section and the Sources rows, so the two
 * never drift apart. It is the segmented bar, or with Retro LCD (plan 197;
 * `look`, or the page's `StudioLookContext`) audiocn's LCD screen on the
 * app's glass (plan 196): segments that turn amber and red where the bar
 * does, a held peak, the level in digits, a printed scale (unless `scale` is
 * off) and a CLIP flag.
 */
export function MicLevelMeter({
  className,
  look,
  scale,
  ...props
}: MicLevelMeterProps): ReactElement {
  const pageLook = useContext(StudioLookContext)
  if ((look ?? pageLook) === 'lcd') {
    return (
      <LcdDisplay className={cn(LCD_ON_GLASS, className)}>
        <MicLcdMeter scale={scale} {...props} />
      </LcdDisplay>
    )
  }
  const { meter, ...rest } = props
  return meter.kind === 'source' ? (
    <LevelMeter
      ballistics="peak"
      className={className}
      orientation="horizontal"
      source={meter.source}
      variant="segmented"
      {...rest}
    />
  ) : (
    <LevelMeter
      ballistics="vu"
      className={className}
      orientation="horizontal"
      peakDb={meter.peakDb}
      variant="segmented"
      {...rest}
    />
  )
}
