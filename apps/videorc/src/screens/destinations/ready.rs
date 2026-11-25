//! Ready to go live checklist (`ReadyToGoLive`, P766–P776).

use gpui::{AnyElement, Context, Window, div, prelude::*, px};
use videorc_app_core::livestream::copy as page_copy;
use videorc_app_core::livestream::plan;
use videorc_app_core::livestream::ready::{self, ReadyInput, ReadyRow, ReadyView, RowState};
use videorc_app_core::livestream::targets;
use videorc_kit::badge::{Badge, BadgeVariant};
use videorc_kit::button::{Button, ButtonVariant};
use videorc_kit::list_row::{GroupedList, ListRow};
use videorc_kit::panel_section::PanelSection;
use videorc_kit::theme::{self, TypeScale, hsla};
use videorc_kit::tokens::text;

use super::DestinationsPanel;

impl DestinationsPanel {
    pub(super) fn build_ready(&self) -> ReadyView {
        let snapshot = self.studio.snapshot();
        let capture = &snapshot.settings.capture_doc;
        let platforms = self.studio.platforms_now();
        let details = self.studio.details_now();
        let targets = targets::targets(capture);
        let recording = plan::recording_video(capture);
        let stream_plan = plan::go_live_plan(capture, &recording, false);
        let stream_enabled = capture
            .get("streamEnabled")
            .and_then(|v| v.as_bool())
            .unwrap_or(true);
        let record_enabled = capture
            .get("recordEnabled")
            .and_then(|v| v.as_bool())
            .unwrap_or(true);
        ready::ready_view(&ReadyInput {
            targets: &targets,
            platforms: &platforms,
            plan: &stream_plan,
            record_enabled,
            stream_enabled,
            recording: &recording,
            ffmpeg_ready: true,
            topology: &details.topology,
            profile_blocking: None,
            captions: None,
            recording_matches_stream: false,
            live: None,
            cloud: None,
        })
    }

    pub(super) fn ready_section(
        &self,
        view: &ReadyView,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let t = theme::current(window, cx).theme();
        let entity = cx.entity();
        let mut section = PanelSection::new("destinations-ready")
            .title(page_copy::READY_TO_GO_LIVE)
            .last(true);

        if let Some(warning) = &view.warning {
            section = section.child(
                div()
                    .type_scale(text::META)
                    .text_color(hsla(t.warning))
                    .child(warning.clone()),
            );
        }

        let mut list = GroupedList::new();
        for (index, row) in view.rows.iter().enumerate() {
            list = list.item(ready_row(index, row, t));
        }
        for (target_id, line) in &view.not_ready {
            let id = target_id.clone();
            let entity = entity.clone();
            list = list.item(
                ListRow::new(format!("ready-nav-{target_id}"), line.clone()).child(
                    Button::new(format!("ready-open-{target_id}"))
                        .label("Open")
                        .variant(ButtonVariant::Ghost)
                        .on_click(move |_, _, cx| {
                            entity.update(cx, |this, cx| this.open_destination(id.clone(), cx))
                        }),
                ),
            );
        }
        if view.retry {
            let entity = entity.clone();
            list = list.item(
                ListRow::new("ready-retry", "Output check failed").child(
                    Button::new("ready-retry-check")
                        .label("Retry")
                        .variant(ButtonVariant::Outline)
                        .on_click(move |_, _, cx| {
                            entity.update(cx, |this, _| this.retry_output_check())
                        }),
                ),
            );
        }

        section.child(list).into_any_element()
    }

    pub(crate) fn open_destination(&mut self, id: String, cx: &mut Context<Self>) {
        self.memory.expanded.insert(id, true);
        self.tab = super::DestinationsTab::Setup;
        self.rebuild(cx);
    }

    fn retry_output_check(&self) {
        let studio = self.studio.clone();
        self.runtime.spawn(async move {
            let snapshot = studio.snapshot();
            let capture = &snapshot.settings.capture_doc;
            let recording = plan::recording_video(capture);
            let stream_plan = plan::go_live_plan(capture, &recording, false);
            let params = ready::probe_params(&stream_plan, &recording, true, false);
            let _ = studio.check_stream_output(params, true).await;
        });
    }
}

fn ready_row(index: usize, row: &ReadyRow, t: &videorc_kit::tokens::Theme) -> impl IntoElement {
    let badge = match row.state {
        RowState::Ok => Badge::new("Ready").variant(BadgeVariant::Success),
        RowState::Pending => Badge::new("Checking…").variant(BadgeVariant::Outline),
        RowState::Info => Badge::new(row.detail.clone()).variant(BadgeVariant::Outline),
        RowState::Nav => Badge::new("Needs attention").variant(BadgeVariant::Warning),
    };
    let mut block = div().child(
        ListRow::new(format!("ready-row-{index}"), row.label.clone())
            .context(if matches!(row.state, RowState::Info) {
                String::new()
            } else {
                row.detail.clone()
            })
            .child(badge),
    );
    if !row.hint.is_empty() || !row.lines.is_empty() {
        let mut body = div().flex().flex_col().gap(px(2.)).px(px(12.)).pb(px(8.));
        if !row.hint.is_empty() {
            body = body.child(
                div()
                    .type_scale(text::META)
                    .text_color(hsla(t.muted_foreground))
                    .child(row.hint.clone()),
            );
        }
        for line in &row.lines {
            body = body.child(
                div()
                    .type_scale(text::META)
                    .text_color(hsla(t.muted_foreground))
                    .child(line.clone()),
            );
        }
        block = block.child(body);
    }
    block
}
