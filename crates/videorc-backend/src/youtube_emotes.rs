//! YouTube's official API supplies display text, not emoji image runs. Only
//! known built-in aliases may be enriched; channel-member names stay text.
//! Catalog provenance and update rules: docs/youtube-chat-emotes.md.

use std::collections::HashMap;
use std::sync::OnceLock;

const CATALOG: &str = include_str!("../assets/youtube-emotes.tsv");

fn catalog() -> &'static HashMap<&'static str, &'static str> {
    static INDEX: OnceLock<HashMap<&str, &str>> = OnceLock::new();
    INDEX.get_or_init(|| {
        CATALOG
            .lines()
            .filter_map(|line| line.split_once('\t'))
            .collect()
    })
}

#[derive(Debug, PartialEq, Eq)]
pub struct YouTubeTextToken<'a> {
    pub text: &'a str,
    pub image_url: Option<&'static str>,
}

/// Empty means the original text needs no rich fragments. Only call this
/// from the YouTube adapter, never from the shared renderer or 7TV matcher.
pub fn tokenize(text: &str) -> Vec<YouTubeTextToken<'_>> {
    let mut tokens = Vec::new();
    let mut plain_start = 0;
    let mut word_start = 0;
    for word in text.split_inclusive(char::is_whitespace) {
        // Keep links intact for the renderer's link parser. A colon-delimited
        // name is not an emote when it is part of a URL.
        if !word.contains("://") && !word.trim_start_matches(['(', '[']).starts_with("www.") {
            let mut search = 0;
            while let Some(open) = word[search..].find(':') {
                let start = search + open;
                let Some(close) = word[start + 1..].find(':') else {
                    break;
                };
                let end = start + 1 + close + 1;
                if let Some(&url) = catalog().get(&word[start..end]) {
                    let absolute_start = word_start + start;
                    if plain_start < absolute_start {
                        tokens.push(YouTubeTextToken {
                            text: &text[plain_start..absolute_start],
                            image_url: None,
                        });
                    }
                    tokens.push(YouTubeTextToken {
                        text: &text[absolute_start..word_start + end],
                        image_url: Some(url),
                    });
                    plain_start = word_start + end;
                    search = end;
                } else {
                    // The closing colon may open a subsequent valid alias.
                    search = end - 1;
                }
            }
        }
        word_start += word.len();
    }
    if !tokens.is_empty() && plain_start < text.len() {
        tokens.push(YouTubeTextToken {
            text: &text[plain_start..],
            image_url: None,
        });
    }
    tokens
}

#[cfg(test)]
mod tests {
    use super::*;

    const BLUE: &str = ":face-blue-smiling:";
    const BLUE_URL: &str = "https://yt3.ggpht.com/cktIaPxFwnrPwn-alHvnvedHLUJwbHi8HCK3AgbHpphrMAW99qw0bDfxuZagSY5ieE9BBrA=w48-h48-c-k-nd";

    #[test]
    fn screenshot_regression_blue_face_is_an_image() {
        assert_eq!(
            tokenize(BLUE),
            vec![YouTubeTextToken {
                text: BLUE,
                image_url: Some(BLUE_URL)
            }]
        );
    }

    #[test]
    fn preserves_mixed_unicode_text_and_adjacent_repeated_emotes() {
        let text = "Hi 👩🏽‍💻 @vcode_sh :face-blue-smiling::face-blue-smiling:! ❤️";
        let tokens = tokenize(text);
        assert_eq!(tokens.iter().filter(|t| t.image_url.is_some()).count(), 2);
        assert_eq!(tokens.iter().map(|t| t.text).collect::<String>(), text);
        assert_eq!(tokens[0].text, "Hi 👩🏽‍💻 @vcode_sh ");
        assert_eq!(tokens[3].text, "! ❤️");
    }

    #[test]
    fn exact_delimiters_allow_emotes_touching_text_but_not_partial_names() {
        assert_eq!(tokenize("hi:face-blue-smiling:bye").len(), 3);
        for text in [
            "face-blue-smiling",
            ":face-blue-smiling-extra:",
            ":face-blue-smiling",
            "face-blue-smiling:",
            ":FACE-BLUE-SMILING:",
        ] {
            assert!(tokenize(text).is_empty(), "{text}");
        }
    }

    #[test]
    fn unknown_member_aliases_and_html_are_preserved_verbatim() {
        let text = "<_html> :_memberCustom: :unknown::face-blue-smiling: & goodbye";
        let tokens = tokenize(text);
        assert_eq!(tokens.iter().filter(|t| t.image_url.is_some()).count(), 1);
        assert_eq!(tokens.iter().map(|t| t.text).collect::<String>(), text);
        for text in [
            "😀 ❤️ 👩🏽‍💻",
            ":_memberCustom:",
            ":unknown:",
            "Kappa catJAM :smile:",
            "",
        ] {
            assert!(tokenize(text).is_empty());
        }
    }

    #[test]
    fn does_not_rewrite_aliases_inside_urls() {
        for text in [
            "https://example.com/:face-blue-smiling:",
            "www.example.com/:face-blue-smiling:",
        ] {
            assert!(tokenize(text).is_empty(), "{text}");
        }
    }

    #[test]
    fn catalog_has_unique_delimited_aliases_and_only_canonical_youtube_images() {
        assert_eq!(catalog().len(), 122);
        assert_eq!(catalog().len(), CATALOG.lines().count());
        for (&alias, &url) in catalog() {
            assert!(alias.starts_with(':') && alias.ends_with(':'));
            assert!(
                alias[1..alias.len() - 1]
                    .bytes()
                    .all(|c| c.is_ascii_alphanumeric() || c == b'-')
            );
            let asset = url
                .strip_prefix("https://yt3.ggpht.com/")
                .unwrap()
                .strip_suffix("=w48-h48-c-k-nd")
                .unwrap();
            assert!(!asset.is_empty());
            assert!(
                asset
                    .bytes()
                    .all(|c| c.is_ascii_alphanumeric() || c == b'_' || c == b'-')
            );
            assert_eq!(tokenize(alias)[0].image_url, Some(url));
        }
    }
}
