//! The UI driver (plan 260 S2.5, from plan 220 S3.0b): a smoke finds, reads,
//! clicks and types in any GPUI window, as Electron's smokes do with
//! `eval-js` and the DOM. Every command hops to GPUI's foreground
//! ([`super::UiThread`]) and works on the live window's AccessKit tree, read
//! with `Window::debug_a11y_tree_json` (`videorc_app_core::smoke::gpui_tree`):
//!
//! - `ui-tree {window?, within?, depth?}`: the window's tree as JSON (role,
//!   label, value, the states, enabled, focused, bounds when known, the
//!   element id, the view, the actions, the children).
//! - `ui-find {window?, label|id|role|value, within?, index?, timeoutMs?,
//!   reveal?}`: waits (Electron's `waitFor`, 8 s by default) for a match and
//!   answers it with the number of matches. A password field's value is
//!   masked unless `reveal: true`.
//! - `ui-click {…selector, via?}` or `ui-click {x, y, modifiers?}`: a pointer
//!   press and release at the element's centre (or at absolute window points)
//!   through the window's own dispatch (`via: "pointer"`, the default: what a
//!   mouse does, so a dialog's scrim takes a click meant for what it covers).
//!   A disabled element is waited for, then refused by name. The selector is
//!   an element id or accessibility name (label). Absolute `x`/`y` is
//!   pointer-only (no `via: "action"`).
//! - `ui-drag {fromX, fromY, toX, toY, steps?, modifiers?}`: press at `from`,
//!   move through `steps` samples to `to`, release — freeform stage gestures.
//! - `ui-focus {…selector}`: the same pointer click so a row or field takes
//!   the focus; answers once the tree says it is focused.
//! - `ui-type {…selector?, text, clear?}`: focuses the element (a click, then
//!   a frame for its input handler) or keeps the focus, which must be on a
//!   text field, and types each character as a keystroke; `clear` selects
//!   all and deletes first.
//! - `ui-key {…selector?, key, modifiers?}`: one key with modifiers held,
//!   into the focused element or the one named (no selector → whatever has
//!   the focus). `meta` is ⌘ on macOS and the Windows or Super key elsewhere,
//!   as GPUI's `platform` modifier is.
//! - `ui-scroll {…selector?, dx?, dy?}`: a wheel scroll at the element's
//!   centre (or the window's); positive `dy` reveals what is below, as a DOM
//!   `deltaY` does.
//! - `ui-set-value {…selector, value}`: the field emptied and the value
//!   typed (see the gaps).
//! - `ui-appearance` and `ui-toast`: the shell's ([`super::ShellSmoke`]).
//! - `resize-window {width?, height?}`: Electron's, the main window's size;
//!   its frame back.
//!
//! Gaps in gpui-pre 0.3.14, each answered by name, never a silent success
//! (`docs/gpui/ui-driver.md`):
//!
//! - Bounds in the dump: closed locally (`patches/gpui-pre`); a node that
//!   still has no rect is refused by name.
//! - No public way to send an AccessKit action into a window
//!   (`Window::handle_a11y_action` is crate-private): `via: "action"` and a
//!   true set-value action wait for it.
//! - `Window::render_to_image` is test-support only: `capture-page` waits
//!   for a capture path.

use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, Instant};

use gpui::{
    App, Keystroke, Modifiers, MouseButton, MouseDownEvent, MouseMoveEvent, MouseUpEvent,
    PlatformInput, Point, ScrollDelta, ScrollEvent, ScrollSource, TouchPhase, Window, point, px,
    size,
};
use serde_json::{Map, Value, json};
use videorc_app_core::smoke::gpui_tree::parse_gpui_tree;
use videorc_app_core::smoke::security::{
    UiClickVia, UiDriverRequest, UiKeyName, UiModifier, UiWindow, validate_ui_driver_request,
};
use videorc_app_core::smoke::ui_tree::{UiNode, UiSelector};
use videorc_app_core::smoke::{CommandFuture, SmokeCommandHandler};

use super::activate::{NativeWindow, activate, native_window};
use super::{UiThread, shell};

/// The commands the driver takes. The server's test (`ui-driver.test.mjs`)
/// checks every `ui-*` command the JS driver sends is named here.
pub const UI_DRIVER_WINDOW_COMMANDS: &[&str] = &[
    "capture-page-alpha",
    "resize-window",
    "ui-appearance",
    "ui-click",
    "ui-drag",
    "ui-find",
    "ui-focus",
    "ui-key",
    "ui-scroll",
    "ui-set-value",
    "ui-toast",
    "ui-tree",
    "ui-type",
];

/// How often a wait looks again (Electron's `waitFor`).
const POLL: Duration = Duration::from_millis(50);
/// How much of the window's words an error quotes.
const SHOWN_TEXT_LIMIT: usize = 240;

/// A node with no rect in the dump (most do, after `patches/gpui-pre`).
const NO_BOUNDS: &str = "This element's accessibility node has no bounds, so the pointer has \
     no target (plan 260 S2.5: docs/gpui/ui-driver.md).";
/// The action gap, by name.
const NO_ACTIONS: &str = "GPUI (gpui-pre 0.3.14) has no public way to send an accessibility \
     action into a window; use the pointer (plan 260 S2.5 gap: docs/gpui/ui-driver.md).";
/// The capture gap, by name.
const NO_CAPTURE: &str = "capture-page-alpha reads a page render GPUI (gpui-pre 0.3.14) only \
     offers to tests; capture-page is the composited window (super::capture).";

/// The driver's handler.
pub struct UiDriver {
    ui: UiThread,
    /// Where `capture-page` writes (`VIDEORC_SMOKE_OUTPUT_DIR`, or the temp
    /// directory as Electron's `app.getPath('temp')`), once it can.
    #[allow(dead_code)]
    output_dir: PathBuf,
}

impl UiDriver {
    pub fn new(ui: UiThread, output_dir: PathBuf) -> Self {
        Self { ui, output_dir }
    }

    async fn drive(&self, command: &str, params: Map<String, Value>) -> Result<Value, String> {
        match command {
            "capture-page-alpha" => return Err(NO_CAPTURE.into()),
            "resize-window" => {
                let (width, height) = resize_params(&params)?;
                return self
                    .ui
                    .run(move |cx| resize_main(width, height, cx))
                    .await?;
            }
            _ => {}
        }
        let request = Arc::new(validate_ui_driver_request(command, &params)?);
        let deadline = Instant::now() + Duration::from_millis(request.timeout_ms());
        loop {
            let asked = request.clone();
            match self.ui.run(move |cx| attempt(&asked, cx)).await?? {
                Attempt::Done(answer) => return Ok(answer),
                Attempt::Wait(miss) if Instant::now() >= deadline => return Err(miss),
                Attempt::Wait(_) => tokio::time::sleep(POLL).await,
            }
        }
    }
}

impl SmokeCommandHandler for UiDriver {
    fn handles(&self, command: &str) -> bool {
        UI_DRIVER_WINDOW_COMMANDS.contains(&command)
    }

    fn run<'a>(&'a self, command: &'a str, params: Map<String, Value>) -> CommandFuture<'a> {
        Box::pin(self.drive(command, params))
    }
}

/// One look at the window: the answer, or what is still missing (waited for
/// until the command's deadline, then its error).
enum Attempt {
    Done(Value),
    Wait(String),
}

fn window_of(request: &UiDriverRequest) -> UiWindow {
    match request {
        UiDriverRequest::Tree { window, .. }
        | UiDriverRequest::Find { window, .. }
        | UiDriverRequest::Click { window, .. }
        | UiDriverRequest::Drag { window, .. }
        | UiDriverRequest::Focus { window, .. }
        | UiDriverRequest::Type { window, .. }
        | UiDriverRequest::Key { window, .. }
        | UiDriverRequest::Scroll { window, .. }
        | UiDriverRequest::SetValue { window, .. } => *window,
        UiDriverRequest::Appearance(_) | UiDriverRequest::Toast(_) => UiWindow::Main,
    }
}

fn attempt(request: &UiDriverRequest, cx: &mut App) -> Result<Attempt, String> {
    let shell = shell(cx)?;
    match request {
        UiDriverRequest::Appearance(look) => return shell.appearance(*look, cx).map(Attempt::Done),
        UiDriverRequest::Toast(toast) => return shell.toast(toast, cx).map(Attempt::Done),
        _ => {}
    }
    let which = window_of(request);
    let Some(handle) = shell.window(which, cx) else {
        return if which == UiWindow::Main {
            Err(super::MAIN_WINDOW_NOT_READY.into())
        } else {
            Ok(Attempt::Wait(format!(
                "The {} window is not open.",
                which.as_str()
            )))
        };
    };
    let mut wake: Option<NativeWindow> = None;
    let outcome = handle
        .update(cx, |_, window, cx| {
            if !window.is_a11y_enabled() {
                return Err(
                    "This app runs without accessibility (Application::new_inaccessible), so \
                     the UI driver has no tree."
                        .to_string(),
                );
            }
            let tree = window
                .debug_a11y_tree_json()
                .filter(|_| window.is_a11y_active())
                .map(|text| parse_gpui_tree(&text));
            match tree {
                Some(Ok(tree)) => look(request, which, &tree, window, cx),
                _ => {
                    // No tree yet: ask for it as a screen reader would, and
                    // draw a frame that builds it. Linux's switch is the
                    // desktop's AT-SPI flag, which a smoke run doesn't own:
                    // the tree is switched on in-process there (the
                    // patched `Window::activate_a11y_in_process`).
                    if cfg!(target_os = "linux") {
                        window.activate_a11y_in_process();
                    } else {
                        wake = Some(native_window(window));
                    }
                    window.refresh();
                    Ok(Attempt::Wait(format!(
                        "The {} window's accessibility tree did not arrive.",
                        which.as_str()
                    )))
                }
            }
        })
        .map_err(|_| format!("The {} window closed.", which.as_str()))??;
    if let Some(native) = wake {
        activate(native)?;
    }
    Ok(outcome)
}

/// What the command does with the window's current tree.
fn look(
    request: &UiDriverRequest,
    which: UiWindow,
    tree: &UiNode,
    window: &mut Window,
    cx: &mut App,
) -> Result<Attempt, String> {
    let missing = |selector: &UiSelector| {
        Attempt::Wait(format!(
            "Timed out waiting for {} in the {} window. It shows: {}",
            selector.describe(),
            which.as_str(),
            tree.visible_text(SHOWN_TEXT_LIMIT)
        ))
    };
    // The window's node alone: the tree is activating but the frame that
    // builds its content has not been drawn yet (seen on X11 right after
    // launch). Wait for it, as the other commands do.
    if tree.children.is_empty() {
        window.refresh();
        return Ok(Attempt::Wait(format!(
            "The {} window's accessibility tree has only the window so far.",
            which.as_str()
        )));
    }
    match request {
        UiDriverRequest::Tree { within, depth, .. } => {
            let scope = match within {
                Some(within) => within.find(tree).ok_or_else(|| {
                    format!(
                        "ui-tree: nothing matches {} in the {} window.",
                        within.describe(),
                        which.as_str()
                    )
                })?,
                None => tree,
            };
            Ok(Attempt::Done(scope.json(false, *depth)))
        }
        UiDriverRequest::Find {
            selector, reveal, ..
        } => {
            let matches = selector.find_all(tree);
            Ok(match matches.get(selector.index) {
                Some(node) => Attempt::Done(json!({
                    "element": node.json(*reveal, None),
                    "count": matches.len(),
                })),
                None => missing(selector),
            })
        }
        UiDriverRequest::Click {
            selector,
            point: at,
            via,
            modifiers,
            ..
        } => {
            let held = modifiers_of(modifiers);
            if let Some((x, y)) = *at {
                pointer_click(point(px(x as f32), px(y as f32)), held, window, cx);
                return Ok(Attempt::Done(json!({ "clicked": true, "x": x, "y": y })));
            }
            let selector = selector.as_ref().expect("validated: selector or point");
            let Some(node) = selector.find(tree) else {
                return Ok(missing(selector));
            };
            if !node.enabled {
                return Ok(Attempt::Wait(format!(
                    "Timed out waiting: {} is disabled.",
                    selector.describe()
                )));
            }
            match via {
                UiClickVia::Action => Err(NO_ACTIONS.into()),
                UiClickVia::Pointer => {
                    click_node(node, held, window, cx)?;
                    Ok(Attempt::Done(json!({
                        "clicked": true,
                        "element": node.json(false, Some(0)),
                    })))
                }
            }
        }
        UiDriverRequest::Drag {
            from,
            to,
            steps,
            modifiers,
            ..
        } => {
            let held = modifiers_of(modifiers);
            pointer_drag(*from, *to, *steps, held, window, cx);
            Ok(Attempt::Done(json!({
                "dragged": true,
                "fromX": from.0,
                "fromY": from.1,
                "toX": to.0,
                "toY": to.1,
                "steps": steps,
            })))
        }
        UiDriverRequest::Focus { selector, .. } => {
            let Some(node) = selector.find(tree) else {
                return Ok(missing(selector));
            };
            if !node.enabled {
                return Ok(Attempt::Wait(format!(
                    "Timed out waiting: {} is disabled.",
                    selector.describe()
                )));
            }
            if node.focused {
                return Ok(Attempt::Done(json!({
                    "focused": true,
                    "element": node.json(false, Some(0)),
                })));
            }
            click_node(node, Modifiers::none(), window, cx)?;
            Ok(Attempt::Wait(format!(
                "{} did not take the focus.",
                selector.describe()
            )))
        }
        UiDriverRequest::Type {
            selector,
            text,
            clear,
            ..
        } => type_into(selector.as_ref(), text, *clear, tree, window, cx, "ui-type"),
        UiDriverRequest::SetValue {
            selector, value, ..
        } => type_into(
            Some(selector),
            value,
            true,
            tree,
            window,
            cx,
            "ui-set-value",
        ),
        UiDriverRequest::Key {
            selector,
            key,
            modifiers,
            ..
        } => {
            if let Some(selector) = selector {
                let Some(node) = selector.find(tree) else {
                    return Ok(missing(selector));
                };
                if !node.focused {
                    click_node(node, Modifiers::none(), window, cx)?;
                    return Ok(Attempt::Wait(format!(
                        "{} did not take the focus.",
                        selector.describe()
                    )));
                }
            }
            let keystroke = keystroke(*key, modifiers);
            let handled = window.dispatch_keystroke(keystroke, cx);
            Ok(Attempt::Done(json!({
                "pressed": key_label(*key, modifiers),
                "handled": handled,
            })))
        }
        UiDriverRequest::Scroll {
            selector, dx, dy, ..
        } => {
            let position = match selector {
                Some(selector) => {
                    let Some(node) = selector.find(tree) else {
                        return Ok(missing(selector));
                    };
                    centre(node)?
                }
                None => {
                    let viewport = window.viewport_size();
                    point(
                        px(viewport.width.as_f32() / 2.0),
                        px(viewport.height.as_f32() / 2.0),
                    )
                }
            };
            // A wheel moves GPUI's pointer to where it scrolls, and hover
            // follows it: put it back after, so a scroll at the window's
            // centre leaves no row hovered (Electron's shooter sets
            // `scrollTop`; the gallery's shots compare to that).
            let pointer = window.mouse_position();
            window.dispatch_event(
                PlatformInput::Scroll(ScrollEvent {
                    position,
                    // A DOM `deltaY` above zero reveals what is below; GPUI's
                    // wheel delta moves the content the other way.
                    delta: ScrollDelta::Pixels(point(px(-*dx as f32), px(-*dy as f32))),
                    modifiers: Modifiers::none(),
                    touch_phase: TouchPhase::Moved,
                    source: ScrollSource::Pointer,
                }),
                cx,
            );
            window.dispatch_event(
                PlatformInput::MouseMove(MouseMoveEvent {
                    position: pointer,
                    pressed_button: None,
                    modifiers: Modifiers::none(),
                }),
                cx,
            );
            Ok(Attempt::Done(
                json!({ "scrolled": true, "dx": dx, "dy": dy }),
            ))
        }
        UiDriverRequest::Appearance(_) | UiDriverRequest::Toast(_) => {
            unreachable!("the shell answers these")
        }
    }
}

/// `ui-type` and `ui-set-value`: the target focused (a click, then the next
/// frame gives it its input handler), emptied when asked, then typed.
fn type_into(
    selector: Option<&UiSelector>,
    text: &str,
    clear: bool,
    tree: &UiNode,
    window: &mut Window,
    cx: &mut App,
    command: &str,
) -> Result<Attempt, String> {
    let node = match selector {
        Some(selector) => match selector.find(tree) {
            Some(node) => node,
            None => {
                return Ok(Attempt::Wait(format!(
                    "Timed out waiting for {}.",
                    selector.describe()
                )));
            }
        },
        None => tree
            .focused_node()
            .ok_or_else(|| format!("{command} needs a field: nothing has the focus."))?,
    };
    if !node.role.ends_with("input") {
        return Err(format!(
            "{command} types into a text field; {} is a {}.",
            describe_node(node),
            node.role
        ));
    }
    if !node.enabled || node.read_only {
        return Ok(Attempt::Wait(format!(
            "Timed out waiting: {} takes no typing.",
            describe_node(node)
        )));
    }
    if !node.focused {
        click_node(node, Modifiers::none(), window, cx)?;
        return Ok(Attempt::Wait(format!(
            "{} did not take the focus.",
            describe_node(node)
        )));
    }
    if clear {
        window.dispatch_keystroke(select_all(), cx);
        window.dispatch_keystroke(named(UiKeyName::Backspace, Modifiers::none()), cx);
    }
    for ch in text.chars() {
        window.dispatch_keystroke(typed(ch), cx);
    }
    Ok(Attempt::Done(json!({
        "typed": text.chars().count(),
        "element": node.json(false, Some(0)),
    })))
}

fn describe_node(node: &UiNode) -> String {
    match node.label.is_empty() {
        true => format!("the {}", node.role),
        false => format!("{:?} ({})", node.label, node.role),
    }
}

/// The element's centre in window points, or the bounds gap by name.
fn centre(node: &UiNode) -> Result<Point<gpui::Pixels>, String> {
    let bounds = node.bounds.ok_or(NO_BOUNDS)?;
    let (x, y) = bounds.center();
    Ok(point(px(x as f32), px(y as f32)))
}

/// A pointer move, press and release at the element's centre.
fn click_node(
    node: &UiNode,
    modifiers: Modifiers,
    window: &mut Window,
    cx: &mut App,
) -> Result<(), String> {
    let at = centre(node)?;
    // A pointer press outside the window lands on nothing: refuse it rather
    // than answer clicked (ogre, XWayland: a row at y 1843 in a 1030-tall
    // window). Scroll it into view first.
    let viewport = window.viewport_size();
    if at.x < px(0.) || at.y < px(0.) || at.x >= viewport.width || at.y >= viewport.height {
        return Err(format!(
            "{} is outside the window ({:.0}, {:.0} in {:.0}×{:.0}); scroll it into view first.",
            if node.label.is_empty() {
                "The element"
            } else {
                node.label.as_str()
            },
            f32::from(at.x),
            f32::from(at.y),
            f32::from(viewport.width),
            f32::from(viewport.height),
        ));
    }
    pointer_click(at, modifiers, window, cx);
    Ok(())
}

/// A pointer move, press and release at `position`, through the window's own
/// dispatch: what a mouse does.
fn pointer_click(
    position: Point<gpui::Pixels>,
    modifiers: Modifiers,
    window: &mut Window,
    cx: &mut App,
) {
    window.dispatch_event(
        PlatformInput::MouseMove(MouseMoveEvent {
            position,
            pressed_button: None,
            modifiers,
        }),
        cx,
    );
    window.dispatch_event(
        PlatformInput::MouseDown(MouseDownEvent {
            button: MouseButton::Left,
            position,
            modifiers,
            click_count: 1,
            first_mouse: false,
        }),
        cx,
    );
    window.dispatch_event(
        PlatformInput::MouseUp(MouseUpEvent {
            button: MouseButton::Left,
            position,
            modifiers,
            click_count: 1,
        }),
        cx,
    );
}

/// Press at `from`, move through `steps` samples to `to`, release.
fn pointer_drag(
    from: (f64, f64),
    to: (f64, f64),
    steps: usize,
    modifiers: Modifiers,
    window: &mut Window,
    cx: &mut App,
) {
    let start = point(px(from.0 as f32), px(from.1 as f32));
    let end = point(px(to.0 as f32), px(to.1 as f32));
    window.dispatch_event(
        PlatformInput::MouseMove(MouseMoveEvent {
            position: start,
            pressed_button: None,
            modifiers,
        }),
        cx,
    );
    window.dispatch_event(
        PlatformInput::MouseDown(MouseDownEvent {
            button: MouseButton::Left,
            position: start,
            modifiers,
            click_count: 1,
            first_mouse: false,
        }),
        cx,
    );
    let hops = steps.max(1);
    for hop in 1..=hops {
        let t = hop as f64 / hops as f64;
        let position = point(
            px((from.0 + (to.0 - from.0) * t) as f32),
            px((from.1 + (to.1 - from.1) * t) as f32),
        );
        window.dispatch_event(
            PlatformInput::MouseMove(MouseMoveEvent {
                position,
                pressed_button: Some(MouseButton::Left),
                modifiers,
            }),
            cx,
        );
    }
    window.dispatch_event(
        PlatformInput::MouseUp(MouseUpEvent {
            button: MouseButton::Left,
            position: end,
            modifiers,
            click_count: 1,
        }),
        cx,
    );
}

fn modifiers_of(held: &[UiModifier]) -> Modifiers {
    Modifiers {
        shift: held.contains(&UiModifier::Shift),
        control: held.contains(&UiModifier::Control),
        alt: held.contains(&UiModifier::Alt),
        platform: held.contains(&UiModifier::Meta),
        ..Modifiers::none()
    }
}

/// A named key as GPUI spells it (`escape`, `enter`, `up` …).
fn named(key: UiKeyName, modifiers: Modifiers) -> Keystroke {
    let (name, typed): (String, Option<&str>) = match key {
        UiKeyName::Escape => ("escape".into(), None),
        UiKeyName::Enter => ("enter".into(), None),
        UiKeyName::Tab => ("tab".into(), None),
        UiKeyName::Space => ("space".into(), Some(" ")),
        UiKeyName::Backspace => ("backspace".into(), None),
        UiKeyName::Delete => ("delete".into(), None),
        UiKeyName::ArrowUp => ("up".into(), None),
        UiKeyName::ArrowDown => ("down".into(), None),
        UiKeyName::ArrowLeft => ("left".into(), None),
        UiKeyName::ArrowRight => ("right".into(), None),
        UiKeyName::Home => ("home".into(), None),
        UiKeyName::End => ("end".into(), None),
        UiKeyName::PageUp => ("pageup".into(), None),
        UiKeyName::PageDown => ("pagedown".into(), None),
        UiKeyName::Function(number) => (format!("f{number}"), None),
        UiKeyName::Char(ch) => {
            let chorded = modifiers.control || modifiers.platform || modifiers.alt;
            return Keystroke {
                modifiers,
                key: ch.to_lowercase().collect(),
                key_char: (!chorded).then(|| {
                    if modifiers.shift {
                        ch.to_uppercase().collect()
                    } else {
                        ch.to_string()
                    }
                }),
            };
        }
    };
    let chorded = modifiers.control || modifiers.platform || modifiers.alt;
    Keystroke {
        modifiers,
        key: name,
        key_char: typed.filter(|_| !chorded).map(str::to_string),
    }
}

/// `ui-key`'s keystroke.
fn keystroke(key: UiKeyName, held: &[UiModifier]) -> Keystroke {
    named(key, modifiers_of(held))
}

/// One typed character: the key as printed, and the character itself (an
/// upper-case letter holds Shift).
fn typed(ch: char) -> Keystroke {
    if ch == '\n' {
        return named(UiKeyName::Enter, Modifiers::none());
    }
    Keystroke {
        modifiers: Modifiers {
            shift: ch.is_uppercase(),
            ..Modifiers::none()
        },
        key: ch.to_lowercase().collect(),
        key_char: Some(ch.to_string()),
    }
}

/// Select all: ⌘A on macOS, Ctrl+A elsewhere.
fn select_all() -> Keystroke {
    let modifiers = if cfg!(target_os = "macos") {
        Modifiers {
            platform: true,
            ..Modifiers::none()
        }
    } else {
        Modifiers {
            control: true,
            ..Modifiers::none()
        }
    };
    named(UiKeyName::Char('a'), modifiers)
}

/// The keystroke as an answer names it (`meta+shift+K`).
fn key_label(key: UiKeyName, held: &[UiModifier]) -> String {
    let mut held = held.to_vec();
    held.sort_unstable();
    held.dedup();
    let name = match key {
        UiKeyName::Function(number) => format!("F{number}"),
        UiKeyName::Char(ch) => ch.to_string(),
        other => format!("{other:?}"),
    };
    held.iter()
        .map(|modifier| modifier.as_str().to_string())
        .chain(std::iter::once(name))
        .collect::<Vec<_>>()
        .join("+")
}

/// `resize-window`'s `{width?, height?}`, in points (Electron's defaults).
fn resize_params(params: &Map<String, Value>) -> Result<(f64, f64), String> {
    if let Some(key) = params
        .keys()
        .find(|key| !matches!(key.as_str(), "width" | "height"))
    {
        return Err(format!("resize-window takes no {key}."));
    }
    let size = |key: &str, default: f64| -> Result<f64, String> {
        match params.get(key) {
            None => Ok(default),
            Some(value) => value
                .as_f64()
                .filter(|size| size.is_finite() && (100.0..=20_000.0).contains(size))
                .ok_or_else(|| format!("resize-window's {key} is a size in points.")),
        }
    };
    Ok((size("width", 1180.0)?, size("height", 780.0)?))
}

fn resize_main(width: f64, height: f64, cx: &mut App) -> Result<Value, String> {
    let handle = shell(cx)?
        .window(UiWindow::Main, cx)
        .ok_or(super::MAIN_WINDOW_NOT_READY)?;
    handle
        .update(cx, |_, window, _| {
            window.resize(size(px(width as f32), px(height as f32)));
            let bounds = window.bounds();
            json!({
                "x": f32::from(bounds.origin.x),
                "y": f32::from(bounds.origin.y),
                "width": f32::from(bounds.size.width),
                "height": f32::from(bounds.size.height),
            })
        })
        .map_err(|_| super::MAIN_WINDOW_NOT_READY.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use videorc_app_core::smoke::APP_WINDOW_COMMANDS;
    use videorc_app_core::smoke::security::UI_DRIVER_COMMAND_NAMES;

    #[test]
    fn the_driver_takes_every_ui_command_and_only_window_commands() {
        for name in UI_DRIVER_COMMAND_NAMES {
            assert!(UI_DRIVER_WINDOW_COMMANDS.contains(name), "{name}");
        }
        for name in UI_DRIVER_WINDOW_COMMANDS {
            assert!(APP_WINDOW_COMMANDS.contains(name), "{name}");
        }
    }

    #[test]
    fn keys_read_as_gpui_spells_them() {
        let enter = keystroke(UiKeyName::Enter, &[]);
        assert_eq!((enter.key.as_str(), enter.key_char), ("enter", None));
        let save = keystroke(UiKeyName::Char('S'), &[UiModifier::Meta]);
        assert_eq!(save.key, "s");
        assert!(save.modifiers.platform);
        assert_eq!(save.key_char, None, "a chord types nothing");
        let capital = typed('K');
        assert!(capital.modifiers.shift);
        assert_eq!(capital.key_char.as_deref(), Some("K"));
        assert_eq!(keystroke(UiKeyName::Function(5), &[]).key, "f5");
        assert_eq!(
            key_label(
                UiKeyName::Char('k'),
                &[UiModifier::Shift, UiModifier::Meta, UiModifier::Shift]
            ),
            "shift+meta+k"
        );
    }

    #[test]
    fn resize_takes_sizes_in_points_and_nothing_else() {
        let params = |value: Value| value.as_object().cloned().unwrap();
        assert_eq!(resize_params(&params(json!({}))), Ok((1180.0, 780.0)));
        assert_eq!(
            resize_params(&params(json!({"width": 900, "height": 600}))),
            Ok((900.0, 600.0))
        );
        assert!(resize_params(&params(json!({"width": 50}))).is_err());
        assert!(resize_params(&params(json!({"depth": 1}))).is_err());
    }
}
