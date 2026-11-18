import type { ReactElement } from 'react'

import { PanelSection } from '@/components/panel-section'
import { Badge } from '@/components/ui/badge'
import { FieldError } from '@/components/ui/field'
import { Switch } from '@/components/ui/switch'
import { useSrtInput, useSrtInputChange, type SrtInputControls } from '@/hooks/use-srt-input'
import { useStudioCore } from '@/hooks/use-studio'
import { SRT_INPUT_DESCRIPTION, SRT_INPUT_TITLE, srtInputHidden } from '@/lib/srt-input-view'

/**
 * Settings → General → SRT input (plan 250, Beta): the opt-in alone. On, the
 * camera list in Sources gains "SRT Camera (port N)", and the camera's own
 * settings (port, passphrase, Connection) show on its row there, the one
 * home of every camera. Only where the backend supports it (macOS, D9).
 */
export function SrtInputSection(): ReactElement | null {
  const controls = useSrtInput()
  const { refreshDevices } = useStudioCore()
  return <SrtInputSectionView controls={controls} onCameraListChanged={refreshDevices} />
}

export function SrtInputSectionView({
  controls,
  onCameraListChanged
}: {
  controls: SrtInputControls
  /** The camera entry comes or goes: the camera list reads again. */
  onCameraListChanged: () => unknown
}): ReactElement | null {
  const { state, connected } = controls
  const change = useSrtInputChange(onCameraListChanged)
  if (!state || srtInputHidden(state)) return null
  return (
    <PanelSection
      action={
        <>
          <Badge variant="outline">Beta</Badge>
          <Switch
            aria-label={SRT_INPUT_TITLE}
            checked={state.enabled}
            data-testid="srt-input-switch"
            disabled={!connected || change.pending}
            onCheckedChange={(enabled) => void change.run(() => controls.set({ enabled }), true)}
          />
        </>
      }
      data-testid="srt-input-section"
      description={SRT_INPUT_DESCRIPTION}
      title={SRT_INPUT_TITLE}
    >
      {change.problem ? <FieldError>{change.problem}</FieldError> : null}
    </PanelSection>
  )
}
