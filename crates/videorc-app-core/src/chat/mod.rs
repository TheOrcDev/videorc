//! Live chat in the core (plan 260 S1.6e, from plan 220 S3.1g): the
//! livestream's chat and the message on stream, as `use-studio.tsx` holds
//! them (the `liveChat.*` and `comments.highlight.status` handlers, the
//! highlight, the bootstrap and lag recovery).
//!
//! - [`model`]: the backend's chat as read here.
//! - [`store`]: the snapshot, then the deltas, deduped, chronological and
//!   bounded, and the delivery journal a list counts new messages from.
//! - [`highlight`]: a message on stream as a row shows it, and the files the
//!   backend draws its card from (the backend never fetches while drawing,
//!   so the avatar and each emote are cached first).
//! - [`overlay`]: which messages the chat-on-stream box shows.
//! - [`images`]: a chat image's bytes through the backend's loopback route,
//!   for the rows' avatars.
//!
//! - [`view`]: the Studio's Chat section.
//!
//! Still to land in S1.6e: the driver that feeds this from the Studio's events (it needs the Studio,
//! S1.6a, behind a trait).

pub mod arrival;
pub mod highlight;
pub mod images;
pub mod model;
pub mod overlay;
pub mod store;
pub mod view;

pub use highlight::{HighlightFailure, RowHighlight, RowPhase};
pub use model::{
    CommentHighlightPhase, CommentHighlightState, LiveChatFragment, LiveChatMessage,
    LiveChatProviderState, LiveChatSnapshotWire,
};
pub use store::{ChatDelivery, DeliveryCursor, DeliveryProgress, LiveChat};
