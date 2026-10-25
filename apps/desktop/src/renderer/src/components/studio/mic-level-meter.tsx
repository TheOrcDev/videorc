import type { ComponentProps, ReactElement } from 'react'

import { LcdDisplay } from '@/components/ui/lcd-display'
import { LcdMeter } from '@/components/ui/lcd-meter'
import type { MeterInput } from '@/lib/mic-meter-input'

type MicLevelMeterProps = Omit<
  ComponentProps<typeof LcdMeter>,
  'source' | 'peakDb' | 'rmsDb' | 'channels' | 'ballistics' | 'className'
> & {
  meter: MeterInput
  /** The screen's place in the caller's layout (it lands on the bezel). */
  className?: string
}

/**
 * One microphone, System audio or Sounds level, whatever drives it (plans 092,
 * 093 and 196), on audiocn's LCD screen: segments, a held peak, the level in
 * digits, a printed scale and a CLIP flag. `LcdDisplay` keeps its defaults,
 * so the ink is Videorc's `--primary` and the screen follows the theme. A
 * live source moves with `peak` ballistics; a plain reading arrives once a
 * second at most, so `vu` ballistics glide between readings. Shared by the
 * Studio Microphone section and the Sources rows, so they never drift apart.
 */
export function MicLevelMeter({ meter, className, ...props }: MicLevelMeterProps): ReactElement {
  return (
    <LcdDisplay className={className}>
      {meter.kind === 'source' ? (
        <LcdMeter ballistics="peak" source={meter.source} {...props} />
      ) : (
        <LcdMeter ballistics="vu" peakDb={meter.peakDb} {...props} />
      )}
    </LcdDisplay>
  )
}
