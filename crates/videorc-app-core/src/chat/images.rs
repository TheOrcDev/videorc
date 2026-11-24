//! A chat image's bytes through the backend's route (plan 220 S1.6a).
//!
//! `chatImages.cache {url, kind}` answers this run's loopback URL for a
//! cached file (`http://127.0.0.1:<port>/chat-images/<file>?key=<key>`), or
//! null for a URL the allowlist refuses. The route serves cached files only
//! and needs its key; this reads one file from it, as the renderer's `<img>`
//! does, with the avatar's 2 MB cap and a deadline. Only a loopback `http`
//! URL is ever read, so nothing here can reach the network.

use std::time::Duration;

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;

/// The route's largest avatar or emote (`AVATAR_MAX_BYTES`).
pub const MAX_IMAGE_BYTES: usize = 2 * 1024 * 1024;
/// How long one read may take (the route reads a local file).
pub const READ_DEADLINE: Duration = Duration::from_secs(4);

/// Why a route read gave no picture.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RouteError {
    /// Not this run's loopback route.
    NotLoopback,
    /// The route answered something other than 200 (a stale key after a
    /// backend restart, a pruned file).
    Status(u16),
    TooLarge,
    Io(String),
    Timeout,
}

impl std::fmt::Display for RouteError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::NotLoopback => write!(f, "not the chat image route"),
            Self::Status(code) => write!(f, "the route answered {code}"),
            Self::TooLarge => write!(f, "the image is over the route's cap"),
            Self::Io(error) => write!(f, "{error}"),
            Self::Timeout => write!(f, "the route did not answer in time"),
        }
    }
}

/// The loopback route's port and path (with its query), or `None` for
/// anything else (`chatImageRoute`).
pub fn route_target(url: &str) -> Option<(u16, String)> {
    let parsed = url::Url::parse(url).ok()?;
    if parsed.scheme() != "http" {
        return None;
    }
    match parsed.host() {
        Some(url::Host::Ipv4(ip)) if ip.is_loopback() => {}
        _ => return None,
    }
    let port = parsed.port()?;
    if !parsed.path().starts_with("/chat-images/") {
        return None;
    }
    let path = match parsed.query() {
        Some(query) => format!("{}?{query}", parsed.path()),
        None => parsed.path().to_string(),
    };
    Some((port, path))
}

/// The file's bytes from the route.
pub async fn read_route(url: &str) -> Result<Vec<u8>, RouteError> {
    let (port, path) = route_target(url).ok_or(RouteError::NotLoopback)?;
    tokio::time::timeout(READ_DEADLINE, read(port, &path))
        .await
        .map_err(|_| RouteError::Timeout)?
}

/// Plan 220 S3.7a: one file from another of the backend's loopback routes
/// (the Library's posters, `/sessions/{id}/poster?token=`), with the same
/// cap and deadline. Only `127.0.0.1` is ever read.
pub async fn read_loopback(port: u16, path: &str) -> Result<Vec<u8>, RouteError> {
    tokio::time::timeout(READ_DEADLINE, read(port, path))
        .await
        .map_err(|_| RouteError::Timeout)?
}

async fn read(port: u16, path: &str) -> Result<Vec<u8>, RouteError> {
    let io = |error: std::io::Error| RouteError::Io(error.to_string());
    let mut stream = TcpStream::connect(("127.0.0.1", port)).await.map_err(io)?;
    let request = format!(
        "GET {path} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nAccept: image/*\r\nConnection: close\r\n\r\n"
    );
    stream.write_all(request.as_bytes()).await.map_err(io)?;
    let mut response = Vec::new();
    let mut chunk = [0u8; 16 * 1024];
    loop {
        let read = stream.read(&mut chunk).await.map_err(io)?;
        if read == 0 {
            break;
        }
        response.extend_from_slice(&chunk[..read]);
        if response.len() > MAX_IMAGE_BYTES + 16 * 1024 {
            return Err(RouteError::TooLarge);
        }
    }
    parse_response(&response)
}

/// An HTTP/1.1 answer's body, when it is a 200 with a body the length says
/// (the route always sends `Content-Length`; a chunked answer is read as
/// such too).
pub fn parse_response(response: &[u8]) -> Result<Vec<u8>, RouteError> {
    let malformed = || RouteError::Io("the route's answer did not read".into());
    let split = response
        .windows(4)
        .position(|window| window == b"\r\n\r\n")
        .ok_or_else(malformed)?;
    let head = std::str::from_utf8(&response[..split]).map_err(|_| malformed())?;
    let body = &response[split + 4..];
    let mut lines = head.split("\r\n");
    let status = lines
        .next()
        .and_then(|line| line.split_whitespace().nth(1))
        .and_then(|code| code.parse::<u16>().ok())
        .ok_or_else(malformed)?;
    if status != 200 {
        return Err(RouteError::Status(status));
    }
    let mut length = None;
    let mut chunked = false;
    for line in lines {
        let Some((name, value)) = line.split_once(':') else {
            continue;
        };
        let value = value.trim();
        if name.eq_ignore_ascii_case("content-length") {
            length = value.parse::<usize>().ok();
        } else if name.eq_ignore_ascii_case("transfer-encoding")
            && value.eq_ignore_ascii_case("chunked")
        {
            chunked = true;
        }
    }
    let body = if chunked {
        dechunk(body).ok_or_else(malformed)?
    } else {
        match length {
            Some(length) if body.len() >= length => body[..length].to_vec(),
            Some(_) => return Err(malformed()),
            None => body.to_vec(),
        }
    };
    if body.len() > MAX_IMAGE_BYTES {
        return Err(RouteError::TooLarge);
    }
    if body.is_empty() {
        return Err(malformed());
    }
    Ok(body)
}

fn dechunk(mut body: &[u8]) -> Option<Vec<u8>> {
    let mut out = Vec::new();
    loop {
        let line_end = body.windows(2).position(|window| window == b"\r\n")?;
        let size_text = std::str::from_utf8(&body[..line_end]).ok()?;
        let size = usize::from_str_radix(size_text.split(';').next()?.trim(), 16).ok()?;
        body = &body[line_end + 2..];
        if size == 0 {
            return Some(out);
        }
        if body.len() < size + 2 {
            return None;
        }
        out.extend_from_slice(&body[..size]);
        body = &body[size + 2..];
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::net::TcpListener;

    #[test]
    fn only_the_loopback_route_is_read() {
        assert_eq!(
            route_target("http://127.0.0.1:4100/chat-images/ab.png?key=k"),
            Some((4100, "/chat-images/ab.png?key=k".to_string()))
        );
        assert_eq!(
            route_target("https://127.0.0.1:4100/chat-images/ab.png"),
            None
        );
        assert_eq!(
            route_target("http://example.com:4100/chat-images/ab.png"),
            None
        );
        assert_eq!(route_target("http://127.0.0.1:4100/other/ab.png"), None);
        assert_eq!(
            route_target("http://10.0.0.1:4100/chat-images/ab.png"),
            None
        );
        assert_eq!(route_target("not a url"), None);
    }

    #[test]
    fn an_answer_reads_by_its_length_or_its_chunks() {
        assert_eq!(
            parse_response(b"HTTP/1.1 200 OK\r\ncontent-length: 3\r\n\r\nabcEXTRA"),
            Ok(b"abc".to_vec())
        );
        assert_eq!(
            parse_response(b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n3\r\nabc\r\n2\r\nde\r\n0\r\n\r\n"),
            Ok(b"abcde".to_vec())
        );
        assert_eq!(
            parse_response(b"HTTP/1.1 401 Unauthorized\r\ncontent-length: 0\r\n\r\n"),
            Err(RouteError::Status(401))
        );
        assert!(parse_response(b"garbage").is_err());
    }

    #[tokio::test]
    async fn a_route_read_returns_the_files_bytes() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut request = [0u8; 1024];
            let read = socket.read(&mut request).await.unwrap();
            let request = String::from_utf8_lossy(&request[..read]).to_string();
            socket
                .write_all(
                    b"HTTP/1.1 200 OK\r\ncontent-type: image/png\r\ncontent-length: 4\r\n\r\nPNG!",
                )
                .await
                .unwrap();
            request
        });
        let bytes = read_route(&format!("http://127.0.0.1:{port}/chat-images/a.png?key=k"))
            .await
            .unwrap();
        assert_eq!(bytes, b"PNG!");
        let request = server.await.unwrap();
        assert!(request.starts_with("GET /chat-images/a.png?key=k HTTP/1.1\r\n"));
        assert_eq!(
            read_route("https://yt3.ggpht.com/a.png").await,
            Err(RouteError::NotLoopback)
        );
    }
}
