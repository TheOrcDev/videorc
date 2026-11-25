//! Destinations → After the stream as the Studio runs it
//! (`streamReport.email.get` / `.set` / `.sendLast`, `streamReport.history.set`).
//!
//! Pure view and request-numbering rules live in
//! [`crate::livestream::stream_report`]. This module drives those rules
//! against the backend, as `StreamReportEmailSection` does: a failed first
//! read retries itself (QA F13) on a spawned timer that a newer read or
//! save cancels; a failed save toasts, puts the confirmed choice back and
//! reads again; a send that says the choice changed elsewhere reads again;
//! `account.changed` forgets the old account's choices and reads afresh.
//! RPC names match Electron.

use std::sync::Arc;
use std::time::Duration;

use serde_json::{Value, json};
use tokio::sync::watch;

use super::{Studio, StudioBackend};
use crate::client::RpcError;
use crate::livestream::stream_report::{
    AfterReadFailure, EMAIL_SAVE_OBJECT, HISTORY_SAVE_OBJECT, Section, State,
};
use crate::user_error::{Failure, UserErrorContext, toast_user_error};

pub const EMAIL_GET: &str = "streamReport.email.get";
pub const EMAIL_SET: &str = "streamReport.email.set";
pub const HISTORY_SET: &str = "streamReport.history.set";
pub const EMAIL_SEND_LAST: &str = "streamReport.email.sendLast";

/// `toastUserError(error, { action: 'save', object })` for each switch.
const SAVE_EMAIL: UserErrorContext = UserErrorContext {
    action: "save",
    object: EMAIL_SAVE_OBJECT,
};
const SAVE_HISTORY: UserErrorContext = UserErrorContext {
    action: "save",
    object: HISTORY_SAVE_OBJECT,
};
const EMAIL_TOAST_ID: &str = "stream-report-email-save";
const HISTORY_TOAST_ID: &str = "stream-report-history-save";

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

    /// One read; a failed first read keeps retrying on its own timer
    /// (2 s, 5 s, 15 s), which a newer read or save cancels.
    async fn fetch_stream_report(&self, request: u64) {
        let AfterReadFailure::RetryAfter(wait) =
            read_stream_report_once(self.backend.as_ref(), &self.stream_report_tx, request).await
        else {
            return;
        };
        let backend = Arc::clone(&self.backend);
        let tx = self.stream_report_tx.clone();
        tokio::spawn(async move {
            let (mut request, mut wait) = (request, wait);
            loop {
                tokio::time::sleep(Duration::from_millis(wait)).await;
                let mut next = None;
                tx.send_if_modified(|store| {
                    next = store.section.retry_due(request);
                    false
                });
                let Some(retry) = next else { return };
                match read_stream_report_once(backend.as_ref(), &tx, retry).await {
                    AfterReadFailure::RetryAfter(after) => (request, wait) = (retry, after),
                    AfterReadFailure::Nothing => return,
                }
            }
        });
    }

    /// A save failed: the latest one toasts, shows the account's confirmed
    /// choice again and reads it again.
    async fn stream_report_save_failed(
        &self,
        method: &str,
        request: u64,
        error: &RpcError,
        context: UserErrorContext,
        toast_id: &str,
    ) {
        self.config
            .logger
            .warn(format!("Studio: {method} did not save ({error})."));
        let mut latest = false;
        self.edit_stream_report(|store| {
            latest = store.section.save_failed(request);
            latest
        });
        if !latest {
            return;
        }
        if let Some(command) = toast_user_error(Failure::Rpc(error), context, toast_id) {
            self.post(vec![command]);
        }
        self.read_stream_report().await;
    }

    /// `account.changed` for Destinations' account-bound sections: the
    /// watchdog's phones and the stream report's choices are read afresh.
    /// Never consumes the event.
    pub(super) async fn handle_account_event(&self, event: &str) {
        if event != crate::accounts::methods::CHANGED_EVENT {
            return;
        }
        self.watchdog_account_changed();
        self.stream_report_account_changed().await;
    }

    /// `account.changed`: another account's choices are not this one's.
    async fn stream_report_account_changed(&self) {
        let request = {
            let mut request = 0;
            self.edit_stream_report(|store| {
                request = store.section.account_changed();
                true
            });
            request
        };
        self.fetch_stream_report(request).await;
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
                self.stream_report_save_failed(
                    EMAIL_SET,
                    request,
                    &error,
                    SAVE_EMAIL,
                    EMAIL_TOAST_ID,
                )
                .await;
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
                self.stream_report_save_failed(
                    HISTORY_SET,
                    request,
                    &error,
                    SAVE_HISTORY,
                    HISTORY_TOAST_ID,
                )
                .await;
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
                let mut changed_elsewhere = false;
                self.edit_stream_report(|store| {
                    changed_elsewhere = store.section.send_answered(generation, &result);
                    true
                });
                // "Turned off" means the account's choice changed somewhere else.
                if changed_elsewhere {
                    self.read_stream_report().await;
                }
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

/// `streamReport.email.get` once, landed on the section under `request`:
/// what the driver does next.
async fn read_stream_report_once<B: StudioBackend>(
    backend: &B,
    tx: &watch::Sender<StreamReportStore>,
    request: u64,
) -> AfterReadFailure {
    match backend
        .livestream_request(EMAIL_GET, Value::Null)
        .await
        .and_then(|value| super::backend::read_json::<State>(EMAIL_GET, value))
    {
        Ok(state) => {
            tx.send_if_modified(|store| {
                store.section.answered(request, state);
                true
            });
            AfterReadFailure::Nothing
        }
        Err(_) => {
            let mut after = AfterReadFailure::Nothing;
            tx.send_if_modified(|store| {
                after = store.section.read_failed(request);
                true
            });
            after
        }
    }
}
