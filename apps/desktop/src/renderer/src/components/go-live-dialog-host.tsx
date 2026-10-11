import type { ReactElement } from 'react'

import { GoLiveConfirmationDialog } from '@/components/go-live-dialog'
import { useStudioCore } from '@/hooks/use-studio'
import { goLiveEntitlementGate } from '@/lib/entitlement-ui'
import { platformConnectOptions } from '../../../shared/platform-scopes'

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
    goLiveExcludedTargetIds,
    goLivePhase,
    startRequestPending,
    goLivePartialSetup,
    goLivePreflight,
    goLiveCaptionsReadiness,
    runtimeInfo,
    streamMetadataDraft,
    patchStreamMetadataDraft,
    cancelGoLiveConfirmation,
    confirmGoLive,
    connectPlatformAccount,
    continueGoLiveWithReadyDestinations,
    continueGoLiveWithoutCaptions,
    recheckGoLive,
    resolveGoLiveBlocker
  } = useStudioCore()

  return (
    <GoLiveConfirmationDialog
      draft={streamMetadataDraft}
      captionsReadiness={goLiveCaptionsReadiness}
      entitlementGate={goLiveEntitlementGate({ entitlements, streaming: captureConfig.streaming })}
      // "Go live without …" leaves these out of this livestream only (B-8).
      excludedTargets={captureConfig.streaming.targets.filter((target) =>
        goLiveExcludedTargetIds.includes(target.id)
      )}
      open={goLiveConfirmationOpen}
      pending={goLiveConfirmationPending || startRequestPending}
      phase={goLivePhase}
      platform={runtimeInfo?.platform}
      preflight={goLivePreflight}
      partialSetup={goLivePartialSetup}
      onCancel={cancelGoLiveConfirmation}
      onConfirm={() => void confirmGoLive()}
      onContinuePartial={() => void continueGoLiveWithReadyDestinations()}
      onContinueWithoutCaptions={continueGoLiveWithoutCaptions}
      onPatchDraft={patchStreamMetadataDraft}
      onRecheck={() => void recheckGoLive()}
      onReconnect={(platform) =>
        void connectPlatformAccount(platform, platformConnectOptions(platform))
      }
      onResolveBlocker={(targetId, resolution) => void resolveGoLiveBlocker(targetId, resolution)}
    />
  )
}
