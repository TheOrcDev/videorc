import { Field, FieldDescription, FieldLabel } from '@/components/ui/field'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
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
      <ToggleGroup
        aria-label="Stream quality"
        className="flex-wrap"
        disabled={disabled}
        size="sm"
        type="single"
        value={selected}
        variant="outline"
        onValueChange={(next) => {
          if (next === 'default' || options.some((option) => option.value === next))
            onChange(next as VideoPreset | 'default')
        }}
      >
        {inherit ? <ToggleGroupItem value="default">Use default</ToggleGroupItem> : null}
        {options.map((option) => (
          <ToggleGroupItem key={option.value} value={option.value}>
            {option.label}
          </ToggleGroupItem>
        ))}
      </ToggleGroup>
      <FieldDescription>
        {custom ? 'Using a saved custom profile. ' : ''}
        {value === 'stream-youtube-4k30'
          ? '4K needs normal latency on YouTube. Other destinations keep their supported quality.'
          : 'Streaming quality is independent of your local recording.'}
      </FieldDescription>
    </Field>
  )
}
