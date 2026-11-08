//! The pages the backend serves carry their own copy of the desktop's palette
//! (plan 208 S6, D13): the phone remote (`remote_web/`) and the OAuth callback
//! page (`oauth_page/`) are plain CSS with no build step, so they cannot import
//! the desktop's tokens. These tests read the desktop's sources of truth and
//! fail when a copy drifts:
//!
//! - the solids, text tiers, brand red, control tint and the work cover come
//!   from `apps/desktop/src/main/window-palette.ts`;
//! - hairlines, the selection tints, `--live`, the chrome controls' materials
//!   (plan 208 S4), Increase Contrast and the dialog drop come from
//!   `apps/desktop/src/renderer/src/styles.css`, whose `.dark` block is the
//!   pages' default column and whose `:root` block is their light column.

use std::collections::HashMap;

const WINDOW_PALETTE_TS: &str = include_str!("../../../apps/desktop/src/main/window-palette.ts");
const STYLES_CSS: &str = include_str!("../../../apps/desktop/src/renderer/src/styles.css");
const REMOTE_CSS: &str = include_str!("../remote_web/app.css");
const REMOTE_HTML: &str = include_str!("../remote_web/index.html");
const REMOTE_MANIFEST: &str = include_str!("../remote_web/manifest.webmanifest");
const OAUTH_HTML: &str = include_str!("../oauth_page/index.html");

/// The chrome controls' materials (styles.css, plan 208 S4) the remote copies.
const CHROME_TOKENS: [&str; 19] = [
    "--chrome-fill-stops",
    "--chrome-fill-flat",
    "--chrome-fill-ink",
    "--chrome-fill-hi",
    "--chrome-fill-lo",
    "--chrome-fill-drop",
    "--chrome-fill-lift",
    "--chrome-press",
    "--chrome-plate-top",
    "--chrome-plate-bottom",
    "--chrome-plate-hi",
    "--chrome-plate-rim",
    "--chrome-led-stops",
    "--chrome-led-flat",
    "--chrome-led-hi",
    "--chrome-led-lo",
    "--chrome-led-drop",
    "--chrome-led-lift",
    "--chrome-edge",
];

#[derive(Clone, Copy, Debug)]
enum Theme {
    Dark,
    Light,
}

impl Theme {
    fn palette_name(self) -> &'static str {
        match self {
            Theme::Dark => "DARK_WINDOW_PALETTE",
            Theme::Light => "LIGHT_WINDOW_PALETTE",
        }
    }

    fn covers_key(self) -> &'static str {
        match self {
            Theme::Dark => "dark",
            Theme::Light => "light",
        }
    }
}

/// One `WindowPalette` literal from window-palette.ts, `key: 'value'` per line.
fn desktop_palette(theme: Theme) -> HashMap<&'static str, String> {
    let name = theme.palette_name();
    let start = WINDOW_PALETTE_TS
        .find(&format!("export const {name}: WindowPalette = {{"))
        .unwrap_or_else(|| panic!("window-palette.ts has no {name}"));
    let literal = &WINDOW_PALETTE_TS[start..];
    let literal = &literal[..literal.find("\n}").expect("the palette literal closes")];
    literal
        .lines()
        .skip(1)
        .filter_map(|line| {
            let (key, value) = line.trim().split_once(':')?;
            let value = value.trim().trim_end_matches(',').trim_matches('\'');
            Some((key.trim(), normalize(value)))
        })
        .collect()
}

/// `GLASS_COVERS[theme].work`: how much of the base tone covers the ground.
fn desktop_work_cover(theme: Theme) -> f64 {
    let start = WINDOW_PALETTE_TS
        .find("export const GLASS_COVERS")
        .expect("window-palette.ts exports GLASS_COVERS");
    let key = format!("{}: {{", theme.covers_key());
    let line = WINDOW_PALETTE_TS[start..]
        .lines()
        .find(|line| line.trim_start().starts_with(&key))
        .unwrap_or_else(|| panic!("GLASS_COVERS has no {key}"));
    line.split("work:")
        .nth(1)
        .expect("a work cover")
        .trim()
        .trim_end_matches(['}', ',', ' '])
        .parse()
        .expect("the work cover is a number")
}

/// Collapse whitespace and drop the optional spaces around `(`, `)` and `,`,
/// so a value reads the same however Prettier wrapped it.
fn normalize(value: &str) -> String {
    value
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .replace("( ", "(")
        .replace(" )", ")")
        .replace(", ", ",")
        .replace(" ,", ",")
        .to_ascii_lowercase()
}

fn without_comments(css: &str) -> String {
    let mut out = String::with_capacity(css.len());
    let mut rest = css;
    while let Some(start) = rest.find("/*") {
        out.push_str(&rest[..start]);
        rest = rest[start + 2..]
            .find("*/")
            .map_or("", |end| &rest[start + 2 + end + 2..]);
    }
    out.push_str(rest);
    out
}

/// The body of the first rule that opens with `marker` (ending in `{`).
fn rule<'a>(css: &'a str, marker: &str) -> &'a str {
    let start = css
        .find(marker)
        .unwrap_or_else(|| panic!("no rule `{marker}`"))
        + marker.len();
    let mut depth = 1;
    for (offset, character) in css[start..].char_indices() {
        match character {
            '{' => depth += 1,
            '}' => {
                depth -= 1;
                if depth == 0 {
                    return &css[start..start + offset];
                }
            }
            _ => {}
        }
    }
    panic!("rule `{marker}` never closes");
}

/// A custom property declared directly in `block`, normalized.
fn declared(block: &str, name: &str) -> Option<String> {
    let needle = format!("{name}:");
    let mut from = 0;
    while let Some(found) = block[from..].find(&needle) {
        let at = from + found;
        let boundary = block[..at]
            .chars()
            .next_back()
            .is_none_or(|character| character.is_whitespace() || matches!(character, ';' | '{'));
        if boundary {
            let value = &block[at + needle.len()..];
            return Some(normalize(&value[..value.find(';')?]));
        }
        from = at + needle.len();
    }
    None
}

/// A column of tokens: its own block first, then the blocks it inherits from.
struct Column<'a> {
    blocks: Vec<&'a str>,
}

impl Column<'_> {
    fn get(&self, name: &str) -> String {
        let value = self
            .blocks
            .iter()
            .find_map(|block| declared(block, name))
            .unwrap_or_else(|| panic!("{name} is not declared"));
        // One level of `var(--x)`, the way the desktop aliases a token.
        match value
            .strip_prefix("var(")
            .and_then(|inner| inner.strip_suffix(')'))
        {
            Some(alias) if !alias.contains(',') => self.get(alias),
            _ => value,
        }
    }
}

struct Stylesheets {
    styles: String,
    remote: String,
    oauth: String,
}

impl Stylesheets {
    fn load() -> Self {
        let oauth_style = OAUTH_HTML
            .split_once("<style>")
            .and_then(|(_, rest)| rest.split_once("</style>"))
            .expect("the OAuth page has an inline stylesheet")
            .0;
        Self {
            styles: without_comments(STYLES_CSS),
            remote: without_comments(REMOTE_CSS),
            oauth: without_comments(oauth_style),
        }
    }

    /// styles.css: `.dark` over `:root` for dark, `:root` alone for light.
    fn desktop(&self, theme: Theme) -> Column<'_> {
        let light = rule(&self.styles, "\n:root {");
        match theme {
            Theme::Dark => Column {
                blocks: vec![rule(&self.styles, "\n.dark {"), light],
            },
            Theme::Light => Column {
                blocks: vec![light],
            },
        }
    }

    fn desktop_more_contrast(&self, theme: Theme) -> Column<'_> {
        let media = rule(&self.styles, "@media (prefers-contrast: more) {");
        let block = match theme {
            Theme::Dark => rule(media, ".dark {"),
            Theme::Light => rule(media, ":root {"),
        };
        Column {
            blocks: vec![block],
        }
    }

    /// A page's columns: its top `:root` is dark, the light media block
    /// overrides it.
    fn page<'a>(css: &'a str, theme: Theme) -> Column<'a> {
        let dark = rule(css, ":root {");
        match theme {
            Theme::Dark => Column { blocks: vec![dark] },
            Theme::Light => Column {
                blocks: vec![
                    rule(
                        rule(css, "@media (prefers-color-scheme: light) {"),
                        ":root {",
                    ),
                    dark,
                ],
            },
        }
    }

    fn remote(&self, theme: Theme) -> Column<'_> {
        Self::page(&self.remote, theme)
    }

    fn remote_more_contrast(&self, theme: Theme) -> Column<'_> {
        let marker = match theme {
            Theme::Dark => "@media (prefers-contrast: more) {",
            Theme::Light => "@media (prefers-contrast: more) and (prefers-color-scheme: light) {",
        };
        Column {
            blocks: vec![rule(rule(&self.remote, marker), ":root {")],
        }
    }

    fn oauth(&self, theme: Theme) -> Column<'_> {
        Self::page(&self.oauth, theme)
    }
}

#[test]
fn remote_page_wears_the_desktop_solids_in_both_schemes() {
    let sheets = Stylesheets::load();
    for theme in [Theme::Dark, Theme::Light] {
        let palette = desktop_palette(theme);
        let remote = sheets.remote(theme);
        let desktop = sheets.desktop(theme);
        for (token, key) in [
            ("--bg", "base"),
            ("--card", "panel"),
            ("--text", "textPrimary"),
            ("--text-2", "textSecondary"),
            ("--text-3", "textTertiary"),
        ] {
            assert_eq!(remote.get(token), palette[key], "{theme:?} {token} = {key}");
        }
        for (token, desktop_token) in [
            ("--hairline", "--border"),
            ("--hover", "--accent"),
            ("--pressed", "--accent-pressed"),
            ("--red", "--live"),
            ("--live-foreground", "--live-foreground"),
        ] {
            assert_eq!(
                remote.get(token),
                desktop.get(desktop_token),
                "{theme:?} {token} = styles.css {desktop_token}"
            );
        }
        let cover: f64 = remote.get("--ground-cover").parse().unwrap();
        assert_eq!(cover, desktop_work_cover(theme), "{theme:?} --ground-cover");
    }
    let dark = sheets.remote(Theme::Dark);
    let light = sheets.remote(Theme::Light);
    assert_eq!(
        dark.get("--ground-image"),
        "url('/chrome-ground-dark.webp')"
    );
    assert_eq!(
        light.get("--ground-image"),
        "url('/chrome-ground-light.webp')"
    );
}

#[test]
fn remote_page_wears_the_desktop_chrome_in_both_schemes() {
    let sheets = Stylesheets::load();
    for theme in [Theme::Dark, Theme::Light] {
        let remote = sheets.remote(theme);
        let desktop = sheets.desktop(theme);
        for token in CHROME_TOKENS {
            assert_eq!(remote.get(token), desktop.get(token), "{theme:?} {token}");
        }
        // The desktop mixes the glow from --live; the remote spells the same
        // colour out (`oklch(L C H / N%)`) for phones without color-mix.
        let glow = desktop.get("--chrome-led-glow");
        let percent = glow
            .strip_prefix("color-mix(in oklch,var(--live) ")
            .and_then(|rest| rest.strip_suffix(",transparent)"))
            .unwrap_or_else(|| panic!("{theme:?} desktop glow changed shape: {glow}"));
        let live = desktop.get("--live");
        let expected = format!("{} / {percent})", live.trim_end_matches(')'));
        assert_eq!(
            remote.get("--chrome-led-glow"),
            normalize(&expected),
            "{theme:?} --chrome-led-glow"
        );
    }
    // The light and shade, cut once from the tokens above (each file
    // declares them in one place).
    let remote = Column {
        blocks: vec![&sheets.remote],
    };
    let desktop = Column {
        blocks: vec![&sheets.styles],
    };
    for token in [
        "--chrome-fill-shadow",
        "--chrome-led-shadow",
        "--chrome-pressed-shadow",
    ] {
        assert_eq!(remote.get(token), desktop.get(token), "{token}");
    }
}

#[test]
fn remote_page_follows_increase_contrast_like_the_desktop() {
    let sheets = Stylesheets::load();
    for theme in [Theme::Dark, Theme::Light] {
        let remote = sheets.remote_more_contrast(theme);
        let desktop = sheets.desktop_more_contrast(theme);
        for (token, desktop_token) in [
            ("--hairline", "--border"),
            ("--text-2", "--muted-foreground"),
            ("--text-3", "--subtle"),
            ("--ground-cover", "--glass-cover-work"),
            ("--chrome-edge", "--chrome-edge"),
            ("--chrome-plate-rim", "--chrome-plate-rim"),
        ] {
            assert_eq!(
                remote.get(token),
                desktop.get(desktop_token),
                "{theme:?} more contrast {token} = styles.css {desktop_token}"
            );
        }
    }
}

#[test]
fn remote_manifest_and_theme_color_are_the_desktop_base() {
    let dark = &desktop_palette(Theme::Dark)["base"];
    let light = &desktop_palette(Theme::Light)["base"];
    let manifest: serde_json::Value = serde_json::from_str(REMOTE_MANIFEST).unwrap();
    for key in ["background_color", "theme_color"] {
        assert_eq!(
            manifest[key].as_str().unwrap().to_ascii_lowercase(),
            *dark,
            "manifest {key}"
        );
    }
    let html = REMOTE_HTML.to_ascii_lowercase();
    for (base, scheme) in [(dark, "dark"), (light, "light")] {
        let meta = format!(
            "<meta name=\"theme-color\" content=\"{base}\" media=\"(prefers-color-scheme: {scheme})\" />"
        );
        assert!(html.contains(&meta), "index.html lacks {meta}");
    }
}

#[test]
fn oauth_page_wears_the_desktop_solids_in_both_schemes() {
    let sheets = Stylesheets::load();
    assert!(OAUTH_HTML.contains("<meta name=\"color-scheme\" content=\"dark light\" />"));
    for theme in [Theme::Dark, Theme::Light] {
        let palette = desktop_palette(theme);
        let page = sheets.oauth(theme);
        let desktop = sheets.desktop(theme);
        for (token, key) in [
            ("--bg", "base"),
            ("--panel", "panel"),
            ("--text", "textPrimary"),
            ("--muted", "textSecondary"),
            ("--subtle", "textTertiary"),
            ("--sheen", "controlBg"),
            ("--bad", "brandRed"),
        ] {
            assert_eq!(page.get(token), palette[key], "{theme:?} {token} = {key}");
        }
        assert_eq!(
            page.get("--hairline"),
            desktop.get("--border"),
            "{theme:?} --hairline = styles.css --border"
        );
        assert_eq!(
            page.get("--shadow"),
            desktop.get("--glass-float-dialog-drop"),
            "{theme:?} --shadow = styles.css --glass-float-dialog-drop"
        );
    }
}

#[test]
fn no_served_page_keeps_the_old_zinc_palette() {
    // The pre-plan-208 copies: zinc-cast greys that no longer exist anywhere.
    let retired = [
        "#0d0d0f", "#141417", "#f4f4f5", "#a1a1aa", "#71717a", "#fafafb", "#1c1c1e", "#6e6e73",
        "#98989d", "#f0444a",
    ];
    for (file, text) in [
        ("remote_web/app.css", REMOTE_CSS),
        ("remote_web/index.html", REMOTE_HTML),
        ("remote_web/manifest.webmanifest", REMOTE_MANIFEST),
        ("oauth_page/index.html", OAUTH_HTML),
    ] {
        let text = text.to_ascii_lowercase();
        for hex in retired {
            assert!(!text.contains(hex), "{file} still carries {hex}");
        }
    }
}
