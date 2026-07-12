use std::sync::Arc;
#[cfg(test)]
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Duration;
use tokio::sync::{OwnedMutexGuard, mpsc, oneshot};

use crate::live_chat::LiveChatMessage;
use crate::storage::{Database, MissingLiveChatSession};

const QUEUE_CAPACITY: usize = 512;
#[cfg(not(test))]
const RETRY_DELAY_MIN: Duration = Duration::from_millis(25);
#[cfg(test)]
const RETRY_DELAY_MIN: Duration = Duration::from_millis(1);
#[cfg(not(test))]
const RETRY_DELAY_MAX: Duration = Duration::from_secs(1);
#[cfg(test)]
const RETRY_DELAY_MAX: Duration = Duration::from_millis(4);
#[cfg(not(test))]
const MAX_TRANSIENT_RETRIES: usize = 6;
#[cfg(test)]
const MAX_TRANSIENT_RETRIES: usize = 3;
const MAX_WORKER_RESTARTS_PER_BATCH: usize = 1;

pub(crate) type BatchWriter =
    Arc<dyn Fn(&[LiveChatMessage]) -> anyhow::Result<()> + Send + Sync + 'static>;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum LiveChatPersistenceFailureKind {
    Retryable,
    Terminal,
}

#[derive(Debug, Clone, thiserror::Error)]
#[error("{message}")]
pub(crate) struct LiveChatPersistenceFailure {
    pub kind: LiveChatPersistenceFailureKind,
    message: String,
    worker_ended: bool,
}

impl LiveChatPersistenceFailure {
    fn retryable(message: impl Into<String>) -> Self {
        Self {
            kind: LiveChatPersistenceFailureKind::Retryable,
            message: message.into(),
            worker_ended: false,
        }
    }

    pub(crate) fn terminal(message: impl Into<String>) -> Self {
        Self {
            kind: LiveChatPersistenceFailureKind::Terminal,
            message: message.into(),
            worker_ended: true,
        }
    }

    fn worker_ended(message: impl Into<String>) -> Self {
        Self {
            kind: LiveChatPersistenceFailureKind::Retryable,
            message: message.into(),
            worker_ended: true,
        }
    }

    pub fn is_terminal(&self) -> bool {
        self.kind == LiveChatPersistenceFailureKind::Terminal
    }
}

struct PersistRequest {
    messages: Vec<LiveChatMessage>,
    acknowledged: oneshot::Sender<Result<(), LiveChatPersistenceFailure>>,
}

/// Lazy, bounded SQLite writer for provider bursts. Construction remains safe
/// in synchronous tests; the worker starts only from the first async persist.
#[derive(Clone)]
pub struct LiveChatPersistence {
    writer: BatchWriter,
    sender: Arc<tokio::sync::Mutex<Option<mpsc::Sender<PersistRequest>>>>,
    delivery: Arc<tokio::sync::Mutex<()>>,
    #[cfg(test)]
    transaction_count: Arc<AtomicUsize>,
    #[cfg(test)]
    worker_start_count: Arc<AtomicUsize>,
}

impl LiveChatPersistence {
    pub fn new(database: Database) -> Self {
        let writer: BatchWriter =
            Arc::new(move |messages| database.save_live_chat_messages(messages));
        Self::from_writer(writer)
    }

    fn from_writer(writer: BatchWriter) -> Self {
        Self {
            writer,
            sender: Arc::new(tokio::sync::Mutex::new(None)),
            delivery: Arc::new(tokio::sync::Mutex::new(())),
            #[cfg(test)]
            transaction_count: Arc::new(AtomicUsize::new(0)),
            #[cfg(test)]
            worker_start_count: Arc::new(AtomicUsize::new(0)),
        }
    }

    #[cfg(test)]
    pub(crate) fn with_writer(writer: BatchWriter) -> Self {
        Self::from_writer(writer)
    }

    #[cfg(test)]
    async fn persist(&self, message: LiveChatMessage) -> Result<(), LiveChatPersistenceFailure> {
        self.persist_batch(vec![message]).await
    }

    /// Persist one coordinator delivery as one SQLite transaction. A page may
    /// exceed the old 64-message worker chunk, but splitting it would make a
    /// later failure roll back coordinator state while leaving an earlier
    /// prefix committed. The bounded request queue still supplies backpressure.
    pub async fn persist_batch(
        &self,
        messages: Vec<LiveChatMessage>,
    ) -> Result<(), LiveChatPersistenceFailure> {
        self.persist_chunk(messages).await
    }

    async fn persist_chunk(
        &self,
        messages: Vec<LiveChatMessage>,
    ) -> Result<(), LiveChatPersistenceFailure> {
        if messages.is_empty() {
            return Ok(());
        }
        let mut worker_restarts = 0;
        loop {
            let sender = self.sender().await;
            let (acknowledged, received) = oneshot::channel();
            if sender
                .send(PersistRequest {
                    messages: messages.clone(),
                    acknowledged,
                })
                .await
                .is_err()
            {
                self.invalidate_sender(&sender).await;
                if worker_restarts < MAX_WORKER_RESTARTS_PER_BATCH {
                    worker_restarts += 1;
                    continue;
                }
                return Err(LiveChatPersistenceFailure::worker_ended(
                    "The live-chat persistence worker stopped before accepting the batch.",
                ));
            }
            let outcome = received.await.unwrap_or_else(|_| {
                Err(LiveChatPersistenceFailure::worker_ended(
                    "The live-chat persistence worker stopped before acknowledging the batch.",
                ))
            });
            match outcome {
                Ok(()) => return Ok(()),
                Err(error)
                    if error.worker_ended
                        && error.kind == LiveChatPersistenceFailureKind::Retryable
                        && worker_restarts < MAX_WORKER_RESTARTS_PER_BATCH =>
                {
                    self.invalidate_sender(&sender).await;
                    worker_restarts += 1;
                }
                Err(error) => {
                    if error.worker_ended {
                        self.invalidate_sender(&sender).await;
                    }
                    return Err(error);
                }
            }
        }
    }

    /// Serialize coordinator mutation + persistence so a failed batch can apply
    /// its compact undo records without racing a different provider delivery.
    pub async fn begin_delivery(&self) -> OwnedMutexGuard<()> {
        self.delivery.clone().lock_owned().await
    }

    async fn sender(&self) -> mpsc::Sender<PersistRequest> {
        let mut sender = self.sender.lock().await;
        if let Some(existing) = sender.as_ref().filter(|sender| !sender.is_closed()) {
            return existing.clone();
        }
        let (next, receiver) = mpsc::channel(QUEUE_CAPACITY);
        #[cfg(test)]
        self.worker_start_count.fetch_add(1, Ordering::SeqCst);
        tokio::spawn(run_worker(
            self.writer.clone(),
            receiver,
            #[cfg(test)]
            self.transaction_count.clone(),
        ));
        *sender = Some(next.clone());
        next
    }

    async fn invalidate_sender(&self, failed: &mpsc::Sender<PersistRequest>) {
        let mut sender = self.sender.lock().await;
        if sender
            .as_ref()
            .is_some_and(|current| current.same_channel(failed))
        {
            *sender = None;
        }
    }

    #[cfg(test)]
    fn transaction_count(&self) -> usize {
        self.transaction_count.load(Ordering::SeqCst)
    }

    #[cfg(test)]
    fn worker_start_count(&self) -> usize {
        self.worker_start_count.load(Ordering::SeqCst)
    }
}

async fn run_worker(
    writer: BatchWriter,
    mut receiver: mpsc::Receiver<PersistRequest>,
    #[cfg(test)] transaction_count: Arc<AtomicUsize>,
) {
    while let Some(request) = receiver.recv().await {
        let mut retry_delay = RETRY_DELAY_MIN;
        let mut transient_retries = 0;
        loop {
            let writer = writer.clone();
            let messages = request.messages.clone();
            match tokio::task::spawn_blocking(move || writer(&messages)).await {
                Ok(Ok(())) => {
                    #[cfg(test)]
                    transaction_count.fetch_add(1, Ordering::SeqCst);
                    let _ = request.acknowledged.send(Ok(()));
                    break;
                }
                Ok(Err(error)) => {
                    match classify_write_error(&error) {
                        WriteErrorDisposition::RetryInWorker
                            if transient_retries < MAX_TRANSIENT_RETRIES =>
                        {
                            // Keep this exact batch in memory while a bounded lock
                            // retry runs. Later provider batches remain ordered.
                            transient_retries += 1;
                            tokio::time::sleep(retry_delay).await;
                            retry_delay = retry_delay.saturating_mul(2).min(RETRY_DELAY_MAX);
                        }
                        WriteErrorDisposition::RetryInWorker => {
                            let _ = request.acknowledged.send(Err(
                                LiveChatPersistenceFailure::retryable(format!(
                                    "Live-chat storage stayed locked after {} retries: {error}",
                                    MAX_TRANSIENT_RETRIES
                                )),
                            ));
                            break;
                        }
                        WriteErrorDisposition::RetryFromProvider => {
                            let _ = request.acknowledged.send(Err(
                                LiveChatPersistenceFailure::retryable(error.to_string()),
                            ));
                            break;
                        }
                        WriteErrorDisposition::Terminal => {
                            let _ = request.acknowledged.send(Err(
                                LiveChatPersistenceFailure::terminal(format!(
                                    "Live-chat storage rejected the batch permanently: {error}"
                                )),
                            ));
                            return;
                        }
                    }
                }
                Err(error) => {
                    let _ =
                        request
                            .acknowledged
                            .send(Err(LiveChatPersistenceFailure::worker_ended(format!(
                                "The live-chat persistence worker failed: {error}"
                            ))));
                    return;
                }
            }
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum WriteErrorDisposition {
    RetryInWorker,
    RetryFromProvider,
    Terminal,
}

fn classify_write_error(error: &anyhow::Error) -> WriteErrorDisposition {
    if error.downcast_ref::<MissingLiveChatSession>().is_some() {
        return WriteErrorDisposition::RetryFromProvider;
    }
    let sqlite_error = error
        .chain()
        .find_map(|cause| cause.downcast_ref::<rusqlite::Error>());
    match sqlite_error {
        Some(rusqlite::Error::SqliteFailure(code, _))
            if matches!(
                code.code,
                rusqlite::ErrorCode::DatabaseBusy | rusqlite::ErrorCode::DatabaseLocked
            ) =>
        {
            WriteErrorDisposition::RetryInWorker
        }
        _ => WriteErrorDisposition::Terminal,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;
    use std::sync::atomic::AtomicBool;

    use crate::live_chat::{LiveChatEventType, live_chat_message_id};
    use crate::streaming::StreamPlatform;

    fn message_for_session(session_id: &str, sequence: usize) -> LiveChatMessage {
        let provider_message_id = format!("provider-{sequence:03}");
        LiveChatMessage {
            id: live_chat_message_id(
                session_id,
                StreamPlatform::Youtube,
                Some("youtube"),
                &provider_message_id,
            ),
            session_id: session_id.to_string(),
            provider_message_id,
            platform: StreamPlatform::Youtube,
            target_id: Some("youtube".to_string()),
            author_id: None,
            author_name: "Viewer".to_string(),
            author_avatar_url: None,
            author_badges: Vec::new(),
            author_roles: Vec::new(),
            published_at: format!("2026-07-12T00:00:{:02}Z", sequence % 60),
            received_at: format!("2026-07-12T00:00:{:02}.{:03}Z", sequence % 60, sequence),
            message_text: format!("message {sequence}"),
            fragments: Vec::new(),
            event_type: LiveChatEventType::Message,
            amount_text: None,
            is_deleted: false,
            raw_provider_type: None,
        }
    }

    fn message(sequence: usize) -> LiveChatMessage {
        message_for_session("batch-session", sequence)
    }

    fn sqlite_error(code: rusqlite::ErrorCode, extended_code: i32) -> anyhow::Error {
        anyhow::Error::new(rusqlite::Error::SqliteFailure(
            rusqlite::ffi::Error {
                code,
                extended_code,
            },
            Some("injected live-chat persistence failure".to_string()),
        ))
    }

    #[tokio::test]
    async fn provider_burst_uses_one_atomic_transaction() {
        let database = Database::open_in_memory_for_tests();
        database
            .ensure_fake_live_chat_session("batch-session")
            .unwrap();
        let persistence = LiveChatPersistence::new(database.clone());
        persistence
            .persist_batch((0..100).map(message).collect())
            .await
            .unwrap();

        let persisted = database
            .list_live_chat_messages_recent("batch-session", 200)
            .unwrap();
        assert_eq!(persisted.len(), 100);
        assert_eq!(persistence.transaction_count(), 1);
    }

    #[tokio::test]
    async fn failure_after_old_chunk_boundary_rolls_back_the_entire_delivery() {
        let database = Database::open_in_memory_for_tests();
        database
            .ensure_fake_live_chat_session("batch-session")
            .unwrap();
        let persistence = LiveChatPersistence::new(database.clone());
        let mut messages = (0..100).map(message).collect::<Vec<_>>();
        messages[70] = message_for_session("late-missing-session", 70);

        let error = persistence
            .persist_batch(messages.clone())
            .await
            .unwrap_err();
        assert_eq!(error.kind, LiveChatPersistenceFailureKind::Retryable);
        assert!(
            database
                .list_live_chat_messages_recent("batch-session", 200)
                .unwrap()
                .is_empty(),
            "the first 64+ rows must roll back with the later missing-session row"
        );
        assert_eq!(persistence.transaction_count(), 0);

        database
            .ensure_fake_live_chat_session("late-missing-session")
            .unwrap();
        persistence.persist_batch(messages).await.unwrap();
        assert_eq!(
            database
                .list_live_chat_messages_recent("batch-session", 200)
                .unwrap()
                .len(),
            99
        );
        assert_eq!(
            database
                .list_live_chat_messages_recent("late-missing-session", 10)
                .unwrap()
                .len(),
            1
        );
        assert_eq!(persistence.transaction_count(), 1);
    }

    #[tokio::test]
    async fn missing_session_is_reported_instead_of_acknowledged_as_persisted() {
        let database = Database::open_in_memory_for_tests();
        let persistence = LiveChatPersistence::new(database.clone());
        let error = persistence
            .persist(message_for_session("missing-session", 1))
            .await
            .unwrap_err();

        assert!(error.to_string().contains("missing session"), "{error}");
        assert_eq!(persistence.transaction_count(), 0);
    }

    #[tokio::test]
    async fn busy_database_retries_the_same_batch_without_losing_order() {
        let attempts = Arc::new(AtomicUsize::new(0));
        let attempted_ids = Arc::new(Mutex::new(Vec::<Vec<String>>::new()));
        let writer: BatchWriter = {
            let attempts = attempts.clone();
            let attempted_ids = attempted_ids.clone();
            Arc::new(move |messages| {
                attempted_ids
                    .lock()
                    .unwrap()
                    .push(messages.iter().map(|message| message.id.clone()).collect());
                if attempts.fetch_add(1, Ordering::SeqCst) < 2 {
                    return Err(sqlite_error(rusqlite::ErrorCode::DatabaseBusy, 5));
                }
                Ok(())
            })
        };
        let persistence = LiveChatPersistence::with_writer(writer);
        let batch = vec![message(1), message(2)];
        let expected_ids = batch
            .iter()
            .map(|message| message.id.clone())
            .collect::<Vec<_>>();

        persistence.persist_batch(batch).await.unwrap();

        assert_eq!(attempts.load(Ordering::SeqCst), 3);
        assert_eq!(
            attempted_ids.lock().unwrap().as_slice(),
            [expected_ids.clone(), expected_ids.clone(), expected_ids]
        );
        assert_eq!(persistence.transaction_count(), 1);
        assert_eq!(persistence.worker_start_count(), 1);
    }

    #[tokio::test]
    async fn persistent_lock_is_bounded_and_the_worker_accepts_a_later_retry() {
        let locked = Arc::new(AtomicBool::new(true));
        let attempts = Arc::new(AtomicUsize::new(0));
        let writer: BatchWriter = {
            let locked = locked.clone();
            let attempts = attempts.clone();
            Arc::new(move |_| {
                attempts.fetch_add(1, Ordering::SeqCst);
                if locked.load(Ordering::SeqCst) {
                    Err(sqlite_error(rusqlite::ErrorCode::DatabaseLocked, 6))
                } else {
                    Ok(())
                }
            })
        };
        let persistence = LiveChatPersistence::with_writer(writer);

        let error = persistence.persist(message(1)).await.unwrap_err();
        assert_eq!(error.kind, LiveChatPersistenceFailureKind::Retryable);
        assert_eq!(attempts.load(Ordering::SeqCst), MAX_TRANSIENT_RETRIES + 1);
        locked.store(false, Ordering::SeqCst);
        persistence.persist(message(1)).await.unwrap();

        assert_eq!(persistence.worker_start_count(), 1);
        assert_eq!(persistence.transaction_count(), 1);
    }

    #[tokio::test]
    async fn corruption_is_terminal_and_the_next_delivery_gets_a_fresh_worker() {
        let attempts = Arc::new(AtomicUsize::new(0));
        let writer: BatchWriter = {
            let attempts = attempts.clone();
            Arc::new(move |_| {
                if attempts.fetch_add(1, Ordering::SeqCst) == 0 {
                    Err(sqlite_error(rusqlite::ErrorCode::DatabaseCorrupt, 11))
                } else {
                    Ok(())
                }
            })
        };
        let persistence = LiveChatPersistence::with_writer(writer);

        let error = persistence.persist(message(1)).await.unwrap_err();
        assert!(error.is_terminal());
        persistence.persist(message(1)).await.unwrap();

        assert_eq!(attempts.load(Ordering::SeqCst), 2);
        assert_eq!(persistence.worker_start_count(), 2);
        assert_eq!(persistence.transaction_count(), 1);
    }

    #[tokio::test]
    async fn panicked_writer_restarts_once_and_replays_the_identical_batch() {
        let attempts = Arc::new(AtomicUsize::new(0));
        let attempted_ids = Arc::new(Mutex::new(Vec::<Vec<String>>::new()));
        let writer: BatchWriter = {
            let attempts = attempts.clone();
            let attempted_ids = attempted_ids.clone();
            Arc::new(move |messages| {
                attempted_ids
                    .lock()
                    .unwrap()
                    .push(messages.iter().map(|message| message.id.clone()).collect());
                if attempts.fetch_add(1, Ordering::SeqCst) == 0 {
                    panic!("injected poisoned writer");
                }
                Ok(())
            })
        };
        let persistence = LiveChatPersistence::with_writer(writer);
        let batch = vec![message(7), message(8)];
        let expected_ids = batch
            .iter()
            .map(|message| message.id.clone())
            .collect::<Vec<_>>();

        persistence.persist_batch(batch).await.unwrap();

        assert_eq!(attempts.load(Ordering::SeqCst), 2);
        assert_eq!(
            attempted_ids.lock().unwrap().as_slice(),
            [expected_ids.clone(), expected_ids]
        );
        assert_eq!(persistence.worker_start_count(), 2);
        assert_eq!(persistence.transaction_count(), 1);
    }

    #[test]
    fn sqlite_failure_classification_is_conservative() {
        assert_eq!(
            classify_write_error(&sqlite_error(rusqlite::ErrorCode::DatabaseBusy, 5)),
            WriteErrorDisposition::RetryInWorker
        );
        assert_eq!(
            classify_write_error(&sqlite_error(rusqlite::ErrorCode::DatabaseLocked, 6)),
            WriteErrorDisposition::RetryInWorker
        );
        for (code, extended_code) in [
            (rusqlite::ErrorCode::DatabaseCorrupt, 11),
            (rusqlite::ErrorCode::NotADatabase, 26),
            (rusqlite::ErrorCode::ReadOnly, 8),
            (rusqlite::ErrorCode::DiskFull, 13),
        ] {
            assert_eq!(
                classify_write_error(&sqlite_error(code, extended_code)),
                WriteErrorDisposition::Terminal,
                "{code:?} must never spin behind the global delivery lock"
            );
        }
    }
}
