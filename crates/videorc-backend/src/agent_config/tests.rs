use std::sync::{Arc, Mutex};

use super::*;
use crate::test_temp_dir::TestTempDir;

const MAC: &str = "/Applications/Videorc.app/Contents/Resources/videorc-mcp";
const WINDOWS_BRIDGE: &str =
    "C:\\Users\\Ana Lee\\AppData\\Local\\Programs\\Videorc\\resources\\videorc-mcp.exe";

fn token() -> String {
    format!("vrc_agent_{}", "ab12".repeat(16))
}

fn now() -> DateTime<Utc> {
    "2026-10-27T22:15:30.123Z".parse().unwrap()
}

fn at(stamp: &str) -> DateTime<Utc> {
    stamp.parse().unwrap()
}

fn entry() -> Json {
    agent_json_server_entry(AgentAddApp::Cursor, MAC, &token())
}

fn no_log(_: &str) {}

fn write_deps<'a>(now: DateTime<Utc>, log: &'a dyn Fn(&str)) -> WriteDeps<'a> {
    WriteDeps {
        now,
        rename: &real_rename,
        log,
    }
}

/// The real path: macOS's temp folder is behind a symlink, and the install
/// reports the file it wrote.
fn root(name: &str) -> (TestTempDir, PathBuf) {
    let dir = TestTempDir::new(name);
    let real = fs::canonicalize(&*dir).unwrap();
    (dir, real)
}

fn folder(root: &Path, parts: &[&str]) -> PathBuf {
    let path = parts
        .iter()
        .fold(root.to_path_buf(), |path, part| path.join(part));
    fs::create_dir_all(&path).unwrap();
    path
}

fn target(app: AgentAddApp, file: &Path) -> AgentConfigTarget {
    AgentConfigTarget {
        app,
        file: file.to_string_lossy().into_owned(),
        format: if app == AgentAddApp::Codex {
            ConfigFormat::Toml
        } else {
            ConfigFormat::Json
        },
    }
}

fn backups(dir: &Path) -> Vec<String> {
    let mut names: Vec<String> = fs::read_dir(dir)
        .unwrap()
        .filter_map(|entry| entry.unwrap().file_name().to_str().map(str::to_string))
        .filter(|name| name.contains(".videorc-backup-"))
        .collect();
    names.sort();
    names
}

fn parse(text: &str) -> serde_json::Value {
    serde_json::from_str(text).unwrap()
}

fn environment(platform: Platform, home: &str) -> AgentEnvironment {
    AgentEnvironment {
        platform,
        home_dir: home.to_string(),
        app_data: None,
        local_app_data: None,
        xdg_config_home: None,
        codex_home: None,
        path_variable: None,
    }
}

fn file_of(app: AgentAddApp, environment: &AgentEnvironment) -> String {
    agent_config_target(app, environment).unwrap().file
}

#[cfg(unix)]
fn mode_of(path: &Path) -> u32 {
    file_mode(path).unwrap()
}

#[test]
fn agent_config_entry_fixture_pins_the_entry_and_its_lines() {
    let fixture: serde_json::Value = serde_json::from_str(include_str!(
        "../../../../protocol-fixtures/agent-config-entry.json"
    ))
    .unwrap();
    let bridge = fixture["connection"]["bridgePath"].as_str().unwrap();
    let token = fixture["connection"]["token"].as_str().unwrap();
    for (name, app) in [
        ("claude-desktop", AgentAddApp::ClaudeDesktop),
        ("cursor", AgentAddApp::Cursor),
        ("vs-code", AgentAddApp::VsCode),
    ] {
        let expected = &fixture["json"][name];
        assert_eq!(agent_json_root_key(app), expected["rootKey"], "{name}");
        let entry = agent_json_server_entry(app, bridge, token);
        assert_eq!(parse(&entry.pretty("  ")), expected["entry"], "{name}");
    }
    let fixture_strings = |key: &str| -> Vec<String> {
        fixture[key]
            .as_array()
            .unwrap()
            .iter()
            .map(|line| line.as_str().unwrap().to_string())
            .collect()
    };
    assert_eq!(
        agent_codex_toml_lines(bridge, token),
        fixture_strings("codexTomlLines")
    );
    assert_eq!(
        agent_claude_code_add_args(bridge, token),
        fixture_strings("claudeCodeAddArgs")
    );
}

#[test]
fn the_vs_code_entry_keeps_type_first() {
    let entry = agent_json_server_entry(AgentAddApp::VsCode, MAC, &token());
    let Json::Object(entries) = entry else {
        panic!("an object");
    };
    let keys: Vec<&str> = entries.iter().map(|(key, _)| key.as_str()).collect();
    assert_eq!(keys, ["type", "command", "args", "env"]);
}

#[test]
fn where_each_app_keeps_its_servers_on_macos() {
    let mac = environment(Platform::Mac, "/Users/ana");
    assert_eq!(
        file_of(AgentAddApp::ClaudeDesktop, &mac),
        "/Users/ana/Library/Application Support/Claude/claude_desktop_config.json"
    );
    assert_eq!(
        file_of(AgentAddApp::Cursor, &mac),
        "/Users/ana/.cursor/mcp.json"
    );
    assert_eq!(
        file_of(AgentAddApp::VsCode, &mac),
        "/Users/ana/Library/Application Support/Code/User/mcp.json"
    );
    assert_eq!(
        agent_config_target(AgentAddApp::Codex, &mac),
        Some(AgentConfigTarget {
            app: AgentAddApp::Codex,
            format: ConfigFormat::Toml,
            file: "/Users/ana/.codex/config.toml".to_string(),
        })
    );
    assert_eq!(agent_config_target(AgentAddApp::ClaudeCode, &mac), None);
}

#[test]
fn where_each_app_keeps_its_servers_on_windows() {
    let mut windows = environment(Platform::Windows, "C:\\Users\\Ana Lee");
    windows.app_data = Some("D:\\Roaming".to_string());
    assert_eq!(
        file_of(AgentAddApp::ClaudeDesktop, &windows),
        "D:\\Roaming\\Claude\\claude_desktop_config.json"
    );
    assert_eq!(
        file_of(AgentAddApp::VsCode, &windows),
        "D:\\Roaming\\Code\\User\\mcp.json"
    );
    assert_eq!(
        file_of(AgentAddApp::Cursor, &windows),
        "C:\\Users\\Ana Lee\\.cursor\\mcp.json"
    );
    assert_eq!(
        file_of(AgentAddApp::Codex, &windows),
        "C:\\Users\\Ana Lee\\.codex\\config.toml"
    );
    assert_eq!(
        file_of(
            AgentAddApp::ClaudeDesktop,
            &environment(Platform::Windows, "C:\\Users\\Ana Lee")
        ),
        "C:\\Users\\Ana Lee\\AppData\\Roaming\\Claude\\claude_desktop_config.json"
    );
}

#[test]
fn where_each_app_keeps_its_servers_on_linux() {
    let linux = environment(Platform::Linux, "/home/ana");
    assert_eq!(
        file_of(AgentAddApp::ClaudeDesktop, &linux),
        "/home/ana/.config/Claude/claude_desktop_config.json"
    );
    assert_eq!(
        file_of(AgentAddApp::VsCode, &linux),
        "/home/ana/.config/Code/User/mcp.json"
    );
    let mut custom = linux.clone();
    custom.xdg_config_home = Some("/xdg".to_string());
    custom.codex_home = Some("/opt/codex".to_string());
    assert_eq!(
        file_of(AgentAddApp::VsCode, &custom),
        "/xdg/Code/User/mcp.json"
    );
    assert_eq!(
        file_of(AgentAddApp::Codex, &custom),
        "/opt/codex/config.toml"
    );
}

#[test]
fn claude_desktop_from_the_microsoft_store_reads_its_package_folder() {
    let mut windows = environment(Platform::Windows, "C:\\Users\\Ana Lee");
    windows.app_data = Some("C:\\Users\\Ana Lee\\AppData\\Roaming".to_string());
    windows.local_app_data = Some("C:\\Users\\Ana Lee\\AppData\\Local".to_string());
    let packages = |path: &str| -> io::Result<Vec<String>> {
        assert_eq!(path, "C:\\Users\\Ana Lee\\AppData\\Local\\Packages");
        Ok(vec![
            "Microsoft.WindowsTerminal_8wekyb3d8bbwe".to_string(),
            "Claude_zz".to_string(),
            "Claude_pzs8sxrjxfjjc".to_string(),
        ])
    };
    assert_eq!(
        resolve_agent_config_target(AgentAddApp::ClaudeDesktop, &windows, &packages)
            .unwrap()
            .file,
        "C:\\Users\\Ana Lee\\AppData\\Local\\Packages\\Claude_pzs8sxrjxfjjc\\LocalCache\\Roaming\\Claude\\claude_desktop_config.json"
    );
    let installer = "C:\\Users\\Ana Lee\\AppData\\Roaming\\Claude\\claude_desktop_config.json";
    let none = |_: &str| -> io::Result<Vec<String>> {
        Ok(vec!["Microsoft.WindowsTerminal_8wekyb3d8bbwe".to_string()])
    };
    assert_eq!(
        resolve_agent_config_target(AgentAddApp::ClaudeDesktop, &windows, &none)
            .unwrap()
            .file,
        installer
    );
    let missing =
        |_: &str| -> io::Result<Vec<String>> { Err(io::Error::from(ErrorKind::NotFound)) };
    assert_eq!(
        resolve_agent_config_target(AgentAddApp::ClaudeDesktop, &windows, &missing)
            .unwrap()
            .file,
        installer
    );
    // Other apps, and other platforms, never look.
    let unused = |_: &str| -> io::Result<Vec<String>> { panic!("read the Packages folder") };
    resolve_agent_config_target(AgentAddApp::VsCode, &windows, &unused);
    resolve_agent_config_target(
        AgentAddApp::ClaudeDesktop,
        &environment(Platform::Mac, "/Users/ana"),
        &unused,
    );
}

fn merged(result: JsonConfigMerge) -> (String, bool) {
    match result {
        JsonConfigMerge::Merged { text, changed } => (text, changed),
        JsonConfigMerge::Refused(reason) => panic!("refused: {reason:?}"),
    }
}

#[test]
fn a_json_merge_adds_videorc_after_the_other_servers_and_keeps_every_key() {
    let existing = "{\n  \"globalShortcut\": \"Alt+Space\",\n  \"mcpServers\": {\n    \"github\": {\n      \"command\": \"gh\"\n    }\n  }\n}";
    let (text, changed) = merged(merge_json_config(Some(existing), "mcpServers", &entry()));
    assert!(changed);
    assert_eq!(
        parse(&text),
        serde_json::json!({
            "globalShortcut": "Alt+Space",
            "mcpServers": { "github": { "command": "gh" }, "videorc": parse(&entry().pretty("  ")) }
        })
    );
    let github = text.find("\"github\"").unwrap();
    assert!(github < text.find("\"videorc\"").unwrap());
    assert!(text.find("\"globalShortcut\"").unwrap() < text.find("\"mcpServers\"").unwrap());
    assert!(text.ends_with("}\n"));
}

#[test]
fn a_json_merge_replaces_an_old_entry_in_its_place_and_keeps_the_indent() {
    let existing = "{\n\t\"mcpServers\": {\n\t\t\"videorc\": {\"command\": \"/old\"},\n\t\t\"z\": {}\n\t}\n}\n";
    let (text, _) = merged(merge_json_config(Some(existing), "mcpServers", &entry()));
    assert!(text.find("\"videorc\"").unwrap() < text.find("\"z\"").unwrap());
    assert!(text.contains("\n\t\"mcpServers\""));
    assert!(text.contains("\"z\": {}"));
}

#[test]
fn a_json_merge_gives_vs_code_its_servers_key_and_keeps_its_inputs() {
    let existing = r#"{"servers":{},"inputs":[{"id":"key","type":"promptString"}]}"#;
    let vs_code = agent_json_server_entry(AgentAddApp::VsCode, MAC, &token());
    let (text, _) = merged(merge_json_config(Some(existing), "servers", &vs_code));
    assert_eq!(
        parse(&text),
        serde_json::json!({
            "servers": { "videorc": parse(&vs_code.pretty("  ")) },
            "inputs": [{ "id": "key", "type": "promptString" }]
        })
    );
    assert!(text.find("\"servers\"").unwrap() < text.find("\"inputs\"").unwrap());
}

#[test]
fn a_json_merge_escapes_a_windows_bridge_path() {
    let windows = agent_json_server_entry(AgentAddApp::Cursor, WINDOWS_BRIDGE, &token());
    let (text, _) = merged(merge_json_config(None, "mcpServers", &windows));
    assert!(text.contains(r#""C:\\Users\\Ana Lee\\AppData"#));
    assert_eq!(
        parse(&text)["mcpServers"]["videorc"]["command"],
        WINDOWS_BRIDGE
    );
}

#[test]
fn a_json_merge_reads_a_bom_and_says_unchanged_when_the_entry_is_there() {
    let existing = format!(
        "\u{feff}{{\"mcpServers\":{{\"videorc\":{}}}}}",
        serde_json::to_string(&entry()).unwrap()
    );
    assert_eq!(
        merge_json_config(Some(&existing), "mcpServers", &entry()),
        JsonConfigMerge::Merged {
            text: existing.clone(),
            changed: false,
        }
    );
    // A null servers key is no servers yet.
    let (text, changed) = merged(merge_json_config(
        Some(r#"{"mcpServers": null}"#),
        "mcpServers",
        &entry(),
    ));
    assert!(changed);
    assert!(parse(&text)["mcpServers"]["videorc"].is_object());
}

#[test]
fn a_json_merge_refuses_what_it_cannot_read() {
    for (existing, reason) in [
        ("{\n  // mine\n  \"mcpServers\": {}\n}", Refusal::NotJson),
        (r#"{"mcpServers": {},}"#, Refusal::NotJson),
        (r#"{"mcpServers": {"#, Refusal::NotJson),
        ("[]", Refusal::NotObject),
        ("null", Refusal::NotObject),
        (r#"{"mcpServers": []}"#, Refusal::ServersNotObject),
        (r#"{"mcpServers": "x"}"#, Refusal::ServersNotObject),
    ] {
        assert_eq!(
            merge_json_config(Some(existing), "mcpServers", &entry()),
            JsonConfigMerge::Refused(reason),
            "{existing}"
        );
    }
}

#[test]
fn a_write_keeps_the_other_servers_backs_the_old_file_up_and_makes_both_owner_only() {
    let (_guard, root) = root("agent-config-write");
    let dir = folder(&root, &["Claude"]);
    let file = dir.join("claude_desktop_config.json");
    let original =
        "{\n  \"mcpServers\": {\n    \"github\": {\n      \"command\": \"gh\"\n    }\n  }\n}";
    fs::write(&file, original).unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&file, fs::Permissions::from_mode(0o640)).unwrap();
    }

    let write = write_agent_config(
        &target(AgentAddApp::ClaudeDesktop, &file),
        MAC,
        &token(),
        Platform::current(),
        &write_deps(now(), &no_log),
    );

    let backup = format!("{}.videorc-backup-20261027-221530", file.display());
    assert_eq!(
        write,
        AgentConfigWrite::Added {
            file: file.to_string_lossy().into_owned(),
            backup: Some(backup.clone()),
        }
    );
    let servers = &parse(&fs::read_to_string(&file).unwrap())["mcpServers"];
    assert_eq!(servers["github"]["command"], "gh");
    assert_eq!(servers["videorc"]["command"], MAC);
    assert_eq!(fs::read_to_string(&backup).unwrap(), original);
    #[cfg(unix)]
    {
        assert_eq!(mode_of(&file), 0o600);
        assert_eq!(mode_of(Path::new(&backup)), 0o600);
    }
    // Nothing else beside it: no staging file left behind.
    let mut names: Vec<String> = fs::read_dir(&dir)
        .unwrap()
        .map(|entry| entry.unwrap().file_name().into_string().unwrap())
        .collect();
    names.sort();
    assert_eq!(
        names,
        [
            "claude_desktop_config.json",
            "claude_desktop_config.json.videorc-backup-20261027-221530"
        ]
    );
}

#[test]
fn a_missing_file_is_created_owner_only_with_no_backup() {
    let (_guard, root) = root("agent-config-create");
    let dir = folder(&root, &[".cursor"]);
    let file = dir.join("mcp.json");
    let write = write_agent_config(
        &target(AgentAddApp::Cursor, &file),
        MAC,
        &token(),
        Platform::current(),
        &write_deps(now(), &no_log),
    );
    assert_eq!(
        write,
        AgentConfigWrite::Added {
            file: file.to_string_lossy().into_owned(),
            backup: None,
        }
    );
    assert_eq!(
        parse(&fs::read_to_string(&file).unwrap())["mcpServers"]["videorc"]["env"][AGENT_TOKEN_ENV],
        token()
    );
    #[cfg(unix)]
    assert_eq!(mode_of(&file), 0o600);
    assert!(backups(&dir).is_empty());
}

#[test]
fn a_write_never_creates_the_apps_folder() {
    let (_guard, root) = root("agent-config-no-app");
    let file = root.join("Code").join("User").join("mcp.json");
    let write = write_agent_config(
        &target(AgentAddApp::VsCode, &file),
        MAC,
        &token(),
        Platform::current(),
        &write_deps(now(), &no_log),
    );
    assert_eq!(
        write,
        AgentConfigWrite::Refused {
            file: file.to_string_lossy().into_owned(),
            reason: Refusal::NoApp,
        }
    );
    assert!(!root.join("Code").exists());
}

#[test]
fn a_file_it_cannot_read_is_left_exactly_as_it_was() {
    let (_guard, root) = root("agent-config-jsonc");
    let dir = folder(&root, &["Code", "User"]);
    let file = dir.join("mcp.json");
    let original = "{\n  // my servers\n  \"servers\": {}\n}\n";
    fs::write(&file, original).unwrap();
    let write = write_agent_config(
        &target(AgentAddApp::VsCode, &file),
        MAC,
        &token(),
        Platform::current(),
        &write_deps(now(), &no_log),
    );
    assert_eq!(
        write,
        AgentConfigWrite::Refused {
            file: file.to_string_lossy().into_owned(),
            reason: Refusal::NotJson,
        }
    );
    assert_eq!(fs::read_to_string(&file).unwrap(), original);
    assert_eq!(fs::read_dir(&dir).unwrap().count(), 1);
}

#[test]
fn an_entry_already_there_writes_nothing_and_makes_no_backup() {
    let (_guard, root) = root("agent-config-unchanged");
    let dir = folder(&root, &[".cursor"]);
    let file = dir.join("mcp.json");
    let write = |log: &dyn Fn(&str)| {
        write_agent_config(
            &target(AgentAddApp::Cursor, &file),
            MAC,
            &token(),
            Platform::current(),
            &write_deps(now(), log),
        )
    };
    write(&no_log);
    let first = fs::read_to_string(&file).unwrap();
    assert_eq!(
        write(&no_log),
        AgentConfigWrite::Unchanged {
            file: file.to_string_lossy().into_owned(),
        }
    );
    assert_eq!(fs::read_to_string(&file).unwrap(), first);
    assert!(backups(&dir).is_empty());

    // An unchanged file holding the token becomes owner-only again.
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&file, fs::Permissions::from_mode(0o644)).unwrap();
        write(&no_log);
        assert_eq!(mode_of(&file), 0o600);
    }
}

#[test]
fn two_changes_in_one_second_keep_both_backups() {
    let (_guard, root) = root("agent-config-same-second");
    let dir = folder(&root, &[".cursor"]);
    let file = dir.join("mcp.json");
    fs::write(&file, "{}").unwrap();
    for token in ["vrc_agent_one", "vrc_agent_two"] {
        write_agent_config(
            &target(AgentAddApp::Cursor, &file),
            MAC,
            token,
            Platform::current(),
            &write_deps(now(), &no_log),
        );
    }
    assert_eq!(
        backups(&dir),
        [
            "mcp.json.videorc-backup-20261027-221530",
            "mcp.json.videorc-backup-20261027-221530-2"
        ]
    );
    assert_eq!(
        fs::read_to_string(dir.join("mcp.json.videorc-backup-20261027-221530")).unwrap(),
        "{}"
    );
}

/// Hands out `bytes`, then fails; on its first read it records the backup's
/// mode, which is the mode the copy holds before any byte lands.
struct FailingSource {
    dir: PathBuf,
    bytes: &'static [u8],
    mode_at_first_read: Option<u32>,
}

impl io::Read for FailingSource {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        if self.mode_at_first_read.is_none() {
            let backup = self.dir.join(&backups(&self.dir)[0]);
            self.mode_at_first_read = Some(file_mode(&backup)?);
        }
        if self.bytes.is_empty() {
            return Err(io::Error::other("the disk went away"));
        }
        let length = self.bytes.len().min(buf.len());
        buf[..length].copy_from_slice(&self.bytes[..length]);
        self.bytes = &self.bytes[length..];
        Ok(length)
    }
}

#[test]
fn a_backup_is_owner_only_before_its_first_byte_and_gone_if_the_copy_fails() {
    let (_guard, root) = root("agent-config-backup-fails");
    let dir = folder(&root, &[".cursor"]);
    let file = dir.join("mcp.json");
    let mut source = FailingSource {
        dir: dir.clone(),
        bytes: b"{\"mcpServers\":{\"videorc\":{\"env\":{\"TOKEN\":\"vrc_agent_old\"}}}}",
        mode_at_first_read: None,
    };
    let error = back_up_from(&mut source, &file, now()).unwrap_err();
    assert_eq!(error.to_string(), "the disk went away");
    assert_eq!(source.mode_at_first_read, Some(0o600));
    assert_eq!(backups(&dir), Vec::<String>::new());
}

#[test]
fn only_videorcs_newest_backups_stay_and_other_files_are_untouched() {
    let (_guard, root) = root("agent-config-prune");
    let dir = folder(&root, &[".cursor"]);
    let file = dir.join("mcp.json");
    fs::write(&file, "{}").unwrap();
    // Someone's own copy, which only looks like ours.
    fs::write(dir.join("mcp.json.videorc-backup-mine"), "keep").unwrap();
    for (index, stamp) in [
        "2026-10-27T22:15:30Z",
        "2026-10-27T22:15:31Z",
        "2026-10-27T22:15:31Z",
        "2026-10-28T09:00:00Z",
        "2026-10-28T09:00:01Z",
    ]
    .into_iter()
    .enumerate()
    {
        let write = write_agent_config(
            &target(AgentAddApp::Cursor, &file),
            MAC,
            &format!("vrc_agent_{index}"),
            Platform::current(),
            &write_deps(at(stamp), &no_log),
        );
        assert!(matches!(write, AgentConfigWrite::Added { .. }), "{write:?}");
    }
    assert_eq!(AGENT_CONFIG_BACKUPS_KEPT, 3);
    // The second write of 22:15:31 (`-2`) is newer than the first, so it is
    // the third one kept.
    assert_eq!(
        backups(&dir),
        [
            "mcp.json.videorc-backup-20261027-221531-2",
            "mcp.json.videorc-backup-20261028-090000",
            "mcp.json.videorc-backup-20261028-090001",
            "mcp.json.videorc-backup-mine"
        ]
    );
    assert_eq!(
        fs::read_to_string(dir.join("mcp.json.videorc-backup-mine")).unwrap(),
        "keep"
    );
}

#[cfg(unix)]
#[test]
fn a_symlinked_config_is_written_through_to_its_target() {
    let (_guard, root) = root("agent-config-symlink");
    let dotfiles = folder(&root, &["dotfiles"]);
    let real = dotfiles.join("cursor-mcp.json");
    fs::write(&real, r#"{"mcpServers":{"github":{"command":"gh"}}}"#).unwrap();
    let dir = folder(&root, &[".cursor"]);
    let link = dir.join("mcp.json");
    std::os::unix::fs::symlink(&real, &link).unwrap();

    let write = write_agent_config(
        &target(AgentAddApp::Cursor, &link),
        MAC,
        &token(),
        Platform::current(),
        &write_deps(now(), &no_log),
    );

    assert!(matches!(write, AgentConfigWrite::Added { .. }));
    assert_eq!(fs::read_link(&link).unwrap(), real);
    assert_eq!(
        parse(&fs::read_to_string(&real).unwrap())["mcpServers"]["videorc"]["command"],
        MAC
    );
    assert_eq!(
        backups(&dotfiles),
        ["cursor-mcp.json.videorc-backup-20261027-221530"]
    );
}

#[test]
fn a_failed_rename_keeps_the_old_file_and_removes_the_staging_file() {
    let (_guard, root) = root("agent-config-rename");
    let dir = folder(&root, &["Claude"]);
    let file = dir.join("claude_desktop_config.json");
    fs::write(&file, r#"{"mcpServers": {}}"#).unwrap();
    let logged = Mutex::new(Vec::<String>::new());
    let log = |message: &str| logged.lock().unwrap().push(message.to_string());
    let rename =
        |_: &Path, _: &Path| -> io::Result<()> { Err(io::Error::other("EXDEV: cross-device")) };

    let write = write_agent_config(
        &target(AgentAddApp::ClaudeDesktop, &file),
        MAC,
        &token(),
        Platform::current(),
        &WriteDeps {
            now: now(),
            rename: &rename,
            log: &log,
        },
    );

    assert_eq!(
        write,
        AgentConfigWrite::Failed {
            file: file.to_string_lossy().into_owned(),
        }
    );
    assert_eq!(fs::read_to_string(&file).unwrap(), r#"{"mcpServers": {}}"#);
    assert!(fs::read_dir(&dir).unwrap().all(|entry| {
        !entry
            .unwrap()
            .file_name()
            .to_string_lossy()
            .ends_with(".tmp")
    }));
    let logged = logged.lock().unwrap();
    assert!(logged[0].contains("EXDEV"));
    assert!(!logged[0].contains(&token()));
}

#[test]
fn codex_gets_its_table_and_keeps_the_rest() {
    let (_guard, root) = root("agent-config-codex");
    let dir = folder(&root, &[".codex"]);
    let file = dir.join("config.toml");
    let original = "model = \"o4\"\n\n[mcp_servers.github]\ncommand = \"gh\"\n";
    fs::write(&file, original).unwrap();
    let write = write_agent_config(
        &target(AgentAddApp::Codex, &file),
        MAC,
        &token(),
        Platform::current(),
        &write_deps(now(), &no_log),
    );
    assert!(matches!(write, AgentConfigWrite::Added { .. }));
    assert_eq!(
        fs::read_to_string(&file).unwrap(),
        format!(
            "{original}\n{}\n",
            agent_codex_toml_lines(MAC, &token()).join("\n")
        )
    );
    assert_eq!(
        backups(&dir),
        ["config.toml.videorc-backup-20261027-221530"]
    );
}

#[test]
fn toml_it_cannot_place_is_refused_and_logged_without_the_token() {
    let (_guard, root) = root("agent-config-codex-refused");
    let dir = folder(&root, &[".codex"]);
    let file = dir.join("config.toml");
    fs::write(&file, "[mcp_servers]\nvideorc = { command = \"x\" }\n").unwrap();
    let logged = Mutex::new(Vec::<String>::new());
    let log = |message: &str| logged.lock().unwrap().push(message.to_string());
    let write = write_agent_config(
        &target(AgentAddApp::Codex, &file),
        MAC,
        &token(),
        Platform::current(),
        &write_deps(now(), &log),
    );
    assert_eq!(
        write,
        AgentConfigWrite::Refused {
            file: file.to_string_lossy().into_owned(),
            reason: Refusal::UnsafeToml,
        }
    );
    let logged = logged.lock().unwrap();
    assert_eq!(logged.len(), 1);
    assert!(!logged[0].contains(&token()));
}

#[test]
fn the_dialog_names_the_app_and_the_next_step() {
    let file = "/Users/ana/.cursor/mcp.json".to_string();
    assert_eq!(
        agent_config_write_message(
            AgentAddApp::ClaudeDesktop,
            &AgentConfigWrite::Added {
                file: file.clone(),
                backup: None
            }
        ),
        "Added. Restart Claude Desktop to see Videorc."
    );
    assert_eq!(
        agent_config_write_message(
            AgentAddApp::Codex,
            &AgentConfigWrite::Unchanged { file: file.clone() }
        ),
        "Added. Restart Codex to see Videorc."
    );
    assert_eq!(
        agent_config_write_message(
            AgentAddApp::Cursor,
            &AgentConfigWrite::Refused {
                file: file.clone(),
                reason: Refusal::NotJson
            }
        ),
        "Cursor's mcp.json isn't plain JSON, so Videorc left it alone. Copy the line instead."
    );
    assert_eq!(
        agent_config_write_message(
            AgentAddApp::VsCode,
            &AgentConfigWrite::Refused {
                file: file.clone(),
                reason: Refusal::NoApp
            }
        ),
        "Videorc can't find VS Code's settings folder on this computer. Open VS Code once, or copy the line instead."
    );
    assert_eq!(
        agent_config_write_message(
            AgentAddApp::Codex,
            &AgentConfigWrite::Refused {
                file: "C:\\Users\\Ana\\.codex\\config.toml".to_string(),
                reason: Refusal::UnsafeToml
            }
        ),
        "Videorc couldn't safely edit Codex's config.toml, so it left it alone. Copy the line instead."
    );
    assert_eq!(
        agent_config_write_message(AgentAddApp::Cursor, &AgentConfigWrite::Failed { file }),
        "Couldn't add Videorc to Cursor. Copy the line instead."
    );
    assert_eq!(backup_stamp(now()), "20261027-221530");
}

#[test]
fn the_temporary_copy_check_matches_the_dialogs() {
    for path in [
        "/Volumes/Videorc/Videorc.app/Contents/Resources/videorc-mcp",
        "/private/var/folders/x/AppTranslocation/ABC/d/Videorc.app/Contents/Resources/videorc-mcp",
    ] {
        assert!(agent_bridge_runs_from_temporary_copy(path), "{path}");
    }
    for path in [
        "/Volumes/SSD/Applications/Videorc.app/Contents/Resources/videorc-mcp",
        MAC,
        WINDOWS_BRIDGE,
    ] {
        assert!(!agent_bridge_runs_from_temporary_copy(path), "{path}");
    }
}

fn mac_cli() -> AgentEnvironment {
    let mut mac = environment(Platform::Mac, "/Users/ana");
    mac.path_variable = Some("/usr/bin:/bin".to_string());
    mac
}

#[test]
fn claude_is_looked_for_on_the_path_then_in_the_installers_folders() {
    assert_eq!(
        claude_cli_candidates(&mac_cli()),
        [
            "/usr/bin/claude",
            "/bin/claude",
            "/Users/ana/.local/bin/claude",
            "/Users/ana/.claude/local/claude",
            "/opt/homebrew/bin/claude",
            "/usr/local/bin/claude"
        ]
    );
    // Windows: claude.exe only (a .cmd needs a shell), relative entries ignored.
    let mut windows = environment(Platform::Windows, "C:\\Users\\Ana");
    windows.path_variable = Some("C:\\Tools;relative;C:\\Users\\Ana\\.local\\bin".to_string());
    assert_eq!(
        claude_cli_candidates(&windows),
        [
            "C:\\Tools\\claude.exe",
            "C:\\Users\\Ana\\.local\\bin\\claude.exe"
        ]
    );
}

type Calls = Arc<Mutex<Vec<(PathBuf, Vec<String>, String)>>>;

/// A `claude` that answers `answer(args)` and records every run.
fn fake_cli(
    calls: Calls,
    answer: impl Fn(&[String]) -> Result<(), CliFailure> + Send + Sync + 'static,
) -> Box<RunCli> {
    Box::new(
        move |cli: PathBuf, args: Vec<String>, path: String, timeout: Duration| -> CliFuture {
            assert!(timeout > Duration::ZERO);
            let result = answer(&args);
            calls.lock().unwrap().push((cli, args, path));
            Box::pin(async move { result })
        },
    )
}

#[tokio::test]
async fn claude_code_removes_an_earlier_videorc_then_adds_it_for_every_project() {
    let calls = Calls::default();
    let run = fake_cli(calls.clone(), |args| {
        if args[1] == "remove" {
            Err(CliFailure {
                timed_out: false,
                stderr: "No MCP server named videorc".to_string(),
            })
        } else {
            Ok(())
        }
    });
    let can_run = |path: &str| path == "/Users/ana/.local/bin/claude";
    let install = add_to_claude_code(MAC, &token(), &mac_cli(), &can_run, &*run, &no_log).await;
    assert_eq!(
        install,
        ClaudeCodeInstall::Added {
            cli: "/Users/ana/.local/bin/claude".to_string()
        }
    );
    let calls = calls.lock().unwrap();
    assert_eq!(calls[0].1, ["mcp", "remove", "--scope", "user", "videorc"]);
    assert_eq!(calls[1].1, agent_claude_code_add_args(MAC, &token()));
    assert_eq!(calls[1].0, PathBuf::from("/Users/ana/.local/bin/claude"));
    // Its own folder first on the PATH, so a script's `node` resolves.
    assert_eq!(calls[1].2.split(':').next(), Some("/Users/ana/.local/bin"));
    assert!(calls[1].2.contains("/opt/homebrew/bin"));
    assert_eq!(
        claude_code_install_message(&install),
        "Added. Start a new Claude Code session to see Videorc."
    );
}

#[tokio::test]
async fn no_claude_command_runs_nothing_and_says_to_run_the_line() {
    let calls = Calls::default();
    let run = fake_cli(calls.clone(), |_| Ok(()));
    let install = add_to_claude_code(MAC, &token(), &mac_cli(), &|_| false, &*run, &no_log).await;
    assert_eq!(install, ClaudeCodeInstall::NoCli);
    assert!(calls.lock().unwrap().is_empty());
    assert_eq!(
        claude_code_install_message(&install),
        "Videorc can't find Claude Code's claude command on this computer. Run the line in a terminal instead."
    );
}

#[tokio::test]
async fn a_failed_or_timed_out_claude_is_logged_without_the_token() {
    let run = fake_cli(Calls::default(), |args| {
        if args[1] == "remove" {
            Ok(())
        } else {
            Err(CliFailure {
                timed_out: true,
                stderr: "Invalid configuration".to_string(),
            })
        }
    });
    let logged = Mutex::new(Vec::<String>::new());
    let log = |message: &str| logged.lock().unwrap().push(message.to_string());
    let install = add_to_claude_code(MAC, &token(), &mac_cli(), &|_| true, &*run, &log).await;
    assert_eq!(
        install,
        ClaudeCodeInstall::Failed {
            cli: "/usr/bin/claude".to_string()
        }
    );
    assert_eq!(
        claude_code_install_message(&install),
        "Claude Code didn't add Videorc. Run the line in a terminal instead."
    );
    let logged = logged.lock().unwrap();
    assert_eq!(
        logged.as_slice(),
        ["claude mcp add didn't finish (timed out): Invalid configuration"]
    );
    assert!(!logged[0].contains(&token()));
}

fn add_deps<'a>(
    environment: AgentEnvironment,
    run: &'a RunCli,
    can_run: &'a (dyn Fn(&str) -> bool + Sync),
) -> AddDeps<'a> {
    AddDeps {
        environment,
        now: now(),
        read_dir: &read_dir_names,
        can_run,
        run,
        log: &no_log,
    }
}

fn params(app: AgentAddApp, bridge_path: &str) -> AgentConfigAddParams {
    AgentConfigAddParams {
        app,
        bridge_path: bridge_path.to_string(),
        token: token(),
    }
}

#[tokio::test]
async fn adding_writes_a_config_app_and_reports_a_refusal_as_not_added() {
    let (_guard, root) = root("agent-config-add");
    folder(&root, &[".cursor"]);
    let home = root.to_string_lossy().into_owned();
    let run = fake_cli(Calls::default(), |_| Ok(()));
    let deps = add_deps(environment(Platform::current(), &home), &*run, &|_| true);

    let added = add_agent_to_app(&params(AgentAddApp::Cursor, MAC), &deps).await;
    assert!(added.added, "{added:?}");
    assert_eq!(
        added.message,
        "Added. Turn on videorc in Cursor Settings → MCP to see Videorc."
    );
    let refused = add_agent_to_app(&params(AgentAddApp::VsCode, MAC), &deps).await;
    assert!(!refused.added);
    assert!(
        refused
            .message
            .contains("Videorc can't find VS Code's settings folder")
    );
}

#[tokio::test]
async fn a_bridge_on_a_disk_image_or_in_a_temporary_copy_writes_nothing() {
    let (_guard, root) = root("agent-config-translocated");
    let dir = folder(&root, &[".cursor"]);
    let home = root.to_string_lossy().into_owned();
    let calls = Calls::default();
    let run = fake_cli(calls.clone(), |_| Ok(()));
    let deps = add_deps(environment(Platform::current(), &home), &*run, &|_| true);
    for bridge in [
        "/Volumes/Videorc/Videorc.app/Contents/Resources/videorc-mcp",
        "/private/var/folders/x/AppTranslocation/ABC/d/Videorc.app/Contents/Resources/videorc-mcp",
    ] {
        for app in [AgentAddApp::Cursor, AgentAddApp::ClaudeCode] {
            assert_eq!(
                add_agent_to_app(&params(app, bridge), &deps).await,
                AgentAddResult {
                    added: false,
                    message: AGENT_BRIDGE_MOVE_FIRST.to_string(),
                }
            );
        }
    }
    assert!(calls.lock().unwrap().is_empty());
    assert_eq!(fs::read_dir(&dir).unwrap().count(), 0);
    // An app kept in an external drive's Applications folder stays put.
    let external = add_agent_to_app(
        &params(
            AgentAddApp::Cursor,
            "/Volumes/SSD/Applications/Videorc.app/Contents/Resources/videorc-mcp",
        ),
        &deps,
    )
    .await;
    assert!(external.added, "{external:?}");
}

#[tokio::test]
async fn adding_claude_code_runs_its_cli() {
    let run = fake_cli(Calls::default(), |_| Ok(()));
    let mut mac = environment(Platform::Mac, "/Users/ana");
    mac.path_variable = Some("/usr/bin".to_string());
    let deps = add_deps(mac, &*run, &|_| true);
    assert_eq!(
        add_agent_to_app(&params(AgentAddApp::ClaudeCode, MAC), &deps).await,
        AgentAddResult {
            added: true,
            message: "Added. Start a new Claude Code session to see Videorc.".to_string(),
        }
    );
}
