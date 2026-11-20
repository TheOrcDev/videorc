import type { OverlayItemLayout, OverlayLayout } from '@/lib/backend'
import type { CaptionsCaptureSettings } from '@/lib/capture'

// One switch (owner, 2026-11-20): Live captions in the Captions tab puts
// captions on the stream, in every scene, local and cloud, and its one
// choice says whether the recording gets them too. A scene only places the
// bar. The captions item in the overlay layout keeps its two switch fields on
// the wire (the backend's layout schema is shared with the other items), but
// nothing reads them for captions any more: these helpers say where captions
// go from the Captions settings alone, for the Scene stage and inspector.

/** Where captions go: nowhere while Live captions is off, the stream always
 * while it is on, and the recording too for "Live stream and recording". */
export function captionsOutputSwitches(
  captions: Pick<CaptionsCaptureSettings, 'enabled' | 'burnTarget'>
): Pick<OverlayItemLayout, 'showOnStream' | 'showInRecording'> {
  return {
    showOnStream: captions.enabled,
    showInRecording: captions.enabled && captions.burnTarget === 'both'
  }
}

/** The layout the Scene stage and inspector show: the saved one, with the
 * captions item's switches read from the Captions settings. For display
 * only; never save it (writes go through the saved layout). */
export function overlayLayoutForDisplay(
  layout: OverlayLayout,
  captions: Pick<CaptionsCaptureSettings, 'enabled' | 'burnTarget'>
): OverlayLayout {
  const switches = captionsOutputSwitches(captions)
  if (
    layout.captions.showOnStream === switches.showOnStream &&
    layout.captions.showInRecording === switches.showInRecording
  ) {
    return layout
  }
  return { ...layout, captions: { ...layout.captions, ...switches } }
}
