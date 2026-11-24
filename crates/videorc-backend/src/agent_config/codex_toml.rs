//! Plan 209 S22: add or replace Codex's `[mcp_servers.videorc]` table in
//! `~/.codex/config.toml` without a TOML library rewriting the file.
//!
//! This is not a TOML parser. It scans the file line by line, tracking
//! strings (all four kinds, multi-line ones across lines), comments and the
//! bracket depth of values, so it knows which lines are table headers and
//! which are key/value lines. It then removes every `[mcp_servers.videorc…]`
//! section and writes the new table in the first one's place (or at the end).
//! Every other byte of the file stays as it was.
//!
//! Anything it can't place with certainty is refused, and the streamer pastes
//! the line instead: `videorc` defined with dotted keys or an inline table,
//! `mcp_servers` as an inline table, an array of `videorc` tables, the table
//! twice, an unterminated string or bracket, or a line that is none of a
//! header, a key/value, a comment or blank.

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum CodexTomlMerge {
    Merged { text: String, changed: bool },
    Refused { reason: String },
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Multiline {
    Basic,
    Literal,
}

impl Multiline {
    fn delimiter(self) -> [char; 3] {
        match self {
            Self::Basic => ['"'; 3],
            Self::Literal => ['\''; 3],
        }
    }
}

#[derive(Default)]
struct ScanState {
    multiline: Option<Multiline>,
    depth: i64,
}

enum ScannedLine {
    Trivia,
    Continuation,
    Header { path: Vec<String>, array: bool },
    KeyVal { path: Vec<String> },
}

struct ScanError(&'static str);

type Scan<T> = Result<T, ScanError>;

fn is_bare_key(char: char) -> bool {
    char.is_ascii_alphanumeric() || char == '_' || char == '-'
}

fn starts_with_at(line: &[char], index: usize, pattern: &[char]) -> bool {
    line.get(index..index + pattern.len()) == Some(pattern)
}

/// A TOML basic string's escapes, enough to compare key names.
fn unescape_basic(raw: &[char]) -> String {
    let mut out = String::new();
    let mut index = 0;
    while index < raw.len() {
        if raw[index] != '\\' || index + 1 >= raw.len() {
            out.push(raw[index]);
            index += 1;
            continue;
        }
        let escape = raw[index + 1];
        let hex_len = match escape {
            'u' => 4,
            'U' => 8,
            _ => 0,
        };
        if hex_len > 0 {
            let digits = raw.get(index + 2..index + 2 + hex_len);
            if let Some(code) = digits
                .filter(|digits| digits.iter().all(char::is_ascii_hexdigit))
                .and_then(|digits| u32::from_str_radix(&digits.iter().collect::<String>(), 16).ok())
                .and_then(char::from_u32)
            {
                out.push(code);
                index += 2 + hex_len;
                continue;
            }
        }
        out.push(match escape {
            'b' => '\u{8}',
            't' => '\t',
            'n' => '\n',
            'f' => '\u{c}',
            'r' => '\r',
            'e' => '\u{1b}',
            other => other,
        });
        index += 2;
    }
    out
}

/// The end of a one-line string that opens at `start` (on the quote).
fn single_line_string_end(line: &[char], start: usize) -> Scan<usize> {
    let quote = line[start];
    let mut index = start + 1;
    while index < line.len() {
        if quote == '"' && line[index] == '\\' {
            index += 2;
            continue;
        }
        if line[index] == quote {
            return Ok(index);
        }
        index += 1;
    }
    Err(ScanError("an unterminated string"))
}

fn skip_blanks(line: &[char], mut index: usize) -> usize {
    while matches!(line.get(index), Some(' ' | '\t')) {
        index += 1;
    }
    index
}

/// A dotted key from `start`, up to `terminator` (`=` for a key/value, `]`
/// for a header). Returns the path and the index after the terminator.
fn read_key_path(line: &[char], start: usize, terminator: char) -> Scan<(Vec<String>, usize)> {
    let mut path = Vec::new();
    let mut index = start;
    loop {
        index = skip_blanks(line, index);
        match line.get(index) {
            Some(&quote @ ('"' | '\'')) => {
                let end = single_line_string_end(line, index)?;
                let raw = &line[index + 1..end];
                path.push(if quote == '"' {
                    unescape_basic(raw)
                } else {
                    raw.iter().collect()
                });
                index = end + 1;
            }
            _ => {
                let from = index;
                while line.get(index).copied().is_some_and(is_bare_key) {
                    index += 1;
                }
                if index == from {
                    return Err(ScanError("a key Videorc could not read"));
                }
                path.push(line[from..index].iter().collect());
            }
        }
        index = skip_blanks(line, index);
        match line.get(index) {
            Some('.') => index += 1,
            Some(&char) if char == terminator => return Ok((path, index + 1)),
            _ => return Err(ScanError("a key Videorc could not read")),
        }
    }
}

/// Scan a value (or a continuation) from `start`, carrying strings and
/// brackets across lines.
fn scan_value(line: &[char], start: usize, state: &mut ScanState) -> Scan<()> {
    let mut index = start;
    while index < line.len() {
        if let Some(multiline) = state.multiline {
            let delimiter = multiline.delimiter();
            if multiline == Multiline::Basic && line[index] == '\\' {
                index += 2;
                continue;
            }
            if starts_with_at(line, index, &delimiter) {
                // Up to two quotes of the content may sit against the closing three.
                let mut end = index + 3;
                while end < line.len() && end < index + 5 && line[end] == delimiter[0] {
                    end += 1;
                }
                state.multiline = None;
                index = end;
                continue;
            }
            index += 1;
            continue;
        }
        let char = line[index];
        if char == '#' {
            return Ok(());
        }
        if starts_with_at(line, index, &['"'; 3]) {
            state.multiline = Some(Multiline::Basic);
            index += 3;
            continue;
        }
        if starts_with_at(line, index, &['\''; 3]) {
            state.multiline = Some(Multiline::Literal);
            index += 3;
            continue;
        }
        if char == '"' || char == '\'' {
            index = single_line_string_end(line, index)? + 1;
            continue;
        }
        if char == '[' || char == '{' {
            state.depth += 1;
        }
        if char == ']' || char == '}' {
            state.depth -= 1;
            if state.depth < 0 {
                return Err(ScanError("an unmatched bracket"));
            }
        }
        index += 1;
    }
    Ok(())
}

fn scan_line(line: &[char], state: &mut ScanState) -> Scan<ScannedLine> {
    if state.multiline.is_some() || state.depth > 0 {
        scan_value(line, 0, state)?;
        return Ok(ScannedLine::Continuation);
    }
    let Some(start) = line.iter().position(|char| !char.is_whitespace()) else {
        return Ok(ScannedLine::Trivia);
    };
    if line[start] == '#' {
        return Ok(ScannedLine::Trivia);
    }
    if line[start] == '[' {
        let array = line.get(start + 1) == Some(&'[');
        let (path, after) = read_key_path(line, start + if array { 2 } else { 1 }, ']')?;
        let mut rest = after;
        if array {
            if line.get(rest) != Some(&']') {
                return Err(ScanError("an array header Videorc could not read"));
            }
            rest += 1;
        }
        let tail: String = line[rest..].iter().collect();
        let tail = tail.trim();
        if !tail.is_empty() && !tail.starts_with('#') {
            return Err(ScanError("a header Videorc could not read"));
        }
        return Ok(ScannedLine::Header { path, array });
    }
    let (path, after) = read_key_path(line, start, '=')?;
    scan_value(line, after, state)?;
    Ok(ScannedLine::KeyVal { path })
}

fn starts_with(path: &[String], prefix: &[&str]) -> bool {
    prefix
        .iter()
        .enumerate()
        .all(|(index, part)| path.get(index).map(String::as_str) == Some(*part))
}

fn same_lines(left: &[&str], right: &[String]) -> bool {
    left.len() == right.len()
        && left
            .iter()
            .zip(right)
            .all(|(left, right)| left.trim() == right.trim())
}

/// `body.split(/\r?\n/)`: a `\r` goes with the `\n` after it only.
fn split_lines(body: &str) -> Vec<&str> {
    let pieces: Vec<&str> = body.split('\n').collect();
    let last = pieces.len() - 1;
    pieces
        .into_iter()
        .enumerate()
        .map(|(index, piece)| {
            if index < last {
                piece.strip_suffix('\r').unwrap_or(piece)
            } else {
                piece
            }
        })
        .collect()
}

/// Put `table` (the `[mcp_servers.<server>]` lines) into `existing`,
/// replacing any earlier `<server>` table and its sub-tables. `existing`
/// None is a file that isn't there yet.
pub(crate) fn merge_codex_toml(
    existing: Option<&str>,
    table: &[String],
    server: &str,
) -> CodexTomlMerge {
    let ours = ["mcp_servers", server];
    let refused = |reason: String| CodexTomlMerge::Refused { reason };
    let existing = match existing {
        Some(text) if !text.trim().is_empty() => text,
        _ => {
            return CodexTomlMerge::Merged {
                text: format!("{}\n", table.join("\n")),
                changed: true,
            };
        }
    };
    let (bom, body) = match existing.strip_prefix('\u{feff}') {
        Some(body) => ("\u{feff}", body),
        None => ("", existing),
    };
    let eol = if body.contains("\r\n") { "\r\n" } else { "\n" };
    let lines = split_lines(body);

    let mut state = ScanState::default();
    let mut scanned = Vec::with_capacity(lines.len());
    for line in &lines {
        let chars: Vec<char> = line.chars().collect();
        match scan_line(&chars, &mut state) {
            Ok(line) => scanned.push(line),
            Err(ScanError(reason)) => return refused(reason.to_string()),
        }
    }
    if state.multiline.is_some() || state.depth != 0 {
        return refused("an unterminated string or bracket".to_string());
    }

    // Our sections: from each `[mcp_servers.<server>…]` header to its last
    // key/value line. Blank lines and comments after that stay: they usually
    // belong to the next table.
    let mut sections: Vec<(usize, usize)> = Vec::new();
    let mut current: Vec<String> = Vec::new();
    let mut open: Option<(usize, usize)> = None;
    let mut exact_headers = 0;
    for (index, line) in scanned.iter().enumerate() {
        match line {
            ScannedLine::Header { path, array } => {
                if let Some(section) = open.take() {
                    sections.push(section);
                }
                current = path.clone();
                if starts_with(path, &ours) {
                    if *array {
                        return refused(format!("an array of {server} tables"));
                    }
                    if path.len() == ours.len() {
                        exact_headers += 1;
                    }
                    open = Some((index, index));
                }
            }
            ScannedLine::Trivia => {}
            _ if open.is_some() => {
                if let Some(section) = open.as_mut() {
                    section.1 = index;
                }
            }
            ScannedLine::KeyVal { path } => {
                let full: Vec<String> = current.iter().chain(path).cloned().collect();
                if full.len() == 1 && full[0] == "mcp_servers" {
                    return refused("mcp_servers written as an inline table".to_string());
                }
                if starts_with(&full, &ours) {
                    return refused(format!(
                        "{server} written with dotted keys or an inline table"
                    ));
                }
            }
            ScannedLine::Continuation => {}
        }
    }
    if let Some(section) = open {
        sections.push(section);
    }
    if exact_headers > 1 {
        return refused(format!("the {server} table twice"));
    }

    if let [(start, end)] = sections.as_slice()
        && same_lines(&lines[*start..=*end], table)
    {
        return CodexTomlMerge::Merged {
            text: existing.to_string(),
            changed: false,
        };
    }

    let mut out: Vec<&str> = Vec::new();
    if sections.is_empty() {
        out.extend(lines.iter().copied());
        // `split` leaves one empty string after a final newline.
        if out.last() == Some(&"") {
            out.pop();
        }
        if out.last().is_some_and(|line| !line.trim().is_empty()) {
            out.push("");
        }
        out.extend(table.iter().map(String::as_str));
        out.push("");
    } else {
        let mut cursor = 0;
        for (order, (start, end)) in sections.iter().enumerate() {
            out.extend(lines[cursor..*start].iter().copied());
            if order == 0 {
                out.extend(table.iter().map(String::as_str));
            }
            cursor = end + 1;
        }
        out.extend(lines[cursor..].iter().copied());
    }
    CodexTomlMerge::Merged {
        text: format!("{bom}{}", out.join(eol)),
        changed: true,
    }
}

#[cfg(test)]
mod tests;
