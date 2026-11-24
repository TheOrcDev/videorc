//! Resource capabilities (plan 260 S2.6a, from `videorc-rust`'s
//! `resources`, plan 220 S3.0i), as Electron main issues them
//! (`main/resource-capabilities.ts`).
//!
//! **Who issues, who checks.** A page never sends the backend a path on the
//! Studio's credential: the backend refuses one there. The app checks the
//! path ([`capability::canonical_resource_path`]) and asks the backend for a
//! capability on the admin credential (`resource.capability.issue`); the
//! opaque `resource:<uuid>` rides in the RPC that uses it, and the backend
//! checks the kind, the deadline, the uses left and that the file is still
//! the one picked. Electron's scope: one use, five minutes, one backend
//! generation.
//!
//! This slice issues the one capability every start into a chosen folder
//! needs: `output-directory` ([`output_directory_authorizer`], the
//! Studio's `OutputAuthorizer`, #1868). The default folder needs none. The
//! pickers, the mirror and the other kinds follow with the pages that use
//! them.
//!
//! No macOS security-scoped bookmark is involved: Videorc is not
//! sandboxed (neither is Electron's app), so a chosen folder needs no
//! bookmark to be written; the backend's capability is the permission.

pub mod capability;

use std::future::Future;
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::sync::Arc;
use std::time::Duration;

use tokio::sync::watch;

use crate::desktop::camera_extension::admin_request;
use crate::process::BackendBootstrap;
use crate::supervisor::BackendState;

use capability::{
    IssueOptions, IssuedCapability, ResourceKind, ResourceSelection, canonical_resource_path,
    display_name, issue_params, parse_issued,
};

/// How long an admin request may take (`BACKEND_ADMIN_TIMEOUT_MS`).
pub const ADMIN_TIMEOUT: Duration = Duration::from_secs(10);

/// `issueResourceCapability`: the path checked and resolved here, the
/// capability issued by `bootstrap`'s backend on its admin credential for
/// the resolved path, and the answer checked.
pub async fn issue_capability(
    bootstrap: &BackendBootstrap,
    path: &Path,
    kind: ResourceKind,
    options: IssueOptions,
) -> Result<(PathBuf, IssuedCapability), String> {
    let raw = path.to_str().ok_or("Resource path is invalid.")?;
    let canonical = canonical_resource_path(raw, kind)?;
    let answer = admin_request(
        bootstrap,
        "resource.capability.issue",
        issue_params(&canonical, kind, options),
        ADMIN_TIMEOUT,
    )
    .await?;
    let issued = parse_issued(&answer, kind)?;
    Ok((canonical, issued))
}

/// `authorizeOutputDirectory`: the chosen recordings folder's capability,
/// before a start.
pub async fn authorize_output_directory(
    bootstrap: &BackendBootstrap,
    path: &Path,
) -> Result<ResourceSelection, String> {
    let (canonical, issued) = issue_capability(
        bootstrap,
        path,
        ResourceKind::OutputDirectory,
        IssueOptions::default(),
    )
    .await?;
    Ok(ResourceSelection {
        capability_id: issued.capability_id,
        kind: issued.kind,
        display_name: display_name(&canonical),
    })
}

/// The Studio's `OutputAuthorizer` (`studio::recordings_folder_actions`,
/// #1868), spelled out so this module needs no Studio: a path in, the
/// capability id out, or why not.
pub type OutputDirectoryAuthorizer = Arc<
    dyn Fn(PathBuf) -> Pin<Box<dyn Future<Output = Result<String, String>> + Send>> + Send + Sync,
>;

/// Refused while no backend is ready to issue.
pub const NO_BACKEND: &str = "The backend is not running, so the folder can't be authorized.";

/// The app's issuer, for `Studio::set_output_authorizer` at launch: each
/// call issues on the admin credential of the backend that is ready then
/// (a restarted backend knows none of the old capabilities, and a start
/// asks again).
pub fn output_directory_authorizer(
    backend: watch::Receiver<BackendState>,
) -> OutputDirectoryAuthorizer {
    Arc::new(move |path: PathBuf| {
        let bootstrap = backend.borrow().bootstrap().cloned();
        Box::pin(async move {
            let bootstrap = bootstrap.ok_or(NO_BACKEND)?;
            authorize_output_directory(&bootstrap, &path)
                .await
                .map(|selection| selection.capability_id)
        })
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn no_backend_refuses_before_any_path_is_read() {
        let (_state, backend) = watch::channel(BackendState::Stopped {
            stray_pids: Vec::new(),
        });
        let authorize = output_directory_authorizer(backend);
        assert_eq!(
            authorize(PathBuf::from("/Users/me/Movies"))
                .await
                .unwrap_err(),
            NO_BACKEND
        );
    }
}
