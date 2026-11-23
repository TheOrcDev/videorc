//! Plan 260 spike S0.5: text under GPUI.
//!
//! Question: does GPUI's text stack carry Videorc's text jobs: IME
//! (Japanese, Chinese), colour emoji, font fallback, selectable text,
//! tabular numbers, and a 10,000-row chat with inline animated WebP emotes
//! that scrolls at 60 fps within 100 MB extra and paints first within 100 ms?
//!
//! - Left: a text input (GPUI's own input example, with IME support), the
//!   samples (emoji, scripts, numbers) and a selectable paragraph.
//! - Right: the chat, a `list()` of `--rows` rows (default 10,000), each a
//!   name and a message whose words and emotes wrap inline.
//! - `--scroll-test` scrolls the chat for 6 s, one step per frame, and
//!   records the frame intervals; `--simulate-ime` (macOS) sends the input
//!   the same `NSTextInputClient` calls Kotoeri and Pinyin send, and checks
//!   what the input holds after each.

mod input;

use gpui::{
    App, AppContext, Bounds, ClipboardItem, Context, Entity, FocusHandle, Focusable, Font,
    FontFeatures, FontWeight, HighlightStyle, KeyBinding, ListAlignment, ListState, MouseButton,
    MouseDownEvent, MouseMoveEvent, SharedString, StyledText, TextLayout, TitlebarOptions, Window,
    WindowBounds, WindowOptions, actions, div, img, list, prelude::*, px, rgb, size,
};
use input::TextInput;
use serde_json::{Value, json};
use spike_summary::{Run, percentile, round};
use std::{
    ops::Range,
    path::PathBuf,
    rc::Rc,
    sync::{
        Arc, Mutex,
        atomic::{AtomicU64, Ordering},
    },
    time::{Duration, Instant},
};

const SPIKE: &str = "spike-text";

actions!(spike_text, [CopySelection]);

static RENDERS: AtomicU64 = AtomicU64::new(0);
static FIRST_PAINT_US: AtomicU64 = AtomicU64::new(0);
/// Rows the chat has built (rendered) so far: a virtual list builds only
/// what is on screen plus its overdraw.
static ROWS_BUILT: AtomicU64 = AtomicU64::new(0);
/// When `open_window` was called, in microseconds since start.
static OPEN_US: AtomicU64 = AtomicU64::new(0);

const GROUND: u32 = 0x070707;
const PANE: u32 = 0x101010;
const HAIRLINE: u32 = 0x262626;
const INK: u32 = 0xededed;
const INK_2: u32 = 0xa1a1a1;

/// Process CPU seconds so far (user + system).
fn cpu_seconds() -> f64 {
    #[cfg(unix)]
    {
        let mut usage: libc::rusage = unsafe { std::mem::zeroed() };
        // SAFETY: getrusage fills the struct we own.
        if unsafe { libc::getrusage(libc::RUSAGE_SELF, &mut usage) } == 0 {
            let t = |tv: libc::timeval| tv.tv_sec as f64 + tv.tv_usec as f64 / 1e6;
            return t(usage.ru_utime) + t(usage.ru_stime);
        }
    }
    0.0
}

// ---------------------------------------------------------------- chat data

enum Token {
    Word(SharedString),
    Emote(usize),
}

struct ChatRow {
    name: SharedString,
    color: u32,
    tokens: Vec<Token>,
}

const NAMES: [&str; 12] = [
    "orc_dev",
    "pixelwitch",
    "数据猫",
    "ゆきこ",
    "streamfan42",
    "Łukasz",
    "mira.codes",
    "ahmad_ali",
    "김민준",
    "nightowl",
    "JPEG_artifact",
    "zoë",
];
const COLORS: [u32; 6] = [0xff6b6b, 0x4dabf7, 0x69db7c, 0xffd43b, 0xda77f2, 0xff922b];
const WORDS: [&str; 40] = [
    "nice", "stream", "the", "audio", "is", "great", "today", "can", "you", "show", "that",
    "again", "please", "lol", "first", "time", "here", "love", "this", "setup", "what", "camera",
    "do", "use", "hello", "from", "Berlin", "GG", "wow", "scene", "switch", "was", "smooth",
    "chat", "is", "fast", "one", "more", "question", "thanks",
];
const PHRASES: [&str; 8] = [
    "こんにちは",
    "配信ありがとう",
    "你好",
    "直播很棒",
    "안녕하세요",
    "😀",
    "👍🏽",
    "🎉",
];

fn chat_rows(n: usize) -> Vec<ChatRow> {
    // A fixed linear congruential sequence, so every run shows the same chat.
    let mut seed: u64 = 0x2600_0507;
    let mut next = |m: usize| {
        seed = seed
            .wrapping_mul(6364136223846793005)
            .wrapping_add(1442695040888963407);
        ((seed >> 33) as usize) % m
    };
    (0..n)
        .map(|i| {
            let words = 3 + next(22);
            let mut tokens = Vec::with_capacity(words);
            for _ in 0..words {
                match next(20) {
                    0..=1 => tokens.push(Token::Emote(next(6))),
                    2 => tokens.push(Token::Word(PHRASES[next(PHRASES.len())].into())),
                    _ => tokens.push(Token::Word(WORDS[next(WORDS.len())].into())),
                }
            }
            if i % 97 == 0 {
                tokens.push(Token::Word(format!("#{i}").into()));
            }
            ChatRow {
                name: NAMES[next(NAMES.len())].into(),
                color: COLORS[next(COLORS.len())],
                tokens,
            }
        })
        .collect()
}

/// How emotes animate: GPUI's own animated `img` (redraws every display
/// frame while one is on screen), or decoded frames swapped by a timer at
/// the emotes' own frame rate (`--emotes timer`).
static EMOTES_TIMER: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

thread_local! {
    /// Each emote's frames as single-frame images, and its frame delay (ms).
    static EMOTE_FRAMES: std::cell::RefCell<Vec<(Vec<Arc<gpui::RenderImage>>, u64)>> =
        const { std::cell::RefCell::new(Vec::new()) };
}

fn load_emote_frames() -> Result<(), String> {
    use image::AnimationDecoder;
    let mut all = Vec::new();
    for i in 0..6 {
        let bytes = std::fs::read(emote_path(i)).map_err(|e| e.to_string())?;
        let decoder = image::codecs::webp::WebPDecoder::new(std::io::Cursor::new(bytes))
            .map_err(|e| e.to_string())?;
        let mut delay_ms = 80;
        let mut frames = Vec::new();
        for frame in decoder.into_frames() {
            let mut frame = frame.map_err(|e| e.to_string())?;
            let (n, d) = frame.delay().numer_denom_ms();
            delay_ms = (n / d.max(1)).max(20) as u64;
            // GPUI keeps images as BGRA.
            for px in frame.buffer_mut().as_chunks_mut::<4>().0 {
                px.swap(0, 2);
            }
            frames.push(Arc::new(gpui::RenderImage::new(vec![frame])));
        }
        all.push((frames, delay_ms));
    }
    EMOTE_FRAMES.with(|f| *f.borrow_mut() = all);
    Ok(())
}

fn timer_emote(e: usize) -> Option<Arc<gpui::RenderImage>> {
    let ms = spike_summary::elapsed_ms() as u64;
    EMOTE_FRAMES.with(|f| {
        let f = f.borrow();
        let (frames, delay) = f.get(e)?;
        frames.get((ms / delay) as usize % frames.len()).cloned()
    })
}

fn emote_path(i: usize) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(format!("assets/emote-{i}.webp"))
}

fn render_row(row: &ChatRow, ix: usize) -> gpui::AnyElement {
    ROWS_BUILT.fetch_add(1, Ordering::Relaxed);
    div()
        .id(("row", ix))
        .w_full()
        .px_3()
        .py(px(3.))
        .flex()
        .flex_wrap()
        .items_center()
        .gap_x(px(4.))
        .text_size(px(14.))
        .line_height(px(22.))
        .text_color(rgb(INK))
        .child(
            div()
                .font_weight(FontWeight::SEMIBOLD)
                .text_color(rgb(row.color))
                .child(format!("{}:", row.name)),
        )
        .children(row.tokens.iter().enumerate().map(|(k, t)| {
            match t {
                Token::Word(w) => div().child(w.clone()).into_any_element(),
                Token::Emote(e) if EMOTES_TIMER.load(Ordering::Relaxed) => match timer_emote(*e) {
                    Some(frame) => img(frame).size(px(28.)).flex_none().into_any_element(),
                    None => div().size(px(28.)).into_any_element(),
                },
                // An id gives the image the state GPUI needs to animate it.
                Token::Emote(e) => img(emote_path(*e))
                    .id(("emote", ix * 64 + k))
                    .size(px(28.))
                    .flex_none()
                    .into_any_element(),
            }
        }))
        .into_any_element()
}

// ---------------------------------------------------------------- selectable text

/// A read-only paragraph you can select with the mouse and copy with ⌘C:
/// `StyledText` for layout, its `TextLayout` to map points to indices, and a
/// highlight for the selection. GPUI has no selectable text element; this is
/// the smallest one.
struct Selectable {
    text: SharedString,
    layout: Option<TextLayout>,
    anchor: Option<usize>,
    selection: Range<usize>,
    focus: FocusHandle,
}

impl Selectable {
    fn index_at(&self, p: gpui::Point<gpui::Pixels>) -> Option<usize> {
        let layout = self.layout.as_ref()?;
        Some(match layout.index_for_position(p) {
            Ok(i) | Err(i) => i.min(self.text.len()),
        })
    }

    fn selected_text(&self) -> String {
        self.text
            .get(self.selection.clone())
            .unwrap_or_default()
            .to_string()
    }
}

impl Focusable for Selectable {
    fn focus_handle(&self, _: &App) -> FocusHandle {
        self.focus.clone()
    }
}

impl Render for Selectable {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let mut highlights = Vec::new();
        if !self.selection.is_empty() {
            highlights.push((
                self.selection.clone(),
                HighlightStyle {
                    background_color: Some(rgb(0x2563eb).into()),
                    ..Default::default()
                },
            ));
        }
        let styled = StyledText::new(self.text.clone()).with_highlights(highlights);
        self.layout = Some(styled.layout().clone());
        div()
            .key_context("Selectable")
            .track_focus(&self.focus)
            .on_action(cx.listener(|this, _: &CopySelection, _, cx| {
                let s = this.selected_text();
                if !s.is_empty() {
                    cx.write_to_clipboard(ClipboardItem::new_string(s.clone()));
                    println!("[spike] copied {s:?}");
                }
            }))
            .cursor_text()
            .text_size(px(14.))
            .line_height(px(21.))
            .text_color(rgb(INK))
            .on_mouse_down(
                MouseButton::Left,
                cx.listener(|this, e: &MouseDownEvent, window, cx| {
                    window.focus(&this.focus, cx);
                    this.anchor = this.index_at(e.position);
                    if let Some(a) = this.anchor {
                        this.selection = a..a;
                    }
                    cx.notify();
                }),
            )
            .on_mouse_move(cx.listener(|this, e: &MouseMoveEvent, _, cx| {
                if e.pressed_button != Some(MouseButton::Left) {
                    return;
                }
                if let (Some(a), Some(h)) = (this.anchor, this.index_at(e.position)) {
                    // Snap to char boundaries.
                    let (mut s, mut t) = (a.min(h), a.max(h));
                    while s > 0 && !this.text.is_char_boundary(s) {
                        s -= 1;
                    }
                    while t < this.text.len() && !this.text.is_char_boundary(t) {
                        t += 1;
                    }
                    if this.selection != (s..t) {
                        this.selection = s..t;
                        cx.notify();
                    }
                }
            }))
            .on_mouse_up(
                MouseButton::Left,
                cx.listener(|this, _, _, _| {
                    this.anchor = None;
                    let s = this.selected_text();
                    if !s.is_empty() {
                        println!("[spike] selected {s:?}");
                        if let Ok(mut f) = FACTS.lock() {
                            f.selected.push(s);
                        }
                    }
                }),
            )
            .child(styled)
    }
}

// ---------------------------------------------------------------- facts

#[derive(Default)]
struct Facts {
    ime_steps: Vec<Value>,
    selected: Vec<String>,
    scroll: Value,
    numbers: Value,
    idle: Value,
    remount_ms: Option<f64>,
}

static FACTS: Mutex<Facts> = Mutex::new(Facts {
    ime_steps: Vec::new(),
    selected: Vec::new(),
    scroll: Value::Null,
    numbers: Value::Null,
    idle: Value::Null,
    remount_ms: None,
});

// ---------------------------------------------------------------- the view

struct Scroll {
    until: Instant,
    frames: Vec<Instant>,
    step: f32,
    rows_built_before: u64,
    active_frames: u64,
}

struct Spike {
    input: Entity<TextInput>,
    selectable: Entity<Selectable>,
    chat: ListState,
    rows: Rc<Vec<ChatRow>>,
    scroll: Option<Scroll>,
    status: SharedString,
    remount: Option<Instant>,
}

fn tnum() -> FontFeatures {
    FontFeatures(Arc::new(vec![("tnum".into(), 1)]))
}

fn label(text: &'static str) -> impl IntoElement {
    div()
        .text_size(px(11.))
        .font_weight(FontWeight::SEMIBOLD)
        .text_color(rgb(INK_2))
        .child(text)
}

impl Render for Spike {
    fn render(&mut self, window: &mut Window, _cx: &mut Context<Self>) -> impl IntoElement {
        let n = RENDERS.fetch_add(1, Ordering::Relaxed) + 1;
        if n == 1 {
            window.on_next_frame(|_, _| {
                let us = (spike_summary::elapsed_ms() * 1000.0) as u64;
                FIRST_PAINT_US.store(us.max(1), Ordering::Relaxed);
            });
        }
        if let Some(t) = self.remount.take() {
            window.on_next_frame(move |_, _| {
                let ms = t.elapsed().as_secs_f64() * 1000.0;
                println!("[spike] remount {ms:.1} ms");
                FACTS.lock().expect("facts").remount_ms = Some(ms);
            });
        }
        if let Some(s) = &mut self.scroll {
            let now = Instant::now();
            if now < s.until {
                s.frames.push(now);
                s.active_frames += window.is_window_active() as u64;
                self.chat.scroll_by(px(s.step));
                window.request_animation_frame();
            } else {
                let s = self.scroll.take().expect("scroll");
                finish_scroll(s);
                self.status = "scroll test done".into();
            }
        }

        let (text, marked) = self.input.read(_cx).state();
        let samples = [
            ("Colour emoji", "😀 🎉 👍🏽 👩‍💻 🇯🇵 ❤️ 🧑🏿‍🚀"),
            ("Japanese", "配信を開始します・カメラ"),
            ("Simplified Chinese", "开始直播，摄像头"),
            ("Traditional Chinese", "開始直播，攝影機"),
            ("Korean", "방송을 시작합니다"),
            ("Arabic (RTL)", "ابدأ البث المباشر الآن"),
            ("Hebrew (RTL)", "התחל שידור חי"),
            ("Thai", "เริ่มถ่ายทอดสด"),
            ("Hindi", "लाइव शुरू करें"),
            ("Greek, Cyrillic", "Ζωντανά · Прямой эфир"),
        ];
        let numbers = ["00:00:00", "11:11:11", "01:47:09", "12:00:58", "98.7 %"];

        let left = div()
            .w(px(560.))
            .h_full()
            .flex_none()
            .p_4()
            .flex()
            .flex_col()
            .gap_3()
            .border_r_1()
            .border_color(rgb(HAIRLINE))
            .child(label("TEXT INPUT (IME)"))
            .child(self.input.clone())
            .child(
                div()
                    .text_size(px(12.))
                    .text_color(rgb(INK_2))
                    .child(format!(
                        "Committed: {text:?}   Composing: {}",
                        marked.map(|m| format!("{m:?}")).unwrap_or("none".into())
                    )),
            )
            .child(label("SCRIPTS AND EMOJI"))
            .children(samples.iter().map(|(name, s)| {
                div()
                    .flex()
                    .gap_3()
                    .text_size(px(15.))
                    .child(div().w(px(150.)).text_color(rgb(INK_2)).child(*name))
                    .child(div().text_color(rgb(INK)).child(*s))
            }))
            .child(label("NUMBERS: PROPORTIONAL, THEN TABULAR (tnum)"))
            .child(
                div()
                    .flex()
                    .gap_6()
                    .text_size(px(15.))
                    .child(
                        div()
                            .flex()
                            .flex_col()
                            .children(numbers.iter().map(|n| div().child(*n))),
                    )
                    .child(
                        div()
                            .flex()
                            .flex_col()
                            .font_features(tnum())
                            .children(numbers.iter().map(|n| div().child(*n))),
                    ),
            )
            .child(label("SELECTABLE TEXT (DRAG, THEN ⌘C)"))
            .child(self.selectable.clone())
            .child(
                div()
                    .text_size(px(12.))
                    .text_color(rgb(INK_2))
                    .child(self.status.clone()),
            );

        let rows = self.rows.clone();
        let chat = div()
            .flex_1()
            .h_full()
            .flex()
            .flex_col()
            .bg(rgb(PANE))
            .child(
                div()
                    .h(px(40.))
                    .flex_none()
                    .px_3()
                    .flex()
                    .items_center()
                    .border_b_1()
                    .border_color(rgb(HAIRLINE))
                    .child(label("CHAT"))
                    .child(div().flex_1())
                    .child(
                        div()
                            .text_size(px(11.))
                            .text_color(rgb(INK_2))
                            .child(format!(
                                "{} rows · built {} · renders {n}",
                                rows.len(),
                                ROWS_BUILT.load(Ordering::Relaxed)
                            )),
                    ),
            )
            .child(
                list(self.chat.clone(), move |ix, _, _| render_row(&rows[ix], ix))
                    .flex_1()
                    .w_full(),
            );

        div()
            .size_full()
            .flex()
            .bg(rgb(GROUND))
            .text_color(rgb(INK))
            .child(left)
            .child(chat)
    }
}

fn finish_scroll(s: Scroll) {
    let intervals: Vec<f64> = s
        .frames
        .windows(2)
        .map(|w| (w[1] - w[0]).as_secs_f64() * 1000.0)
        .collect();
    let total_s = match (s.frames.first(), s.frames.last()) {
        (Some(a), Some(b)) => (*b - *a).as_secs_f64(),
        _ => 0.0,
    };
    let over = intervals
        .iter()
        .filter(|&&v| v > 1000.0 / 60.0 + 0.5)
        .count();
    let v = json!({
        "frames": s.frames.len(),
        "seconds": round(total_s, 2),
        "fps": round(intervals.len() as f64 / total_s.max(0.001), 1),
        "interval_p50_ms": percentile(&intervals, 50.0).map(|v| round(v, 2)),
        "interval_p95_ms": percentile(&intervals, 95.0).map(|v| round(v, 2)),
        "interval_p99_ms": percentile(&intervals, 99.0).map(|v| round(v, 2)),
        "interval_max_ms": intervals.iter().cloned().fold(0.0, f64::max),
        "frames_over_16_7_ms": over,
        "step_px": s.step,
        "rows_built_during": ROWS_BUILT.load(Ordering::Relaxed) - s.rows_built_before,
        "frames_with_window_active": s.active_frames,
    });
    println!("[spike] scroll {v}");
    FACTS.lock().expect("facts").scroll = v;
}

// ---------------------------------------------------------------- IME (macOS)

#[cfg(target_os = "macos")]
mod ime {
    //! Sends the calls an input method sends to the focused view, through
    //! `NSTextInputClient` on GPUI's own NSView, as Kotoeri and Pinyin do.

    use gpui::Window;
    use objc2::{msg_send, rc::Retained, runtime::AnyObject};
    use objc2_foundation::{NSNotFound, NSRange, NSRect, NSString};
    use raw_window_handle::{HasWindowHandle, RawWindowHandle};

    /// GPUI's content view, as an address (it outlives the window's use here).
    pub fn view(window: &Window) -> Option<usize> {
        let h = HasWindowHandle::window_handle(window).ok()?;
        match h.as_raw() {
            RawWindowHandle::AppKit(h) => Some(h.ns_view.as_ptr() as usize),
            _ => None,
        }
    }

    fn obj(view: usize) -> *mut AnyObject {
        view as *mut AnyObject
    }

    fn none() -> NSRange {
        NSRange::new(NSNotFound as usize, 0)
    }

    /// `setMarkedText:selectedRange:replacementRange:`, the composing text.
    pub fn set_marked(view: usize, text: &str) {
        let s: Retained<NSString> = NSString::from_str(text);
        let len = s.length();
        // SAFETY: GPUI's view implements NSTextInputClient; main thread.
        unsafe {
            let _: () = msg_send![obj(view), setMarkedText: &*s, selectedRange: NSRange::new(len, 0), replacementRange: none()];
        }
    }

    /// `insertText:replacementRange:`, the commit.
    pub fn insert(view: usize, text: &str) {
        let s: Retained<NSString> = NSString::from_str(text);
        // SAFETY: as above.
        unsafe {
            let _: () = msg_send![obj(view), insertText: &*s, replacementRange: none()];
        }
    }

    /// `firstRectForCharacterRange:actualRange:`, where the candidate window goes (screen points).
    pub fn first_rect(view: usize, start: usize, len: usize) -> NSRect {
        // SAFETY: as above; a null actualRange is allowed.
        unsafe {
            msg_send![obj(view), firstRectForCharacterRange: NSRange::new(start, len), actualRange: std::ptr::null_mut::<NSRange>()]
        }
    }

    pub fn has_marked(view: usize) -> bool {
        // SAFETY: as above.
        unsafe {
            let b: objc2::runtime::Bool = msg_send![obj(view), hasMarkedText];
            b.as_bool()
        }
    }
}

/// What an input method sends, one call per step, and what the input should
/// hold afterwards (committed text, composing text).
enum ImeSend {
    Marked(&'static str),
    Insert(&'static str),
}

const IME_SCRIPT: [(&str, ImeSend, &str, Option<&str>); 6] = [
    // Japanese (Kotoeri, Romaji): n-i-h-o-n shows marked, turns to kana,
    // then converts and commits.
    (
        "ja: marked romaji",
        ImeSend::Marked("nihon"),
        "nihon",
        Some("nihon"),
    ),
    (
        "ja: marked kana",
        ImeSend::Marked("にほん"),
        "にほん",
        Some("にほん"),
    ),
    ("ja: commit kanji", ImeSend::Insert("日本"), "日本", None),
    // Chinese (Pinyin): marked pinyin with a space, then commit the hanzi.
    (
        "zh: marked pinyin",
        ImeSend::Marked("zhong wen"),
        "日本zhong wen",
        Some("zhong wen"),
    ),
    (
        "zh: commit hanzi",
        ImeSend::Insert("中文"),
        "日本中文",
        None,
    ),
    // The emoji picker and press-and-hold accents commit with insertText too.
    ("emoji picker", ImeSend::Insert("😀"), "日本中文😀", None),
];

fn record_ime(
    name: &str,
    text: String,
    marked: Option<String>,
    want: &str,
    want_marked: Option<&str>,
) {
    let ok = text == want && marked.as_deref() == want_marked;
    let v = json!({
        "step": name,
        "text": text,
        "marked": marked,
        "want_text": want,
        "want_marked": want_marked,
        "ok": ok,
    });
    println!("[spike] ime {v}");
    FACTS.lock().expect("facts").ime_steps.push(v);
    if !ok {
        spike_summary::error(format!("ime step {name}: got {text:?} / {marked:?}"));
    }
}

// ---------------------------------------------------------------- numbers

fn measure_numbers(window: &mut Window) -> Value {
    let ts = window.text_style();
    let size = px(15.);
    let width = |s: &str, features: FontFeatures| {
        let font = Font {
            features,
            ..ts.font()
        };
        let run = gpui::TextRun {
            len: s.len(),
            font,
            color: rgb(INK).into(),
            background_color: None,
            underline: None,
            strikethrough: None,
        };
        let line = window
            .text_system()
            .shape_line(s.to_owned().into(), size, &[run], None);
        f32::from(line.width)
    };
    let p1 = width("1111111111", FontFeatures::default());
    let p8 = width("8888888888", FontFeatures::default());
    let t1 = width("1111111111", tnum());
    let t8 = width("8888888888", tnum());
    json!({
        "font": ts.font().family.to_string(),
        "proportional_ones_px": round(p1 as f64, 2),
        "proportional_eights_px": round(p8 as f64, 2),
        "tabular_ones_px": round(t1 as f64, 2),
        "tabular_eights_px": round(t8 as f64, 2),
        "tabular_equal": (t1 - t8).abs() < 0.01,
        "proportional_differs": (p1 - p8).abs() >= 0.01,
    })
}

// ---------------------------------------------------------------- main

fn main() {
    let run = Run::start(SPIKE);
    let seconds = run.args.seconds;
    let rows_n: usize = run
        .args
        .value("--rows")
        .and_then(|v| v.parse().ok())
        .unwrap_or(10_000);
    let scroll_test = run.args.flag("--scroll-test");
    let sim_ime = run.args.flag("--simulate-ime");
    let step: f32 = run
        .args
        .value("--step")
        .and_then(|v| v.parse().ok())
        .unwrap_or(24.0);
    let emotes_timer = run.args.value("--emotes") == Some("timer");
    // GPUI caps an inactive window at about 30 fps; this lifts the cap, so a
    // run on a busy Mac measures what GPUI can draw, not who has focus.
    let no_inactive_cap = run.args.flag("--no-inactive-cap");
    EMOTES_TIMER.store(emotes_timer, Ordering::Relaxed);
    let run = Arc::new(Mutex::new(run));

    let t0 = Instant::now();
    let rows = Rc::new(chat_rows(rows_n));
    let data_ms = t0.elapsed().as_secs_f64() * 1000.0;

    gpui_platform::application().run(move |cx: &mut App| {
        TextInput::bind_keys(cx);
        if emotes_timer && let Err(e) = load_emote_frames() {
            spike_summary::error(format!("emote frames: {e}"));
        }
        cx.bind_keys([KeyBinding::new("cmd-c", CopySelection, Some("Selectable"))]);
        let bounds = Bounds::centered(None, size(px(1650.), px(962.)), cx);
        let rows2 = rows.clone();
        OPEN_US.store(
            (spike_summary::elapsed_ms() * 1000.0) as u64,
            Ordering::Relaxed,
        );
        let opened = cx.open_window(
            WindowOptions {
                window_bounds: Some(WindowBounds::Windowed(bounds)),
                titlebar: Some(TitlebarOptions {
                    title: Some(SPIKE.into()),
                    ..Default::default()
                }),
                inactive_frame_interval: if no_inactive_cap {
                    None
                } else {
                    WindowOptions::default().inactive_frame_interval
                },
                ..Default::default()
            },
            move |window, cx| {
                let input = cx.new(|cx| TextInput::new("Type here (IME, emoji)…", cx));
                let selectable = cx.new(|cx| Selectable {
                    text: "Select any part of this paragraph with the mouse, then press ⌘C. \
                           Chat and Notes text must be selectable (D13): 日本語、中文 and 😀 \
                           select as whole characters."
                        .into(),
                    layout: None,
                    anchor: None,
                    selection: 0..0,
                    focus: cx.focus_handle(),
                });
                let chat = ListState::new(rows2.len(), ListAlignment::Top, px(600.));
                let focus = input.read(cx).focus_handle(cx);
                window.focus(&focus, cx);
                cx.new(|_| Spike {
                    input,
                    selectable,
                    chat,
                    rows: rows2,
                    scroll: None,
                    status: "".into(),
                    remount: None,
                })
            },
        );
        let handle = match opened {
            Ok(h) => h,
            Err(e) => {
                spike_summary::error(format!("open_window failed: {e:#}"));
                run.lock().expect("run").finish();
            }
        };
        cx.activate(true);

        // Timer-driven emotes: one redraw per emote frame (80 ms here), not
        // one per display frame.
        if emotes_timer {
            cx.spawn(async move |cx| {
                loop {
                    cx.background_executor()
                        .timer(Duration::from_millis(80))
                        .await;
                    if handle.update(cx, |_, _, cx| cx.notify()).is_err() {
                        break;
                    }
                }
            })
            .detach();
        }

        // The script: numbers, IME, the scroll test, an idle window with
        // emotes on screen, then the summary.
        let run2 = run.clone();
        cx.spawn(async move |cx| {
            let exec = cx.background_executor().clone();
            let wait = move |ms: u64| exec.timer(Duration::from_millis(ms));
            let start_delay: u64 = std::env::var("SPIKE_START_DELAY_MS")
                .ok()
                .and_then(|v| v.parse().ok())
                .unwrap_or(800);
            wait(start_delay).await;
            let _ = handle.update(cx, |_, window, _| {
                let v = measure_numbers(window);
                println!("[spike] numbers {v}");
                FACTS.lock().expect("facts").numbers = v;
            });
            if sim_ime {
                // AppKit calls the view from outside any GPUI update; so do we.
                #[cfg(target_os = "macos")]
                {
                    let view = handle
                        .update(cx, |_, window, _| ime::view(window))
                        .ok()
                        .flatten();
                    if let Some(v) = view {
                        let mut candidate = Value::Null;
                        for (name, send, want, want_marked) in IME_SCRIPT {
                            match send {
                                ImeSend::Marked(t) => ime::set_marked(v, t),
                                ImeSend::Insert(t) => ime::insert(v, t),
                            }
                            wait(150).await;
                            if name == "ja: marked kana" {
                                let r = ime::first_rect(v, 0, 3);
                                let input_bounds = handle
                                    .update(cx, |spike, _, cx| spike.input.read(cx).bounds())
                                    .ok()
                                    .flatten();
                                candidate = json!({
                                    "first_rect_screen": [r.origin.x, r.origin.y, r.size.width, r.size.height],
                                    "has_marked_text": ime::has_marked(v),
                                    "input_bounds_window": input_bounds.map(|b| [f32::from(b.origin.x), f32::from(b.origin.y), f32::from(b.size.width), f32::from(b.size.height)]),
                                });
                                println!("[spike] ime candidate {candidate}");
                            }
                            let (text, marked) = handle
                                .update(cx, |spike, _, cx| spike.input.read(cx).state())
                                .unwrap_or_default();
                            record_ime(name, text, marked, want, want_marked);
                        }
                        FACTS
                            .lock()
                            .expect("facts")
                            .ime_steps
                            .push(json!({ "step": "candidate window rect", "detail": candidate }));
                    } else {
                        spike_summary::error("ime: no NSView");
                    }
                }
                #[cfg(not(target_os = "macos"))]
                spike_summary::error(
                    "--simulate-ime is macOS only; on Windows and Linux type with the real IME (WC-0.7, L5)",
                );
                let _ = handle.update(cx, |_, _, cx| cx.notify());
                wait(1200).await;
            }
            if scroll_test {
                let _ = handle.update(cx, |spike, _, cx| {
                    spike.scroll = Some(Scroll {
                        until: Instant::now() + Duration::from_secs(6),
                        frames: Vec::new(),
                        step,
                        rows_built_before: ROWS_BUILT.load(Ordering::Relaxed),
                        active_frames: 0,
                    });
                    spike.status = "scroll test running…".into();
                    cx.notify();
                });
                wait(6500).await;
            }
            // Idle with animated emotes on screen: what does it cost?
            let idle_active = handle
                .update(cx, |_, window, _| window.is_window_active())
                .unwrap_or(false);
            let (c0, t0) = (cpu_seconds(), Instant::now());
            let r0 = RENDERS.load(Ordering::Relaxed);
            wait(5000).await;
            let secs = t0.elapsed().as_secs_f64();
            let idle = json!({
                "seconds": round(secs, 2),
                "cpu_percent": round((cpu_seconds() - c0) / secs * 100.0, 1),
                "renders_per_second": round((RENDERS.load(Ordering::Relaxed) - r0) as f64 / secs, 1),
                "window_active": idle_active,
            });
            println!("[spike] idle-with-emotes {idle}");
            FACTS.lock().expect("facts").idle = idle;

            // Open the chat again: all rows reset and re-measured, to the
            // next frame (what switching to the chat page costs).
            let _ = handle.update(cx, |spike, _, cx| {
                spike.remount = Some(Instant::now());
                spike.chat.reset(spike.rows.len());
                cx.notify();
            });
            wait(500).await;
            let rest = seconds.saturating_sub(spike_summary::elapsed_ms() as u64 / 1000);
            wait(rest * 1000).await;
            let mut run = run2.lock().expect("run");
            let elapsed_s = spike_summary::elapsed_ms() / 1000.0;
            let renders = RENDERS.load(Ordering::Relaxed);
            run.set("renders", renders);
            run.set(
                "ui_redraws_per_second_idle",
                FACTS.lock().expect("facts").idle["renders_per_second"].clone(),
            );
            let fp = FIRST_PAINT_US.load(Ordering::Relaxed);
            if fp > 0 {
                run.set("startup_to_first_paint_ms", round(fp as f64 / 1000.0, 1));
            }
            let open_us = OPEN_US.load(Ordering::Relaxed);
            if fp > 0 && open_us > 0 {
                run.set(
                    "window_open_to_first_paint_ms",
                    round(fp.saturating_sub(open_us) as f64 / 1000.0, 1),
                );
            }
            let remount = FACTS.lock().expect("facts").remount_ms;
            run.set("chat_remount_to_frame_ms", remount.map(|v| round(v, 1)));
            run.set("emotes", if emotes_timer { "timer" } else { "gpui-img" });
            run.set("chat_rows", rows_n as u64);
            run.set("chat_data_ms", round(data_ms, 1));
            run.set("chat_rows_built", ROWS_BUILT.load(Ordering::Relaxed));
            let f = FACTS.lock().expect("facts");
            run.set("scroll", f.scroll.clone());
            run.set("ime_steps", json!(f.ime_steps));
            run.set("numbers", f.numbers.clone());
            run.set("idle_with_emotes", f.idle.clone());
            run.set("selected_text", json!(f.selected));
            let _ = elapsed_s;
            drop(f);
            run.finish();
        })
        .detach();
    });
}
