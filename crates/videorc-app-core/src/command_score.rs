//! Plan 220 S3.5d.1: cmdk's filter (`cmdk` 1.1.1, `command-score`), the
//! score every Electron `Command` list sorts and hides its items by: a
//! continuous run of characters scores 1, a jump to the next word 0.9 (after
//! a space or `-`) or 0.8 (after `\ / _ + . # " @ [ ( { &`), a jump inside a
//! word 0.17; each skipped character, a case mismatch and an incomplete
//! match cost a little; a transposed pair is worth a tenth. 0 means "no
//! match": cmdk hides the item.
//!
//! Ported line for line (the recursion, the memo, the transposition and the
//! repeated-letter rules), on Unicode scalars where JavaScript walks UTF-16
//! units; a character whose lower case is longer than one character keeps
//! its first, so the string and its lower-cased twin stay aligned.

use std::collections::HashMap;

const SCORE_CONTINUE_MATCH: f64 = 1.0;
const SCORE_SPACE_WORD_JUMP: f64 = 0.9;
const SCORE_NON_SPACE_WORD_JUMP: f64 = 0.8;
const SCORE_CHARACTER_JUMP: f64 = 0.17;
const SCORE_TRANSPOSITION: f64 = 0.1;
const PENALTY_SKIPPED: f64 = 0.999;
const PENALTY_CASE_MISMATCH: f64 = 0.9999;
const PENALTY_NOT_COMPLETE: f64 = 0.99;

/// `IS_GAP_REGEXP`: `[\\\/_+.#"@\[\(\{&]`.
fn is_gap(c: char) -> bool {
    matches!(
        c,
        '\\' | '/' | '_' | '+' | '.' | '#' | '"' | '@' | '[' | '(' | '{' | '&'
    )
}

/// `IS_SPACE_REGEXP`: `[\s-]`.
fn is_space(c: char) -> bool {
    c.is_whitespace() || c == '-'
}

fn lower(c: char) -> char {
    c.to_lowercase().next().unwrap_or(c)
}

/// `formatInput`: lower case, every space character a plain space.
fn format_input(chars: &[char]) -> Vec<char> {
    chars
        .iter()
        .map(|&c| if is_space(c) { ' ' } else { lower(c) })
        .collect()
}

/// `charAt`: `None` past either end (JavaScript's `""`).
fn at(chars: &[char], index: isize) -> Option<char> {
    usize::try_from(index)
        .ok()
        .and_then(|i| chars.get(i).copied())
}

/// `indexOf(char, from)`.
fn index_of(chars: &[char], needle: Option<char>, from: usize) -> Option<usize> {
    let needle = needle?;
    chars
        .iter()
        .skip(from)
        .position(|&c| c == needle)
        .map(|i| i + from)
}

struct Inner<'a> {
    string: &'a [char],
    abbreviation: &'a [char],
    lower_string: &'a [char],
    lower_abbreviation: &'a [char],
    memo: HashMap<(usize, usize), f64>,
}

impl Inner<'_> {
    fn score(&mut self, string_index: usize, abbreviation_index: usize) -> f64 {
        if abbreviation_index >= self.abbreviation.len() {
            return if string_index == self.string.len() {
                SCORE_CONTINUE_MATCH
            } else {
                PENALTY_NOT_COMPLETE
            };
        }
        if let Some(&known) = self.memo.get(&(string_index, abbreviation_index)) {
            return known;
        }
        let abbreviation_char = self.lower_abbreviation.get(abbreviation_index).copied();
        let next_abbreviation = at(self.lower_abbreviation, abbreviation_index as isize + 1);
        let mut index = index_of(self.lower_string, abbreviation_char, string_index);
        let mut high_score = 0.0_f64;

        while let Some(found) = index {
            let mut score = self.score(found + 1, abbreviation_index + 1);
            if score > high_score {
                let before = at(self.string, found as isize - 1);
                if found == string_index {
                    score *= SCORE_CONTINUE_MATCH;
                } else if before.is_some_and(is_gap) {
                    score *= SCORE_NON_SPACE_WORD_JUMP;
                    let breaks = self.string[string_index..found - 1]
                        .iter()
                        .filter(|&&c| is_gap(c))
                        .count();
                    if breaks > 0 && string_index > 0 {
                        score *= PENALTY_SKIPPED.powf(breaks as f64);
                    }
                } else if before.is_some_and(is_space) {
                    score *= SCORE_SPACE_WORD_JUMP;
                    let breaks = self.string[string_index..found - 1]
                        .iter()
                        .filter(|&&c| is_space(c))
                        .count();
                    if breaks > 0 && string_index > 0 {
                        score *= PENALTY_SKIPPED.powf(breaks as f64);
                    }
                } else {
                    score *= SCORE_CHARACTER_JUMP;
                    if string_index > 0 {
                        score *= PENALTY_SKIPPED.powf((found - string_index) as f64);
                    }
                }
                if self.string.get(found) != self.abbreviation.get(abbreviation_index) {
                    score *= PENALTY_CASE_MISMATCH;
                }
            }

            let before_lower = at(self.lower_string, found as isize - 1);
            if (score < SCORE_TRANSPOSITION && before_lower == next_abbreviation)
                || (next_abbreviation == abbreviation_char && before_lower != abbreviation_char)
            {
                let transposed = self.score(found + 1, abbreviation_index + 2);
                if transposed * SCORE_TRANSPOSITION > score {
                    score = transposed * SCORE_TRANSPOSITION;
                }
            }

            if score > high_score {
                high_score = score;
            }
            index = index_of(self.lower_string, abbreviation_char, found + 1);
        }

        self.memo
            .insert((string_index, abbreviation_index), high_score);
        high_score
    }
}

/// `commandScore(string, abbreviation, aliases)`: how well `search` matches
/// an item's value and its keywords (joined after the value with spaces).
/// 0 is no match.
pub fn command_score(value: &str, search: &str, keywords: &[&str]) -> f64 {
    let joined = if keywords.is_empty() {
        value.to_string()
    } else {
        format!("{value} {}", keywords.join(" "))
    };
    let string: Vec<char> = joined.chars().collect();
    let abbreviation: Vec<char> = search.chars().collect();
    let lower_string = format_input(&string);
    let lower_abbreviation = format_input(&abbreviation);
    Inner {
        string: &string,
        abbreviation: &abbreviation,
        lower_string: &lower_string,
        lower_abbreviation: &lower_abbreviation,
        memo: HashMap::new(),
    }
    .score(0, 0)
}

/// What a cmdk list shows for `search`: every item in order when the search
/// is empty; otherwise the items that score above 0, best first (a stable
/// sort, so equal scores keep their order). `items` yields each item's value
/// and keywords; the answer is their indices.
pub fn filter_sorted<'a, I>(items: I, search: &str) -> Vec<usize>
where
    I: IntoIterator<Item = (&'a str, Vec<&'a str>)>,
{
    let scored = items
        .into_iter()
        .enumerate()
        .map(|(i, (value, keywords))| {
            let score = if search.is_empty() {
                1.0
            } else {
                command_score(value, search, &keywords)
            };
            (i, score)
        })
        .filter(|(_, score)| *score > 0.0);
    let mut scored: Vec<(usize, f64)> = scored.collect();
    if !search.is_empty() {
        scored.sort_by(|a, b| b.1.total_cmp(&a.1));
    }
    scored.into_iter().map(|(i, _)| i).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Each case's score from cmdk 1.1.1 itself (node, `chunk-NZJY6EH4.mjs`).
    #[test]
    fn scores_match_cmdk() {
        let cases: &[(&str, &str, &str, f64)] = &[
            (
                "Europe/Madrid",
                "madrid",
                "Europe/Madrid",
                0.799_920_000_000_000_1,
            ),
            (
                "America/New_York",
                "new york",
                "America/New York",
                0.799_840_008_000_000_1,
            ),
            (
                "America/New_York",
                "ny",
                "America/New York",
                0.712_657_447_128,
            ),
            ("America/Managua", "mad", "America/Managua", 0.0),
            (
                "Asia/Kolkata",
                "kol",
                "Asia/Kolkata",
                0.791_920_800_000_000_1,
            ),
            ("Europe/London", "EUR", "Europe/London", 0.989_802_009_9),
            ("Europe/London", "xyz", "Europe/London", 0.0),
            ("UTC", "utc", "UTC", 0.989_703_029_699_01),
            (
                "America/Argentina/Buenos_Aires",
                "buenos",
                "America/Argentina/Buenos Aires",
                0.791_920_800_000_000_1,
            ),
            (
                "Pacific/Port_Moresby",
                "port m",
                "Pacific/Port Moresby",
                0.791_841_607_920_000_1,
            ),
            (
                "Australia/Sydney",
                "sydeny",
                "Australia/Sydney",
                0.079_992_000_000_000_02,
            ),
            (
                "Europe/Berlin",
                "eb",
                "Europe/Berlin",
                0.791_841_607_920_000_1,
            ),
            (
                "Europe/Zurich",
                "zz",
                "Europe/Zurich",
                0.633_473_286_336_000_1,
            ),
            (
                "America/Los_Angeles",
                "la",
                "America/Los Angeles",
                0.712_657_447_128,
            ),
            (
                "America/Los_Angeles",
                "los-angeles",
                "America/Los Angeles",
                0.799_760_023_999_200_1,
            ),
            ("Asia/Tokyo", "ot", "Asia/Tokyo", 0.134_626_536_000_000_02),
        ];
        for (value, search, keyword, want) in cases {
            let got = command_score(value, search, &[keyword]);
            assert!(
                (got - want).abs() < 1e-12,
                "{value} / {search}: got {got}, cmdk {want}"
            );
        }
    }

    #[test]
    fn an_empty_search_keeps_every_item_in_order() {
        let items = ["b", "a", "c"];
        let order = filter_sorted(items.iter().map(|v| (*v, Vec::new())), "");
        assert_eq!(order, vec![0, 1, 2]);
    }

    #[test]
    fn a_search_hides_misses_and_puts_the_best_first() {
        let items = [
            "Europe/Berlin",
            "Europe/Madrid",
            "Atlantic/Madeira",
            "Asia/Tokyo",
        ];
        let order = filter_sorted(items.iter().map(|v| (*v, vec![*v])), "madrid");
        assert_eq!(order.first(), Some(&1));
        assert!(!order.contains(&3), "Tokyo has no m-a-d-r-i-d");
    }
}
