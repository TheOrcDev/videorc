//! The living preview (`buddy-pet-preview.tsx`): the avatar as it plays on
//! stream, driven by app-core's `PetPlayer` (the idle tick, the blink, sleep,
//! the click cycle over its reactions, talk). A Still avatar plays its four
//! pictures; an Alive one cuts each frame's cell out of its pack's sheets.
//!
//! It redraws on the player's 160 ms idle tick and when a reaction ends,
//! never every frame, and stops while paused or off screen. GPUI can't
//! transform an element, so the stream's bounce and breath (the motion
//! envelope) aren't drawn here; the frames are.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

use gpui::{
    Context, Image, ImageFormat, ImageSource, KeyDownEvent, ObjectFit, SharedString, Window, div,
    img, prelude::*, px,
};
use videorc_app_core::buddy::pet_pack::{self, Cell, read_manifest, read_pack_file, still_pack};
use videorc_app_core::buddy::pet_player::{Pack, PetPlayer, REACTION_HOLD_MS, TICK_MS};
use videorc_kit::skeleton::Skeleton;
use videorc_kit::theme::{self, hsla};
use videorc_kit::tokens::radius;
use videorc_protocol::buddy_pet::BuddyMotionSettings;

use super::pictures;

/// `BUDDY_STILL_PACK_ID`: the pack id the preview takes for Still.
pub const STILL_PACK_ID: &str = "still";
/// Still's four pictures, idle the neutral cell.
const STILL_STATES: [(&str, bool); 4] = [
    ("idle", false),
    ("talk", true),
    ("laugh", true),
    ("think", true),
];
const LOAD_FAILED: &str = "Couldn't load the preview.";

/// The packs Videorc ships with the app (`buddy-assets/bundled`): the
/// build's resources, or `VIDEORC_BUDDY_BUNDLED_ROOT` where a package puts
/// them elsewhere.
pub fn bundled_root() -> PathBuf {
    std::env::var_os("VIDEORC_BUDDY_BUNDLED_ROOT")
        .map(PathBuf::from)
        .unwrap_or_else(|| Path::new(env!("CARGO_MANIFEST_DIR")).join("../desktop/resources/buddy"))
}

/// One sheet of a pack, decoded once.
struct Sheet {
    image: Arc<Image>,
    size: (u32, u32),
}

/// What the preview draws each frame from.
enum Art {
    /// Still: one whole picture per frame.
    Still(BTreeMap<String, ImageSource>),
    /// Alive: each frame's cell of a sheet.
    Sheets {
        cells: BTreeMap<String, Cell>,
        sheets: BTreeMap<String, Sheet>,
    },
}

pub struct PetPreview {
    size: f32,
    label: SharedString,
    /// What is shown: `still:<pictures>` or `<persona>/<pack>`.
    key: Option<String>,
    art: Option<Art>,
    player: Option<PetPlayer>,
    motion: BuddyMotionSettings,
    error: Option<String>,
    paused: bool,
    active: bool,
    /// The tick loop runs (one at a time).
    ticking: bool,
    epoch: Instant,
}

impl PetPreview {
    pub fn new(size: f32, label: impl Into<SharedString>) -> Self {
        Self {
            size,
            label: label.into(),
            key: None,
            art: None,
            player: None,
            motion: BuddyMotionSettings::default(),
            error: None,
            paused: false,
            active: true,
            ticking: false,
            epoch: Instant::now(),
        }
    }

    fn now(&self) -> f64 {
        self.epoch.elapsed().as_secs_f64() * 1000.0
    }

    pub fn error(&self) -> Option<&str> {
        self.error.as_deref()
    }

    pub fn paused(&self) -> bool {
        self.paused
    }

    pub fn set_label(&mut self, label: impl Into<SharedString>) {
        self.label = label.into();
    }

    /// What the loaded pack offers, for Test's plan.
    pub fn test_pack(&self) -> Option<videorc_app_core::buddy::test_view::TestPack> {
        let player = self.player.as_ref()?;
        Some(videorc_app_core::buddy::test_view::TestPack {
            neutral: player.neutral().to_string(),
            reactions: player.reactions(),
            gazes: player.gazes(),
        })
    }

    /// The preview follows the Motion section (sleep after, the drawn
    /// frames).
    pub fn set_motion(&mut self, motion: BuddyMotionSettings) {
        if motion != self.motion {
            self.motion = motion;
            if let Some(player) = self.player.as_mut() {
                player.set_motion_settings(motion);
            }
        }
    }

    /// The page is on screen (and the window shows): only then does it tick.
    pub fn set_active(&mut self, active: bool, cx: &mut Context<Self>) {
        self.active = active;
        self.kick(cx);
    }

    pub fn set_paused(&mut self, paused: bool, cx: &mut Context<Self>) {
        self.paused = paused;
        if paused && let Some(player) = self.player.as_mut() {
            player.stop();
        }
        self.kick(cx);
        cx.notify();
    }

    /// Still: the four pictures (`stillImages`), each a whole frame. A
    /// missing state falls back to idle, then the default pack's.
    pub fn show_still(
        &mut self,
        key: String,
        pictures: Vec<(String, ImageSource)>,
        cx: &mut Context<Self>,
    ) {
        let key = format!("{STILL_PACK_ID}:{key}");
        if self.key.as_deref() == Some(key.as_str()) {
            return;
        }
        let mut art = BTreeMap::new();
        for (state, picture) in pictures {
            art.insert(state, picture);
        }
        let pack = still_pack(&STILL_STATES);
        self.key = Some(key);
        self.error = None;
        self.start(Art::Still(art), pack, cx);
    }

    /// Alive: the worn pack's manifest and sheets, read off the main thread.
    pub fn show_pack(
        &mut self,
        user_data_dir: &Path,
        persona_id: &str,
        pack_id: &str,
        cx: &mut Context<Self>,
    ) {
        let key = format!("{persona_id}/{pack_id}");
        if self.key.as_deref() == Some(key.as_str()) {
            return;
        }
        self.key = Some(key.clone());
        self.art = None;
        self.player = None;
        self.error = None;
        let write_root = user_data_dir.join(pictures::BUDDY_ASSETS_FOLDER);
        let (persona_id, pack_id) = (persona_id.to_string(), pack_id.to_string());
        let read = cx.background_spawn(async move {
            load_pack(&write_root, &bundled_root(), &persona_id, &pack_id)
        });
        cx.spawn(async move |this, cx| {
            let loaded = read.await;
            let _ = this.update(cx, |preview, cx| {
                // A newer choice overtook this read.
                if preview.key.as_deref() != Some(key.as_str()) {
                    return;
                }
                match loaded {
                    Some((cells, sheets, pack)) => {
                        preview.start(Art::Sheets { cells, sheets }, pack, cx)
                    }
                    None => {
                        preview.error = Some(LOAD_FAILED.into());
                        cx.notify();
                    }
                }
            });
        })
        .detach();
    }

    /// Nothing to show (no pack worn yet).
    pub fn clear(&mut self, cx: &mut Context<Self>) {
        self.key = None;
        self.art = None;
        self.player = None;
        self.error = None;
        cx.notify();
    }

    fn start(&mut self, art: Art, pack: Pack, cx: &mut Context<Self>) {
        let mut seed = self.epoch.elapsed().as_nanos() as u64 | 1;
        let random = Box::new(move || {
            // xorshift: the blink's jitter, nothing that needs more.
            seed ^= seed << 13;
            seed ^= seed >> 7;
            seed ^= seed << 17;
            (seed % 10_000) as f64 / 10_000.0
        });
        let now = self.now();
        self.player = PetPlayer::new(pack, f64::from(self.size), self.motion, false, now, random);
        if self.player.is_none() {
            self.error = Some(LOAD_FAILED.into());
        }
        self.art = Some(art);
        self.kick(cx);
        cx.notify();
    }

    /// Plays a reaction (Try, Test): false when there is nothing to play it.
    pub fn react(&mut self, id: &str, cx: &mut Context<Self>) -> bool {
        let now = self.now();
        let Some(player) = self.player.as_mut() else {
            return false;
        };
        let played = if player.has_reaction(id) {
            player.react(id, now, REACTION_HOLD_MS, true)
        } else {
            player.hop(now)
        };
        self.kick(cx);
        cx.notify();
        played
    }

    /// Test's state: hold a pose (None lets go), and talk.
    pub fn set_pose(&mut self, pose: Option<&str>, talking: bool, cx: &mut Context<Self>) {
        let now = self.now();
        if let Some(player) = self.player.as_mut() {
            player.pose(pose, now);
            player.set_talking(talking, now);
        }
        self.kick(cx);
        cx.notify();
    }

    fn click(&mut self, cx: &mut Context<Self>) {
        let now = self.now();
        if let Some(player) = self.player.as_mut()
            && player.click(now).is_some()
        {
            self.kick(cx);
            cx.notify();
        }
    }

    fn recenter(&mut self, cx: &mut Context<Self>) {
        if let Some(player) = self.player.as_mut()
            && player.center()
        {
            cx.notify();
        }
    }

    fn should_tick(&self) -> bool {
        self.active && !self.paused && self.player.is_some()
    }

    /// Starts the tick loop when it should run and isn't: one timer at the
    /// player's idle pace, never a frame loop.
    fn kick(&mut self, cx: &mut Context<Self>) {
        if self.ticking || !self.should_tick() {
            return;
        }
        self.ticking = true;
        cx.spawn(async move |this, cx| {
            loop {
                cx.background_executor()
                    .timer(Duration::from_millis(TICK_MS as u64))
                    .await;
                let go_on = this
                    .update(cx, |preview, cx| {
                        if !preview.should_tick() {
                            preview.ticking = false;
                            return false;
                        }
                        let now = preview.now();
                        let talking = preview.player.as_ref().is_some_and(PetPlayer::is_talking);
                        let changed = preview
                            .player
                            .as_mut()
                            .is_some_and(|player| player.tick(now));
                        if changed || talking {
                            if let Some(player) = preview.player.as_mut() {
                                // Talk steps its mouth through `advance`.
                                let _ = player.advance(now);
                            }
                            cx.notify();
                        }
                        true
                    })
                    .unwrap_or(false);
                if !go_on {
                    break;
                }
            }
        })
        .detach();
    }
}

/// What a pack read gives back across threads: its cells, its sheets and
/// the frames the player plays.
type LoadedPack = (BTreeMap<String, Cell>, BTreeMap<String, Sheet>, Pack);

/// A pack's manifest, cells and sheets, read from disk.
fn load_pack(
    write_root: &Path,
    bundled: &Path,
    persona_id: &str,
    pack_id: &str,
) -> Option<LoadedPack> {
    let (folder, root) = pet_pack::pack_folder(write_root, bundled, persona_id, pack_id)?;
    let manifest = read_pack_file(&folder, &root, pet_pack::MANIFEST_FILE)?;
    let preview = read_manifest(&manifest)?;
    let mut sheets = BTreeMap::new();
    for name in &preview.sheets {
        let bytes = read_pack_file(&folder, &root, name)?;
        let size = pictures::image_size(&bytes)?;
        let format = if name.ends_with(".png") {
            ImageFormat::Png
        } else {
            ImageFormat::Webp
        };
        sheets.insert(
            name.clone(),
            Sheet {
                image: Arc::new(Image::from_bytes(format, bytes)),
                size,
            },
        );
    }
    let cells = preview
        .cells
        .into_iter()
        .map(|cell| (cell.frame.clone(), cell))
        .collect();
    Some((cells, sheets, preview.pack))
}

impl Render for PetPreview {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let t = theme::resolve(None, window, cx);
        let size = self.size;
        let frame = self
            .player
            .as_ref()
            .map(|player| player.frame().to_string());
        let mut stage = div()
            .id(SharedString::from(format!("avatar-preview-{}", self.label)))
            .relative()
            .size(px(size))
            .flex_none()
            .overflow_hidden()
            .rounded(px(radius::ROW))
            .border_1()
            .border_color(hsla(t.border))
            .bg(hsla(t.inset))
            .cursor_pointer()
            .on_click(cx.listener(|preview, _, _, cx| preview.click(cx)))
            .on_key_down(cx.listener(|preview, event: &KeyDownEvent, _, cx| {
                if event.keystroke.key == "escape" {
                    preview.recenter(cx);
                }
            }));
        match (&self.art, frame) {
            (Some(Art::Still(pictures)), Some(frame)) => {
                let picture = pictures
                    .get(&frame)
                    .or_else(|| pictures.get("idle"))
                    .cloned();
                if let Some(picture) = picture {
                    stage = stage.child(
                        img(picture)
                            .size_full()
                            .p(px(6.))
                            .object_fit(ObjectFit::Contain),
                    );
                }
            }
            (Some(Art::Sheets { cells, sheets }), Some(frame)) => {
                if let Some(cell) = cells.get(&frame)
                    && let Some(sheet) = sheets.get(&cell.sheet)
                {
                    stage = stage.child(cell_picture(cell, sheet, size));
                }
            }
            _ if self.error.is_none() => {
                stage = stage.child(Skeleton::new("avatar-preview-loading").size_full());
            }
            _ => {}
        }
        stage
    }
}

/// One cell of a sheet, fitted into the stage: the sheet scaled so the
/// cell fills the square, moved so only the cell shows.
fn cell_picture(cell: &Cell, sheet: &Sheet, size: f32) -> impl IntoElement {
    let [x, y, w, h] = cell.rect.map(|value| value as f32);
    let scale = size / w.max(h);
    let (left, top) = ((size - w * scale) / 2.0, (size - h * scale) / 2.0);
    img(sheet.image.clone())
        .absolute()
        .left(px(left - x * scale))
        .top(px(top - y * scale))
        .w(px(sheet.size.0 as f32 * scale))
        .h(px(sheet.size.1 as f32 * scale))
        .object_fit(ObjectFit::Fill)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_bundled_pack_reads_from_the_resources() {
        let root = bundled_root();
        let loaded = load_pack(Path::new("/nonexistent"), &root, "p1", "bundled:buddy");
        let (cells, sheets, pack) = loaded.expect("the shipped pack loads");
        assert!(!pack.frames.is_empty());
        assert!(cells.contains_key(&pack.neutral));
        assert!(
            sheets
                .values()
                .all(|sheet| sheet.size.0 > 0 && sheet.size.1 > 0)
        );
    }
}
