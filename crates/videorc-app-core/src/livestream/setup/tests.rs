use serde_json::{Value, json};

use super::*;
use crate::livestream::accounts::{
    AccountStatus, AccountValidation, ProviderCredentials, ValidationState,
};

fn config() -> Value {
    crate::studio::capture_config::default_capture_config("2026-11-11T00:00:00.000Z")
}

fn input<'a>(capture: &'a Value, platforms: &'a PlatformsState) -> SetupInput<'a> {
    SetupInput {
        capture,
        platforms,
        runtimes: &[],
        entitlements: None,
        session_active: false,
        go_live_pending: false,
        development: false,
    }
}

fn card<'a>(view: &'a SetupView, id: &str) -> &'a DestinationView {
    view.destinations.iter().find(|d| d.id == id).unwrap()
}

#[test]
fn the_rows_say_how_each_destination_connects() {
    let capture = config();
    let platforms = PlatformsState::default();
    let view = setup_view(&input(&capture, &platforms), &PageMemory::default());
    assert_eq!(view.destinations.len(), 9);
    assert_eq!(
        view.destinations_description,
        "Where the stream goes. Stream to up to 5 at once. Open a destination for its account or key."
    );
    let youtube = card(&view, "youtube");
    assert_eq!(youtube.label, "YouTube");
    assert_eq!(youtube.context, "Stream key");
    assert_eq!(youtube.switch_label, "Enable YouTube");
    assert!(youtube.badge.is_none());
    assert!(!youtube.expanded);
    let vertical = card(&view, "youtube-vertical");
    assert_eq!(vertical.context, "9:16 · Stream key");
    let custom = card(&view, "custom");
    assert_eq!(custom.label, "Custom RTMP");
    assert_eq!(custom.url_mode, Some(0));
    assert!(custom.auth_mode.is_none());
    assert_eq!(
        card(&view, "tiktok").key_only_line.as_deref(),
        Some("TikTok uses a stream key.")
    );
    assert_eq!(
        card(&view, "facebook").key_only_line.as_deref(),
        Some("Signing in with Facebook isn't available yet. Use a stream key.")
    );
    assert_eq!(
        card(&view, "x").auth_mode,
        Some((
            vec![
                "Sign in · Chat works".to_string(),
                "Stream key · No chat".to_string()
            ],
            1
        ))
    );
    assert_eq!(view.quality.options.len(), 2);
}

#[test]
fn the_first_destination_that_needs_setup_opens_on_its_own() {
    let mut capture = config();
    for index in [1, 2] {
        capture["streaming"]["targets"][index]["enabled"] = json!(true);
    }
    let platforms = PlatformsState::default();
    let mut memory = PageMemory::default();
    let view = setup_view(&input(&capture, &platforms), &memory);
    let twitch = card(&view, "twitch");
    assert!(twitch.expanded);
    assert_eq!(
        twitch.badge,
        Some((Tone::Warning, "Needs setup".to_string()))
    );
    assert!(!card(&view, "kick").expanded);
    memory.expanded.insert("twitch".into(), false);
    let view = setup_view(&input(&capture, &platforms), &memory);
    assert!(!card(&view, "twitch").expanded);
    let manual = card(&view, "twitch").manual.as_ref().unwrap();
    assert_eq!(manual.server_label, "Server URL");
    assert_eq!(manual.key_placeholder, "Paste your stream key");
    assert!(!manual.save_key);
}

#[test]
fn a_saved_key_offers_clear_and_names_its_tail() {
    let mut capture = config();
    let twitch = &mut capture["streaming"]["targets"][1];
    twitch["streamKeyPresent"] = json!(true);
    twitch["streamKeyHint"] = json!("••••abcd");
    twitch["previousStreamKeyPresent"] = json!(true);
    twitch["previousStreamKeyHint"] = json!("••••wxyz");
    let platforms = PlatformsState::default();
    let mut memory = PageMemory::default();
    memory
        .key_drafts
        .insert("twitch".into(), "live_1_new".into());
    let view = setup_view(&input(&capture, &platforms), &memory);
    let manual = card(&view, "twitch").manual.clone().unwrap();
    assert!(manual.save_key && manual.clear_key);
    assert_eq!(
        manual.key_description.as_deref(),
        Some("Saved securely · ends ••••abcd")
    );
    assert_eq!(
        manual.restore.as_deref(),
        Some("Restore previous stream key (ends ••••wxyz)")
    );
    let target = targets::targets(&capture)
        .into_iter()
        .find(|t| t.id == "twitch")
        .unwrap();
    let question = request_key_save(&target, "live_1_newkey", false)
        .unwrap()
        .unwrap();
    let words = question_view(&question, &targets::targets(&capture)).unwrap();
    assert_eq!(words.title, "Replace the Twitch stream key?");
    assert_eq!(
        words.description,
        "The saved stream key ending ••••abcd will be replaced by the new one ending ••••wkey. The old one is kept as your previous stream key, so you can restore it."
    );
    assert_eq!(words.confirm, "Replace stream key");
    assert!(!words.destructive);
}

#[test]
fn a_key_that_looks_like_another_platforms_asks_first() {
    let capture = config();
    let list = targets::targets(&capture);
    let youtube = list.iter().find(|t| t.id == "youtube").unwrap();
    let question = request_key_save(youtube, "live_123_abcdef", false)
        .unwrap()
        .unwrap();
    let words = question_view(&question, &list).unwrap();
    assert_eq!(words.title, "Save this stream key to YouTube?");
    assert!(words.destructive);
    assert_eq!(
        words.warning.as_deref(),
        Some("This looks like a Twitch stream key, but you're saving it to YouTube.")
    );
    // A plain key with nothing saved saves at once.
    assert_eq!(request_key_save(youtube, "abcdef123", false), Ok(None));
    assert_eq!(request_key_save(youtube, "   ", false), Err(None));
    let custom = list.iter().find(|t| t.id == "custom").unwrap();
    assert_eq!(
        request_key_save(custom, "https://x/app/key", true),
        Err(Some(
            "Full URLs start with rtmp:// or rtmps://.".to_string()
        ))
    );
}

#[test]
fn signing_in_shows_connect_then_the_account() {
    let mut capture = config();
    capture["streaming"]["targets"][1]["authMode"] = json!("oauth");
    let mut platforms = PlatformsState {
        credentials: vec![ProviderCredentials {
            platform: "twitch".into(),
            ready: true,
            client_id_source: "environment".into(),
            message: String::new(),
        }],
        ..PlatformsState::default()
    };
    let mut setup = input(&capture, &platforms);
    setup.development = true;
    let view = setup_view(&setup, &PageMemory::default());
    let twitch = card(&view, "twitch");
    assert!(twitch.manual.is_none());
    assert!(twitch.guidance.is_none());
    match twitch.oauth.as_ref().unwrap() {
        OAuthView::SignIn {
            connect_label,
            connect_enabled,
            environment_override,
            pending,
        } => {
            assert_eq!(connect_label, "Connect Twitch");
            assert!(*connect_enabled && *environment_override);
            assert!(pending.is_none());
        }
        other => panic!("{other:?}"),
    }
    // The wait shows until the account comes back changed.
    let mut memory = PageMemory::default();
    memory.sign_in.insert(
        "twitch".into(),
        SignInWait {
            from: account_version(None),
            url: Some("https://id.twitch.tv/x".into()),
            copied: false,
        },
    );
    let view = setup_view(&input(&capture, &platforms), &memory);
    match card(&view, "twitch").oauth.as_ref().unwrap() {
        OAuthView::SignIn { pending, .. } => {
            let pending = pending.clone().unwrap();
            assert!(pending.has_url);
            assert_eq!(
                pending.other_browser,
                "Signed in to Twitch in another browser? Copy the link and open it there."
            );
        }
        other => panic!("{other:?}"),
    }
    platforms.accounts = vec![PlatformAccount {
        platform: "twitch".into(),
        account_id: "42".into(),
        account_label: "Orc Dev".into(),
        account_handle: Some("orcdev".into()),
        scopes: accounts::twitch_optional_scopes()
            .into_iter()
            .map(str::to_string)
            .collect(),
        ..PlatformAccount::default()
    }];
    platforms.validations = vec![AccountValidation {
        platform: "twitch".into(),
        state: ValidationState::Valid,
        message: "Account access is valid.".into(),
    }];
    let view = setup_view(&input(&capture, &platforms), &memory);
    let twitch = card(&view, "twitch");
    assert_eq!(twitch.context, "Orc Dev");
    match twitch.oauth.as_ref().unwrap() {
        OAuthView::Account(account) => {
            assert!(account.ok && !account.reconnect && account.can_disconnect);
            assert_eq!(account.initials, "OD");
            assert_eq!(account.handle, "orcdev");
            assert!(account.pending.is_none(), "a changed account ends the wait");
            assert!(account.permissions.is_none());
        }
        other => panic!("{other:?}"),
    }
    platforms.accounts[0].status = AccountStatus::NeedsReconnect;
    let view = setup_view(&input(&capture, &platforms), &memory);
    match card(&view, "twitch").oauth.as_ref().unwrap() {
        OAuthView::Account(account) => assert!(account.reconnect),
        other => panic!("{other:?}"),
    }
}

#[test]
fn a_running_session_locks_setup_and_names_its_problems() {
    let capture = config();
    let platforms = PlatformsState::default();
    let runtimes = vec![
        Runtime {
            target_id: "twitch".into(),
            label: "Twitch".into(),
            state: "live".into(),
            ..Runtime::default()
        },
        Runtime {
            target_id: "kick".into(),
            label: "Kick".into(),
            state: "failed".into(),
            ..Runtime::default()
        },
    ];
    let mut setup = input(&capture, &platforms);
    setup.session_active = true;
    setup.runtimes = &runtimes;
    let mut memory = PageMemory::default();
    let view = setup_view(&setup, &memory);
    assert!(view.controls_disabled);
    assert_eq!(
        view.notices.session_lock.as_deref(),
        Some(
            "Destinations, stream quality, Videorc Cloud and stream details are locked while you're recording or live. Changes apply the next time you record or go live."
        )
    );
    let banner = view.notices.failure.clone().unwrap();
    assert_eq!(banner.key, "kick:failed");
    assert_eq!(banner.lines.len(), 1);
    assert!(banner.lines[0].ends_with("Kick. The other destination keeps streaming."));
    assert_eq!(card(&view, "twitch").badge.as_ref().unwrap().0, Tone::Live);
    assert!(!card(&view, "twitch").switch_enabled);
    memory.dismissed_problems = Some(banner.key);
    assert!(setup_view(&setup, &memory).notices.failure.is_none());
}

fn manual<'a>(view: &'a SetupView, id: &str) -> &'a ManualView {
    card(view, id).manual.as_ref().unwrap()
}

#[test]
fn a_saved_bad_server_url_says_so_at_once_and_while_typing() {
    let mut capture = config();
    capture["streaming"]["targets"][8]["serverUrl"] = json!("http://example/app");
    let platforms = PlatformsState::default();
    let mut memory = PageMemory::default();
    memory.page_opened(&capture);
    let issue = |capture: &Value, memory: &PageMemory| {
        manual(&setup_view(&input(capture, &platforms), memory), "custom")
            .server_issue
            .clone()
    };
    assert!(issue(&capture, &memory).is_some(), "saved bad: at once");
    capture["streaming"]["targets"][8]["serverUrl"] = json!("http://example/ap");
    let custom = targets::targets(&capture)
        .into_iter()
        .find(|t| t.id == "custom")
        .unwrap();
    memory.server_edited(&custom, "http://example/ap");
    assert!(
        issue(&capture, &memory).is_some(),
        "still checked while typing"
    );

    // A good saved URL: a typed bad one waits for the field to be left.
    capture["streaming"]["targets"][8]["serverUrl"] = json!("rtmp://example/app");
    let mut memory = PageMemory::default();
    memory.page_opened(&capture);
    capture["streaming"]["targets"][8]["serverUrl"] = json!("http://example/app");
    assert_eq!(
        issue(&capture, &memory),
        None,
        "typing starts without an error"
    );
    let custom = targets::targets(&capture)
        .into_iter()
        .find(|t| t.id == "custom")
        .unwrap();
    memory.server_left(&custom);
    assert!(
        issue(&capture, &memory).is_some(),
        "left once: from then on"
    );
}

#[test]
fn a_full_url_field_starts_from_the_saved_url_and_empties_once_stored() {
    let mut capture = config();
    capture["streaming"]["targets"][8]["urlMode"] = json!("full-url");
    capture["streaming"]["targets"][8]["serverUrl"] = json!("rtmp://example/app");
    let platforms = PlatformsState::default();
    let mut memory = PageMemory::default();
    memory.page_opened(&capture);
    let field = |capture: &Value, memory: &PageMemory| {
        let view = setup_view(&input(capture, &platforms), memory);
        let manual = manual(&view, "custom");
        (manual.server_value.clone(), manual.save_url)
    };
    assert_eq!(
        field(&capture, &memory),
        ("rtmp://example/app".to_string(), true),
        "`useState(target.serverUrl)`, and Save URL for a non-empty draft"
    );
    let custom = targets::targets(&capture)
        .into_iter()
        .find(|t| t.id == "custom")
        .unwrap();
    memory.server_edited(&custom, "rtmp://example/app/key");
    assert_eq!(
        field(&capture, &memory),
        ("rtmp://example/app/key".to_string(), true)
    );
    memory.full_url_saved(&custom);
    assert_eq!(field(&capture, &memory), (String::new(), false));
    capture["streaming"]["targets"][8]["serverUrl"] = json!("rtmp://other/app");
    assert_eq!(
        field(&capture, &memory),
        ("rtmp://other/app".to_string(), true),
        "a new saved URL starts the field again"
    );
}

#[test]
fn the_cloud_feed_is_no_destination_on_air() {
    let capture = config();
    let platforms = PlatformsState::default();
    let runtimes = vec![
        Runtime {
            target_id: "videorc-cloud-main".into(),
            label: "Videorc Cloud".into(),
            state: "live".into(),
            ..Runtime::default()
        },
        Runtime {
            target_id: "kick".into(),
            label: "Kick".into(),
            state: "failed".into(),
            ..Runtime::default()
        },
    ];
    let mut setup = input(&capture, &platforms);
    setup.session_active = true;
    setup.runtimes = &runtimes;
    let banner = setup_view(&setup, &PageMemory::default())
        .notices
        .failure
        .unwrap();
    assert_eq!(
        banner.lines,
        ["Failed: Kick. No other destination is streaming, so viewers see nothing."]
    );
}

#[test]
fn the_questions_name_what_is_lost() {
    let capture = config();
    let list = targets::targets(&capture);
    let words = question_view(
        &Question::Disconnect {
            platform: "youtube".into(),
        },
        &list,
    )
    .unwrap();
    assert_eq!(words.title, "Disconnect YouTube?");
    assert_eq!(
        words.description,
        "Videorc signs out of YouTube and YouTube Vertical. To stream there again, connect the account again."
    );
    let words = question_view(
        &Question::RemoveKey {
            target_id: "kick".into(),
        },
        &list,
    )
    .unwrap();
    assert_eq!(words.title, "Remove the Kick stream key?");
    assert_eq!(words.confirm, "Remove stream key");
}

#[test]
fn initials_fall_back_like_the_avatar() {
    assert_eq!(initials("Orc Dev"), "OD");
    assert_eq!(initials("orc"), "OR");
    assert_eq!(initials("The Orc Dev"), "TD");
    assert_eq!(initials(""), "");
}

#[test]
fn cancelling_a_scheduled_stream_asks_as_upcoming_asks() {
    use crate::livestream::scheduled::Event;
    let x = Event {
        provider: Some("x".into()),
        provider_event_id: Some("1ynKO".into()),
        ..Event::default()
    };
    let view = question_view(
        &Question::CancelScheduled {
            event: Box::new(x.clone()),
        },
        &[],
    )
    .unwrap();
    assert_eq!(view.title, "Cancel this X broadcast?");
    assert_eq!(
        view.description,
        "The upcoming broadcast will be deleted from X and its link will stop working."
    );
    assert_eq!(view.confirm, "Cancel event");
    assert_eq!(view.cancel.as_deref(), Some("Keep event"));
    assert!(view.destructive);

    let draft = Event {
        provider_event_id: None,
        ..x
    };
    let view = question_view(
        &Question::CancelScheduled {
            event: Box::new(draft),
        },
        &[],
    )
    .unwrap();
    assert_eq!(view.title, "Move draft to Past?");
    assert_eq!(
        view.description,
        "The draft moves to Past. Nothing on X is deleted."
    );
    assert_eq!(view.confirm, "Move to Past");
    assert_eq!(view.cancel.as_deref(), Some("Keep draft"));
    assert!(view.destructive);
}
