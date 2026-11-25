//! The app's recording posters (plan 260 L3): one cache for every page that
//! draws a recording's poster, the Library's rows and Sidekick's Clean cut
//! list, as Electron draws one `SessionPoster` in both.
//!
//! The cache and the read are app-core's
//! ([`videorc_app_core::library::posters`]); this module keeps them in one
//! entity for the window ([`install`], [`shared`]), reads on the core's
//! runtime, and draws the frame a poster sits in ([`frame`], [`picture`]).
//! A page observes the entity to draw again when a poster arrives.

use std::sync::Arc;

use gpui::{AnyElement, App, AppContext, Context, Entity, Global, div, prelude::*, px};
use videorc_app_core::library::posters::{PosterCache, PosterKey};
use videorc_kit::icon::{IconName, icon};
use videorc_kit::theme::{hsla, with_alpha};
use videorc_kit::tokens::{Theme, radius};

use crate::screens::library::Core;

/// The posters every page shares.
pub struct Posters {
    core: Arc<Core>,
    runtime: tokio::runtime::Handle,
    cache: PosterCache<Arc<gpui::Image>>,
}

struct PostersGlobal(Entity<Posters>);

impl Global for PostersGlobal {}

/// The one poster cache, made on the first call; later calls get it.
pub fn install(core: Arc<Core>, runtime: tokio::runtime::Handle, cx: &mut App) -> Entity<Posters> {
    if let Some(global) = cx.try_global::<PostersGlobal>() {
        return global.0.clone();
    }
    let posters = cx.new(|_| Posters {
        core,
        runtime,
        cache: PosterCache::default(),
    });
    cx.set_global(PostersGlobal(posters.clone()));
    posters
}

/// The poster cache, once [`install`] ran.
pub fn shared(cx: &App) -> Option<Entity<Posters>> {
    cx.try_global::<PostersGlobal>()
        .map(|global| global.0.clone())
}

impl Posters {
    /// The poster, once read; `None` while on its way or when there is none.
    pub fn get(&self, session_id: &str, version: Option<i64>) -> Option<Arc<gpui::Image>> {
        self.cache.get(session_id, version).cloned()
    }

    /// A poster can be read now: the backend is connected.
    pub fn serves(&self) -> bool {
        self.core.serves_posters()
    }

    /// `user` wants these posters: the ones nobody asked for yet are read
    /// off the main thread, and the page draws again when they arrive.
    pub fn want(
        &mut self,
        user: &'static str,
        keys: impl IntoIterator<Item = PosterKey>,
        cx: &mut Context<Self>,
    ) {
        let needed = self.cache.want(user, keys);
        if needed.is_empty() {
            return;
        }
        let core = self.core.clone();
        let read = self
            .runtime
            .spawn(async move { core.load_posters(needed).await });
        cx.spawn(async move |this, cx| {
            let Ok(pictures) = read.await else {
                return;
            };
            let _ = this.update(cx, |this, cx| {
                for (key, bytes) in pictures {
                    let picture = bytes.map(|bytes| {
                        Arc::new(gpui::Image::from_bytes(gpui::ImageFormat::Jpeg, bytes))
                    });
                    this.cache.fill(key, picture);
                }
                cx.notify();
            });
        })
        .detach();
    }

    /// `user` lets go of the sessions it no longer lists.
    pub fn keep(&mut self, user: &'static str, listed: impl Fn(&str) -> bool) {
        self.cache.keep(user, listed);
    }
}

/// `LIBRARY_POSTER_CLASS` at this size: the frame a poster or its glyph
/// sits in (`rounded-row border bg-muted/30`).
pub fn frame(width: f32, height: f32, t: &Theme) -> gpui::Div {
    div()
        .flex_none()
        .w(px(width))
        .h(px(height))
        .flex()
        .items_center()
        .justify_center()
        .overflow_hidden()
        .rounded(px(radius::ROW))
        .border_1()
        .border_color(hsla(t.border))
        .bg(hsla(with_alpha(t.muted, 0.3)))
}

/// The poster filling its frame (`object-cover`), or the video file glyph
/// while there is none.
pub fn picture(image: Option<Arc<gpui::Image>>, t: &Theme) -> AnyElement {
    match image {
        Some(image) => gpui::img(image)
            .size_full()
            .rounded(px(radius::ROW))
            .object_fit(gpui::ObjectFit::Cover)
            .into_any_element(),
        None => icon(IconName::FileVideo, 16., hsla(t.muted_foreground)).into_any_element(),
    }
}
