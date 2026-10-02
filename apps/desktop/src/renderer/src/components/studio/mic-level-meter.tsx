import type { ComponentProps, ReactElement } from 'react'

import { LevelMeter } from '@/components/ui/level-meter'
import type { MeterInput } from '@/lib/mic-meter-input'

type MicLevelMeterProps = Omit<
  ComponentProps<typeof LevelMeter>,
  'source' | 'peakDb' | 'rmsDb' | 'channels' | 'ballistics'
> & {
  meter: MeterInput
}

/**
 * One microphone (or System audio) level, whatever drives it (plans 092 and
 * 093): a live source moves with `peak` ballistics; a plain reading arrives
 * once a second at most, so `vu` ballistics glide between readings. Shared
 * by the Studio Microphone section and the Sources Audio mixer, so the two
 * never drift apart.
 */
export function MicLevelMeter({ meter, ...props }: MicLevelMeterProps): ReactElement {
  return meter.kind === 'source' ? (
    <LevelMeter ballistics="peak" source={meter.source} {...props} />
  ) : (
    <LevelMeter ballistics="vu" peakDb={meter.peakDb} {...props} />
  )
}
