import type { ReactElement } from 'react'
import type { CameraLook } from '../../../../shared/backend'
import { Button } from '@/components/ui/button'
import { FieldGroup } from '@/components/ui/field'
import { PanelSection } from '@/components/panel-section'
import { PowerSlider } from '@/components/power-slider'
import { NEUTRAL_CAMERA_LOOK } from '@/lib/camera-look'

export function CameraLookControls({
  look,
  disabledReason,
  onChange
}: {
  look: CameraLook | undefined
  disabledReason?: string
  onChange: (look: CameraLook) => void
}): ReactElement {
  const current = look ?? NEUTRAL_CAMERA_LOOK
  return (
    <PanelSection
      headingLevel={3}
      title="Camera look"
      description="Saved for this camera in every scene."
      action={
        <Button
          size="xs"
          variant="ghost"
          aria-label="Reset camera look"
          disabled={!look || Boolean(disabledReason)}
          onClick={() => onChange(NEUTRAL_CAMERA_LOOK)}
        >
          Reset
        </Button>
      }
    >
      <FieldGroup>
        <PowerSlider
          bipolar
          label="Brightness"
          min={-100}
          max={100}
          step={1}
          defaultValue={0}
          numericInput
          value={Math.round(current.brightness * 400)}
          disabled={Boolean(disabledReason)}
          disabledReason={disabledReason}
          onChange={(value) => onChange({ ...current, brightness: value / 400 })}
        />
        <PowerSlider
          bipolar
          label="Contrast"
          min={-100}
          max={100}
          step={1}
          defaultValue={0}
          numericInput
          value={Math.round((current.contrast - 1) * 200)}
          disabled={Boolean(disabledReason)}
          disabledReason={disabledReason}
          onChange={(value) => onChange({ ...current, contrast: 1 + value / 200 })}
        />
        <PowerSlider
          bipolar
          label="Saturation"
          min={-100}
          max={100}
          step={1}
          defaultValue={0}
          numericInput
          value={Math.round((current.saturation - 1) * 100)}
          disabled={Boolean(disabledReason)}
          disabledReason={disabledReason}
          onChange={(value) => onChange({ ...current, saturation: 1 + value / 100 })}
        />
      </FieldGroup>
    </PanelSection>
  )
}
