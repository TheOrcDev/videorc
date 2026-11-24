//! The one HTTP/1.1 response parser the loopback calls share (the shutdown
//! preparation in [`crate::process`] and the interruption lease in
//! [`crate::interruption`]). Small enough that the app does not need an HTTP
//! client crate.
//!
//! The response is split and de-chunked as bytes and only then decoded as
//! UTF-8, so a chunk boundary inside a multi-byte character cannot panic.

use anyhow::{Result, anyhow};

/// A parsed response: the status code and the body as text.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct HttpResponse {
    pub status: u16,
    pub body: String,
}

/// Parses a whole `Connection: close` response.
pub(crate) fn parse_response(raw: &[u8]) -> Result<HttpResponse> {
    let split = find(raw, b"\r\n\r\n").ok_or_else(|| anyhow!("malformed HTTP response"))?;
    let head = String::from_utf8_lossy(&raw[..split]);
    let body = &raw[split + 4..];
    let status = head
        .lines()
        .next()
        .and_then(|line| line.split_whitespace().nth(1))
        .and_then(|code| code.parse::<u16>().ok())
        .ok_or_else(|| anyhow!("malformed HTTP status line: {head}"))?;
    let chunked = head
        .lines()
        .any(|line| line.to_ascii_lowercase().trim() == "transfer-encoding: chunked");
    let body = if chunked {
        decode_chunked(body)
    } else {
        body.to_vec()
    };
    Ok(HttpResponse {
        status,
        body: String::from_utf8_lossy(&body).into_owned(),
    })
}

fn find(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack
        .windows(needle.len())
        .position(|window| window == needle)
}

/// Joins the chunks of a chunked body; stops at the last chunk or at the
/// first malformed or truncated one.
fn decode_chunked(body: &[u8]) -> Vec<u8> {
    let mut decoded = Vec::new();
    let mut rest = body;
    while let Some(line_end) = find(rest, b"\r\n") {
        let size_line = String::from_utf8_lossy(&rest[..line_end]);
        let size = usize::from_str_radix(size_line.trim().split(';').next().unwrap_or("0"), 16)
            .unwrap_or(0);
        let after = &rest[line_end + 2..];
        if size == 0 || after.len() < size {
            break;
        }
        decoded.extend_from_slice(&after[..size]);
        rest = after[size..].strip_prefix(b"\r\n").unwrap_or(&[]);
    }
    decoded
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn chunked_bodies_decode() {
        assert_eq!(decode_chunked(b"5\r\nhello\r\n0\r\n\r\n"), b"hello");
        assert_eq!(decode_chunked(b"2\r\n{}\r\n0\r\n\r\n"), b"{}");
    }

    #[test]
    fn a_chunk_boundary_inside_a_character_does_not_panic() {
        // "é" is two bytes (C3 A9); the first chunk ends between them.
        let raw = b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n2\r\n\"\xC3\r\n2\r\n\xA9\"\r\n0\r\n\r\n";
        let response = parse_response(raw).unwrap();
        assert_eq!(response.status, 200);
        assert_eq!(response.body, "\"é\"");
    }

    #[test]
    fn a_plain_body_and_a_bad_head_are_handled() {
        let response = parse_response(b"HTTP/1.1 409 Conflict\r\nX: y\r\n\r\n{\"a\":1}").unwrap();
        assert_eq!(response.status, 409);
        assert_eq!(response.body, "{\"a\":1}");
        assert!(parse_response(b"HTTP/1.1 200 OK\r\n").is_err());
        assert!(parse_response(b"garbage\r\n\r\n").is_err());
    }
}
