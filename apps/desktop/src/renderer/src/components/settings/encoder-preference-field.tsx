import type { ReactElement } from 'react'

import { Badge } from '@/components/ui/badge'
import { Field, FieldLabel } from '@/components/ui/field'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import type { EncoderPreferenceState, WindowsH264EncoderPreference } from '@/lib/backend'

const OPTIONS: ReadonlyArray<{ value: WindowsH264EncoderPreference; label: string }> = [
  { value: 'auto', label: 'Automatic' },
  { value: 'quick-sync', label: 'Intel Quick Sync' },
  { value: 'software', label: 'Software only' }
]

/**
 * Settings → Recording, Windows PCs with Intel graphics only (plan 090 C5).
 * Chooses the encoder for the fallback path Videorc uses when its normal
 * hardware encoder can't start. Opt-in while Quick Sync is in beta: Automatic
 * keeps the software fallback.
 */
export function EncoderPreferenceField({
  state,
  onChange
}: {
  state: EncoderPreferenceState | null
  onChange: (preference: WindowsH264EncoderPreference) => void
}): ReactElement | null {
  if (!state?.quickSyncAvailable) {
    return null
  }
  return (
    <Field>
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-0.5">
          <div className="flex items-center gap-2">
            <FieldLabel htmlFor="encoder-preference">Fallback video encoder</FieldLabel>
            <Badge variant="outline">Beta</Badge>
          </div>
          <p className="text-xs text-muted-foreground">
            {state.envOverride
              ? 'Set by VIDEORC_WINDOWS_H264_ENCODER for this run.'
              : "Used only when this PC's hardware encoder can't start. Intel Quick Sync encodes on the Intel graphics chip instead of the processor, and falls back to software if its own check fails."}
          </p>
        </div>
        <Select
          disabled={state.envOverride}
          value={state.preference}
          onValueChange={(value) => onChange(value as WindowsH264EncoderPreference)}
        >
          <SelectTrigger className="w-44 shrink-0" id="encoder-preference">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {OPTIONS.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
    </Field>
  )
}
