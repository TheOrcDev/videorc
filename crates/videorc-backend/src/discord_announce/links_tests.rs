use super::*;
use crate::protocol::AccountStatus;

fn account(
    platform: StreamPlatform,
    id: &str,
    label: &str,
    handle: Option<&str>,
) -> PlatformAccount {
    PlatformAccount {
        id: format!("acct-{id}"),
        platform,
        account_id: id.to_string(),
        account_label: label.to_string(),
        account_handle: handle.map(str::to_string),
        avatar_url: Some(format!("https://cdn.example/{id}.png")),
        scopes: Vec::new(),
        access_token_present: true,
        refresh_token_present: true,
        stream_key_present: false,
        expires_at: None,
        connected_at: "2026-10-01T00:00:00Z".to_string(),
        updated_at: "2026-10-01T00:00:00Z".to_string(),
        status: PlatformAccountStatus::Connected,
    }
}

fn target(id: &str, platform: StreamPlatform, auth_mode: StreamAuthMode) -> LinkTarget {
    LinkTarget {
        id: id.to_string(),
        platform,
        label: format!("{id} label"),
        auth_mode,
        account_id: None,
        output_orientation: None,
        platform_broadcast_id: None,
    }
}

fn accounts() -> Vec<PlatformAccount> {
    vec![
        account(StreamPlatform::Twitch, "t1", "OrcDev", Some("@OrcDev")),
        account(
            StreamPlatform::Youtube,
            "UC123",
            "Orc Dev TV",
            Some("@orcdevtv"),
        ),
        account(StreamPlatform::Kick, "k1", "orcdev", Some("orcdev")),
        account(StreamPlatform::X, "x1", "Orc", Some("@orcdev")),
    ]
}

#[test]
fn builds_links_from_connected_accounts() {
    use StreamAuthMode::{ManualRtmp, Oauth};
    let targets = vec![
        target("tw", StreamPlatform::Twitch, Oauth),
        target("yt-key", StreamPlatform::Youtube, ManualRtmp),
        target("kick", StreamPlatform::Kick, ManualRtmp),
        target("yt", StreamPlatform::Youtube, Oauth),
        target("x", StreamPlatform::X, Oauth),
        target("tiktok", StreamPlatform::Tiktok, ManualRtmp),
        target("custom", StreamPlatform::Custom, ManualRtmp),
    ];
    let rows = preview(&targets, &accounts(), &[], &BTreeMap::new());
    let kinds: Vec<(LinkKind, Option<&str>)> = rows
        .iter()
        .map(|row| (row.link_kind, row.link.as_deref()))
        .collect();
    assert_eq!(
        kinds,
        vec![
            (LinkKind::Auto, Some("https://www.twitch.tv/orcdev")),
            (
                LinkKind::Auto,
                Some("https://www.youtube.com/@orcdevtv/live")
            ),
            (LinkKind::Auto, Some("https://kick.com/orcdev")),
            (LinkKind::AtGoLive, None),
            (LinkKind::AtGoLive, None),
            (LinkKind::None, None),
            (LinkKind::None, None),
        ]
    );
    let included: Vec<bool> = rows.iter().map(|row| row.included).collect();
    assert_eq!(included, vec![true, true, true, true, true, false, false]);
}

#[test]
fn a_prepared_youtube_broadcast_links_its_watch_page() {
    let mut yt = target("yt", StreamPlatform::Youtube, StreamAuthMode::Oauth);
    yt.platform_broadcast_id = Some("dQw4w9WgXcQ".to_string());
    let rows = preview(&[yt], &[], &[], &BTreeMap::new());
    assert_eq!(
        rows[0].link.as_deref(),
        Some("https://www.youtube.com/watch?v=dQw4w9WgXcQ")
    );
}

#[test]
fn typed_links_win_and_exclusions_untick() {
    let targets = vec![
        target("tw", StreamPlatform::Twitch, StreamAuthMode::ManualRtmp),
        target("tiktok", StreamPlatform::Tiktok, StreamAuthMode::ManualRtmp),
    ];
    let overrides = BTreeMap::from([(
        "tiktok".to_string(),
        "https://www.tiktok.com/@orcdev/live".to_string(),
    )]);
    let rows = preview(&targets, &[], &["tw".to_string()], &overrides);
    assert_eq!(rows[0].link_kind, LinkKind::None);
    assert!(!rows[0].included);
    assert_eq!(rows[1].link_kind, LinkKind::Typed);
    assert!(rows[1].included);
}

#[test]
fn leg_plans_keep_ticked_linkable_legs_in_order() {
    use StreamAuthMode::{ManualRtmp, Oauth};
    let mut vertical = target("yt-v", StreamPlatform::Youtube, Oauth);
    vertical.output_orientation = Some(StreamOutputOrientation::Vertical);
    vertical.platform_broadcast_id = Some("V1".to_string());
    let targets = vec![
        target("custom", StreamPlatform::Custom, ManualRtmp),
        target("tw", StreamPlatform::Twitch, Oauth),
        vertical,
        target("x", StreamPlatform::X, Oauth),
        target("kick", StreamPlatform::Kick, ManualRtmp),
    ];
    let plans = leg_plans(
        &targets,
        &accounts(),
        &["kick".to_string()],
        &BTreeMap::new(),
        StreamPrivacy::Unlisted,
    );
    let ids: Vec<&str> = plans.iter().map(|plan| plan.target_id.as_str()).collect();
    assert_eq!(
        ids,
        vec!["tw", "yt-v", "x"],
        "no-link custom and unticked kick drop"
    );
    assert_eq!(plans[1].label, "YouTube · Vertical");
    assert_eq!(
        plans[1].confirm,
        Confirm::YouTube {
            broadcast_id: Some("V1".to_string())
        }
    );
    assert_eq!(plans[1].draft_privacy, Some(StreamPrivacy::Unlisted));
    assert_eq!(plans[2].confirm, Confirm::X);
    assert_eq!(plans[0].confirm, Confirm::Dwell);
    assert_eq!(plans[0].draft_privacy, None);
}

#[test]
fn only_platforms_with_both_orientations_say_vertical() {
    let mut tiktok = target("t", StreamPlatform::Tiktok, StreamAuthMode::ManualRtmp);
    tiktok.output_orientation = Some(StreamOutputOrientation::Vertical);
    assert_eq!(button_label(&tiktok), "TikTok");
    let mut youtube = target("y", StreamPlatform::Youtube, StreamAuthMode::Oauth);
    youtube.output_orientation = Some(StreamOutputOrientation::Vertical);
    assert_eq!(button_label(&youtube), "YouTube · Vertical");
}

#[test]
fn custom_destinations_use_their_own_name() {
    let mut custom = target("c", StreamPlatform::Custom, StreamAuthMode::ManualRtmp);
    custom.label = "My site".to_string();
    assert_eq!(button_label(&custom), "My site");
    custom.label = "  ".to_string();
    assert_eq!(button_label(&custom), "Watch");
}

#[test]
fn typed_links_must_be_https_urls() {
    assert_eq!(
        validate_typed_link(" https://www.tiktok.com/@orcdev/live "),
        Ok("https://www.tiktok.com/@orcdev/live".to_string())
    );
    for bad in [
        "http://twitch.tv/x",
        "twitch.tv/x",
        "javascript:alert(1)",
        "https://user:pass@example.com/",
        "",
    ] {
        assert!(validate_typed_link(bad).is_err(), "{bad}");
    }
    assert!(validate_typed_link(&format!("https://a.com/{}", "x".repeat(600))).is_err());
}

#[test]
fn automatic_sender_is_the_first_ticked_destinations_account() {
    let accounts = accounts();
    let twitch = target("tw", StreamPlatform::Twitch, StreamAuthMode::Oauth);
    let sender = resolve_sender(&PostAs::Automatic, Some(&twitch), &accounts, None).unwrap();
    assert_eq!(sender.name, "OrcDev");
    assert_eq!(
        sender.avatar_url.as_deref(),
        Some("https://cdn.example/t1.png")
    );
}

#[test]
fn automatic_sender_falls_back_to_videorc_then_the_webhook() {
    let videorc = VideorcAccountSnapshot {
        status: AccountStatus::SignedIn,
        username: Some("orc@example.com".to_string()),
        display_name: Some("Orc Dev".to_string()),
        email: Some("orc@example.com".to_string()),
        avatar_url: None,
    };
    let custom = target("c", StreamPlatform::Custom, StreamAuthMode::ManualRtmp);
    assert_eq!(
        resolve_sender(&PostAs::Automatic, Some(&custom), &[], Some(&videorc))
            .unwrap()
            .name,
        "Orc Dev"
    );
    assert_eq!(
        resolve_sender(&PostAs::Automatic, Some(&custom), &[], None),
        None
    );
    assert_eq!(
        resolve_sender(&PostAs::Webhook, Some(&custom), &accounts(), Some(&videorc)),
        None
    );
}

#[test]
fn a_picked_account_wins_and_a_missing_one_falls_back() {
    let accounts = accounts();
    let twitch = target("tw", StreamPlatform::Twitch, StreamAuthMode::Oauth);
    let picked = PostAs::Platform {
        account_id: "acct-UC123".to_string(),
    };
    assert_eq!(
        resolve_sender(&picked, Some(&twitch), &accounts, None)
            .unwrap()
            .name,
        "Orc Dev TV"
    );
    let gone = PostAs::Platform {
        account_id: "acct-gone".to_string(),
    };
    assert_eq!(
        resolve_sender(&gone, Some(&twitch), &accounts, None)
            .unwrap()
            .name,
        "OrcDev"
    );
}

#[test]
fn identities_list_connected_accounts_then_videorc() {
    let mut list = accounts();
    list[3].status = PlatformAccountStatus::Disconnected;
    let videorc = VideorcAccountSnapshot {
        status: AccountStatus::SignedIn,
        username: Some("orc".to_string()),
        display_name: None,
        email: None,
        avatar_url: None,
    };
    let names: Vec<String> = identities(&list, Some(&videorc))
        .into_iter()
        .map(|identity| identity.name)
        .collect();
    assert_eq!(names, vec!["OrcDev", "Orc Dev TV", "orcdev", "orc"]);
}

#[test]
fn post_as_round_trips_on_the_wire() {
    let picked = PostAs::Platform {
        account_id: "acct-1".to_string(),
    };
    let json = serde_json::to_value(&picked).unwrap();
    assert_eq!(
        json,
        serde_json::json!({ "kind": "platform", "accountId": "acct-1" })
    );
    assert_eq!(serde_json::from_value::<PostAs>(json).unwrap(), picked);
    assert_eq!(
        serde_json::to_value(PostAs::Automatic).unwrap(),
        serde_json::json!({ "kind": "automatic" })
    );
}
