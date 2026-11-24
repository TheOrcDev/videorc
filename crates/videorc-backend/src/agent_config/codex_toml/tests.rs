//! Codex's config.toml gets `[mcp_servers.videorc]` added or replaced, and
//! every other byte stays; anything uncertain is refused.

use super::*;
use crate::agent_config::agent_codex_toml_lines;

const MAC: &str = "/Applications/Videorc.app/Contents/Resources/videorc-mcp";

fn table() -> Vec<String> {
    agent_codex_toml_lines(MAC, &format!("vrc_agent_{}", "ab12".repeat(16)))
}

fn merge(existing: Option<&str>) -> CodexTomlMerge {
    merge_codex_toml(existing, &table(), "videorc")
}

fn text(result: CodexTomlMerge) -> String {
    match result {
        CodexTomlMerge::Merged { text, .. } => text,
        CodexTomlMerge::Refused { reason } => panic!("refused: {reason}"),
    }
}

fn joined(lines: &[String], eol: &str) -> String {
    lines.join(eol)
}

#[test]
fn the_table_goes_alone_into_a_missing_or_empty_file() {
    let alone = format!("{}\n", joined(&table(), "\n"));
    assert_eq!(text(merge(None)), alone);
    assert_eq!(text(merge(Some("  \n"))), alone);
}

#[test]
fn it_appends_after_everything_else_leaving_it_byte_for_byte() {
    let existing = [
        "model = \"o4\"",
        "",
        "[mcp_servers.github]",
        "command = \"gh-mcp\"",
        "env = { GITHUB_TOKEN = \"secret\" }",
        "",
    ]
    .join("\n");
    assert_eq!(
        text(merge(Some(&existing))),
        format!("{existing}\n{}\n", joined(&table(), "\n"))
    );
    // No final newline: one is added before the blank separator.
    assert_eq!(
        text(merge(Some("model = \"o4\""))),
        format!("model = \"o4\"\n\n{}\n", joined(&table(), "\n"))
    );
}

#[test]
fn it_replaces_the_old_table_in_place_and_keeps_the_next_tables_comment() {
    let existing = [
        "model = \"o4\"",
        "",
        "[mcp_servers.videorc]",
        "command = \"/old/videorc-mcp\"",
        "# my own note inside",
        "args = [",
        "  \"--old\",",
        "]",
        "startup_timeout_sec = 30",
        "",
        "# GitHub, for work",
        "[mcp_servers.github]",
        "command = \"gh-mcp\"",
        "",
    ]
    .join("\n");
    let mut expected = vec!["model = \"o4\"".to_string(), String::new()];
    expected.extend(table());
    expected.extend(
        [
            "",
            "# GitHub, for work",
            "[mcp_servers.github]",
            "command = \"gh-mcp\"",
            "",
        ]
        .map(str::to_string),
    );
    assert_eq!(text(merge(Some(&existing))), expected.join("\n"));
}

#[test]
fn it_removes_a_videorc_sub_table_and_leaves_a_similar_name_alone() {
    let old = agent_codex_toml_lines("/old/videorc-mcp", "vrc_agent_old");
    let mut existing: Vec<String> = old[..3].to_vec();
    existing.extend(
        [
            "",
            "[mcp_servers.videorc-old]",
            "command = \"keep-me\"",
            "",
            "[mcp_servers.videorc.env]",
            "VIDEORC_AGENT_TOKEN = \"vrc_agent_old\"",
            "",
            "[profiles.fast]",
            "model = \"o4-mini\"",
        ]
        .map(str::to_string),
    );
    let mut expected = table();
    expected.extend(
        [
            "",
            "[mcp_servers.videorc-old]",
            "command = \"keep-me\"",
            "",
            "",
            "[profiles.fast]",
            "model = \"o4-mini\"",
        ]
        .map(str::to_string),
    );
    assert_eq!(text(merge(Some(&existing.join("\n")))), expected.join("\n"));
}

#[test]
fn quoted_and_spaced_headers_are_found_and_a_current_table_is_unchanged() {
    let quoted = "[ mcp_servers . \"videorc\" ]\ncommand = \"/old\"\n";
    assert_eq!(
        text(merge(Some(quoted))),
        format!("{}\n", joined(&table(), "\n"))
    );
    let literal = "['mcp_servers'.'videorc']\ncommand = \"/old\"";
    assert_eq!(text(merge(Some(literal))), joined(&table(), "\n"));
    let current = format!("model = \"o4\"\n\n{}\n", joined(&table(), "\n"));
    assert_eq!(
        merge(Some(&current)),
        CodexTomlMerge::Merged {
            text: current.clone(),
            changed: false,
        }
    );
}

#[test]
fn a_header_inside_a_string_or_a_multi_line_array_is_never_read() {
    let existing = [
        "notes = \"\"\"",
        "[mcp_servers.videorc]",
        "command = \"inside a string\"",
        "\"\"\"",
        "literal = '''",
        "[mcp_servers.videorc]",
        "'''",
        "matrix = [",
        "  [1],",
        "  [2]",
        "]",
        "url = \"https://example.com/#[mcp_servers.videorc]\" # a comment [x]",
        "",
    ]
    .join("\n");
    assert_eq!(
        text(merge(Some(&existing))),
        format!("{existing}\n{}\n", joined(&table(), "\n"))
    );
}

#[test]
fn windows_line_endings_and_a_byte_order_mark_stay() {
    let existing = "\u{feff}model = \"o4\"\r\n\r\n[mcp_servers.videorc]\r\ncommand = \"/old\"\r\n";
    assert_eq!(
        text(merge(Some(existing))),
        format!(
            "\u{feff}model = \"o4\"\r\n\r\n{}\r\n",
            joined(&table(), "\r\n")
        )
    );
}

#[test]
fn a_windows_bridge_path_is_escaped_so_it_reads_back_the_same() {
    let windows =
        "C:\\Users\\Ana Lee\\AppData\\Local\\Programs\\Videorc\\resources\\videorc-mcp.exe";
    let lines = agent_codex_toml_lines(windows, "vrc_agent_x");
    assert_eq!(
        lines[1],
        "command = \"C:\\\\Users\\\\Ana Lee\\\\AppData\\\\Local\\\\Programs\\\\Videorc\\\\resources\\\\videorc-mcp.exe\""
    );
    assert!(text(merge_codex_toml(Some(""), &lines, "videorc")).contains(&lines[1]));
}

#[test]
fn anything_it_cannot_place_with_certainty_is_refused() {
    for (label, existing) in [
        (
            "dotted keys at the root",
            "mcp_servers.videorc.command = \"x\"\n",
        ),
        (
            "an inline videorc table",
            "[mcp_servers]\nvideorc = { command = \"x\" }\n",
        ),
        (
            "dotted videorc keys in [mcp_servers]",
            "[mcp_servers]\nvideorc.command = \"x\"\n",
        ),
        (
            "mcp_servers as an inline table",
            "mcp_servers = { github = { command = \"gh\" } }\n",
        ),
        (
            "an array of videorc tables",
            "[[mcp_servers.videorc]]\ncommand = \"x\"\n",
        ),
        (
            "the table twice",
            "[mcp_servers.videorc]\na = 1\n[mcp_servers.videorc]\nb = 2\n",
        ),
        (
            "an unterminated multi-line string",
            "notes = \"\"\"\nnever closed\n",
        ),
        ("an unterminated array", "args = [\n \"a\",\n"),
        ("an unterminated string", "name = \"open\n"),
        ("a line that is not TOML", "this is not toml\n"),
        (
            "a header with junk after it",
            "[mcp_servers.github] extra\n",
        ),
    ] {
        assert!(
            matches!(merge(Some(existing)), CodexTomlMerge::Refused { .. }),
            "{label}"
        );
    }
}

#[test]
fn other_servers_as_dotted_keys_or_inline_tables_are_fine() {
    let inline = "[mcp_servers]\ngithub = { command = \"gh\" }\n";
    assert_eq!(
        text(merge(Some(inline))),
        format!("{inline}\n{}\n", joined(&table(), "\n"))
    );
    let dotted = "mcp_servers.github.command = \"gh\"\n";
    assert_eq!(
        text(merge(Some(dotted))),
        format!("{dotted}\n{}\n", joined(&table(), "\n"))
    );
}
