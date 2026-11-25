//! Destinations → After the stream as the Studio runs it
//! (`streamReport.email.get` / `.set` / `.sendLast`, `streamReport.history.set`).
//!
//! Pure view and request-numbering rules live in
//! [`crate::livestream::stream_report`]. This module drives those rules
//! against the backend. Automatic QA F13 load retries are left to the
//! Destinations screen (`LOAD_RETRY_MS` + Try again); L2 can move them
//! into a driver later. RPC names match Electron.

use serde_json::{Value, json};
use tokio::sync::watch;

use super::{Studio, StudioBackend};
use crate::livestream::stream_report::{Section, State};

pub const EMAIL_GET: &str = "streamReport.email.get";
pub const EMAIL_SET: &str = "streamReport.email.set";
pub const HISTORY_SET: &str = "streamReport.history.set";
pub const EMAIL_SEND_LAST: &str = "streamReport.email.sendLast";

/// What Destinations' After the stream section reads.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct StreamReportStore {
    pub section: Section,
}

impl<B: StudioBackend> Studio<B> {
    pub fn stream_report(&self) -> watch::Receiver<StreamReportStore> {
        self.stream_report_tx.subscribe()
    }

    pub fn stream_report_now(&self) -> StreamReportStore {
        self.stream_report_tx.borrow().clone()
    }

    fn edit_stream_report(&self, edit: impl FnOnce(&mut StreamReportStore) -> bool) {
        self.stream_report_tx.send_if_modified(edit);
    }

    /// Bootstrap / page open: `streamReport.email.get`.
    pub(super) async fn read_stream_report(&self) {
        let request = {
            let mut request = 0;
            self.edit_stream_report(|store| {
                request = store.section.read_started();
                true
            });
            request
        };
        self.fetch_stream_report(request).await;
    }

    /// Try again after a failed read (resets the QA F13 retry cycle).
    pub async fn reload_stream_report(&self) {
        let request = {
            let mut request = 0;
            self.edit_stream_report(|store| {
                request = store.section.retry_started();
                true
            });
            request
        };
        self.fetch_stream_report(request).await;
    }

    async fn fetch_stream_report(&self, request: u64) {
        match self
            .backend
            .livestream_request(EMAIL_GET, Value::Null)
            .await
            .and_then(|value| super::backend::read_json::<State>(EMAIL_GET, value))
        {
            Ok(state) => {
                self.edit_stream_report(|store| {
                    store.section.answered(request, state);
                    true
                });
            }
            Err(_) => {
                self.edit_stream_report(|store| {
                    let _ = store.section.read_failed(request);
                    true
                });
            }
        }
    }

    /// `streamReport.email.set`.
    pub async fn set_stream_report_email(&self, enabled: bool) {
        let request = {
            let mut request = 0;
            self.edit_stream_report(|store| {
                request = store.section.email_flipped(enabled);
                true
            });
            request
        };
        match self
            .backend
            .livestream_request(EMAIL_SET, json!({ "enabled": enabled }))
            .await
            .and_then(|value| super::backend::read_json::<State>(EMAIL_SET, value))
        {
            Ok(state) => {
                self.edit_stream_report(|store| {
                    store.section.answered(request, state);
                    true
                });
            }
            Err(error) => {
                self.config
                    .logger
                    .warn(format!("Studio: {EMAIL_SET} did not save ({error})."));
                self.edit_stream_report(|store| store.section.save_failed(request));
            }
        }
    }

    /// `streamReport.history.set`.
    pub async fn set_stream_report_history(&self, enabled: bool) {
        let request = {
            let mut request = 0;
            self.edit_stream_report(|store| {
                request = store.section.history_flipped(enabled);
                true
            });
            request
        };
        match self
            .backend
            .livestream_request(HISTORY_SET, json!({ "enabled": enabled }))
            .await
            .and_then(|value| super::backend::read_json::<State>(HISTORY_SET, value))
        {
            Ok(state) => {
                self.edit_stream_report(|store| {
                    store.section.answered(request, state);
                    true
                });
            }
            Err(error) => {
                self.config
                    .logger
                    .warn(format!("Studio: {HISTORY_SET} did not save ({error})."));
                self.edit_stream_report(|store| store.section.save_failed(request));
            }
        }
    }

    /// `streamReport.email.sendLast`.
    pub async fn send_last_stream_report(&self) {
        let generation = {
            let mut generation = 0;
            self.edit_stream_report(|store| {
                generation = store.section.send_started();
                true
            });
            generation
        };
        match self
            .backend
            .livestream_request(EMAIL_SEND_LAST, Value::Null)
            .await
        {
            Ok(result) => {
                self.edit_stream_report(|store| store.section.send_answered(generation, &result));
            }
            Err(_) => {
                self.edit_stream_report(|store| {
                    store.section.send_failed(generation);
                    true
                });
            }
        }
    }
}
