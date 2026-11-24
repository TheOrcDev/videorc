//! Plan 260 S0.2b: `preview.handover.open` and `preview.handover.close`, the
//! lease on the Windows preview hand-over (`windows_d3d11_preview_handover.rs`
//! has the contract). Like the macOS frame lease (`preview.surface.frame.*`),
//! these run on the socket's own task, never as detached work, so a closing
//! connection always releases the hand-over it holds. Main-process (admin)
//! credential only: the lease puts handles into another process.

use crate::backend_authority::BackendRole;
use crate::protocol::{
    ClientCommand, PreviewHandoverCloseParams, PreviewHandoverLease, PreviewHandoverOpenParams,
    ServerResponse,
};
use crate::state::AppState;
use uuid::Uuid;

const OPEN: &str = "preview.handover.open";
const CLOSE: &str = "preview.handover.close";

/// The hand-over one connection holds; dropping it closes the hand-over.
#[derive(Default)]
pub(crate) struct HeldPreviewHandover {
    held: Option<Held>,
}

struct Held {
    lease_id: String,
    /// Closes the hand-over on the media thread (queued, never waited on).
    close: Option<Box<dyn FnOnce() + Send>>,
}

impl Drop for Held {
    fn drop(&mut self) {
        if let Some(close) = self.close.take() {
            close();
        }
    }
}

type OpenError = (&'static str, String);

pub(crate) async fn handle_preview_handover_control(
    state: &AppState,
    role: BackendRole,
    lease: &mut HeldPreviewHandover,
    text: &str,
) -> Option<ServerResponse> {
    if !text.contains("preview.handover.") {
        return None;
    }
    let command = serde_json::from_str::<ClientCommand>(text).ok()?;
    if command.method != OPEN && command.method != CLOSE {
        return None;
    }
    if role != BackendRole::Admin {
        return Some(ServerResponse::error(
            command.id,
            "forbidden",
            "The preview hand-over requires the main-process credential.",
        ));
    }
    if command.method == CLOSE {
        return Some(
            match serde_json::from_value::<PreviewHandoverCloseParams>(command.params) {
                Ok(params) => {
                    let matches = lease
                        .held
                        .as_ref()
                        .is_some_and(|held| held.lease_id == params.lease_id);
                    if matches {
                        lease.held = None;
                    }
                    ServerResponse::ok(command.id, matches)
                }
                Err(_) => ServerResponse::error(
                    command.id,
                    "invalid-params",
                    "Invalid preview hand-over close parameters.",
                ),
            },
        );
    }
    let params = match serde_json::from_value::<PreviewHandoverOpenParams>(command.params) {
        Ok(params) if Uuid::parse_str(&params.lease_id).is_ok() && params.consumer_pid != 0 => {
            params
        }
        _ => {
            return Some(ServerResponse::error(
                command.id,
                "invalid-params",
                "Invalid preview hand-over open parameters.",
            ));
        }
    };
    if lease.held.is_some() {
        return Some(ServerResponse::error(
            command.id,
            "preview-handover-busy",
            "This connection already holds a preview hand-over; close it first.",
        ));
    }
    Some(match open(state, params).await {
        Ok((granted, held)) => {
            lease.held = Some(held);
            ServerResponse::ok(command.id, granted)
        }
        Err((code, message)) => ServerResponse::error(command.id, code, message),
    })
}

#[cfg(not(target_os = "windows"))]
async fn open(
    _state: &AppState,
    _params: PreviewHandoverOpenParams,
) -> Result<(PreviewHandoverLease, Held), OpenError> {
    Err((
        "unsupported-platform",
        "The preview hand-over is Windows only (plan 260 S0.2b); on macOS the app leases the \
         IOSurface with preview.surface.frame.acquire."
            .to_string(),
    ))
}

#[cfg(target_os = "windows")]
async fn open(
    state: &AppState,
    params: PreviewHandoverOpenParams,
) -> Result<(PreviewHandoverLease, Held), OpenError> {
    use crate::windows_d3d11_preview_handover::{HANDOVER_HEADER_BYTES, HANDOVER_VERSION};

    let monitor = crate::recording::windows_d3d11_preview_monitor(state)
        .await
        .ok_or_else(|| {
            (
                "preview-handover-unavailable",
                "No D3D11 media session is running. The hand-over serves the session's \
                 preview: start the Clips ring, a recording or a stream, then ask again."
                    .to_string(),
            )
        })?;
    let opener = monitor.clone();
    let (route, consumer_pid) = (params.route, params.consumer_pid);
    // The media thread creates GPU resources and duplicates handles; the
    // client waits on its reply, so keep that wait off the async workers.
    let grant =
        tokio::task::spawn_blocking(move || opener.open_preview_handover(route, consumer_pid))
            .await
            .map_err(|error| ("preview-handover-failed", error.to_string()))?
            .map_err(|error| {
                let message = error.to_string();
                let code = if message.contains("preview-handover-busy") {
                    "preview-handover-busy"
                } else {
                    "preview-handover-failed"
                };
                (code, message)
            })?;
    let granted = PreviewHandoverLease {
        lease_id: params.lease_id.clone(),
        route,
        media_generation: grant.media_generation,
        adapter_luid: grant.adapter_luid.as_u64(),
        backend_pid: std::process::id(),
        header_mapping_handle: grant.header_mapping_handle,
        header_bytes: HANDOVER_HEADER_BYTES,
        header_version: HANDOVER_VERSION,
        frame_event_handle: grant.frame_event_handle,
        composition_surface_handle: grant.composition_surface_handle,
        pixel_format: "bgra8".to_string(),
    };
    // The token closes only this hand-over, never a newer one another
    // lease opened on the same generation.
    let token = grant.token;
    Ok((
        granted,
        Held {
            lease_id: params.lease_id,
            close: Some(Box::new(move || monitor.close_preview_handover(token))),
        },
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn test_state() -> AppState {
        let (events, _) = tokio::sync::broadcast::channel(16);
        AppState::new(
            "test-token".to_string(),
            1234,
            events,
            crate::storage::Database::open_in_memory_for_tests(),
        )
    }

    fn open_request(lease_id: &str, route: &str, pid: u32) -> String {
        json!({"id": "open", "method": OPEN,
            "params": {"leaseId": lease_id, "route": route, "consumerPid": pid}})
        .to_string()
    }

    #[tokio::test]
    async fn preview_handover_ignores_other_methods() {
        let state = test_state();
        let mut lease = HeldPreviewHandover::default();
        for text in [
            json!({"id": "1", "method": "preview.surface.status"}).to_string(),
            json!({"id": "2", "method": "preview.handover.peek"}).to_string(),
            "preview.handover. but not json".to_string(),
        ] {
            assert!(
                handle_preview_handover_control(&state, BackendRole::Admin, &mut lease, &text)
                    .await
                    .is_none()
            );
        }
    }

    #[tokio::test]
    async fn preview_handover_requires_the_main_process_credential() {
        let state = test_state();
        let request = open_request(&Uuid::new_v4().to_string(), "shared-texture", 4242);
        for role in [
            BackendRole::Renderer,
            BackendRole::Remote,
            BackendRole::Agent,
        ] {
            let mut lease = HeldPreviewHandover::default();
            let response = handle_preview_handover_control(&state, role, &mut lease, &request)
                .await
                .unwrap();
            assert_eq!(response.error.unwrap().code, "forbidden");
            assert!(response.payload.is_none());
            assert!(lease.held.is_none());
        }
    }

    #[tokio::test]
    async fn preview_handover_refuses_bad_open_parameters() {
        let state = test_state();
        let lease_id = Uuid::new_v4().to_string();
        for request in [
            open_request("not-a-uuid", "shared-texture", 4242),
            open_request(&lease_id, "cpu-ring", 4242),
            open_request(&lease_id, "shared-texture", 0),
            json!({"id": "open", "method": OPEN, "params": {"leaseId": lease_id,
                "route": "shared-texture", "consumerPid": 4242, "extra": true}})
            .to_string(),
        ] {
            let mut lease = HeldPreviewHandover::default();
            let response =
                handle_preview_handover_control(&state, BackendRole::Admin, &mut lease, &request)
                    .await
                    .unwrap();
            assert_eq!(response.error.unwrap().code, "invalid-params", "{request}");
        }
    }

    #[tokio::test]
    async fn preview_handover_close_answers_whether_it_closed_the_named_lease() {
        let state = test_state();
        let mut lease = HeldPreviewHandover::default();
        let close = |lease_id: &str| {
            json!({"id": "close", "method": CLOSE, "params": {"leaseId": lease_id}}).to_string()
        };
        let held_id = Uuid::new_v4().to_string();
        let closed = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let flag = std::sync::Arc::clone(&closed);
        lease.held = Some(Held {
            lease_id: held_id.clone(),
            close: Some(Box::new(move || {
                flag.store(true, std::sync::atomic::Ordering::SeqCst);
            })),
        });
        let response = handle_preview_handover_control(
            &state,
            BackendRole::Admin,
            &mut lease,
            &close(&Uuid::new_v4().to_string()),
        )
        .await
        .unwrap();
        assert_eq!(response.payload, Some(json!(false)));
        assert!(
            lease.held.is_some(),
            "a stale close keeps the current lease"
        );
        assert!(!closed.load(std::sync::atomic::Ordering::SeqCst));
        let response = handle_preview_handover_control(
            &state,
            BackendRole::Admin,
            &mut lease,
            &close(&held_id),
        )
        .await
        .unwrap();
        assert_eq!(response.payload, Some(json!(true)));
        assert!(lease.held.is_none());
        assert!(
            closed.load(std::sync::atomic::Ordering::SeqCst),
            "closing the lease closes the hand-over"
        );
    }

    #[test]
    fn preview_handover_dropped_connection_closes_the_hand_over() {
        let closed = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let flag = std::sync::Arc::clone(&closed);
        let lease = HeldPreviewHandover {
            held: Some(Held {
                lease_id: Uuid::new_v4().to_string(),
                close: Some(Box::new(move || {
                    flag.store(true, std::sync::atomic::Ordering::SeqCst);
                })),
            }),
        };
        drop(lease);
        assert!(closed.load(std::sync::atomic::Ordering::SeqCst));
    }

    #[cfg(not(target_os = "windows"))]
    #[tokio::test]
    async fn preview_handover_is_windows_only() {
        let state = test_state();
        let mut lease = HeldPreviewHandover::default();
        let request = open_request(&Uuid::new_v4().to_string(), "composition-surface", 4242);
        let response =
            handle_preview_handover_control(&state, BackendRole::Admin, &mut lease, &request)
                .await
                .unwrap();
        assert_eq!(response.error.unwrap().code, "unsupported-platform");
        assert!(lease.held.is_none());
    }

    #[cfg(target_os = "windows")]
    #[tokio::test]
    async fn preview_handover_needs_a_running_d3d11_session() {
        let state = test_state();
        let mut lease = HeldPreviewHandover::default();
        let request = open_request(
            &Uuid::new_v4().to_string(),
            "shared-texture",
            std::process::id(),
        );
        let response =
            handle_preview_handover_control(&state, BackendRole::Admin, &mut lease, &request)
                .await
                .unwrap();
        assert_eq!(response.error.unwrap().code, "preview-handover-unavailable");
        assert!(lease.held.is_none());
    }

    #[test]
    fn preview_handover_lease_wire_shape() {
        let lease = PreviewHandoverLease {
            lease_id: "00000000-0000-0000-0000-000000000001".to_string(),
            route: crate::protocol::PreviewHandoverRoute::CompositionSurface,
            media_generation: 3,
            adapter_luid: 0x1_0000_0002,
            backend_pid: 10,
            header_mapping_handle: 0x2a0,
            header_bytes: 4096,
            header_version: 1,
            frame_event_handle: 0x2a4,
            composition_surface_handle: Some(0x2a8),
            pixel_format: "bgra8".to_string(),
        };
        assert_eq!(
            serde_json::to_value(&lease).unwrap(),
            json!({
                "leaseId": "00000000-0000-0000-0000-000000000001",
                "route": "composition-surface",
                "mediaGeneration": 3,
                "adapterLuid": 4294967298u64,
                "backendPid": 10,
                "headerMappingHandle": 672,
                "headerBytes": 4096,
                "headerVersion": 1,
                "frameEventHandle": 676,
                "compositionSurfaceHandle": 680,
                "pixelFormat": "bgra8"
            })
        );
        let shared = PreviewHandoverLease {
            route: crate::protocol::PreviewHandoverRoute::SharedTexture,
            composition_surface_handle: None,
            ..lease
        };
        let value = serde_json::to_value(&shared).unwrap();
        assert_eq!(value["route"], "shared-texture");
        assert!(value.get("compositionSurfaceHandle").is_none());
    }
}
