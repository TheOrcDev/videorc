import { ResetIcon } from '@/components/icons'
import { useState, type ReactElement } from 'react'

import { ConfirmDialog } from '@/components/confirm-dialog'
import { Button } from '@/components/ui/button'

/**
 * The shipped camera defaults: placement, frame and lens. Never the layout
 * preset or the selected sources (owner request, 2026-08-19), and never the
 * camera's background (plan 258 S5): the green or blue screen moved into it,
 * kept per camera, and a reset that turned a blur off would show the room.
 */
export const CAMERA_SETTINGS_DEFAULTS = {
  cameraTransformMode: 'preset',
  cameraTransform: null,
  cameraCorner: 'bottom-right',
  cameraSize: 'medium',
  cameraShape: 'rectangle',
  cameraCornerRadiusPct: 12,
  cameraAspect: 'source',
  cameraMargin: 32,
  cameraFit: 'fill',
  cameraMirror: false,
  cameraZoom: 100,
  cameraOffsetX: 0,
  cameraOffsetY: 0
} as const

/**
 * "Reset camera settings" (plan 174 S0.3, C-18): one committed patch back to
 * the defaults, behind a question, because it rewrites nineteen values at
 * once, on a running stream or recording too.
 */
export function CameraResetButton({
  onReset
}: {
  onReset: (defaults: typeof CAMERA_SETTINGS_DEFAULTS) => void
}): ReactElement {
  const [confirming, setConfirming] = useState(false)
  return (
    <>
      <Button className="mt-2 w-fit" size="xs" variant="outline" onClick={() => setConfirming(true)}>
        <ResetIcon data-icon="inline-start" />
        Reset camera settings
      </Button>
      <ConfirmDialog
        confirmLabel="Reset camera settings"
        description="Placement, frame and lens go back to their defaults, on a running stream or recording too. The layout, your sources and the background stay."
        open={confirming}
        testId="camera-reset"
        title="Reset camera settings?"
        onCancel={() => setConfirming(false)}
        onConfirm={() => {
          setConfirming(false)
          onReset(CAMERA_SETTINGS_DEFAULTS)
        }}
      />
    </>
  )
}
