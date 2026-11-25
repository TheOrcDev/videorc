//! The scene cards' still pictures (P286, `useScenePictures`): the rules
//! are app-core's (`scenes::pictures`); this module keeps the stills, asks
//! `sources.scene_pictures` one request at a time on the core's runtime and
//! turns each JPEG into an image for the card's screen area.

use std::collections::HashMap;
use std::sync::Arc;

use gpui::{Context, Image, ImageFormat};
use videorc_app_core::client::methods::ScenePicturesGet;
use videorc_app_core::scenes::pictures::{
    PictureInputs, PicturesAnswer, pictures_answer, pictures_eligible, pictures_refresh_due,
    visibility_refresh_due,
};
use videorc_app_core::studio::scenes_section::ScenesGalleryView;

use super::{ScenesSection, now_ms};
use crate::app::hotkeys::node_platform;

/// The stills and the one request's state.
#[derive(Default)]
pub(super) struct Stills {
    inputs: PictureInputs,
    /// Each still by `picture_key`.
    images: HashMap<String, Arc<Image>>,
    /// A request is on its way; another waits for it.
    in_flight: bool,
    /// Something asked for fresh stills.
    pending: bool,
    /// This Mac takes no stills (until the next connection).
    unsupported: bool,
    connected: bool,
    /// The connection the stills were asked on.
    generation: Option<u64>,
    /// The first ask, then the last one the window's return made.
    last_visibility: Option<u64>,
}

impl Stills {
    /// The still for a card's target, once one came back.
    pub(super) fn image(&self, key: &str) -> Option<Arc<Image>> {
        self.images.get(key).cloned()
    }

    fn eligible(&self) -> bool {
        pictures_eligible(
            Some(node_platform()),
            self.connected,
            self.unsupported,
            &self.inputs,
        )
    }
}

impl ScenesSection {
    /// The cards, the holds or the connection changed: ask again when the
    /// rules say so.
    pub(super) fn update_stills(
        &mut self,
        gallery: &ScenesGalleryView,
        busy: bool,
        generation: u64,
        connected: bool,
        cx: &mut Context<Self>,
    ) {
        let next = PictureInputs::of(
            gallery.cards.iter().filter_map(|card| card.picture.clone()),
            self.privacy.hidden,
            busy,
        );
        let stills = &mut self.stills;
        stills.connected = connected;
        // A new connection asks afresh, and may take stills again.
        if connected && stills.generation != Some(generation) {
            stills.generation = Some(generation);
            stills.unsupported = false;
            stills.pending = true;
        }
        if next != stills.inputs {
            if pictures_refresh_due(&stills.inputs, &next) {
                stills.pending = true;
            }
            stills.inputs = next;
        }
        self.run_stills(cx);
    }

    /// The window came back to the front: a deferred ask runs, or a fresh
    /// one at most every 30 s.
    pub(super) fn window_activated(&mut self, cx: &mut Context<Self>) {
        let stills = &mut self.stills;
        if !stills.eligible() {
            return;
        }
        if !stills.pending {
            let now = now_ms();
            if !visibility_refresh_due(stills.last_visibility, now) {
                return;
            }
            stills.last_visibility = Some(now);
            stills.pending = true;
        }
        self.run_stills(cx);
    }

    /// One request at a time; an answer to older inputs is dropped.
    fn run_stills(&mut self, cx: &mut Context<Self>) {
        let stills = &mut self.stills;
        if !stills.eligible() || stills.in_flight || !stills.pending {
            return;
        }
        stills.pending = false;
        stills.last_visibility.get_or_insert_with(now_ms);
        stills.in_flight = true;
        let asked = stills.inputs.clone();
        let params = asked.params();
        let studio = self.studio.clone();
        let job = self
            .runtime
            .spawn(async move { studio.backend().call::<ScenePicturesGet>(&params).await });
        cx.spawn(async move |this, cx| {
            let answer = job.await;
            this.update(cx, |section, cx| {
                let stills = &mut section.stills;
                stills.in_flight = false;
                // Kept on a failure: the backend may be reconnecting.
                if let Ok(Ok(result)) = answer
                    && stills.eligible()
                    && stills.inputs == asked
                {
                    match pictures_answer(&result) {
                        PicturesAnswer::Keep => {}
                        PicturesAnswer::Unsupported => {
                            stills.unsupported = true;
                            stills.images.clear();
                            cx.notify();
                        }
                        PicturesAnswer::Pictures(pictures) => {
                            stills.images = pictures
                                .into_iter()
                                .map(|(key, jpeg)| {
                                    (key, Arc::new(Image::from_bytes(ImageFormat::Jpeg, jpeg)))
                                })
                                .collect();
                            cx.notify();
                        }
                    }
                }
                section.run_stills(cx);
            })
            .ok();
        })
        .detach();
    }
}
