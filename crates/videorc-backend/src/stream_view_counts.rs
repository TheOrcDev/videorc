//! Pure provider-view observation policy. Views are not concurrent viewers or
//! unique people. A later valid provider correction may lower the count.
pub const MAX_COUNT: u64 = 100_000_000;

pub fn parse_count(raw: &str) -> Option<u64> {
    if raw.is_empty() || !raw.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    raw.parse::<u64>().ok().filter(|count| *count <= MAX_COUNT)
}

/// Missing/invalid/stale reads preserve known data. A genuine zero is data.
/// Equal timestamps keep the first observation, never choose a peak.
pub fn observe(previous: Option<(u64, i64)>, next: Option<(u64, i64)>) -> Option<(u64, i64)> {
    match next.filter(|(count, _)| *count <= MAX_COUNT) {
        Some(next) if previous.is_none_or(|(_, at)| next.1 > at) => Some(next),
        _ => previous,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn missing_stale_and_overflow_reads_cannot_erase_a_known_count() {
        let previous = Some((1203, 100));
        for next in [
            None,
            Some((0, 99)),
            Some((9999, 100)),
            Some((MAX_COUNT + 1, 200)),
        ] {
            assert_eq!(observe(previous, next), previous);
        }
    }
    #[test]
    fn a_later_provider_correction_is_not_replaced_by_a_peak_or_sum() {
        let mut known = None;
        for next in [(1203, 100), (1200, 200), (1300, 300)] {
            known = observe(known, Some(next));
            assert_eq!(known, Some(next));
        }
        assert_eq!(observe(known, Some((0, 400))), Some((0, 400)));
    }
    #[test]
    fn provider_strings_are_bounded_unsigned_counts_and_zero_is_known() {
        assert_eq!(parse_count("0"), Some(0));
        assert_eq!(parse_count("1203"), Some(1203));
        assert_eq!(parse_count("100000000"), Some(MAX_COUNT));
        for raw in [
            "",
            "-1",
            "+1",
            "1.5",
            "1e3",
            " 12 ",
            "NaN",
            "100000001",
            "18446744073709551616",
        ] {
            assert_eq!(parse_count(raw), None, "{raw}");
        }
    }
}
