import type { ComponentProps, ReactElement } from 'react'

import { LevelMeter } from '@/components/ui/level-meter'
import type { MeterInput } from '@/lib/mic-meter-input'

type MicLevelMeterProps = Omit<
  ComponentProps<typeof LevelMeter>,
  'source' | 'peakDb' | 'rmsDb' | 'channels' | 'ballistics' | 'children'
> & { meter: MeterInput }

/** Shared Studio and Sources meter: live sources use peak ballistics; sampled levels use VU. */
export function MicLevelMeter({ className, ...props }: MicLevelMeterProps): ReactElement {
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
