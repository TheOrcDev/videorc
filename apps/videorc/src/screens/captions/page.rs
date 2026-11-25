//! Captions ⌘4 (`components/tabs/captions-tab.tsx`): the caption preview
//! the backend draws, the Live captions controls and the host transcript,
//! from `videorc_app_core::captions` and drawn with the kit.

use std::sync::Arc;

use gpui::{
    AnyElement, App, Context, Entity, EventEmitter, ObjectFit, SharedString, Window, div,
    prelude::*, px,
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
    theme::{self, FONT, TypeScale, hsla},
    toggle_group::{ToggleGroup, ToggleItem},
    tokens::{Theme, radius, size, text},
};

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
        }
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
        let ground = match self.backdrop {
            PreviewBackdrop::Dark => t.video_ground,
            PreviewBackdrop::Light => t.video_ground_foreground,
            PreviewBackdrop::Mixed => t.video_ground_muted,
        };
        // The stand-in video at the canvas aspect, the backend's bar on it.
        let frame_width = 480.0_f32;
        let frame_height = frame_width * canvas_h as f32 / canvas_w.max(1) as f32;
        let mut frame = div()
            .id("caption-preview-frame")
            .relative()
            .w(px(frame_width))
            .h(px(frame_height))
            .max_w_full()
            .overflow_hidden()
            .rounded(px(radius::ROW))
            .border_1()
            .border_color(hsla(t.border))
            .bg(hsla(ground));
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
        PanelSection::new("caption-preview")
            .title(c::PREVIEW_TITLE)
            .description(c::PREVIEW_DESCRIPTION)
            .action(
                Badge::new(if sample {
                    c::PREVIEW_SAMPLE_BADGE
                } else {
                    c::PREVIEW_LATEST_BADGE
                })
                .variant(BadgeVariant::Outline),
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
                            .child(div().type_scale(text::LABEL).truncate().child(text.clone()))
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

    fn controls_section(&self, t: &Theme, cx: &mut Context<Self>) -> AnyElement {
        let (view, upgrade) = self.page_view(cx);
        let feed = self.feed.read(cx);
        let pending = feed.pending();
        let start_error = feed.start_error.clone();
        let strip: Vec<c::CaptionLine> = feed.lines().tail(c::STRIP_LINES).to_vec();
        let announcement = feed.lines().latest_final().map(str::to_string);
        let locked = view.locked.is_some();
        let this = cx.entity().downgrade();
        let reader_open = super::reader::is_open(cx);

        let mut section = PanelSection::new("captions-controls")
            .title(c::LIVE_CAPTIONS)
            .description(c::PANEL_DESCRIPTION);

        // Locked means disabled with one reason, and the lock leads.
        if let Some(reason) = view.locked.clone() {
            let mut alert = Alert::new("captions-lock")
                .variant(AlertVariant::Warning)
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
            section = section.child(alert);
        }

        // One state signal: the switch says on or off; while on, one dot
        // names what captions are doing, with its line.
        let mut switch_row = SettingsRow::new("captions-enabled-row", c::LIVE_CAPTIONS)
            .description(view.switch_line.clone());
        let mut trailing = div().flex().flex_none().items_center().gap(px(8.));
        if view.enabled {
            trailing = trailing.child(
                StatusDot::new("captions-status")
                    .tone(status_tone(view.status_tone))
                    .label(view.status_word),
            );
        }
        if view.show_retry {
            trailing = trailing.child(
                Button::new("captions-retry")
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
        section = section.child(SettingsGroup::new().row(switch_row));

        if let Some(error) = start_error {
            section = section.child(
                Alert::new("captions-start-error")
                    .variant(AlertVariant::Destructive)
                    .title(error),
            );
        }
        if view.room_open {
            section = section.child(
                Alert::new("captions-room")
                    .title(c::ROOM_TITLE)
                    .description(c::ROOM_DESCRIPTION),
            );
        }
        if view.platform_unavailable {
            section = section.child(
                Alert::new("captions-platform-unavailable")
                    .variant(AlertVariant::Warning)
                    .title(captions_preflight::LINUX_TITLE)
                    .description(captions_preflight::LINUX_DETAIL),
            );
        }
        if let Some(blocker) = view.livestream_blocker {
            section = section.child(
                Alert::new("captions-livestream-blocker")
                    .variant(AlertVariant::Warning)
                    .title(c::BLOCKER_TITLE)
                    .description(blocker),
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
        section = section.child(field(
            t,
            c::OUTPUTS_LABEL,
            view.outputs_description,
            outputs.on_change({
                let this = this.clone();
                move |value, _, app| {
                    let _ = this.update(app, |this, cx| {
                        this.patch("burnTarget", json!(value.as_ref()), false, cx)
                    });
                }
            }),
        ));

        // What captions hear and where the bar sits belong to Sources and
        // Scene: these rows say it and open the page.
        let open = |page: PageId| {
            let this = this.clone();
            move |_: &gpui::ClickEvent, _: &mut Window, app: &mut App| {
                let _ = this.update(app, |_, cx| cx.emit(OpenPage(page)));
            }
        };
        let mut elsewhere = GroupedList::new()
            .label(c::ELSEWHERE_LABEL)
            .row(
                NavigableRow::new(
                    "captions-microphone",
                    c::MICROPHONE,
                    view.microphone.clone(),
                )
                .on_navigate(open(PageId::Sources)),
            )
            .row(
                NavigableRow::new(
                    "captions-placement",
                    c::PLACEMENT,
                    view.placement.unwrap_or("Bottom"),
                )
                .on_navigate(open(PageId::Layouts)),
            );
        if let Some(allowance) = view.allowance.clone() {
            elsewhere = elsewhere.row(NavigableRow::new(
                "captions-allowance",
                c::ALLOWANCE,
                allowance,
            ));
        }
        section = section.child(elsewhere);

        // The look: applied live. Each chip shows a swatch, the name and
        // its line (`StyleSwatch`).
        let styles = c::STYLES.iter().fold(
            ToggleGroup::new("caption-style")
                .outline(true)
                .accessibility_label(c::STYLE_LABEL)
                .disabled(locked)
                .value([view.style_id.clone()]),
            |group, style| {
                group.item(ToggleItem::new(style.id, style.label).child(style_chip(t, style)))
            },
        );
        section = section.child(field(
            t,
            c::STYLE,
            c::STYLE_DESCRIPTION,
            div().flex().flex_col().gap(px(6.)).child(styles.on_change({
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
            })),
        ));

        let sizes = c::TEXT_SIZES.iter().fold(
            SegmentedControl::new("caption-text-size")
                .accessibility_label(c::TEXT_SIZE_LABEL)
                .disabled(locked)
                .value(Some(view.text_size.clone())),
            |control, (value, label)| control.option(Segment::new(*value, *label)),
        );
        section = section.child(field(
            t,
            c::TEXT_SIZE,
            "",
            sizes.on_change({
                let this = this.clone();
                move |value, _, app| {
                    let _ = this.update(app, |this, cx| {
                        this.patch("textSize", json!(value.as_ref()), true, cx)
                    });
                }
            }),
        ));

        let languages = c::LANGUAGES.iter().fold(
            Select::new("caption-language")
                .accessibility_label(c::LANGUAGE)
                .disabled(locked || view.language_locked)
                .value(Some(SharedString::from(view.language.clone()))),
            |select, (id, label)| select.option(*id, *label),
        );
        section = section.child(field(
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
        ));

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
            if strip.is_empty() {
                lines = lines.child(
                    div()
                        .type_scale(text::LABEL)
                        .text_color(hsla(t.muted_foreground))
                        .child(c::LISTENING),
                );
            }
            for line in &strip {
                lines = lines.child(
                    div()
                        .id(SharedString::from(format!("strip-{}", line.identity())))
                        .type_scale(text::LABEL)
                        .text_color(hsla(if line.is_partial() {
                            t.muted_foreground
                        } else {
                            t.foreground
                        }))
                        .child(line.text.clone()),
                );
            }
            section = section.child(lines);
        }
        if let Some(final_text) = announcement {
            section = section.child(live_region(final_text));
        }

        let reader_label = if reader_open {
            format!("Close {}", c::READER_NAME)
        } else {
            format!("Open {}", c::READER_NAME)
        };
        section
            .child(
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
                        div()
                            .max_w(px(420.))
                            .type_scale(text::META)
                            .text_color(hsla(t.muted_foreground))
                            .child(c::PRIVACY_NOTE),
                    )
                    .child(
                        Button::new("captions-reader-toggle")
                            .label(reader_label)
                            .variant(ButtonVariant::Outline)
                            .disabled(!reader_open && locked)
                            .on_click(|_, window, cx| {
                                window.dispatch_action(Box::new(ToggleCaptions), cx)
                            })
                            .child(ShortcutKeys::for_action(&ToggleCaptions)),
                    ),
            )
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
        let mut section = PanelSection::new("host-transcript")
            .title(c::TRANSCRIPT_TITLE)
            .description(c::TRANSCRIPT_NOTE)
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
            section =
                section.child(Alert::new("host-transcript-failed").title(c::TRANSCRIPT_FAILED));
        }
        let mut list = GroupedList::new().label(c::TRANSCRIPT_LABEL);
        for (index, (offset, words)) in self.transcript.iter().enumerate() {
            list = list.item(
                div()
                    .id(SharedString::from(format!("transcript-{index}")))
                    .flex()
                    .gap(px(6.))
                    .px(px(12.))
                    .py(px(4.))
                    .type_scale(text::LABEL)
                    .child(
                        div()
                            .text_color(hsla(t.muted_foreground))
                            .child(offset.clone()),
                    )
                    .child(words.clone()),
            );
        }
        if !self.transcript.is_empty() {
            section = section.child(list);
        }
        Some(section.into_any_element())
    }
}

/// One Style chip's body (`StyleSwatch` and its words): the bar's shape on
/// a stand-in frame, then the name and its line. The frame is video, so it
/// is the video ground in both themes.
fn style_chip(t: &Theme, style: &c::CaptionStyle) -> AnyElement {
    let words = div()
        .max_w_full()
        .px(px(8.))
        .py(px(4.))
        .text_size(px(11.))
        .truncate()
        .text_color(hsla(t.video_ground_foreground))
        .child(c::STYLE_SAMPLE);
    let plate = match style.id {
        "glass" => words
            .rounded(px(radius::CHIP))
            .border_1()
            .border_color(hsla(t.border))
            .bg(hsla(t.glass_float)),
        "lower-third" => words
            .w_full()
            .rounded(px(radius::TAG))
            .bg(hsla(t.glass_float)),
        "high-contrast" => words
            .rounded(px(radius::TAG))
            .font_weight(gpui::FontWeight::BOLD)
            .bg(hsla(t.video_ground)),
        _ => words.font_weight(gpui::FontWeight::SEMIBOLD),
    };
    let mut swatch = div()
        .flex()
        .items_end()
        .w_full()
        .h(px(48.))
        .p(px(8.))
        .overflow_hidden()
        .rounded(px(radius::CHIP))
        .bg(hsla(t.video_ground));
    swatch = if style.id == "lower-third" {
        swatch.justify_start()
    } else {
        swatch.justify_center()
    };
    div()
        .flex()
        .flex_col()
        .gap(px(8.))
        .w(px(180.))
        .p(px(8.))
        .child(swatch.child(plate))
        .child(
            div()
                .flex()
                .flex_col()
                .gap(px(2.))
                .child(div().type_scale(text::META).child(style.label))
                .child(
                    div()
                        .text_size(px(11.))
                        .text_color(hsla(t.muted_foreground))
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

/// A labelled field: the title, its line, then the control.
fn field(
    t: &Theme,
    label: &'static str,
    description: &'static str,
    control: impl IntoElement,
) -> impl IntoElement {
    let mut field = div()
        .flex()
        .flex_col()
        .gap(px(6.))
        .child(div().type_scale(text::LABEL).child(label));
    if !description.is_empty() {
        field = field.child(
            div()
                .type_scale(text::META)
                .text_color(hsla(t.muted_foreground))
                .child(description),
        );
    }
    field.child(control)
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
        let controls = self.controls_section(t, cx);
        let transcript = self.transcript_section(t, cx);
        div()
            .id("captions-page")
            .flex()
            .flex_col()
            .size_full()
            .min_h(px(0.))
            .font_family(FONT)
            .type_scale(text::META)
            .bg(hsla(t.glass_solid))
            .text_color(hsla(t.foreground))
            .child(
                ScrollArea::new("captions-scroll").child(
                    div()
                        .flex()
                        .flex_col()
                        .gap(px(size::GUTTER))
                        .child(preview)
                        .child(controls)
                        .children(transcript),
                ),
            )
    }
}
