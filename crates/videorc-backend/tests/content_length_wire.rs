//! Wire-level regression for the YouTube 411 fix: Google's front end rejects POSTs
//! without a Content-Length header, and reqwest/hyper OMIT the header for empty
//! bodies (including `.body("")` and `Vec::new()`). Parameter-only YouTube POSTs
//! (liveBroadcasts/bind, liveBroadcasts/transition) therefore set the header
//! explicitly; this test pins the only construction that actually reaches the wire.
use std::sync::{Arc, Mutex};

use axum::{Router, extract::State, http::HeaderMap, routing::post};

type Seen = Arc<Mutex<Option<String>>>;

async fn handler(State(seen): State<Seen>, headers: HeaderMap) -> &'static str {
    *seen.lock().unwrap() = headers
        .get("content-length")
        .and_then(|value| value.to_str().ok())
        .map(String::from);
    "{\"id\":\"x\"}"
}

#[tokio::test]
async fn explicit_content_length_header_survives_the_wire() {
    let seen: Seen = Arc::new(Mutex::new(None));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let state = seen.clone();
    tokio::spawn(async move {
        axum::serve(
            listener,
            Router::new()
                .route("/bind", post(handler))
                .with_state(state),
        )
        .await
        .unwrap();
    });

    reqwest::Client::new()
        .post(format!("http://{addr}/bind"))
        .bearer_auth("token")
        .header(reqwest::header::CONTENT_LENGTH, "0")
        .body("")
        .send()
        .await
        .unwrap();

    assert_eq!(seen.lock().unwrap().as_deref(), Some("0"));
}
