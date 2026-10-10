import type { ReactElement } from 'react'

import { GoLiveConfirmationDialog } from '@/components/go-live-dialog'
import { useStudioCore } from '@/hooks/use-studio'
import { goLiveEntitlementGate } from '@/lib/entitlement-ui'

// The Go Live confirmation wired to the studio state machine. The shell hosts
// it through GoLiveDialogGate (plan 174 S0.6, B-5), which loads this module
// the first time Go Live is asked for, so the dialog stays out of the shell's
// eager chunk.
export function GoLiveDialogHost(): ReactElement {
  const {
    captureConfig,
    entitlements,
    goLiveConfirmationOpen,
    goLiveConfirmationPending,
    startRequestPending,
    goLivePartialSetup,
    goLivePreflight,
    goLiveCaptionsReadiness,
    streamMetadataDraft,
    patchStreamMetadataDraft,
    cancelGoLiveConfirmation,
    confirmGoLive,
    continueGoLiveWithReadyDestinations,
    continueGoLiveWithoutCaptions,
    resolveGoLiveBlocker
  } = useStudioCore()

  return (
    <GoLiveConfirmationDialog
      draft={streamMetadataDraft}
      captionsReadiness={goLiveCaptionsReadiness}
      entitlementGate={goLiveEntitlementGate({ entitlements, streaming: captureConfig.streaming })}
      open={goLiveConfirmationOpen}
      pending={goLiveConfirmationPending || startRequestPending}
      preflight={goLivePreflight}
      partialSetup={goLivePartialSetup}
      onCancel={cancelGoLiveConfirmation}
      onConfirm={() => void confirmGoLive()}
      onContinuePartial={() => void continueGoLiveWithReadyDestinations()}
      onContinueWithoutCaptions={continueGoLiveWithoutCaptions}
      onPatchDraft={patchStreamMetadataDraft}
      onResolveBlocker={(targetId, resolution) => void resolveGoLiveBlocker(targetId, resolution)}
    />
  )
}
