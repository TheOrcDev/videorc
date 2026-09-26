//! The page the system browser shows when a platform sign-in comes back to the
//! backend's loopback callback (`/oauth/callback`). It looks like Videorc
//! (black glass, the orb, chrome text; dark always, like the Preview and Chat
//! windows) and says in one line what happened and what to do next. Everything is inline: the
//! loopback server serves no other assets.

use base64::Engine as _;

use crate::oauth::{OAuthCallbackResult, OAuthCallbackStatus};
use crate::streaming::StreamPlatform;

const TEMPLATE: &str = include_str!("../oauth_page/index.html");
const LOGO_PNG: &[u8] = include_bytes!("../oauth_page/logo.png");

const CHECK_BADGE: &str = "<svg viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" \
     stroke-width=\"2.5\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><path d=\"M5 12.5l4.5 4.5L19 7.5\"/></svg>";
const ALERT_BADGE: &str = "<svg viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" \
     stroke-width=\"2.5\" stroke-linecap=\"round\"><path d=\"M12 6.5v7\"/><path d=\"M12 17.5h.01\"/></svg>";

/// The words for one callback outcome, before escaping.
#[derive(Debug, PartialEq, Eq)]
struct PageCopy {
    doc_title: &'static str,
    title: &'static str,
    lede: String,
    next: &'static str,
    good: bool,
}

fn platform_label(platform: Option<StreamPlatform>) -> Option<&'static str> {
    match platform? {
        StreamPlatform::Youtube => Some("YouTube"),
        StreamPlatform::Twitch => Some("Twitch"),
        StreamPlatform::Kick => Some("Kick"),
        StreamPlatform::X => Some("X"),
        StreamPlatform::Tiktok => Some("TikTok"),
        StreamPlatform::Instagram => Some("Instagram"),
        StreamPlatform::Custom => None,
    }
}

fn page_copy(result: &OAuthCallbackResult) -> PageCopy {
    let platform = platform_label(result.platform);
    match result.status {
        OAuthCallbackStatus::Success => PageCopy {
            doc_title: "Connected · Videorc",
            title: "You're now connected to Videorc",
            lede: match platform {
                Some(name) => format!("Your {name} account is linked and ready to go live."),
                None => "Your account is linked and ready to go live.".to_string(),
            },
            next: "You can close this tab and go back to Videorc.",
            good: true,
        },
        OAuthCallbackStatus::Failed => PageCopy {
            doc_title: "Not connected · Videorc",
            title: "Couldn't connect to Videorc",
            lede: match platform {
                Some(name) => format!("Videorc could not link your {name} account."),
                None => "Videorc could not link your account.".to_string(),
            },
            next: "Go back to Videorc and try again.",
            good: false,
        },
        OAuthCallbackStatus::Expired => PageCopy {
            doc_title: "Sign-in expired · Videorc",
            title: "This sign-in expired",
            lede: "It took too long to finish, so Videorc stopped waiting for it.".to_string(),
            next: "Go back to Videorc and connect again.",
            good: false,
        },
        OAuthCallbackStatus::UnknownState => PageCopy {
            doc_title: "Sign-in not found · Videorc",
            title: "This sign-in is no longer valid",
            lede: "Videorc did not start it, or it has already finished.".to_string(),
            next: "Go back to Videorc and connect again.",
            good: false,
        },
    }
}

/// Renders the callback page. Every value is escaped before it lands in the
/// template, and the template is filled in ONE pass, so provider-supplied text
/// can never be re-read as a placeholder.
pub fn render(result: &OAuthCallbackResult) -> String {
    let copy = page_copy(result);
    // Say WHY a sign-in failed. A bare failure leaves the user with nothing to
    // act on and nothing to report; the backend already knows the reason.
    let detail = if copy.good {
        String::new()
    } else {
        result
            .message
            .as_deref()
            .map(|message| format!("<p class=\"detail\">{}</p>", html_escape_text(message)))
            .unwrap_or_default()
    };
    let logo = base64::engine::general_purpose::STANDARD.encode(LOGO_PNG);

    let mut page = String::with_capacity(TEMPLATE.len() + logo.len() + 512);
    let mut rest = TEMPLATE;
    while let Some(start) = rest.find("{{") {
        page.push_str(&rest[..start]);
        let after = &rest[start + 2..];
        let Some(end) = after.find("}}") else {
            page.push_str(&rest[start..]);
            rest = "";
            break;
        };
        match &after[..end] {
            "TONE" => page.push_str(if copy.good { "good" } else { "bad" }),
            "DOC_TITLE" => page.push_str(&html_escape_text(copy.doc_title)),
            "TITLE" => page.push_str(&html_escape_text(copy.title)),
            "LEDE" => page.push_str(&html_escape_text(&copy.lede)),
            "NEXT" => page.push_str(&html_escape_text(copy.next)),
            "DETAIL" => page.push_str(&detail),
            "BADGE" => page.push_str(if copy.good { CHECK_BADGE } else { ALERT_BADGE }),
            "LOGO" => page.push_str(&logo),
            unknown => {
                page.push_str("{{");
                page.push_str(unknown);
                page.push_str("}}");
            }
        }
        rest = &after[end + 2..];
    }
    page.push_str(rest);
    page
}

/// Escape provider-supplied text before it reaches the callback page. The
/// message can carry an upstream error string, so it is never trusted markup.
pub fn html_escape_text(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&#39;")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn result(
        status: OAuthCallbackStatus,
        platform: Option<StreamPlatform>,
        message: Option<&str>,
    ) -> OAuthCallbackResult {
        let connected = status == OAuthCallbackStatus::Success;
        OAuthCallbackResult {
            platform,
            state: "state".to_string(),
            status,
            code_present: true,
            error: None,
            message: message.map(str::to_string),
            token_stored: connected,
            account_connected: connected,
            retryable: false,
            received_at: "2026-09-26T00:00:00Z".to_string(),
        }
    }

    #[test]
    fn success_says_you_are_connected_and_names_the_platform() {
        let page = render(&result(
            OAuthCallbackStatus::Success,
            Some(StreamPlatform::Kick),
            None,
        ));
        assert!(page.contains("<h1>You&#39;re now connected to Videorc</h1>"));
        assert!(page.contains("Your Kick account is linked and ready to go live."));
        assert!(page.contains("You can close this tab and go back to Videorc."));
        assert!(page.contains("data-tone=\"good\""));
        assert!(page.contains("<title>Connected · Videorc</title>"));
    }

    #[test]
    fn every_placeholder_is_filled_and_the_logo_is_inline() {
        for status in [
            OAuthCallbackStatus::Success,
            OAuthCallbackStatus::Failed,
            OAuthCallbackStatus::Expired,
            OAuthCallbackStatus::UnknownState,
        ] {
            let page = render(&result(status.clone(), None, Some("upstream said no")));
            assert!(!page.contains("{{"), "{status:?} left a placeholder");
            assert!(page.contains("src=\"data:image/png;base64,iVBORw0KGgo"));
            // The loopback server serves nothing else: no external requests.
            assert!(!page.contains("http://") && !page.contains("https://"));
        }
    }

    #[test]
    fn failures_explain_why_with_the_escaped_provider_message() {
        let page = render(&result(
            OAuthCallbackStatus::Failed,
            Some(StreamPlatform::Twitch),
            Some("<script>alert('x')</script> {{LOGO}}"),
        ));
        assert!(page.contains("<h1>Couldn&#39;t connect to Videorc</h1>"));
        assert!(page.contains("Videorc could not link your Twitch account."));
        assert!(page.contains("&lt;script&gt;alert(&#39;x&#39;)&lt;/script&gt;"));
        assert!(!page.contains("<script>"));
        // Provider text is never re-read as a placeholder.
        assert!(page.contains("{{LOGO}}</p>"));
        assert!(page.contains("data-tone=\"bad\""));
        assert!(page.contains("Go back to Videorc and try again."));
    }

    #[test]
    fn success_never_shows_a_failure_detail() {
        let page = render(&result(
            OAuthCallbackStatus::Success,
            None,
            Some("stale message"),
        ));
        assert!(!page.contains("stale message"));
        assert!(page.contains("Your account is linked and ready to go live."));
    }

    #[test]
    fn expired_and_unknown_state_ask_to_connect_again() {
        let expired = render(&result(OAuthCallbackStatus::Expired, None, None));
        assert!(expired.contains("<h1>This sign-in expired</h1>"));
        let unknown = render(&result(OAuthCallbackStatus::UnknownState, None, None));
        assert!(unknown.contains("<h1>This sign-in is no longer valid</h1>"));
        for page in [expired, unknown] {
            assert!(page.contains("Go back to Videorc and connect again."));
            assert!(!page.contains("class=\"detail\""));
        }
    }

    #[test]
    fn escapes_provider_supplied_failure_text() {
        let escaped = html_escape_text("<script>alert('x')</script> & \"quoted\"");
        assert!(!escaped.contains('<'));
        assert!(!escaped.contains('>'));
        assert!(escaped.contains("&lt;script&gt;"));
        assert!(escaped.contains("&amp;"));
        assert!(escaped.contains("&quot;"));
        assert!(escaped.contains("&#39;"));
    }
}
