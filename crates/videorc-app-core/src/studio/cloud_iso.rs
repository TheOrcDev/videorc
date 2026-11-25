//! Cloud ISO ("Separate files") on Guests (plan 249 S22):
//! `cloud.iso.status` / `.enable` / `.disable`. Answers are
//! [`crate::guests::iso::IsoAnswer`], not the room status — never routed
//! through [`super::cloud::Studio::cloud_request`].

use serde_json::{Value, json};

use super::{Studio, StudioBackend};
use crate::client::RpcError;
use crate::guests::iso::{IsoAnswer, IsoEnableParams};

impl<B: StudioBackend> Studio<B> {
    async fn cloud_iso_call(
        &self,
        method: &'static str,
        params: Value,
    ) -> Result<IsoAnswer, RpcError> {
        let answer = self
            .backend
            .livestream_request(method, params)
            .await
            .map_err(|error| {
                self.config
                    .logger
                    .warn(format!("Cloud ISO: {method} failed: {}", error.message));
                error
            })?;
        serde_json::from_value(answer).map_err(|_| {
            RpcError::new(
                method,
                "unreadable",
                "Videorc Cloud's separate-files answer did not read.",
            )
        })
    }

    /// `cloud.iso.status { showId }`.
    pub async fn cloud_iso_status(&self, show_id: &str) -> Result<IsoAnswer, RpcError> {
        self.cloud_iso_call("cloud.iso.status", json!({ "showId": show_id }))
            .await
    }

    /// `cloud.iso.enable`: consent is required and never defaulted.
    pub async fn cloud_iso_enable(&self, params: &IsoEnableParams) -> Result<IsoAnswer, RpcError> {
        let value = serde_json::to_value(params).unwrap_or(Value::Null);
        self.cloud_iso_call("cloud.iso.enable", value).await
    }

    /// `cloud.iso.disable { showId }`.
    pub async fn cloud_iso_disable(&self, show_id: &str) -> Result<IsoAnswer, RpcError> {
        self.cloud_iso_call("cloud.iso.disable", json!({ "showId": show_id }))
            .await
    }
}
