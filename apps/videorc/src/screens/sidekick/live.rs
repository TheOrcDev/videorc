//! Overview's Sidekick Live view (`lib/buddy-tab-view.ts` `buddyLiveView`):
//! status, switch, unlock. Words from [`videorc_app_core::buddy::copy`].

use videorc_app_core::buddy::copy as words;
use videorc_app_core::stream_manager::buddy::{CohostState, error_detail_text};

/// Status kind on the Overview row (plan 174 F-20).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StatusKind {
    Off,
    On,
    Live,
    Attention,
}

impl StatusKind {
    pub fn label(self) -> &'static str {
        match self {
            Self::Off => words::STATUS_OFF,
            Self::On => words::STATUS_ON,
            Self::Live => words::STATUS_LIVE,
            Self::Attention => words::STATUS_ATTENTION,
        }
    }

    pub fn tone(self) -> &'static str {
        match self {
            Self::Live => "good",
            Self::Attention => "warn",
            Self::Off | Self::On => "neutral",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LiveStatus {
    pub kind: StatusKind,
    pub label: &'static str,
    pub reason: Option<String>,
    pub detail: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UnlockAction {
    SignIn,
    ViewPremium,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Unlock {
    pub action: Option<UnlockAction>,
    pub reason: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LiveView {
    pub status: LiveStatus,
    pub checked: bool,
    pub switch_disabled: bool,
    pub unlock: Option<Unlock>,
}

#[derive(Debug, Clone, Copy)]
pub struct LiveInput<'a> {
    pub settings_known: bool,
    pub enabled: bool,
    pub signed_in: bool,
    pub entitled: bool,
    pub consented: bool,
    pub live: bool,
    pub state: Option<&'a CohostState>,
}

fn unlock(signed_in: bool, entitled: bool) -> Option<Unlock> {
    if !signed_in {
        return Some(Unlock {
            action: Some(UnlockAction::SignIn),
            reason: words::SIGNED_OUT_REASON.to_string(),
        });
    }
    if !entitled {
        return Some(Unlock {
            action: Some(UnlockAction::ViewPremium),
            reason: words::LIVE_PREMIUM_REASON.to_string(),
        });
    }
    None
}

fn status_of(input: LiveInput<'_>) -> LiveStatus {
    let locked = unlock(input.signed_in, input.entitled);
    if !input.enabled {
        let reason = locked
            .as_ref()
            .map(|u| u.reason.clone())
            .or_else(|| (!input.consented).then(|| words::CONSENT_OFF_REASON.to_string()));
        return LiveStatus {
            kind: StatusKind::Off,
            label: StatusKind::Off.label(),
            reason,
            detail: None,
        };
    }
    if locked.is_some() {
        return LiveStatus {
            kind: StatusKind::On,
            label: StatusKind::On.label(),
            reason: Some(words::LIVE_ON_REASON.to_string()),
            detail: None,
        };
    }
    if !input.live {
        return LiveStatus {
            kind: StatusKind::On,
            label: StatusKind::On.label(),
            reason: Some(words::LIVE_ON_REASON.to_string()),
            detail: None,
        };
    }
    let state = input.state;
    let status = state.map(|s| s.status.as_str()).unwrap_or("off");
    if status == "error" || status == "paused" {
        let detail = state.and_then(|s| error_detail_text(s.detail.as_ref()));
        let reason = state
            .and_then(|s| s.reason.clone())
            .filter(|r| !r.is_empty());
        return LiveStatus {
            kind: StatusKind::Attention,
            label: StatusKind::Attention.label(),
            reason,
            detail,
        };
    }
    LiveStatus {
        kind: StatusKind::Live,
        label: StatusKind::Live.label(),
        reason: None,
        detail: None,
    }
}

/// `buddyLiveView` over the page's inputs.
pub fn live_view(input: LiveInput<'_>) -> LiveView {
    let unlock = unlock(input.signed_in, input.entitled);
    let enabled = input.enabled;
    LiveView {
        status: status_of(input),
        checked: enabled,
        switch_disabled: !input.settings_known || (!enabled && unlock.is_some()),
        unlock,
    }
}
