//! `videorc://` links (plan 260 S2.6a): the open-URL Apple Event (through
//! GPUI's `on_open_urls`), the command line and a second launch's hand-off
//! all reach the core's `DeepLinks`, which completes them through the
//! backend. A link carries a short-lived code: only its kind and outcome
//! are logged, never the URL.

use std::sync::Arc;

use videorc_app_core::BackendClient;
use videorc_app_core::desktop::deep_link::{DeepLinks, LinkSource};

pub type Links = Arc<DeepLinks<BackendClient>>;

/// Hands each link to the core. Must run inside the core's Tokio runtime
/// (the main thread holds its `enter` guard), where the core's follow-up
/// work runs.
pub fn receive(links: &Links, urls: &[String], source: LinkSource) {
    for raw in urls {
        let taken = links.receive(raw, source);
        let outcome = match taken.rejection {
            None => "taken".to_string(),
            Some(rejection) => format!("refused: {}", rejection.describe()),
        };
        eprintln!(
            "[videorc-app] link {:?} from {:?}: {outcome}",
            taken.kind, taken.source
        );
    }
}
