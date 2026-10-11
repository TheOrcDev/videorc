import { Field, FieldDescription, FieldLabel } from '@/components/ui/field'
import { SegmentedControl } from '@/components/ui/segmented-control'
import type { VideoPreset } from '@/lib/backend'
import { streamQualityOptions } from '@/lib/output-quality'

export function StreamQualityControl({
  value,
  disabled,
  youtube,
  inherit = false,
  onChange
}: {
  value: VideoPreset | 'default'
  disabled: boolean
  youtube: boolean
  inherit?: boolean
  onChange: (value: VideoPreset | 'default') => void
}) {
  const options = streamQualityOptions.filter(
    (option) => youtube || option.value !== 'stream-youtube-4k30'
  )
  const selected = value === 'tutorial-1080p30' ? 'stream-safe-1080p30' : value
  const custom = selected !== 'default' && !options.some((option) => option.value === selected)
  return (
    <Field data-disabled={disabled}>
      <FieldLabel>Stream quality</FieldLabel>
      <SegmentedControl<VideoPreset | 'default'>
        disabled={disabled}
        options={[
          ...(inherit ? [{ value: 'default' as const, label: 'Use default' }] : []),
          ...options
        ]}
        value={selected}
        onValueChange={onChange}
      />
      <FieldDescription>
        {custom ? 'Using a saved custom profile. ' : ''}
        {value === 'stream-youtube-4k30'
          ? '4K needs normal latency on YouTube. Other destinations keep their supported quality.'
          : 'Streaming quality is independent of your local recording.'}
      </FieldDescription>
    </Field>
  )
}
