//! The poll card on the picture (plan 188 S3).
//!
//! The Studio renderer rasterizes the card per output target and pushes it
//! through `polls.overlay.set` into `AppState.poll_overlay`, like the Buddy
//! bubble; the compositor draws it between the Buddy and the highlight card.
//! The poll engine (`polls.rs`) owns when the card is up and clears the slot
//! itself, so a renderer that died mid-poll can't leave a card on stream.

use crate::state::AppState;

/// Drop the poll card from every target: the card hid, the poll was
/// cancelled or the session ended.
pub(crate) fn clear_poll_overlay(state: &AppState) {
    if let Err(error) = crate::captions::clear_caption_overlays(
        &state.poll_overlay,
        crate::captions::ClearCaptionOverlayParams {
            target: None,
            style_revision: None,
        },
    ) {
        tracing::warn!("Could not clear the poll card: {error:#}");
    }
}

/// Whether this session's picture can draw the poll card (D14). Placeholder
/// until S3 wires the real capability (the poll twin of
/// `comment_highlight_available`): the legacy FFmpeg 4K60 path and direct
/// D3D11 recording have no live text slot.
pub(crate) async fn poll_card_available(_state: &AppState) -> bool {
    true
}
