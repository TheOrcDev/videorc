//! The one HTTP/1.1 response parser the loopback calls share (the shutdown
//! preparation in [`crate::process`], the interruption lease in
//! [`crate::interruption`] and the Library's posters, [`get_bytes`]). Small
//! enough that the app does not need an HTTP client crate.
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
    let (status, body) = parse_response_bytes(raw)?;
    Ok(HttpResponse {
        status,
        body: String::from_utf8_lossy(&body).into_owned(),
    })
}

/// Parses a whole `Connection: close` response, its body as bytes (a
/// picture).
pub(crate) fn parse_response_bytes(raw: &[u8]) -> Result<(u16, Vec<u8>)> {
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
    Ok((status, body))
}

/// `GET {path}` on the backend's loopback server: a 200's body, refused past
/// `max_bytes` or `deadline`. Anything but a 200 is an error.
pub(crate) async fn get_bytes(
    port: u16,
    path: &str,
    accept: &str,
    max_bytes: usize,
    deadline: std::time::Duration,
) -> Result<Vec<u8>> {
    let response = get_raw(port, path, accept, max_bytes, deadline).await?;
    let (status, body) = parse_response_bytes(&response)?;
    if status != 200 {
        return Err(anyhow!("HTTP {status}"));
    }
    Ok(body)
}

/// `GET {path}` with the answer's status and headers too (a frame route's
/// cursor rides in its headers; a 204 is an answer, not an error). Header
/// names are lowercase.
pub(crate) async fn get_with_headers(
    port: u16,
    path: &str,
    accept: &str,
    max_bytes: usize,
    deadline: std::time::Duration,
) -> Result<(u16, Vec<(String, String)>, Vec<u8>)> {
    let response = get_raw(port, path, accept, max_bytes, deadline).await?;
    let (status, body) = parse_response_bytes(&response)?;
    let split = find(&response, b"\r\n\r\n").unwrap_or(response.len());
    let headers = String::from_utf8_lossy(&response[..split])
        .lines()
        .skip(1)
        .filter_map(|line| {
            let (name, value) = line.split_once(':')?;
            Some((name.trim().to_ascii_lowercase(), value.trim().to_string()))
        })
        .collect();
    Ok((status, headers, body))
}

/// The whole raw answer of one `Connection: close` GET.
async fn get_raw(
    port: u16,
    path: &str,
    accept: &str,
    max_bytes: usize,
    deadline: std::time::Duration,
) -> Result<Vec<u8>> {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let read = async {
        let mut stream = tokio::net::TcpStream::connect(("127.0.0.1", port)).await?;
        let request = format!(
            "GET {path} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nAccept: {accept}\r\nConnection: close\r\n\r\n"
        );
        stream.write_all(request.as_bytes()).await?;
        let mut response = Vec::new();
        let mut chunk = [0u8; 16 * 1024];
        loop {
            let read = stream.read(&mut chunk).await?;
            if read == 0 {
                break;
            }
            response.extend_from_slice(&chunk[..read]);
            if response.len() > max_bytes + 16 * 1024 {
                return Err(anyhow!("the answer is over {max_bytes} bytes"));
            }
        }
        Ok(response)
    };
    tokio::time::timeout(deadline, read)
        .await
        .map_err(|_| anyhow!("no answer in {deadline:?}"))?
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

    /// The poster read: a binary body comes back byte for byte; anything but
    /// a 200, or a body past the limit, is an error.
    #[tokio::test]
    async fn get_bytes_reads_a_picture_and_refuses_the_rest() {
        async fn serve(answer: Vec<u8>) -> u16 {
            let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
                .await
                .unwrap();
            let port = listener.local_addr().unwrap().port();
            tokio::spawn(async move {
                use tokio::io::{AsyncReadExt, AsyncWriteExt};
                let (mut stream, _) = listener.accept().await.unwrap();
                let mut request = [0u8; 1024];
                let _ = stream.read(&mut request).await;
                stream.write_all(&answer).await.unwrap();
            });
            port
        }
        let deadline = std::time::Duration::from_secs(2);
        let picture: Vec<u8> = vec![0x89, b'P', b'N', b'G', 0x00, 0xff, 0xc3];
        let mut ok = format!(
            "HTTP/1.1 200 OK\r\nContent-Length: {}\r\n\r\n",
            picture.len()
        )
        .into_bytes();
        ok.extend_from_slice(&picture);
        let port = serve(ok).await;
        assert_eq!(
            get_bytes(port, "/p", "image/*", 1024, deadline)
                .await
                .unwrap(),
            picture
        );
        let port = serve(b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n".to_vec()).await;
        assert!(
            get_bytes(port, "/p", "image/*", 1024, deadline)
                .await
                .is_err()
        );
        let mut big = b"HTTP/1.1 200 OK\r\n\r\n".to_vec();
        big.extend(std::iter::repeat_n(0u8, 40 * 1024));
        let port = serve(big).await;
        assert!(
            get_bytes(port, "/p", "image/*", 1024, deadline)
                .await
                .is_err()
        );
    }
}
