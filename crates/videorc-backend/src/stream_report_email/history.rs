//! YouTube's saved statistics must be stripped after Disconnect (plan 241 D3).
use super::{WebAccess, web_access};
use crate::{state::AppState, storage::Database};

const PENDING: &str = "streamHistoryYouTubeRevokedAccount";
const PATH: &str = "/api/desktop/stream-history/youtube-revoked";

fn same_account(a: &str, b: &str) -> bool {
    a.trim().eq_ignore_ascii_case(b.trim())
}

async fn post(client: &reqwest::Client, web: &WebAccess) -> bool {
    match client
        .post(format!("{}{PATH}", web.base_url))
        .bearer_auth(&web.token)
        .send()
        .await
    {
        Ok(response) if response.status().is_success() => response
            .json::<serde_json::Value>()
            .await
            .ok()
            .is_some_and(|body| body.get("ok").and_then(|v| v.as_bool()) == Some(true)),
        _ => false,
    }
}

async fn deliver(database: &Database, client: &reqwest::Client, web: &WebAccess) {
    if post(client, web).await {
        // A later Disconnect for another account may already have replaced it.
        if database
            .load_setting::<String>(PENDING)
            .ok()
            .flatten()
            .is_some_and(|email| same_account(&email, &web.email))
        {
            let _ = database.delete_setting(PENDING);
        }
    }
}

/// Capture `web` before revoking YouTube, so an account transition cannot
/// turn the old account's Disconnect into a request against a new one.
pub(crate) fn youtube_revoked(state: &AppState, web: Option<WebAccess>) {
    let Some(web) = web else {
        return;
    };
    // Persist before spawning: a crash during HTTP still retries next launch.
    if let Err(error) = state.database.save_setting(PENDING, &web.email) {
        tracing::warn!("Could not remember the stream-history cleanup: {error:#}");
    }
    let state = state.clone();
    tokio::spawn(async move {
        if let Some(client) = super::http_client() {
            deliver(&state.database, &client, &web).await;
        }
    });
}

async fn retry(database: &Database, client: &reqwest::Client, web: Option<&WebAccess>) {
    let Some(pending) = database.load_setting::<String>(PENDING).ok().flatten() else {
        return;
    };
    let Some(web) = web else {
        return;
    };
    if !same_account(&pending, &web.email) {
        let _ = database.delete_setting(PENDING);
        return;
    }
    deliver(database, client, web).await;
}

/// Called once after the launch's account refresh, off all recording paths.
pub(crate) async fn retry_at_launch(state: &AppState) {
    let Some(client) = super::http_client() else {
        return;
    };
    let web = web_access(state).await;
    retry(&state.database, &client, web.as_ref()).await;
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{
        Json, Router,
        extract::State,
        http::{HeaderMap, StatusCode},
        routing::post,
    };
    use std::sync::{Arc, Mutex};
    #[tokio::test]
    async fn success_failure_retry_and_other_account_drop() {
        let status = Arc::new(Mutex::new((200u16, 0usize)));
        let app = Router::new()
            .route(
                PATH,
                post(
                    |State(s): State<Arc<Mutex<(u16, usize)>>>,
                     headers: HeaderMap,
                     body: axum::body::Bytes| async move {
                        assert_eq!(headers["authorization"], "Bearer fake");
                        assert!(body.is_empty());
                        let mut s = s.lock().unwrap();
                        s.1 += 1;
                        (
                            StatusCode::from_u16(s.0).unwrap(),
                            Json(serde_json::json!({"ok":true,"stripped":2})),
                        )
                    },
                ),
            )
            .with_state(status.clone());
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let web = WebAccess {
            base_url: format!("http://{}", listener.local_addr().unwrap()),
            token: "fake".into(),
            email: "ada@example.com".into(),
        };
        let task = tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        let db = Database::open_in_memory_for_tests();
        let client = reqwest::Client::new();
        db.save_setting(PENDING, &web.email).unwrap();
        deliver(&db, &client, &web).await;
        assert!(db.load_setting::<String>(PENDING).unwrap().is_none());
        db.save_setting(PENDING, &web.email).unwrap();
        status.lock().unwrap().0 = 503;
        deliver(&db, &client, &web).await;
        assert_eq!(
            db.load_setting::<String>(PENDING).unwrap().as_deref(),
            Some("ada@example.com")
        );
        // Signed out leaves the flag, never calls the web.
        retry(&db, &client, None).await;
        assert_eq!(status.lock().unwrap().1, 2);
        status.lock().unwrap().0 = 200;
        retry(&db, &client, Some(&web)).await;
        assert!(db.load_setting::<String>(PENDING).unwrap().is_none());
        db.save_setting(PENDING, &"bo@example.com").unwrap();
        retry(&db, &client, Some(&web)).await;
        assert!(db.load_setting::<String>(PENDING).unwrap().is_none());
        assert_eq!(status.lock().unwrap().1, 3);
        task.abort();
    }
}
