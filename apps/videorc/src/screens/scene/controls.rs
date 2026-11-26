//! The inspector's stateful controls: one `SliderState` per slider (the
//! `PowerSlider`s and the banner's Opacity), one `InputState` per
//! `PowerSlider`'s typed number and one per typed percent (Position and
//! size, Crop, Hide edges). The page owns them; each follows the editor
//! model while the streamer isn't moving or typing in it, and its release,
//! reset, Enter or blur commits through the Studio.

use gpui::{AnyElement, Context, Entity, SharedString, Window, div, prelude::*, px};
use serde_json::{Map, Value, json};
use tokio::sync::oneshot;
use videorc_app_core::editor::inspector::{
    CROP_FIELDS, SCREEN_SIZE_DEFAULT, SCREEN_SIZE_MAX, SCREEN_SIZE_MIN, SCREEN_ZOOM_MAX,
    SCREEN_ZOOM_MIN, TRANSFORM_FIELDS, TransformPatch, crop_edit_on_picture, crop_field,
    crop_field_patch, look_of_sliders, parse_percent_value, picture_edit_frame_patch, rect_field,
    screen_zoom_patch, transform_field_patch, visibility_for_screen_size, with_crop_field,
};
use videorc_app_core::editor::stage::{StageCrop, StageRect, stage_crop_of};
use videorc_app_core::studio::camera_background::STRONG_BLUR_PCT;
use videorc_app_core::studio::camera_background_view::{
    BLUR_MARKS, BLUR_MAX_PCT, BLUR_MIN_PCT, KEY_EDGES, background_with_key, key_edges_of,
    key_edges_patch, key_of,
};
use videorc_kit::command::InputEvent;
use videorc_kit::dialog::DialogHandle;
use videorc_kit::input::{Input, InputState};
use videorc_kit::label::Label;
use videorc_kit::power_slider::{PowerSlider, PowerSliderMark, clamp_to_range};
use videorc_kit::slider::{SliderEvent, SliderState};
use videorc_kit::theme::{TypeScale, hsla};
use videorc_kit::tokens::{Theme, text};

use super::ScenePage;
use super::editor::{EditTarget, copy};

/// Every slider on the inspector.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum Knob {
    ScreenSize,
    ScreenZoom,
    CornerRadius,
    Margin,
    CameraZoom,
    PanX,
    PanY,
    Brightness,
    Contrast,
    Saturation,
    BlurStrength,
    Similarity,
    Smoothness,
    Spill,
    Opacity,
}

impl Knob {
    const ALL: [Knob; 15] = [
        Knob::ScreenSize,
        Knob::ScreenZoom,
        Knob::CornerRadius,
        Knob::Margin,
        Knob::CameraZoom,
        Knob::PanX,
        Knob::PanY,
        Knob::Brightness,
        Knob::Contrast,
        Knob::Saturation,
        Knob::BlurStrength,
        Knob::Similarity,
        Knob::Smoothness,
        Knob::Spill,
        Knob::Opacity,
    ];

    /// Min, max, step and the value it starts at (each `PowerSlider`'s).
    fn range(self) -> (f32, f32, f32, f32) {
        match self {
            Knob::ScreenSize => (
                SCREEN_SIZE_MIN as f32,
                SCREEN_SIZE_MAX as f32,
                1.,
                SCREEN_SIZE_DEFAULT as f32,
            ),
            Knob::ScreenZoom | Knob::CameraZoom => (
                SCREEN_ZOOM_MIN as f32,
                if self == Knob::ScreenZoom {
                    SCREEN_ZOOM_MAX as f32
                } else {
                    200.
                },
                5.,
                100.,
            ),
            Knob::CornerRadius => (0., 50., 1., 12.),
            Knob::Margin => (0., 96., 1., 32.),
            Knob::PanX | Knob::PanY => (-100., 100., 5., 0.),
            Knob::Brightness | Knob::Contrast | Knob::Saturation => (-100., 100., 1., 0.),
            Knob::BlurStrength => (
                BLUR_MIN_PCT as f32,
                BLUR_MAX_PCT as f32,
                1.,
                STRONG_BLUR_PCT as f32,
            ),
            Knob::Similarity => (0., 100., 1., 40.),
            Knob::Smoothness => (0., 100., 1., 8.),
            Knob::Spill => (0., 100., 1., 10.),
            Knob::Opacity => (20., 100., 1., 100.),
        }
    }

    /// The unit after the value (each `PowerSlider`'s `suffix`).
    fn suffix(self) -> &'static str {
        match self {
            Knob::Margin => "px",
            Knob::PanX | Knob::PanY | Knob::Brightness | Knob::Contrast | Knob::Saturation => "",
            _ => "%",
        }
    }

    /// A value either side of zero (`bipolar`).
    fn bipolar(self) -> bool {
        matches!(
            self,
            Knob::PanX | Knob::PanY | Knob::Brightness | Knob::Contrast | Knob::Saturation
        )
    }

    /// The reset's value (`defaultValue`), where Electron offers one.
    fn reset_to(self) -> Option<f32> {
        match self {
            Knob::ScreenSize => Some(SCREEN_SIZE_DEFAULT as f32),
            Knob::ScreenZoom => Some(SCREEN_ZOOM_MIN as f32),
            Knob::Brightness | Knob::Contrast | Knob::Saturation => Some(0.),
            Knob::BlurStrength => Some(STRONG_BLUR_PCT as f32),
            _ => None,
        }
    }

    /// The typed number in place of the readout (`numericInput`): every
    /// `PowerSlider`; the banner's Opacity is a `ParameterSlider`.
    fn typed(self) -> bool {
        self != Knob::Opacity
    }
}

/// Every typed number on the inspector, by its place in the core's lists.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum Field {
    /// `TRANSFORM_FIELDS[i]`.
    Transform(usize),
    /// `CROP_FIELDS[i]`.
    Crop(usize),
    /// `KEY_EDGES[i]`.
    Edge(usize),
}

impl Field {
    const ALL: [Field; 12] = [
        Field::Transform(0),
        Field::Transform(1),
        Field::Transform(2),
        Field::Transform(3),
        Field::Crop(0),
        Field::Crop(1),
        Field::Crop(2),
        Field::Crop(3),
        Field::Edge(0),
        Field::Edge(1),
        Field::Edge(2),
        Field::Edge(3),
    ];
}

/// What the inspector's controls keep between frames.
pub(super) struct Controls {
    knobs: Vec<(Knob, Entity<SliderState>)>,
    /// The slider under the pointer (a drag shows its own value).
    live: Option<Knob>,
    /// The last value a send-on-every-change slider sent.
    last_sent: Option<(Knob, i64)>,
    /// Each `PowerSlider`'s typed number.
    knob_inputs: Vec<(Knob, Entity<InputState>)>,
    /// The slider whose number the streamer typed in since its last commit.
    typing: Option<Knob>,
    inputs: Vec<(Field, Entity<InputState>)>,
    /// The field the streamer typed in since its last commit.
    editing: Option<Field>,
    /// `createCameraLookThrottle`: one look on its way, the latest next.
    look_in_flight: bool,
    look_next: Option<Value>,
    /// Reset camera settings?
    pub camera_reset: DialogHandle,
    /// Choose an image (P586).
    pub choose_image: DialogHandle,
    /// The banner whose Timing is open (closed again for another banner).
    pub timing_open_for: Option<String>,
    /// The connection the banners and the overlay layout were read on.
    pub lists_generation: Option<u64>,
}

impl Controls {
    pub(super) fn new(window: &mut Window, cx: &mut Context<ScenePage>) -> Self {
        let mut knobs = Vec::new();
        for knob in Knob::ALL {
            let (min, max, step, start) = knob.range();
            let state = cx.new(|_| {
                SliderState::new()
                    .min(min)
                    .max(max)
                    .step(step)
                    .default_value(start)
            });
            cx.subscribe(&state, move |page, _, event: &SliderEvent, cx| {
                page.knob_event(knob, event, cx)
            })
            .detach();
            knobs.push((knob, state));
        }
        let mut knob_inputs = Vec::new();
        for knob in Knob::ALL.into_iter().filter(|knob| knob.typed()) {
            let state = cx.new(|cx| InputState::new(window, cx));
            cx.subscribe_in(
                &state,
                window,
                move |page, input, event: &InputEvent, window, cx| {
                    page.knob_input_event(knob, input, event, window, cx)
                },
            )
            .detach();
            knob_inputs.push((knob, state));
        }
        let mut inputs = Vec::new();
        for field in Field::ALL {
            let state = cx.new(|cx| InputState::new(window, cx));
            cx.subscribe_in(
                &state,
                window,
                move |page, input, event: &InputEvent, _, cx| {
                    page.field_event(field, input, event, cx)
                },
            )
            .detach();
            inputs.push((field, state));
        }
        Self {
            knobs,
            live: None,
            last_sent: None,
            knob_inputs,
            typing: None,
            inputs,
            editing: None,
            look_in_flight: false,
            look_next: None,
            camera_reset: DialogHandle::new(false),
            choose_image: DialogHandle::new(false),
            timing_open_for: None,
            lists_generation: None,
        }
    }

    fn knob(&self, knob: Knob) -> &Entity<SliderState> {
        &self
            .knobs
            .iter()
            .find(|(each, _)| *each == knob)
            .expect("every knob has a slider")
            .1
    }

    /// A `PowerSlider`'s typed number (none for the banner's Opacity).
    fn knob_input(&self, knob: Knob) -> Option<&Entity<InputState>> {
        self.knob_inputs
            .iter()
            .find(|(each, _)| *each == knob)
            .map(|(_, state)| state)
    }

    fn input(&self, field: Field) -> &Entity<InputState> {
        &self
            .inputs
            .iter()
            .find(|(each, _)| *each == field)
            .expect("every field has an input")
            .1
    }
}

fn rounded(value: f32) -> i64 {
    value.round() as i64
}

impl ScenePage {
    /// What a slider shows when nobody holds it.
    fn knob_target(&self, knob: Knob) -> Option<f32> {
        let view = &self.editor.inspector;
        let placement = view.placement.as_ref();
        let camera = placement.and_then(|placement| placement.camera.as_ref());
        let lens = view.lens.as_ref();
        let screen = self
            .editor
            .background
            .as_ref()
            .and_then(|background| background.screen.as_ref());
        let value = match knob {
            Knob::ScreenSize => view.screen_size.map(|(size, _)| size as f64),
            Knob::ScreenZoom => placement
                .and_then(|placement| placement.zoom)
                .map(|(zoom, _)| zoom as f64),
            Knob::CornerRadius => camera.and_then(|camera| camera.radius).map(f64::from),
            Knob::Margin => camera.and_then(|camera| camera.margin).map(f64::from),
            Knob::CameraZoom => lens.map(|lens| f64::from(lens.zoom)),
            Knob::PanX => lens.map(|lens| f64::from(lens.pan_x)),
            Knob::PanY => lens.map(|lens| f64::from(lens.pan_y)),
            Knob::Brightness => lens.map(|lens| f64::from(lens.look.brightness)),
            Knob::Contrast => lens.map(|lens| f64::from(lens.look.contrast)),
            Knob::Saturation => lens.map(|lens| f64::from(lens.look.saturation)),
            Knob::BlurStrength => self
                .editor
                .background
                .as_ref()
                .and_then(|background| background.blur_pct),
            Knob::Similarity => screen.map(|screen| screen.similarity_pct),
            Knob::Smoothness => screen.map(|screen| screen.smoothness_pct),
            Knob::Spill => screen.map(|screen| screen.spill_pct),
            Knob::Opacity => view.banner.as_ref().map(|banner| f64::from(banner.opacity)),
        };
        value.map(|value| value as f32)
    }

    /// What a typed number shows when nobody types in it.
    fn field_target(&self, field: Field) -> Option<String> {
        let placement = self.editor.inspector.placement.as_ref();
        match field {
            Field::Transform(index) => placement
                .and_then(|placement| placement.fields.as_ref())
                .map(|fields| fields.values[index].clone()),
            Field::Crop(index) => placement
                .and_then(|placement| placement.crop.as_ref())
                .map(|crop| crop.values[index].clone()),
            Field::Edge(index) => self
                .editor
                .background
                .as_ref()
                .and_then(|background| background.screen.as_ref())
                .map(|screen| {
                    let pct = screen
                        .hide_edges
                        .get(KEY_EDGES[index].0)
                        .and_then(Value::as_f64)
                        .unwrap_or(0.0);
                    (pct as i64).to_string()
                }),
        }
    }

    /// Every control back on the model, except the one in the streamer's
    /// hands. Called each frame (`set_value` needs the window).
    pub(super) fn sync_controls(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        for (knob, state) in &self.controls.knobs {
            if self.controls.live == Some(*knob) {
                continue;
            }
            let Some(target) = self.knob_target(*knob) else {
                continue;
            };
            state.update(cx, |state, cx| {
                if (state.value().end() - target).abs() >= 0.5 {
                    state.set_value(target, window, cx);
                }
            });
        }
        // A typed number shows its slider, a drag's value too.
        for (knob, state) in &self.controls.knob_inputs {
            if self.controls.typing == Some(*knob) {
                continue;
            }
            let target = rounded(self.controls.knob(*knob).read(cx).value().end()).to_string();
            state.update(cx, |state, cx| {
                if state.value().to_string() != target {
                    state.set_value(target, window, cx);
                }
            });
        }
        for (field, state) in &self.controls.inputs {
            if self.controls.editing == Some(*field) {
                continue;
            }
            let Some(target) = self.field_target(*field) else {
                continue;
            };
            state.update(cx, |state, cx| {
                if state.value().to_string() != target {
                    state.set_value(target, window, cx);
                }
            });
        }
    }

    fn knob_event(&mut self, knob: Knob, event: &SliderEvent, cx: &mut Context<Self>) {
        let (value, released) = match event {
            SliderEvent::Change(value) => (value.end(), false),
            SliderEvent::Release(value) => (value.end(), true),
        };
        self.controls.live = (!released).then_some(knob);
        self.knob_moved(knob, rounded(value), released, cx);
        if released {
            // The next drag sends its first value even when it is this one.
            self.controls.last_sent = None;
        }
        cx.notify();
    }

    /// A send-on-every-change slider sends each new value once.
    fn fresh(&mut self, knob: Knob, value: i64) -> bool {
        if self.controls.last_sent == Some((knob, value)) {
            return false;
        }
        self.controls.last_sent = Some((knob, value));
        true
    }

    fn knob_moved(&mut self, knob: Knob, value: i64, released: bool, cx: &mut Context<Self>) {
        let unchanged = self
            .knob_target(knob)
            .is_some_and(|target| rounded(target) == value);
        match knob {
            // P546: every change is a quiet background transaction.
            Knob::ScreenSize => {
                if self.fresh(knob, value) {
                    let visibility = visibility_for_screen_size(value as f64);
                    let studio = self.studio.clone();
                    self.run(async move {
                        studio.set_background_visibility(visibility).await;
                    });
                }
            }
            // P562: every drag tick is a layout transaction (no draft).
            Knob::CornerRadius => {
                if self.fresh(knob, value) {
                    self.patch_layout("cameraCornerRadiusPct", json!(value));
                }
            }
            // P572: every change, one look on its way at a time.
            Knob::Brightness | Knob::Contrast | Knob::Saturation => {
                let look = self.editor.inspector.lens.as_ref().map(|lens| lens.look);
                if let Some(mut look) = look
                    && self.fresh(knob, value)
                {
                    let value = value as i32;
                    match knob {
                        Knob::Brightness => look.brightness = value,
                        Knob::Contrast => look.contrast = value,
                        _ => look.saturation = value,
                    }
                    self.send_look(look_of_sliders(look), cx);
                }
            }
            // P564, P569, P570: the drag is local; the drop applies.
            Knob::Margin | Knob::CameraZoom | Knob::PanX | Knob::PanY => {
                if released && !unchanged {
                    let key = match knob {
                        Knob::Margin => "cameraMargin",
                        Knob::CameraZoom => "cameraZoom",
                        Knob::PanX => "cameraOffsetX",
                        _ => "cameraOffsetY",
                    };
                    self.patch_layout(key, json!(value));
                }
            }
            // P552: the drop zooms around the centre.
            Knob::ScreenZoom => {
                if released
                    && !unchanged
                    && let Some(edit) = self.editor.edit.clone()
                {
                    let rect = screen_zoom_patch(edit.picture, value as f64);
                    self.commit_picture_edit(&edit, patch_of_rect(rect), cx);
                }
            }
            // P581, P582: a draft while dragging, the drop commits.
            Knob::BlurStrength | Knob::Similarity | Knob::Smoothness | Knob::Spill => {
                let current = self.editor.camera_background.clone();
                let next = if knob == Knob::BlurStrength {
                    let mut next = current;
                    next["blurPct"] = json!(value);
                    next
                } else {
                    let field = match knob {
                        Knob::Similarity => "similarityPct",
                        Knob::Smoothness => "smoothnessPct",
                        _ => "spillPct",
                    };
                    let mut patch = Map::new();
                    patch.insert(field.into(), json!(value));
                    background_with_key(&current, &patch)
                };
                let camera = self.editor.camera_id.clone();
                if released {
                    if let Some(next) = self
                        .editor_state
                        .background_draft
                        .commit(camera.as_deref(), next)
                    {
                        self.apply_camera_background(next);
                    }
                } else {
                    self.editor_state
                        .background_draft
                        .hold(camera.as_deref(), next);
                }
                self.refresh_editor(cx);
            }
            // P605: one update on release, none when back where it was.
            Knob::Opacity => {
                let banner = self
                    .editor
                    .inspector
                    .banner
                    .as_ref()
                    .map(|banner| banner.id.clone());
                if released
                    && !unchanged
                    && let Some(id) = banner
                {
                    let mut patch = Map::new();
                    patch.insert("opacity".into(), json!(value as f64 / 100.0));
                    self.patch_banner(id, patch, cx);
                }
            }
        }
    }

    /// `createCameraLookThrottle`: a look while one is on its way waits,
    /// and only the latest goes next.
    fn send_look(&mut self, look: Value, cx: &mut Context<Self>) {
        if self.controls.look_in_flight {
            self.controls.look_next = Some(look);
            return;
        }
        self.controls.look_in_flight = true;
        let studio = self.studio.clone();
        let (done, answer) = oneshot::channel();
        self.run(async move {
            let _ = done.send(studio.apply_camera_look(look).await);
        });
        cx.spawn(async move |this, cx| {
            let _ = answer.await;
            let _ = this.update(cx, |page, cx| {
                page.controls.look_in_flight = false;
                if let Some(next) = page.controls.look_next.take() {
                    page.send_look(next, cx);
                }
            });
        })
        .detach();
    }

    /// P571: the look back to neutral.
    pub(super) fn reset_camera_look(&mut self, cx: &mut Context<Self>) {
        self.controls.look_next = None;
        self.send_look(
            json!({"brightness": 0.0, "contrast": 1.0, "saturation": 1.0}),
            cx,
        );
    }

    fn field_event(
        &mut self,
        field: Field,
        input: &Entity<InputState>,
        event: &InputEvent,
        cx: &mut Context<Self>,
    ) {
        match event {
            // `set_value` stays quiet, so a change is the streamer's.
            InputEvent::Change => self.controls.editing = Some(field),
            InputEvent::PressEnter { .. } | InputEvent::Blur => {
                if self.controls.editing == Some(field) {
                    self.controls.editing = None;
                    let typed = input.read(cx).value().to_string();
                    self.commit_field(field, &typed, cx);
                }
                cx.notify();
            }
            _ => {}
        }
    }

    /// A `PowerSlider`'s typed number: Enter or blur commits it.
    fn knob_input_event(
        &mut self,
        knob: Knob,
        input: &Entity<InputState>,
        event: &InputEvent,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        match event {
            // `set_value` stays quiet, so a change is the streamer's.
            InputEvent::Change => self.controls.typing = Some(knob),
            InputEvent::PressEnter { .. } | InputEvent::Blur => {
                if self.controls.typing == Some(knob) {
                    self.controls.typing = None;
                    let typed = input.read(cx).value().to_string();
                    self.commit_knob_text(knob, &typed, window, cx);
                }
                cx.notify();
            }
            _ => {}
        }
    }

    /// `commitNumeric`: a number, clamped and snapped to the slider's
    /// range, moves the slider and commits as a release does. Nothing when
    /// it doesn't parse or says what is already there.
    fn commit_knob_text(
        &mut self,
        knob: Knob,
        typed: &str,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let Ok(parsed) = typed.trim().parse::<f32>() else {
            return;
        };
        if !parsed.is_finite() {
            return;
        }
        let (min, max, step, _) = knob.range();
        let value = clamp_to_range(parsed, min, max, step);
        let state = self.controls.knob(knob).clone();
        if rounded(state.read(cx).value().end()) == rounded(value) {
            return;
        }
        state.update(cx, |state, cx| state.set_value(value, window, cx));
        self.knob_moved(knob, rounded(value), true, cx);
        self.controls.last_sent = None;
    }

    /// A `PowerSlider`'s reset (its button or a double-click on the track):
    /// the kit has moved the slider to `value`; it commits as a release.
    fn knob_reset(&mut self, knob: Knob, value: f32, cx: &mut Context<Self>) {
        self.controls.live = None;
        self.knob_moved(knob, rounded(value), true, cx);
        self.controls.last_sent = None;
        cx.notify();
    }

    /// Enter or blur on a typed number (`commitField`): nothing when it
    /// doesn't parse, is off, or says what is already there.
    fn commit_field(&mut self, field: Field, typed: &str, cx: &mut Context<Self>) {
        let placement = self.editor.inspector.placement.clone();
        match field {
            Field::Transform(index) => {
                let (Some(edit), Some(fields)) = (
                    self.editor.edit.clone(),
                    placement.and_then(|placement| placement.fields),
                ) else {
                    return;
                };
                let key = TRANSFORM_FIELDS[index].0;
                let Some(parsed) = parse_percent_value(typed) else {
                    return;
                };
                if !fields.enabled || parsed == rect_field(edit.picture, key) {
                    return;
                }
                let patch = transform_field_patch(key, parsed, edit.picture, fields.aspect_locked);
                self.commit_picture_edit(&edit, patch, cx);
            }
            Field::Crop(index) => {
                let (Some(edit), Some(crop)) = (
                    self.editor.edit.clone(),
                    placement.and_then(|placement| placement.crop),
                ) else {
                    return;
                };
                let key = CROP_FIELDS[index].0;
                let committed = stage_crop_of(&edit.source.transform);
                let Some(parsed) = parse_percent_value(typed) else {
                    return;
                };
                if !crop.enabled || parsed == crop_field(committed, key) {
                    return;
                }
                let (side, value) = crop_field_patch(key, parsed, committed);
                self.commit_crop(&edit, &side, value, cx);
            }
            Field::Edge(index) => {
                let background = self.editor.camera_background.clone();
                let key = key_of(&background);
                let edges = key_edges_of(key.get("hideEdges"));
                if let Some(next) = key_edges_patch(&edges, KEY_EDGES[index].0, typed) {
                    self.set_hide_edges(next);
                }
            }
        }
    }

    /// P583, P584: the key's Hide edges, as a whole.
    pub(super) fn set_hide_edges(&mut self, edges: Value) {
        let mut patch = Map::new();
        patch.insert("hideEdges".into(), edges);
        let next = background_with_key(&self.editor.camera_background, &patch);
        self.apply_camera_background(next);
    }

    /// A crop side (P553) or all four back to 0 (P554). While the box is
    /// the picture the uncropped picture stays and the box shrinks to what
    /// is kept, as an Alt-drag does; otherwise the box stays.
    pub(super) fn commit_crop(
        &mut self,
        edit: &EditTarget,
        side: &str,
        value: f64,
        cx: &mut Context<Self>,
    ) {
        let committed = stage_crop_of(&edit.source.transform);
        let next = with_crop_field(committed, side, value);
        self.commit_crop_to(edit, next, side, cx);
    }

    pub(super) fn commit_crop_to(
        &mut self,
        edit: &EditTarget,
        next: StageCrop,
        side: &str,
        cx: &mut Context<Self>,
    ) {
        if !edit.box_is_picture {
            let mut patch = Map::new();
            if side.is_empty() {
                if let Value::Object(all) = next.json() {
                    patch = all;
                }
            } else {
                patch.insert(side.into(), json!(crop_field(next, side)));
            }
            self.precise_commit(edit.source.id.clone(), Value::Object(patch), cx);
            return;
        }
        let committed = stage_crop_of(&edit.source.transform);
        let rect = crop_edit_on_picture(next, edit.picture, committed);
        let frame = picture_edit_frame_patch(
            patch_of_rect(rect),
            edit.picture,
            StageRect::of(&edit.source.transform),
            &edit.source.kind,
            edit.stage_margin,
            edit.canvas,
            edit.camera_on_stage,
        );
        let mut patch = match next.json() {
            Value::Object(crop) => crop,
            _ => Map::new(),
        };
        if let Value::Object(frame) = frame.json() {
            patch.extend(frame);
        }
        self.precise_commit(edit.source.id.clone(), Value::Object(patch), cx);
    }

    /// `commitPictureEdit`: an edit of the picture box, as the frame it
    /// maps back to.
    pub(super) fn commit_picture_edit(
        &mut self,
        edit: &EditTarget,
        patch: TransformPatch,
        cx: &mut Context<Self>,
    ) {
        let frame = picture_edit_frame_patch(
            patch,
            edit.picture,
            StageRect::of(&edit.source.transform),
            &edit.source.kind,
            edit.stage_margin,
            edit.canvas,
            edit.camera_on_stage,
        );
        self.precise_commit(edit.source.id.clone(), frame.json(), cx);
    }

    /// `runPreciseEdit(setSceneSourceTransform)`: one at a time; input
    /// while one lands is dropped.
    fn precise_commit(&mut self, source_id: String, patch: Value, cx: &mut Context<Self>) {
        let studio = self.studio.clone();
        self.precise(cx, async move {
            studio.commit_source_transform(&source_id, patch).await;
        });
    }

    /// `runPreciseEdit`: the stage reads as pending until it lands.
    pub(super) fn precise(
        &mut self,
        cx: &mut Context<Self>,
        job: impl std::future::Future<Output = ()> + Send + 'static,
    ) {
        if self.editor_state.precise_pending {
            return;
        }
        self.editor_state.precise_pending = true;
        self.refresh_editor(cx);
        let (done, answer) = oneshot::channel();
        self.run(async move {
            job.await;
            let _ = done.send(());
        });
        cx.spawn(async move |this, cx| {
            let _ = answer.await;
            let _ = this.update(cx, |page, cx| {
                page.editor_state.precise_pending = false;
                page.refresh_editor(cx);
            });
        })
        .detach();
    }

    /// `applyLayoutPatch({[key]: value})`.
    pub(super) fn patch_layout(&self, key: &str, value: Value) {
        let mut patch = Map::new();
        patch.insert(key.into(), value);
        self.apply_layout_patch(patch);
    }

    pub(super) fn apply_layout_patch(&self, patch: Map<String, Value>) {
        let studio = self.studio.clone();
        self.run(async move {
            studio.apply_layout_patch(patch).await;
        });
    }

    /// `applyCameraPreset(patch)`.
    pub(super) fn apply_camera_preset(&self, key: &str, value: &str) {
        let mut patch = Map::new();
        patch.insert(key.into(), json!(value));
        let studio = self.studio.clone();
        self.run(async move {
            studio.apply_camera_preset(patch, false).await;
        });
    }

    pub(super) fn apply_camera_background(&self, background: Value) {
        let studio = self.studio.clone();
        self.run(async move {
            studio.apply_camera_background(&background).await;
        });
    }

    // ── Drawing ────────────────────────────────────────────────────────

    /// A `PowerSlider`: its label and typed number over the track, the
    /// reset where Electron has a default, Blur strength's marks, and the
    /// reason it waits under it. The banner's Opacity (a `ParameterSlider`)
    /// shows its value as words.
    pub(super) fn knob_row(
        &self,
        knob: Knob,
        label: &'static str,
        disabled: bool,
        reason: Option<&'static str>,
        cx: &Context<Self>,
    ) -> AnyElement {
        let id = format!("scene-knob-{knob:?}");
        let (_, _, step, _) = knob.range();
        let mut slider = PowerSlider::new(
            SharedString::from(id.clone()),
            label,
            self.controls.knob(knob),
        )
        .step(step)
        .suffix(knob.suffix())
        .bipolar(knob.bipolar())
        .disabled(disabled);
        if let Some(reason) = reason {
            slider = slider.disabled_reason(reason);
        }
        if let Some(default) = knob.reset_to() {
            let page = cx.entity().downgrade();
            slider = slider.default_value(default).on_reset(move |value, _, cx| {
                let _ = page.update(cx, |page, cx| page.knob_reset(knob, value, cx));
            });
        }
        if knob == Knob::BlurStrength {
            slider = slider.marks(
                BLUR_MARKS
                    .iter()
                    .map(|(at, word)| PowerSliderMark {
                        value: *at as f32,
                        label: Some(SharedString::from(*word)),
                    })
                    .collect(),
            );
        }
        if let Some(input) = self.controls.knob_input(knob) {
            slider = slider.value_slot(
                div().w(px(80.)).child(
                    Input::new(SharedString::from(format!("{id}-value")), input)
                        // Electron's number box is `text-right`.
                        .align_right(true)
                        .disabled(disabled)
                        .revert_on_escape(true)
                        .accessibility_label(format!("{label} value")),
                ),
            );
        }
        slider.into_any_element()
    }

    /// One typed percent: its label over the field and the `%` after it.
    // TODO(kit): `InputGroup` with an inline-end `%` addon, once it takes
    // `revert_on_escape` (P549: Escape reverts the draft to what the field
    // held when it took focus; only the plain `Input` has it today).
    pub(super) fn percent_field(
        &self,
        field: Field,
        label: &'static str,
        name: String,
        enabled: bool,
        t: &Theme,
    ) -> AnyElement {
        let id = match field {
            Field::Transform(index) => format!("scene-transform-{index}"),
            Field::Crop(index) => format!("scene-crop-{index}"),
            Field::Edge(index) => format!("scene-key-edge-{index}"),
        };
        div()
            .flex()
            .flex_col()
            .gap(px(4.))
            .min_w_0()
            .flex_1()
            .child(Label::new(label))
            .child(
                div()
                    .flex()
                    .items_center()
                    .gap(px(4.))
                    .child(
                        div().flex_1().min_w_0().child(
                            Input::new(SharedString::from(id), self.controls.input(field))
                                .disabled(!enabled)
                                .revert_on_escape(true)
                                .accessibility_label(name),
                        ),
                    )
                    .child(
                        div()
                            .type_scale(text::META)
                            .text_color(hsla(t.muted_foreground))
                            .child(copy::PERCENT),
                    ),
            )
            .into_any_element()
    }
}

/// A whole box as a patch of its four fields.
fn patch_of_rect(rect: StageRect) -> TransformPatch {
    TransformPatch {
        x: Some(rect.x),
        y: Some(rect.y),
        width: Some(rect.width),
        height: Some(rect.height),
    }
}
