//! Wire types from `videorc-backend`'s `room_program_camera` module (plan 260 S1.1).
//! The backend re-exports them under their old paths.

use serde::{Deserialize, Serialize};

/// What Videorc Camera shows while a room program upload owns it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum RoomProgramSource {
    /// The room's Program preview (a reconstruction, not the encoded stream).
    RoomProgramPreview,
    /// The upload is open but frames stopped: a black still.
    RoomProgramPaused,
}
