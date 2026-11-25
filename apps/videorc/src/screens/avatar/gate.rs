//! One gate model for creating an avatar (`lib/buddy-create-gate.ts`, plan
//! 174 S3.15a, G-5): a new look (the onboarding, Redo on a draft) and an
//! Alive avatar (the creator, Create under Alive) ask the same questions in
//! the order a streamer can fix them, and each answer is one line with at
//! most one action. [`gate_alert`] draws it (`BuddyCreateGateAlert`); the
//! controls under it are off.

use gpui::{AnyElement, App, SharedString, Window, prelude::*};
use serde_json::Value;
use videorc_app_core::buddy::copy as words;
use videorc_app_core::buddy::library::{LibraryState, library_is_full, library_limit};
use videorc_kit::alert::{Alert, AlertVariant};
use videorc_kit::button::{Button, ButtonSize, ButtonVariant};

/// `BUDDY_ONBOARDING_GATES`.
pub const LOOK_SIGNED_OUT: &str = "Sign in to create an avatar.";
pub const LOOK_PREMIUM: &str = "Creating your own avatar is part of Videorc Premium.";
pub const LOOK_CLOUD_AI_OFF: &str = "Allow cloud AI to create an avatar.";
pub const LOOK_ALLOWANCE_USED: &str = "You've used today's images. You get more tomorrow.";
pub const SIGN_IN: &str = "Sign in";
pub const VIEW_PREMIUM: &str = "View Premium";
pub const ALLOW_CLOUD_AI: &str = "Allow cloud AI";
/// `VIDEORC_PREMIUM_URL`.
pub const PREMIUM_URL: &str = "https://videorc.com/premium";
/// A new look is four pictures (`BUDDY_LOOK_CREATE_IMAGES`).
#[allow(dead_code)] // The onboarding's gate (batch B).
pub const LOOK_CREATE_IMAGES: u64 = 4;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GateKind {
    SignedOut,
    Premium,
    CloudAi,
    Full,
    Unavailable,
    Allowance,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum GateAction {
    SignIn,
    ViewPremium(String),
    AllowCloudAi,
}

/// Why creating is off: one line, and the one thing that turns it on.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Gate {
    #[allow(dead_code)] // Read by the tests and the onboarding (batch B).
    pub kind: GateKind,
    pub reason: String,
    pub action: Option<GateAction>,
}

/// What the gate reads: the account, Premium (`liveCohost`), cloud AI
/// consent and `ai.capabilities.get`'s answer.
#[derive(Debug, Clone, Copy)]
pub struct GateInput<'a> {
    pub signed_in: bool,
    pub entitled: bool,
    pub upgrade_url: Option<&'a str>,
    pub consented: bool,
    pub capabilities: Option<&'a Value>,
}

impl GateInput<'_> {
    fn premium(&self) -> GateAction {
        GateAction::ViewPremium(self.upgrade_url.unwrap_or(PREMIUM_URL).to_string())
    }

    fn number(&self, pointer: &str) -> Option<u64> {
        self.capabilities?.pointer(pointer)?.as_u64()
    }

    fn flag(&self, pointer: &str) -> bool {
        self.capabilities
            .and_then(|caps| caps.pointer(pointer))
            .and_then(Value::as_bool)
            == Some(true)
    }
}

fn gate(kind: GateKind, reason: &str, action: Option<GateAction>) -> Option<Gate> {
    Some(Gate {
        kind,
        reason: reason.to_string(),
        action,
    })
}

fn look_gate(input: &GateInput, library: Option<&LibraryState>, images: u64) -> Option<Gate> {
    if !input.signed_in {
        return gate(
            GateKind::SignedOut,
            LOOK_SIGNED_OUT,
            Some(GateAction::SignIn),
        );
    }
    if !input.entitled {
        return gate(GateKind::Premium, LOOK_PREMIUM, Some(input.premium()));
    }
    if !input.consented {
        return gate(
            GateKind::CloudAi,
            LOOK_CLOUD_AI_OFF,
            Some(GateAction::AllowCloudAi),
        );
    }
    if let Some(library) = library {
        let web_limit = input
            .number("/cohost/buddyLibrary/limit")
            .and_then(|limit| u32::try_from(limit).ok());
        let web_count = input
            .number("/cohost/buddyLibrary/count")
            .and_then(|count| u32::try_from(count).ok());
        if library_is_full(web_limit, web_count, Some(library)) {
            let limit = library_limit(web_limit, Some(library));
            return gate(GateKind::Full, &words::library_full_line(limit), None);
        }
    }
    if !input.flag("/cohost/avatar/enabled") {
        return gate(GateKind::Unavailable, words::GENERATE_NOT_AVAILABLE, None);
    }
    if input.number("/cohost/avatar/remainingToday").unwrap_or(0) < images {
        return gate(GateKind::Allowance, LOOK_ALLOWANCE_USED, None);
    }
    None
}

/// `buddyLookCreateGate`: why a new look can't be made now, or None.
#[allow(dead_code)] // The onboarding (batch B) asks it.
pub fn look_create_gate(input: &GateInput, library: Option<&LibraryState>) -> Option<Gate> {
    look_gate(input, library, LOOK_CREATE_IMAGES)
}

/// `buddyLookRedoGate`: the same questions, without the library's room,
/// and one image is enough.
pub fn look_redo_gate(input: &GateInput) -> Option<Gate> {
    look_gate(input, None, 1)
}

/// `buddyAliveCreateGate`: why an Alive avatar can't be made now, or None.
pub fn alive_create_gate(input: &GateInput) -> Option<Gate> {
    if !input.signed_in {
        return gate(
            GateKind::SignedOut,
            words::ALIVE_SIGNED_OUT,
            Some(GateAction::SignIn),
        );
    }
    if !input.entitled {
        return gate(
            GateKind::Premium,
            words::ALIVE_PREMIUM,
            Some(input.premium()),
        );
    }
    if !input.consented {
        return gate(
            GateKind::CloudAi,
            words::ALIVE_CONSENT_OFF,
            Some(GateAction::AllowCloudAi),
        );
    }
    if !input.flag("/cohost/pet/enabled") {
        return gate(GateKind::Unavailable, words::GENERATE_NOT_AVAILABLE, None);
    }
    if input
        .number("/cohost/pet/creationsRemainingThisMonth")
        .unwrap_or(0)
        == 0
    {
        return gate(GateKind::Allowance, words::ALIVE_NONE_LEFT, None);
    }
    None
}

/// `buddyRedoLabel`: "Redo · 1 image".
pub fn redo_label(redo: &str) -> String {
    format!("{redo} · 1 image")
}

/// `buddyImagesLeftLine`: "12 images left today", when the web says.
pub fn images_left_line(capabilities: Option<&Value>) -> Option<String> {
    let avatar = capabilities?.pointer("/cohost/avatar")?;
    if avatar.get("enabled").and_then(Value::as_bool) != Some(true) {
        return None;
    }
    let left = avatar.get("remainingToday").and_then(Value::as_u64)?;
    Some(format!(
        "{left} {} left today",
        if left == 1 { "image" } else { "images" }
    ))
}

/// `buddyPetAllowanceLine`: "2 of 3 left this month", when the web says.
pub fn pet_allowance_line(capabilities: Option<&Value>) -> Option<String> {
    let pet = capabilities?.pointer("/cohost/pet")?;
    if pet.get("enabled").and_then(Value::as_bool) != Some(true) {
        return None;
    }
    let left = pet.get("creationsRemainingThisMonth")?.as_u64()?;
    let limit = pet.get("monthlyLimit")?.as_u64()?;
    (limit > 0).then(|| format!("{left} of {limit} left this month"))
}

/// `BuddyCreateGateAlert`: the reason, and its one action. Sign in calls
/// `on_sign_in`; Allow cloud AI calls `on_allow_cloud_ai` (the consent
/// dialog); View Premium opens the page.
pub fn gate_alert(
    id: &'static str,
    gate: &Gate,
    on_sign_in: impl Fn(&mut Window, &mut App) + 'static,
    on_allow_cloud_ai: impl Fn(&mut Window, &mut App) + 'static,
) -> AnyElement {
    let mut alert = Alert::new(id)
        .variant(AlertVariant::Locked)
        .title(gate.reason.clone());
    if let Some(action) = gate.action.clone() {
        let label = match &action {
            GateAction::SignIn => SIGN_IN,
            GateAction::ViewPremium(_) => VIEW_PREMIUM,
            GateAction::AllowCloudAi => ALLOW_CLOUD_AI,
        };
        alert = alert.action(
            Button::new(SharedString::from(format!("{id}-action")))
                .variant(ButtonVariant::Outline)
                .size(ButtonSize::Xs)
                .label(label)
                .on_click(move |_, window, cx| match &action {
                    GateAction::SignIn => on_sign_in(window, cx),
                    GateAction::ViewPremium(url) => cx.open_url(url),
                    GateAction::AllowCloudAi => on_allow_cloud_ai(window, cx),
                }),
        );
    }
    alert.into_any_element()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn input(caps: &Value) -> GateInput<'_> {
        GateInput {
            signed_in: true,
            entitled: true,
            upgrade_url: None,
            consented: true,
            capabilities: Some(caps),
        }
    }

    #[test]
    fn the_questions_come_in_the_order_a_streamer_fixes_them() {
        let caps = json!({ "cohost": {
            "avatar": { "enabled": true, "remainingToday": 3 },
            "pet": { "enabled": true, "creationsRemainingThisMonth": 0, "monthlyLimit": 3 }
        }});
        let signed_out = GateInput {
            signed_in: false,
            ..input(&caps)
        };
        assert_eq!(
            look_create_gate(&signed_out, None).unwrap().kind,
            GateKind::SignedOut
        );
        let free = GateInput {
            entitled: false,
            upgrade_url: Some("https://videorc.com/up"),
            ..input(&caps)
        };
        assert_eq!(
            alive_create_gate(&free).unwrap().action,
            Some(GateAction::ViewPremium("https://videorc.com/up".into()))
        );
        let no_consent = GateInput {
            consented: false,
            ..input(&caps)
        };
        assert_eq!(look_redo_gate(&no_consent).unwrap().kind, GateKind::CloudAi);
        // Four pictures need four images; a redo needs one.
        assert_eq!(
            look_create_gate(&input(&caps), None).unwrap().reason,
            LOOK_ALLOWANCE_USED
        );
        assert_eq!(look_redo_gate(&input(&caps)), None);
        assert_eq!(
            alive_create_gate(&input(&caps)).unwrap().reason,
            words::ALIVE_NONE_LEFT
        );
        assert_eq!(
            alive_create_gate(&input(&json!({}))).unwrap().kind,
            GateKind::Unavailable
        );
    }

    #[test]
    fn the_lines_count_what_is_left() {
        let caps = json!({ "cohost": {
            "avatar": { "enabled": true, "remainingToday": 1 },
            "pet": { "enabled": true, "creationsRemainingThisMonth": 2, "monthlyLimit": 3 }
        }});
        assert_eq!(
            images_left_line(Some(&caps)).as_deref(),
            Some("1 image left today")
        );
        assert_eq!(
            pet_allowance_line(Some(&caps)).as_deref(),
            Some("2 of 3 left this month")
        );
        assert_eq!(redo_label("Redo"), "Redo · 1 image");
        assert_eq!(images_left_line(None), None);
    }
}
