//! Wire types from `videorc-backend`'s `live_chat_moderation` module (plan 260 S1.1).
//! The backend re-exports them under their old paths.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum RemoveConfirmMode {
    #[default]
    Confirm,
    Countdown,
}
