//! Exact Electron ConfirmDialog strings for delete and remove questions.
//! Pages call [`super::DialogsHost::ask_confirm`] with these; the words stay
//! here so they cannot drift from the renderer.

/// Delete scene (`scene-dialogs.tsx`).
pub fn delete_scene(name: &str, next_on_stream: Option<&str>) -> super::ConfirmRequest {
    let description = match next_on_stream {
        Some(next) => format!("“{name}” and its key are deleted. “{next}” goes on stream."),
        None => format!("“{name}” and its key are deleted. What’s on stream stays as it is."),
    };
    super::ConfirmRequest {
        title: "Delete scene?".into(),
        description,
        cancel_label: "Cancel".into(),
        confirm_label: "Delete scene".into(),
        confirm_variant: super::ConfirmVariant::Destructive,
        pending_label: Some("Deleting…".into()),
    }
}

/// Delete banner (`banners.ts` `bannerDeleteDescription`).
pub fn delete_banner(name: &str, html: bool) -> super::ConfirmRequest {
    let kind = if html { "files" } else { "image" };
    super::ConfirmRequest {
        title: "Delete banner?".into(),
        description: format!("“{name}” and its {kind} will be deleted. This can't be undone."),
        cancel_label: "Cancel".into(),
        confirm_label: "Delete banner".into(),
        confirm_variant: super::ConfirmVariant::Destructive,
        pending_label: Some("Deleting…".into()),
    }
}

/// Delete takeover (`takeover-screens-section.tsx`).
pub fn delete_takeover(name: &str) -> super::ConfirmRequest {
    super::ConfirmRequest {
        title: format!("Delete {name}?"),
        description: "Its image file is deleted from this computer.".into(),
        cancel_label: "Cancel".into(),
        confirm_label: "Delete takeover".into(),
        confirm_variant: super::ConfirmVariant::Destructive,
        pending_label: None,
    }
}

/// Remove phone (`phone-remote-section.tsx`).
pub fn remove_phone(name: &str) -> super::ConfirmRequest {
    super::ConfirmRequest {
        title: format!("Remove {name}?"),
        description: "It's disconnected now and needs a new pairing to come back. Your Stream Deck isn't affected.".into(),
        cancel_label: "Cancel".into(),
        confirm_label: "Remove phone".into(),
        confirm_variant: super::ConfirmVariant::Destructive,
        pending_label: None,
    }
}

/// Remove guest (`guests-view.ts` `removeGuestCopy`).
pub fn remove_guest(name: &str) -> super::ConfirmRequest {
    super::ConfirmRequest {
        title: format!("Remove {name}?"),
        description: format!("{name} leaves the show. The link still works for everyone else."),
        cancel_label: "Cancel".into(),
        confirm_label: format!("Remove {name}"),
        confirm_variant: super::ConfirmVariant::Destructive,
        pending_label: Some("Removing…".into()),
    }
}

/// Ban guest (`guests-view.ts` `banGuestCopy`).
pub fn ban_guest(name: &str) -> super::ConfirmRequest {
    super::ConfirmRequest {
        title: format!("Ban {name}?"),
        description: format!(
            "{name} leaves the show and can't ask to join again. The link changes, so share the new one with your guests."
        ),
        cancel_label: "Cancel".into(),
        confirm_label: format!("Ban {name}"),
        confirm_variant: super::ConfirmVariant::Destructive,
        pending_label: Some("Banning…".into()),
    }
}

/// Close the room (`close-room-button.tsx`).
pub fn close_room(confirm_label: &str, description: &str) -> super::ConfirmRequest {
    super::ConfirmRequest {
        title: "Close the room?".into(),
        description: description.into(),
        cancel_label: "Cancel".into(),
        confirm_label: confirm_label.into(),
        confirm_variant: super::ConfirmVariant::Destructive,
        pending_label: Some("Closing…".into()),
    }
}

/// Remove Videorc Camera (`camera_copy::REMOVE_*` / Health).
pub fn remove_videorc_camera(
    title: &str,
    description: &str,
    confirm: &str,
) -> super::ConfirmRequest {
    super::ConfirmRequest {
        title: title.into(),
        description: description.into(),
        cancel_label: "Cancel".into(),
        confirm_label: confirm.into(),
        confirm_variant: super::ConfirmVariant::Destructive,
        pending_label: None,
    }
}
