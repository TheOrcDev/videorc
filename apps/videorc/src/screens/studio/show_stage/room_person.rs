//! The parts of a person's row (`components/guests/room-person.tsx`, plan
//! 252) that the Show stage's lists draw: their picture, their connection,
//! their mic, their screen, and "wants to join". A picture or an icon says
//! the state; the sentence is its tooltip, and every icon keeps its words
//! for a screen reader.

use std::rc::Rc;
use std::sync::Arc;

use gpui::{AnyElement, App, Image, ObjectFit, SharedString, Window, div, img, prelude::*, px};
use videorc_app_core::guests::tile::name_initial;
use videorc_app_core::guests::view::{
    MicState, MicView, RoomPerson, ScreenShareState, Tone, guest_screen_share, quality_status,
    request_device, request_title,
};
use videorc_app_core::guests::wire::{GuestDevice, RoomRequest};
use videorc_kit::avatar::Avatar;
use videorc_kit::badge::{Badge, BadgeVariant};
use videorc_kit::button::{Button, ButtonSize, ButtonVariant};
use videorc_kit::icon::{IconName, icon};
use videorc_kit::kebab_menu::{KebabMenu, KebabMenuItem};
use videorc_kit::list_row::ListRow;
use videorc_kit::section_label::SectionLabel;
use videorc_kit::status_dot::{StatusDot, StatusTone};
use videorc_kit::theme::{TypeScale, hsla, with_alpha};
use videorc_kit::toggle_group::Toggle;
use videorc_kit::tokens::{Theme, radius, text};
use videorc_kit::tooltip::tooltip;

/// `PERSON_ROW_CLASS = 'h-10'`: a row with a picture in it is 40 px.
pub const PERSON_ROW_PX: f32 = 40.;

type Handler = Rc<dyn Fn(&mut Window, &mut App)>;

fn tone_of(tone: Tone) -> StatusTone {
    match tone {
        Tone::Good => StatusTone::Good,
        Tone::Warn => StatusTone::Warn,
        Tone::Error => StatusTone::Error,
        Tone::Live => StatusTone::Live,
        Tone::Neutral => StatusTone::Neutral,
    }
}

/// `CountLabel` inside a `SectionLabel` (`px-1`): the words, then the count
/// in the muted tone at normal weight, 6 px apart ("On stage 3").
pub fn count_label(words: &str, count: usize, t: &Theme) -> AnyElement {
    div()
        .px(px(4.))
        .flex()
        .items_center()
        .gap(px(6.))
        .child(SectionLabel::new(words.to_string()))
        .child(
            div()
                .type_scale(text::LABEL)
                .font_weight(gpui::FontWeight::NORMAL)
                .text_color(hsla(t.muted_foreground))
                .child(count.to_string()),
        )
        .into_any_element()
}

/// `PersonThumb`: their camera, live, or the camera-off letter the viewers
/// see, 50×28 on the video ground. A green rim while they talk (`outline-2
/// outline-offset-1`): the one colour on the row, and it is information.
pub fn person_thumb(
    id: &str,
    name: &str,
    frame: Option<Arc<Image>>,
    camera_off: bool,
    speaking: bool,
    t: &Theme,
) -> AnyElement {
    let picture = div()
        .relative()
        .w(px(50.))
        .h(px(28.))
        .overflow_hidden()
        .rounded(px(radius::CHIP))
        .bg(hsla(t.video_ground))
        .map(|thumb| match frame {
            Some(frame) => thumb.child(img(frame).size_full().object_fit(ObjectFit::Cover)),
            None => thumb.child(
                div()
                    .id(SharedString::from(format!("person-thumb-letter-{id}")))
                    .absolute()
                    .inset_0()
                    .flex()
                    .items_center()
                    .justify_center()
                    .aria_label(if camera_off {
                        "Camera off"
                    } else {
                        "No picture yet"
                    })
                    .child(
                        div()
                            .size(px(20.))
                            .rounded_full()
                            .flex()
                            .items_center()
                            .justify_center()
                            .bg(hsla(with_alpha(t.video_ground_muted, 0.35)))
                            .text_size(px(11.))
                            .line_height(px(11.))
                            .font_weight(gpui::FontWeight::MEDIUM)
                            .text_color(hsla(t.video_ground_foreground))
                            .child(name_initial(name)),
                    ),
            ),
        });
    div()
        .relative()
        .flex_none()
        .child(picture)
        .when(speaking, |thumb| {
            thumb.child(
                div()
                    .absolute()
                    .top(px(-3.))
                    .left(px(-3.))
                    .right(px(-3.))
                    .bottom(px(-3.))
                    .rounded(px(radius::CHIP + 3.))
                    .border_2()
                    .border_color(hsla(t.success)),
            )
        })
        .into_any_element()
}

/// `ConnectionDot`: a dot only when the connection is not fine.
fn connection_dot(person: &RoomPerson) -> Option<AnyElement> {
    let (tone, label) = quality_status(person.quality);
    if tone == Tone::Good {
        return None;
    }
    Some(
        div()
            .id(SharedString::from(format!(
                "person-connection-{}",
                person.identity
            )))
            .size(px(16.))
            .flex()
            .items_center()
            .justify_center()
            .tooltip(tooltip(label))
            .child(
                StatusDot::new(SharedString::from(format!(
                    "person-connection-dot-{}",
                    person.identity
                )))
                .tone(tone_of(tone))
                .label(label),
            )
            .into_any_element(),
    )
}

/// `PersonStateBadges`: "Away", and the host's hold or a mic the guest
/// turned off, each in words (D14).
fn state_badges(person: &RoomPerson, mic: &MicView) -> Vec<AnyElement> {
    let mut out = Vec::new();
    if person.away {
        out.push(
            div()
                .id(SharedString::from(format!(
                    "person-away-{}",
                    person.identity
                )))
                .tooltip(tooltip(format!(
                    "{}'s camera stopped sending. Viewers see “Back in a moment”.",
                    person.name
                )))
                .child(Badge::new("Away").variant(BadgeVariant::Warning))
                .into_any_element(),
        );
    }
    if matches!(mic.state, MicState::Held | MicState::Off) {
        let badge = div()
            .id(SharedString::from(format!(
                "person-mic-badge-{}",
                person.identity
            )))
            .child(Badge::new(mic.label).variant(BadgeVariant::Outline));
        out.push(match mic.hint.clone() {
            Some(hint) => badge.tooltip(tooltip(hint)).into_any_element(),
            None => badge.into_any_element(),
        });
    }
    out
}

/// What a Show stage row needs to draw one person.
pub struct PersonRowParts {
    pub person: RoomPerson,
    pub picture: Option<Arc<Image>>,
    pub camera_off: bool,
    pub mic: MicView,
    /// What a press of the mic does ("Mute Ada", "Let Ada unmute").
    pub mic_label: String,
    /// Pressed means muted (the host's own mute, or the hold on a guest).
    pub mic_pressed: bool,
    pub disabled: bool,
    pub menu: Vec<KebabMenuItem>,
    /// The page's own control (the stage move), between the toggles and ⋯.
    pub action: Option<AnyElement>,
}

/// `PersonRow`: picture, name, what is wrong when something is, the mic, a
/// guest's screen share, the page's control, and ⋯.
pub fn person_row(
    parts: PersonRowParts,
    t: &Theme,
    on_mic: Handler,
    on_screen_share: Handler,
) -> ListRow {
    let PersonRowParts {
        person,
        picture,
        camera_off,
        mic,
        mic_label,
        mic_pressed,
        disabled,
        menu,
        action,
    } = parts;
    let id = person.identity.clone();
    let silent = matches!(mic.state, MicState::Held | MicState::Off | MicState::Muted);
    // `MicToggle`: the icon is the state; pressed means muted. Talking, the
    // glyph wears the success tone.
    let mic_toggle = {
        let on_mic = on_mic.clone();
        Toggle::new(
            SharedString::from(format!("show-stage-mute-{id}")),
            if silent {
                IconName::WaveformSlash
            } else {
                IconName::Waveform
            },
            mic_label.clone(),
        )
        .pressed(mic_pressed)
        .disabled(disabled)
        .tooltip(mic_label)
        .when(mic.state == MicState::Talking, |toggle| {
            toggle.ink(t.success)
        })
        .on_change(move |_, window, cx| on_mic(window, cx))
    };
    // `ScreenShareToggle`: pressed means they may share; the dot means they
    // are sharing now.
    let share_toggle = (!person.host && person.guest_id.is_some()).then(|| {
        let share = guest_screen_share(&person);
        let on_screen_share = on_screen_share.clone();
        Toggle::new(
            SharedString::from(format!("show-stage-screen-share-{id}")),
            IconName::Monitor,
            share.action_label.clone(),
        )
        .pressed(share.state != ScreenShareState::Off)
        .dot(share.state == ScreenShareState::Sharing)
        .disabled(disabled)
        .tooltip(share.hint.clone())
        .on_change(move |_, window, cx| on_screen_share(window, cx))
    });
    let mut alias = div().flex().flex_none().items_center().gap(px(6.));
    alias = alias.children(connection_dot(&person));
    alias = alias.children(state_badges(&person, &mic));

    let mut row = ListRow::new(format!("show-stage-strip-row-{id}"), person.name.clone())
        .auto_height(true)
        .min_height(PERSON_ROW_PX)
        .py(6.)
        .leading(person_thumb(
            &id,
            &person.name,
            picture,
            camera_off,
            mic.state == MicState::Talking,
            t,
        ))
        .alias(alias)
        .child(mic_toggle)
        .children(share_toggle)
        .children(action);
    if !menu.is_empty() {
        row = row.child(
            KebabMenu::new(SharedString::from(format!("show-stage-more-{id}")), menu)
                .label(format!("More for {}", person.name))
                .disabled(disabled),
        );
    }
    row
}

/// `RequestRow`: "Ada wants to join", the device, Let in and Decline (D4).
pub fn request_row(
    request: &RoomRequest,
    disabled: bool,
    t: &Theme,
    on_let_in: Handler,
    on_decline: Handler,
) -> ListRow {
    let id = request.request_id.clone();
    let device = request_device(request);
    let device_icon = match request.device {
        GuestDevice::Phone => IconName::DeviceMobile,
        GuestDevice::Computer => IconName::Desktop,
    };
    ListRow::new(format!("show-stage-request-{id}"), request_title(request))
        .auto_height(true)
        .min_height(PERSON_ROW_PX)
        .py(6.)
        .leading(Avatar::new(name_initial(&request.name)).sm())
        .alias(
            div()
                .id(SharedString::from(format!(
                    "show-stage-request-device-{id}"
                )))
                .flex()
                .items_center()
                .tooltip(tooltip(device))
                .child(icon(device_icon, 16., hsla(t.muted_foreground))),
        )
        .child(
            Button::new(SharedString::from(format!("show-stage-let-in-{id}")))
                .label("Let in")
                .size(ButtonSize::Xs)
                .disabled(disabled)
                .on_click(move |_, window, cx| on_let_in(window, cx)),
        )
        .child(
            Button::new(SharedString::from(format!("show-stage-decline-{id}")))
                .label("Decline")
                .size(ButtonSize::Xs)
                .variant(ButtonVariant::Ghost)
                .disabled(disabled)
                .on_click(move |_, window, cx| on_decline(window, cx)),
        )
}
