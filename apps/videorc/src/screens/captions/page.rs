//! Captions ⌘4 (`components/tabs/captions-tab.tsx`): the caption preview
//! the backend draws, the Live captions controls and the host transcript,
//! from `videorc_app_core::captions` and drawn with the kit.

use std::sync::Arc;

use gpui::{
    AnyElement, App, Context, Entity, EventEmitter, FontWeight, ObjectFit, Role, SharedString,
    Window, div, prelude::*, px,
};
use serde_json::{Value, json};
use videorc_app_core::account::entitlements::EntitlementGate;
use videorc_app_core::buddy::copy::VIEW_PREMIUM;
use videorc_app_core::captions::{self as c, PreviewBackdrop, Tone, methods};
use videorc_app_core::livestream::captions_preflight;
use videorc_app_core::nav::PageId;
use videorc_app_core::studio::capture_config;
use videorc_kit::{
    alert::{Alert, AlertVariant},
    badge::{Badge, BadgeVariant},
    button::{Button, ButtonSize, ButtonVariant},
    caption_preview_backdrop::{CaptionPreviewBackdrop, CaptionPreviewBackdropEl},
    field::{Field, FieldGroup},
    icon::{IconName, icon},
    list_row::GroupedList,
    navigable_row::NavigableRow,
    panel_section::PanelSection,
    scroll_area::ScrollArea,
    segmented_control::{Segment, SegmentedControl},
    select::Select,
    settings_row::{SettingsGroup, SettingsRow},
    shortcut_keys::ShortcutKeys,
    status_dot::{StatusDot, StatusTone},
    switch::Switch,
    theme::{self, FONT, TypeScale, faded_over, hsla, with_alpha},
    toggle_group::{ToggleGroup, ToggleItem},
    tokens::{Color, Theme, radius, size, text},
};

/// `CAPTIONS_GRID` (`lib/page-layout.ts`): the preview beside the controls
/// from 940 px of page width (`@min-[940px]/page`), stacked below it.
const CAPTIONS_GRID_MIN_WIDTH: f32 = 940.;
/// `minmax(380px,0.8fr)`: the controls column's floor.
const CONTROLS_MIN_WIDTH: f32 = 380.;
/// `grid-cols-2 gap-2`: the Style chips' gap.
const STYLE_GAP: f32 = 8.;

use super::feed::{self, AppStudio, CaptionsFeed};
use crate::app::menus::ToggleCaptions;

/// A door to another page: Sources for the microphone, Scene for the bar.
pub struct OpenPage(pub PageId);

impl EventEmitter<OpenPage> for CaptionsPanel {}

pub struct CaptionsPanel {
    feed: Entity<CaptionsFeed>,
    studio: Arc<AppStudio>,
    runtime: tokio::runtime::Handle,
    active: bool,
    backdrop: PreviewBackdrop,
    /// The bar as the backend draws it, and what it was drawn from.
    preview: Option<Arc<gpui::Image>>,
    preview_key: Option<Value>,
    preview_ticket: u64,
    /// `overlays.layout.get`'s captions rects.
    layout: Option<Value>,
    transcript: Vec<(String, String)>,
    transcript_failed: bool,
    transcript_show: Option<String>,
    /// The page's measured width (`@container/page`): one column or two,
    /// and the Style chips' width.
    width: f32,
}

impl CaptionsPanel {
    pub fn new(
        feed: Entity<CaptionsFeed>,
        runtime: tokio::runtime::Handle,
        cx: &mut Context<Self>,
    ) -> Self {
        cx.observe(&feed, |this, _, cx| {
            if this.active {
                this.sync_preview(cx);
            }
            cx.notify();
        })
        .detach();
        let studio = feed.read(cx).studio().clone();
        Self {
            feed,
            studio,
            runtime,
            active: false,
            backdrop: PreviewBackdrop::default(),
            preview: None,
            preview_key: None,
            preview_ticket: 0,
            layout: None,
            transcript: Vec::new(),
            transcript_failed: false,
            transcript_show: None,
            width: 0.,
        }
    }

    fn measured(&mut self, width: f32, cx: &mut Context<Self>) {
        if (width - self.width).abs() >= 0.5 {
            self.width = width;
            cx.notify();
        }
    }

    fn wide(&self) -> bool {
        self.width >= CAPTIONS_GRID_MIN_WIDTH
    }

    /// One Style chip's body width: two chips to a row of the controls
    /// column (`grid-cols-2 gap-2`), less the chip's own padding and rim.
    fn style_chip_width(&self) -> f32 {
        let column = if self.wide() {
            (self.width * 0.4).max(CONTROLS_MIN_WIDTH)
        } else {
            self.width
        };
        let item = (column - 2. * size::GUTTER - STYLE_GAP) / 2.;
        (item - 2. * 8. - 2.).floor().max(120.)
    }

    pub fn set_active(&mut self, active: bool, cx: &mut Context<Self>) {
        self.active = active;
        if active {
            self.read_layout(cx);
            self.sync_preview(cx);
            cx.notify();
        }
    }

    fn read_layout(&mut self, cx: &mut Context<Self>) {
        let client = self.studio.backend().clone();
        let job = self.runtime.spawn(async move {
            client
                .request(methods::OVERLAY_LAYOUT_GET, Value::Null)
                .await
        });
        cx.spawn(async move |this, cx| {
            if let Ok(Ok(layout)) = job.await {
                let _ = this.update(cx, |this, cx| {
                    this.layout = Some(layout);
                    cx.notify();
                });
            }
        })
        .detach();
    }

    /// `captions.preview.render` whenever the text, the canvas or the look
    /// changes; the last answer stays until the next one lands.
    fn sync_preview(&mut self, cx: &mut Context<Self>) {
        let snapshot = self.studio.snapshot();
        let capture = &snapshot.settings.capture_doc;
        let captions = &capture["captions"];
        let (width, height) = c::preview_canvas(
            capture["video"]["width"].as_u64().unwrap_or(1920) as u32,
            capture["video"]["height"].as_u64().unwrap_or(1080) as u32,
        );
        let text = preview_text(self.feed.read(cx));
        let params = json!({
            "text": text,
            "canvasWidth": width,
            "canvasHeight": height,
            "styleId": captions["styleId"].as_str().unwrap_or("classic"),
            "position": captions["position"].as_str().unwrap_or("bottom"),
            "textSize": captions["textSize"].as_str().unwrap_or("m"),
        });
        if self.preview_key.as_ref() == Some(&params) || !self.studio.is_connected() {
            return;
        }
        self.preview_key = Some(params.clone());
        self.preview_ticket = self.preview_ticket.wrapping_add(1);
        let ticket = self.preview_ticket;
        let client = self.studio.backend().clone();
        let job = self.runtime.spawn(async move {
            let answer = client.request(methods::PREVIEW_RENDER, params).await.ok()?;
            c::decode_base64(answer["pngBase64"].as_str()?)
        });
        cx.spawn(async move |this, cx| {
            let png = job.await.ok().flatten();
            let _ = this.update(cx, |this, cx| {
                if this.preview_ticket != ticket {
                    return;
                }
                this.preview = png
                    .map(|bytes| Arc::new(gpui::Image::from_bytes(gpui::ImageFormat::Png, bytes)));
                cx.notify();
            });
        })
        .detach();
    }

    /// One field of the stored captions block; a look change bumps the
    /// style revision so the live bar and the captioned copy follow it.
    fn patch(&mut self, key: &'static str, value: Value, bump_style: bool, cx: &mut Context<Self>) {
        let studio = self.studio.clone();
        let job = self.runtime.spawn(async move {
            let _ = studio
                .update_capture_config(|config| {
                    if config["captions"][key] == value {
                        return;
                    }
                    capture_config::set_path(config, &["captions", key], Some(value));
                    if bump_style {
                        let revision = config["captions"]["styleRevision"].as_u64().unwrap_or(0);
                        capture_config::set_path(
                            config,
                            &["captions", "styleRevision"],
                            Some(json!(revision + 1)),
                        );
                    }
                })
                .await;
        });
        cx.spawn(async move |this, cx| {
            let _ = job.await;
            let _ = this.update(cx, |this, cx| {
                this.sync_preview(cx);
                cx.notify();
            });
        })
        .detach();
    }

    fn retry(&mut self, cx: &mut Context<Self>) {
        let language = self.studio.snapshot().settings.capture_doc["captions"]["language"]
            .as_str()
            .unwrap_or("auto")
            .to_string();
        self.feed.update(cx, |feed, cx| feed.start(language, cx));
    }

    fn refresh_transcript(&mut self, show_id: String, cx: &mut Context<Self>) {
        let client = self.studio.backend().clone();
        let params = json!({ "showId": show_id });
        let job = self
            .runtime
            .spawn(async move { client.request(methods::TRANSCRIPT, params).await });
        cx.spawn(async move |this, cx| {
            let result = job.await;
            let _ = this.update(cx, |this, cx| {
                // A reply for a room that closed or changed is dropped.
                if this.transcript_show.as_deref() != Some(show_id.as_str()) {
                    return;
                }
                match result {
                    Ok(Ok(answer)) => {
                        this.transcript = c::transcript_rows(&answer);
                        this.transcript_failed = false;
                    }
                    _ => this.transcript_failed = true,
                }
                cx.notify();
            });
        })
        .detach();
    }

    fn page_view(&self, cx: &App) -> (c::PageView, Option<String>) {
        let feed = self.feed.read(cx);
        let snapshot = self.studio.snapshot();
        let capture = &snapshot.settings.capture_doc;
        let status = feed.status();
        let gate = feed.gate();
        let microphone_id = capture["sources"]["microphoneId"].as_str().unwrap_or("");
        let microphone = snapshot
            .sources
            .devices
            .devices
            .iter()
            .find(|device| !microphone_id.is_empty() && device.id == microphone_id)
            .map(|device| device.name.clone());
        let vertical = capture["layout"]["layoutPreset"]
            .as_str()
            .is_some_and(capture_config::layout_preset_is_vertical);
        let placement = self
            .layout
            .as_ref()
            .and_then(|layout| c::placement_bottom(layout, vertical));
        let view = c::page(&c::PageInputs {
            capture,
            status: &status,
            session_active: snapshot.session.phase.is_active(),
            room_open: feed.room_open(),
            gate: &gate,
            platform: feed::platform(),
            microphone_device: microphone.as_deref(),
            placement_bottom: placement,
        });
        let upgrade = match gate {
            EntitlementGate::Locked {
                upgrade_url: Some(url),
                ..
            } => Some(url.to_string()),
            _ => None,
        };
        (view, upgrade)
    }

    fn preview_section(&self, t: &Theme, cx: &mut Context<Self>) -> AnyElement {
        let feed = self.feed.read(cx);
        let latest = feed
            .lines()
            .latest()
            .map(|line| line.text.trim().to_string());
        let sample = latest.as_deref().is_none_or(str::is_empty);
        let text = preview_text(feed);
        let snapshot = self.studio.snapshot();
        let capture = &snapshot.settings.capture_doc;
        let video_w = capture["video"]["width"].as_u64().unwrap_or(1920);
        let video_h = capture["video"]["height"].as_u64().unwrap_or(1080);
        let (canvas_w, canvas_h) = c::preview_canvas(video_w as u32, video_h as u32);
        let top = capture["captions"]["position"].as_str() == Some("top");
        // Stand-in video: Electron's fixed preview surfaces, drawn by the
        // kit (Light from the video tokens, Dark and Mixed pre-drawn).
        let backdrop = match self.backdrop {
            PreviewBackdrop::Dark => CaptionPreviewBackdrop::Dark,
            PreviewBackdrop::Light => CaptionPreviewBackdrop::Light,
            PreviewBackdrop::Mixed => CaptionPreviewBackdrop::Mixed,
        };
        // The stand-in video fills the column at the canvas aspect
        // (`aspect-video w-full`), the backend's bar on it.
        let mut frame = div()
            .id("caption-preview-frame")
            .relative()
            .w_full()
            .aspect_ratio(canvas_w.max(1) as f32 / canvas_h.max(1) as f32)
            .overflow_hidden()
            .rounded(px(radius::ROW))
            .border_1()
            .border_color(hsla(t.border))
            .bg(hsla(t.video_ground))
            .child(
                div()
                    .absolute()
                    .top_0()
                    .left_0()
                    .size_full()
                    .child(CaptionPreviewBackdropEl::new(backdrop)),
            );
        // Faint safe-area columns: a hairline at the middle of every 8rem
        // tile, white 8% at 35%.
        let column = hsla(with_alpha(t.video_ground_foreground, 0.08 * 0.35));
        for index in 0..16 {
            frame = frame.child(
                div()
                    .absolute()
                    .top_0()
                    .h_full()
                    .left(px(63. + 128. * index as f32))
                    .w(px(2.))
                    .bg(column),
            );
        }
        if let Some(image) = self.preview.clone() {
            frame = frame.child(
                gpui::img(image)
                    .absolute()
                    .top_0()
                    .left_0()
                    .size_full()
                    .object_fit(ObjectFit::Contain),
            );
        }
        let backdrop_control = PreviewBackdrop::ALL.into_iter().fold(
            SegmentedControl::new("caption-preview-background")
                .small(true)
                .accessibility_label(c::PREVIEW_BACKGROUND)
                .value(Some(self.backdrop.id())),
            |control, backdrop| control.option(Segment::new(backdrop.id(), backdrop.label())),
        );
        let this = cx.entity().downgrade();
        // The column's only section: no hairline under it.
        PanelSection::new("caption-preview")
            .icon(icon(IconName::EyeDuotone, 16., hsla(t.muted_foreground)))
            .title(c::PREVIEW_TITLE)
            .description(c::PREVIEW_DESCRIPTION)
            .last(true)
            .action(
                Badge::new(if sample {
                    c::PREVIEW_SAMPLE_BADGE
                } else {
                    c::PREVIEW_LATEST_BADGE
                })
                .variant(BadgeVariant::Default),
            )
            .child(frame)
            .child(
                div()
                    .flex()
                    .flex_wrap()
                    .items_center()
                    .justify_between()
                    .gap(px(12.))
                    .child(
                        div()
                            .min_w(px(0.))
                            .flex()
                            .flex_col()
                            // `text-sm font-medium`.
                            .child(
                                div()
                                    .text_size(px(14.))
                                    .line_height(px(20.))
                                    .font_weight(FontWeight::MEDIUM)
                                    .truncate()
                                    .child(text.clone()),
                            )
                            .child(
                                div()
                                    .type_scale(text::META)
                                    .text_color(hsla(t.muted_foreground))
                                    .child(format!(
                                        "{video_w} × {video_h} · {}",
                                        if top { "Top" } else { "Bottom" }
                                    )),
                            ),
                    )
                    .child(backdrop_control.on_change(move |value, _, app| {
                        if let Some(backdrop) = PreviewBackdrop::parse(value.as_ref()) {
                            let _ = this.update(app, |this, cx| {
                                this.backdrop = backdrop;
                                cx.notify();
                            });
                        }
                    })),
            )
            .into_any_element()
    }

    fn controls_section(&self, t: &Theme, last: bool, cx: &mut Context<Self>) -> AnyElement {
        let (view, upgrade) = self.page_view(cx);
        let feed = self.feed.read(cx);
        let pending = feed.pending();
        let start_error = feed.start_error.clone();
        let strip: Vec<c::CaptionLine> = feed.lines().tail(c::STRIP_LINES).to_vec();
        let announcement = feed.lines().latest_final().map(str::to_string);
        let locked = view.locked.is_some();
        let this = cx.entity().downgrade();
        let reader_open = super::reader::is_open(cx);
        let muted = hsla(t.muted_foreground);

        let section = PanelSection::new("captions-controls")
            .icon(icon(IconName::ClosedCaptioningDuotone, 16., muted))
            .title(c::LIVE_CAPTIONS)
            .description(c::PANEL_DESCRIPTION)
            .last(last);
        // One `FieldGroup` holds the section's fields, 24 px apart.
        let mut fields: Vec<AnyElement> = Vec::new();

        // Locked means disabled with one reason, and the lock leads.
        if let Some(reason) = view.locked.clone() {
            let mut alert = Alert::new("captions-lock")
                .variant(AlertVariant::Locked)
                .title(reason);
            if let Some(url) = upgrade {
                alert = alert.action(
                    Button::new("captions-unlock")
                        .label(VIEW_PREMIUM)
                        .variant(ButtonVariant::Outline)
                        .size(ButtonSize::Xs)
                        .on_click(move |_, _, cx| cx.open_url(&url)),
                );
            }
            fields.push(alert.into_any_element());
        }

        // One state signal: the switch says on or off; while on, one dot
        // names what captions are doing, with its line, in the row's
        // description (`flex flex-wrap items-center gap-x-2 gap-y-0.5`).
        let switch_line: AnyElement = if view.enabled {
            div()
                .flex()
                .flex_wrap()
                .items_center()
                .gap_x(px(8.))
                .gap_y(px(2.))
                .child(
                    StatusDot::new("captions-status")
                        .tone(status_tone(view.status_tone))
                        .label(view.status_word),
                )
                .child(div().min_w(px(0.)).child(view.switch_line.clone()))
                .into_any_element()
        } else {
            view.switch_line.clone().into_any_element()
        };
        let mut switch_row =
            SettingsRow::new("captions-enabled-row", c::LIVE_CAPTIONS).description(switch_line);
        let mut trailing = div().flex().flex_none().items_center().gap(px(8.));
        if view.show_retry {
            trailing = trailing.child(
                Button::new("captions-retry")
                    .icon(IconName::ArrowClockwise)
                    .label(c::RETRY)
                    .variant(ButtonVariant::Outline)
                    .size(ButtonSize::Xs)
                    .disabled(pending)
                    .on_click(cx.listener(|this, _, _, cx| this.retry(cx))),
            );
        }
        trailing = trailing.child(
            Switch::new("captions-enabled")
                .checked(view.enabled)
                .disabled(pending || !view.can_toggle)
                .accessibility_label(c::LIVE_CAPTIONS)
                .on_change({
                    let this = this.clone();
                    move |enabled, _, app| {
                        let _ = this.update(app, |this, cx| {
                            this.patch("enabled", json!(enabled), false, cx)
                        });
                    }
                }),
        );
        switch_row = switch_row.child(trailing);
        fields.push(SettingsGroup::new().row(switch_row).into_any_element());

        if let Some(error) = start_error {
            fields.push(
                Alert::new("captions-start-error")
                    .variant(AlertVariant::Destructive)
                    .title(error)
                    .into_any_element(),
            );
        }
        if view.room_open {
            fields.push(
                Alert::new("captions-room")
                    .title(c::ROOM_TITLE)
                    .description(c::ROOM_DESCRIPTION)
                    .into_any_element(),
            );
        }
        if view.platform_unavailable {
            fields.push(
                Alert::new("captions-platform-unavailable")
                    .variant(AlertVariant::Warning)
                    .title(captions_preflight::LINUX_TITLE)
                    .description(captions_preflight::LINUX_DETAIL)
                    .into_any_element(),
            );
        }
        if let Some(blocker) = view.livestream_blocker {
            fields.push(
                Alert::new("captions-livestream-blocker")
                    .variant(AlertVariant::Warning)
                    .title(c::BLOCKER_TITLE)
                    .description(blocker)
                    .into_any_element(),
            );
        }

        // The one choice beside the one switch: the live stream always,
        // the recording too if picked.
        let mut outputs = SegmentedControl::new("captions-outputs")
            .accessibility_label(c::OUTPUTS_LABEL)
            .disabled(locked || view.outputs_locked)
            .value(Some(view.outputs.clone()));
        if !locked && view.outputs_locked {
            outputs = outputs.disabled_reason(c::SESSION_LOCK_REASON);
        }
        for (value, label) in c::OUTPUT_OPTIONS {
            outputs = outputs.option(Segment::new(*value, *label));
        }
        // Its line sits under the control (`FieldLabel`, the control, then
        // `FieldDescription`): the kit `Field` order.
        fields.push(
            Field::new("captions-outputs-field")
                .label(c::OUTPUTS_LABEL)
                .description(view.outputs_description)
                .child(outputs.on_change({
                    let this = this.clone();
                    move |value, _, app| {
                        let _ = this.update(app, |this, cx| {
                            this.patch("burnTarget", json!(value.as_ref()), false, cx)
                        });
                    }
                }))
                .into_any_element(),
        );

        // What captions hear and where the bar sits belong to Sources and
        // Scene: these rows say it and open the page.
        let open = |page: PageId| {
            let this = this.clone();
            move |_: &gpui::ClickEvent, _: &mut Window, app: &mut App| {
                let _ = this.update(app, |_, cx| cx.emit(OpenPage(page)));
            }
        };
        // The group's name is for screen readers only (`aria-label`).
        let mut elsewhere = GroupedList::new()
            .accessibility_label(c::ELSEWHERE_LABEL)
            .row(
                NavigableRow::new(
                    "captions-microphone",
                    c::MICROPHONE,
                    view.microphone.clone(),
                )
                .icon(icon(IconName::Microphone, 16., muted))
                .on_navigate(open(PageId::Sources)),
            )
            .row(
                NavigableRow::new(
                    "captions-placement",
                    c::PLACEMENT,
                    view.placement.unwrap_or("Bottom"),
                )
                .icon(icon(IconName::SquaresFour, 16., muted))
                .on_navigate(open(PageId::Layouts)),
            );
        if let Some(allowance) = view.allowance.clone() {
            elsewhere = elsewhere.row(
                NavigableRow::new("captions-allowance", c::ALLOWANCE, allowance).icon(icon(
                    IconName::ClosedCaptioning,
                    16.,
                    muted,
                )),
            );
        }
        fields.push(elsewhere.into_any_element());

        // The look: applied live. Each chip shows a swatch, the name and
        // its line (`StyleSwatch`).
        // Two chips to a row, 8 px apart (`grid w-full grid-cols-2 gap-2`).
        let chip_width = self.style_chip_width();
        let styles = c::STYLES.iter().fold(
            // `data-pressed:border-primary/50 data-pressed:bg-primary/10`.
            ToggleGroup::new("caption-style")
                .outline(true)
                .card(true)
                .spacing(STYLE_GAP)
                .accessibility_label(c::STYLE_LABEL)
                .disabled(locked)
                .value([view.style_id.clone()]),
            |group, style| {
                group.item(
                    ToggleItem::new(style.id, style.label)
                        .child(style_chip(t, style, chip_width, locked)),
                )
            },
        );
        fields.push(
            field(
                t,
                c::STYLE,
                c::STYLE_DESCRIPTION,
                styles.on_change({
                    let this = this.clone();
                    move |values, _, app| {
                        let Some(value) = values.into_iter().next() else {
                            return;
                        };
                        if c::STYLES.iter().any(|style| style.id == value.as_ref()) {
                            let _ = this.update(app, |this, cx| {
                                this.patch("styleId", json!(value.as_ref()), true, cx)
                            });
                        }
                    }
                }),
            )
            .into_any_element(),
        );

        let sizes = c::TEXT_SIZES.iter().fold(
            SegmentedControl::new("caption-text-size")
                .accessibility_label(c::TEXT_SIZE_LABEL)
                .disabled(locked)
                .value(Some(view.text_size.clone())),
            |control, (value, label)| control.option(Segment::new(*value, *label)),
        );
        fields.push(
            Field::new("caption-text-size-field")
                .label(c::TEXT_SIZE)
                .child(sizes.on_change({
                    let this = this.clone();
                    move |value, _, app| {
                        let _ = this.update(app, |this, cx| {
                            this.patch("textSize", json!(value.as_ref()), true, cx)
                        });
                    }
                }))
                .into_any_element(),
        );

        let languages = c::LANGUAGES.iter().fold(
            Select::new("caption-language")
                .accessibility_label(c::LANGUAGE)
                .disabled(locked || view.language_locked)
                .value(Some(SharedString::from(view.language.clone()))),
            |select, (id, label)| select.option(*id, *label),
        );
        fields.push(
            field(
                t,
                c::LANGUAGE,
                view.language_description,
                languages.on_change({
                    let this = this.clone();
                    move |value, _, app| {
                        let _ = this.update(app, |this, cx| {
                            this.patch("language", json!(value.as_ref()), false, cx)
                        });
                    }
                }),
            )
            .into_any_element(),
        );

        // The live strip: the last three lines, partials in the secondary
        // tone; screen readers hear settled lines only.
        if view.show_strip || !strip.is_empty() {
            let mut lines = div()
                .id("captions-strip")
                .flex()
                .flex_col()
                .justify_end()
                .gap(px(6.))
                .min_h(px(64.))
                .p(px(12.))
                .rounded(px(radius::ROW))
                .border_1()
                .border_color(hsla(t.border))
                .bg(hsla(t.inset));
            // `text-sm leading-6`.
            if strip.is_empty() {
                lines = lines.child(
                    div()
                        .text_size(px(14.))
                        .line_height(px(24.))
                        .text_color(muted)
                        .child(c::LISTENING),
                );
            }
            for line in &strip {
                lines = lines.child(
                    div()
                        .id(SharedString::from(format!("strip-{}", line.identity())))
                        .text_size(px(14.))
                        .line_height(px(24.))
                        .text_color(hsla(if line.is_partial() {
                            t.muted_foreground
                        } else {
                            t.foreground
                        }))
                        .child(line.text.clone()),
                );
            }
            fields.push(lines.into_any_element());
        }
        if let Some(final_text) = announcement {
            fields.push(live_region(final_text).into_any_element());
        }

        let reader_label = if reader_open {
            format!("Close {}", c::READER_NAME)
        } else {
            format!("Open {}", c::READER_NAME)
        };
        let reader_disabled = !reader_open && locked;
        fields.push(
            div()
                .flex()
                .flex_wrap()
                .items_center()
                .justify_between()
                .gap(px(12.))
                .pt(px(16.))
                .border_t_1()
                .border_color(hsla(t.border))
                .child(
                    // `max-w-md`.
                    div()
                        .max_w(px(448.))
                        .type_scale(text::META)
                        .text_color(muted)
                        .child(c::PRIVACY_NOTE),
                )
                .child(
                    // Leading ExternalLinkIcon, the words, then the keys
                    // (`ml-1`).
                    Button::new("captions-reader-toggle")
                        .accessibility_label(reader_label.clone())
                        .variant(ButtonVariant::Outline)
                        .disabled(reader_disabled)
                        .on_click(|_, window, cx| {
                            window.dispatch_action(Box::new(ToggleCaptions), cx)
                        })
                        .icon(IconName::ArrowSquareOut)
                        .label(reader_label)
                        .child(
                            div()
                                .ml(px(4.))
                                .child(ShortcutKeys::for_action(&ToggleCaptions)),
                        ),
                )
                .into_any_element(),
        );

        section
            .child(FieldGroup::new().children(fields))
            .into_any_element()
    }

    fn transcript_section(&mut self, t: &Theme, cx: &mut Context<Self>) -> Option<AnyElement> {
        let feed = self.feed.read(cx);
        let show_id = self
            .studio
            .cloud_now()
            .status
            .and_then(|status| status.show)
            .map(|show| show.id);
        let room_open = feed.room_open();
        // A new room starts with no rows and no error.
        if show_id != self.transcript_show {
            self.transcript_show = show_id.clone();
            self.transcript.clear();
            self.transcript_failed = false;
        }
        let show_id = show_id.filter(|_| room_open)?;
        // The page's last section; the note is its first line of content,
        // not a header description.
        let mut section = PanelSection::new("host-transcript")
            .title(c::TRANSCRIPT_TITLE)
            .last(true)
            .child(
                div()
                    .type_scale(text::META)
                    .text_color(hsla(t.muted_foreground))
                    .child(c::TRANSCRIPT_NOTE),
            )
            .child(
                Button::new("host-transcript-refresh")
                    .label(c::TRANSCRIPT_REFRESH)
                    .variant(ButtonVariant::Ghost)
                    .disabled(!self.studio.is_connected())
                    .on_click(cx.listener(move |this, _, _, cx| {
                        this.refresh_transcript(show_id.clone(), cx)
                    })),
            );
        if self.transcript_failed {
            section = section
                .child(Alert::new("host-transcript-failed").description(c::TRANSCRIPT_FAILED));
        }
        // A plain list, newest first, at most 256 px tall
        // (`max-h-64 overflow-auto text-sm`).
        let mut list = div()
            .id("host-transcript-list")
            .role(Role::List)
            .aria_label(c::TRANSCRIPT_LABEL)
            .flex()
            .flex_col()
            .max_h(px(256.))
            .overflow_y_scroll()
            .text_size(px(14.))
            .line_height(px(20.));
        for (index, (offset, words)) in self.transcript.iter().enumerate() {
            list = list.child(
                div()
                    .id(SharedString::from(format!("transcript-{index}")))
                    .flex()
                    .gap(px(4.))
                    .child(
                        div()
                            .flex_none()
                            .text_color(hsla(t.muted_foreground))
                            .child(offset.clone()),
                    )
                    .child(div().min_w(px(0.)).child(words.clone())),
            );
        }
        Some(section.child(list).into_any_element())
    }
}

/// One Style chip's body (`StyleSwatch` and its words): the bar's shape on
/// a stand-in frame, then the name and its line. The frame is video, so it
/// is the video ground in both themes, with white words and black plates
/// (`text-white`, `bg-black/70`, `bg-black/85`, `bg-black`). `width` is the
/// body's share of a two-column row; `disabled` pre-blends the picture over
/// the window's solid at half strength, as Chromium fades the locked chip.
fn style_chip(t: &Theme, style: &c::CaptionStyle, width: f32, disabled: bool) -> AnyElement {
    let fade = |color: Color| {
        if disabled {
            faded_over(color, t.glass_solid, 0.5)
        } else {
            color
        }
    };
    // A black plate at `alpha` composited over the swatch's ground.
    let plate_over = |alpha: f32| faded_over(with_alpha(t.video_ground, alpha), t.video_ground, 1.);
    let plate_fill = |alpha: f32| fade(plate_over(alpha));
    // 11 px is the floor (Electron draws the sample at 8 px).
    let words = div()
        .max_w_full()
        .px(px(8.))
        .py(px(4.))
        .text_size(px(11.))
        .line_height(px(11.))
        .truncate()
        .text_color(hsla(fade(t.video_ground_foreground)));
    let plate = match style.id {
        "glass" => {
            let fill = plate_fill(0.7);
            // `rounded-md`, 8 px; the band and the solid plate are
            // `rounded-sm`, 6 px.
            words
                .rounded(px(radius::ROW))
                .border_1()
                // `border-white/10` over the plate.
                .border_color(hsla(fade(faded_over(
                    with_alpha(t.video_ground_foreground, 0.1),
                    plate_over(0.7),
                    1.,
                ))))
                .bg(hsla(fill))
                .font_weight(FontWeight::SEMIBOLD)
        }
        "lower-third" => words
            .w_full()
            .rounded(px(radius::CHIP))
            .bg(hsla(plate_fill(0.85)))
            .font_weight(FontWeight::SEMIBOLD),
        "high-contrast" => words
            .rounded(px(radius::CHIP))
            .bg(hsla(plate_fill(1.)))
            .font_weight(FontWeight::BOLD),
        _ => words.font_weight(FontWeight::SEMIBOLD),
    };
    let mut swatch = div()
        .flex()
        .items_end()
        .w_full()
        .h(px(48.))
        .p(px(8.))
        .overflow_hidden()
        .rounded(px(radius::CHIP))
        .bg(hsla(fade(t.video_ground)));
    swatch = if style.id == "lower-third" {
        swatch.justify_start()
    } else {
        swatch.justify_center()
    };
    // The chip pads itself (8 px); the body is the swatch, then the name
    // (`text-xs font-medium`) and its line (`text-[11px] leading-snug`).
    div()
        .flex()
        .flex_col()
        .gap(px(8.))
        .w(px(width))
        .child(swatch.child(plate.child(c::STYLE_SAMPLE)))
        .child(
            div()
                .flex()
                .flex_col()
                .gap(px(2.))
                .child(
                    div()
                        .type_scale(text::META)
                        .font_weight(FontWeight::MEDIUM)
                        .child(style.label),
                )
                .child(
                    div()
                        .text_size(px(11.))
                        .line_height(px(15.))
                        .text_color(hsla(fade(t.muted_foreground)))
                        .child(style.description),
                ),
        )
        .into_any_element()
}

/// The preview's words: the latest line, or the sample before one arrives.
fn preview_text(feed: &CaptionsFeed) -> String {
    feed.lines()
        .latest()
        .map(|line| line.text.trim().to_string())
        .filter(|text| !text.is_empty())
        .unwrap_or_else(|| c::PREVIEW_SAMPLE.to_string())
}

fn status_tone(tone: Tone) -> StatusTone {
    match tone {
        Tone::Good => StatusTone::Good,
        Tone::Warn => StatusTone::Warn,
        Tone::Error => StatusTone::Error,
        Tone::Neutral => StatusTone::Neutral,
    }
}

/// A field whose line sits above the control (`Field` > `FieldContent`
/// [`FieldTitle`/`FieldLabel` 14/20/500, `FieldDescription` 12/18, 4 px
/// apart], then the control 12 px under them). The kit `Field` puts the
/// description after the control (the plain shadcn order), so Style and
/// Spoken language keep this one.
fn field(
    t: &Theme,
    label: &'static str,
    description: &'static str,
    control: impl IntoElement,
) -> impl IntoElement {
    div()
        .flex()
        .flex_col()
        .gap(px(12.))
        .child(
            div()
                .flex()
                .flex_col()
                .gap(px(4.))
                .child(
                    div()
                        .text_size(px(14.))
                        .line_height(px(20.))
                        .font_weight(FontWeight::MEDIUM)
                        .child(label),
                )
                .child(
                    div()
                        .type_scale(text::META)
                        .line_height(px(18.))
                        .text_color(hsla(t.muted_foreground))
                        .child(description),
                ),
        )
        .child(control)
}

/// The settled line for screen readers (`aria-live="polite"`), drawn
/// nowhere.
fn live_region(text: String) -> impl IntoElement {
    div()
        .id("captions-final-announcement")
        .absolute()
        .w(px(1.))
        .h(px(1.))
        .overflow_hidden()
        .child(text)
}

impl Render for CaptionsPanel {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let t = theme::current(window, cx).theme();
        let preview = self.preview_section(t, cx);
        let transcript = self.transcript_section(t, cx);
        let controls = self.controls_section(t, transcript.is_none(), cx);
        let page = cx.entity().downgrade();
        let measure = gpui::canvas(
            move |bounds, _, cx| {
                let width = f32::from(bounds.size.width);
                page.update(cx, |page, cx| page.measured(width, cx)).ok();
            },
            |_, _, _, _| {},
        )
        .absolute()
        .size_full();

        // `CAPTIONS_GRID`: flush columns split by a hairline, never a gap.
        let trail = div()
            .flex()
            .flex_col()
            .min_w(px(0.))
            .child(controls)
            .children(transcript);
        let body = if self.wide() {
            // The preview stays in view (`CAPTIONS_PREVIEW_PIN`) while the
            // controls beside it scroll: `minmax(0,1.2fr)` |
            // `minmax(380px,0.8fr)`.
            div()
                .flex()
                .size_full()
                .child(
                    div()
                        .flex_1()
                        .flex_grow(1.2)
                        .min_w(px(0.))
                        .h_full()
                        .flex()
                        .flex_col()
                        .border_r_1()
                        .border_color(hsla(t.border))
                        .child(preview),
                )
                .child(
                    div()
                        .flex_1()
                        .flex_grow(0.8)
                        .min_w(px(CONTROLS_MIN_WIDTH))
                        .h_full()
                        .child(ScrollArea::new("captions-scroll").child(trail)),
                )
        } else {
            // Stacked in one column, a hairline above the controls.
            div().size_full().child(
                ScrollArea::new("captions-scroll").child(
                    div()
                        .flex()
                        .flex_col()
                        .child(preview)
                        .child(trail.border_t_1().border_color(hsla(t.border))),
                ),
            )
        };
        div()
            .id("captions-page")
            .relative()
            .flex()
            .flex_col()
            .size_full()
            .min_h(px(0.))
            .font_family(FONT)
            .type_scale(text::META)
            .bg(hsla(t.glass_solid))
            .text_color(hsla(t.foreground))
            .child(measure)
            .child(body)
    }
}
