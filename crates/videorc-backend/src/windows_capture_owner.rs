//! Bounded ownership for thread-affine capture drivers. The encoder actor never
//! opens, acquires, or closes a driver. A timed-out acquisition remains owned
//! until its exact completion; callers must retain its destination lease.
use std::sync::{
    Arc, Mutex,
    atomic::{AtomicBool, AtomicUsize, Ordering},
    mpsc,
};
use std::thread;
use std::time::Duration;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum CaptureOwnerCompletion {
    Running,
    Closed,
    Panicked,
}

struct Shared<O, E> {
    opened: Option<Result<(), E>>,
    acquired: Option<Result<O, E>>,
}

/// The platform pool survives media actor/session recreation, so quarantined
/// driver closes cannot be bypassed by starting a new authority.
pub(crate) fn platform_pool() -> Arc<AtomicUsize> {
    static POOL: std::sync::OnceLock<Arc<AtomicUsize>> = std::sync::OnceLock::new();
    POOL.get_or_init(|| Arc::new(AtomicUsize::new(0))).clone()
}

pub(crate) struct CaptureOwner<I, O, E> {
    commands: mpsc::SyncSender<I>,
    stop: Arc<AtomicBool>,
    shared: Arc<Mutex<Shared<O, E>>>,
    in_flight: bool,
    closed: tokio::sync::watch::Receiver<CaptureOwnerCompletion>,
    pub(crate) generation: u64,
}

impl<I: Send + 'static, O: Send + 'static, E: Send + 'static> CaptureOwner<I, O, E> {
    pub(crate) fn start<T: 'static>(
        generation: u64,
        owners: Arc<AtomicUsize>,
        open: impl FnOnce() -> Result<T, E> + Send + 'static,
        acquire: impl FnMut(&mut T, I) -> Result<O, E> + Send + 'static,
    ) -> Result<Self, String> {
        Self::start_with_wake(generation, owners, open, acquire, || {})
    }
    pub(crate) fn start_with_wake<T: 'static>(
        generation: u64,
        owners: Arc<AtomicUsize>,
        open: impl FnOnce() -> Result<T, E> + Send + 'static,
        mut acquire: impl FnMut(&mut T, I) -> Result<O, E> + Send + 'static,
        wake: impl Fn() + Send + 'static,
    ) -> Result<Self, String> {
        if generation == 0 {
            return Err("Capture generation zero is reserved".into());
        }
        owners
            .fetch_update(Ordering::AcqRel, Ordering::Acquire, |count| {
                (count < 2).then_some(count + 1)
            })
            .map_err(|_| "Two capture owners are still opening, active, or closing".to_string())?;
        let (commands, receiver) = mpsc::sync_channel(1);
        let stop = Arc::new(AtomicBool::new(false));
        let shared = Arc::new(Mutex::new(Shared {
            opened: None,
            acquired: None,
        }));
        let (closed_tx, closed) = tokio::sync::watch::channel(CaptureOwnerCompletion::Running);
        let worker_stop = stop.clone();
        let worker_shared = shared.clone();
        let worker_owners = owners.clone();
        let spawned = thread::Builder::new()
            .name("d3d11-capture-owner".into())
            .spawn(move || {
                let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    let mut capture = match open() {
                        Ok(capture) => capture,
                        Err(error) => {
                            worker_shared
                                .lock()
                                .unwrap_or_else(|p| p.into_inner())
                                .opened = Some(Err(error));
                            wake();
                            return;
                        }
                    };
                    worker_shared
                        .lock()
                        .unwrap_or_else(|p| p.into_inner())
                        .opened = Some(Ok(()));
                    wake();
                    while !worker_stop.load(Ordering::Acquire) {
                        let input = match receiver.recv_timeout(Duration::from_millis(10)) {
                            Ok(input) => input,
                            Err(mpsc::RecvTimeoutError::Timeout) => continue,
                            Err(mpsc::RecvTimeoutError::Disconnected) => break,
                        };
                        if worker_stop.load(Ordering::Acquire) {
                            break;
                        }
                        let output = acquire(&mut capture, input);
                        // Completion is retained even after cancellation. The
                        // destination cannot be recycled until this is observed.
                        worker_shared
                            .lock()
                            .unwrap_or_else(|p| p.into_inner())
                            .acquired = Some(output);
                        wake();
                    }
                    drop(capture); // must execute on the creating COM thread
                }));
                let completion = if outcome.is_ok() {
                    worker_owners.fetch_sub(1, Ordering::AcqRel);
                    CaptureOwnerCompletion::Closed
                } else {
                    // A panic does not prove driver release. Keep the quarantine
                    // permit charged; do not admit unbounded replacement owners.
                    CaptureOwnerCompletion::Panicked
                };
                closed_tx.send_replace(completion);
                wake();
            });
        if let Err(error) = spawned {
            owners.fetch_sub(1, Ordering::AcqRel);
            return Err(format!("Could not spawn capture owner: {error}"));
        }
        Ok(Self {
            commands,
            stop,
            shared,
            in_flight: false,
            closed,
            generation,
        })
    }
    pub(crate) fn take_open_result(&self) -> Option<Result<(), E>> {
        self.shared
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .opened
            .take()
    }
    pub(crate) fn begin_acquire(&mut self, input: I) -> Result<(), I> {
        if self.in_flight || self.stop.load(Ordering::Acquire) {
            return Err(input);
        }
        match self.commands.try_send(input) {
            Ok(()) => {
                self.in_flight = true;
                Ok(())
            }
            Err(mpsc::TrySendError::Full(input) | mpsc::TrySendError::Disconnected(input)) => {
                Err(input)
            }
        }
    }
    pub(crate) fn take_acquired(&mut self) -> Option<Result<O, E>> {
        let result = self
            .shared
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .acquired
            .take();
        if result.is_some() {
            self.in_flight = false;
        }
        result
    }
    pub(crate) fn stop(&self) {
        self.stop.store(true, Ordering::Release);
    }
    pub(crate) fn completion(&self) -> CaptureOwnerCompletion {
        *self.closed.borrow()
    }
    pub(crate) fn close_receipt(&self) -> tokio::sync::watch::Receiver<CaptureOwnerCompletion> {
        self.closed.clone()
    }
}
impl<I, O, E> Drop for CaptureOwner<I, O, E> {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Release);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::rc::Rc;

    struct AffineOwner {
        created: thread::ThreadId,
        dropping: mpsc::SyncSender<thread::ThreadId>,
        close_release: mpsc::Receiver<()>,
        _not_send: Rc<()>,
    }
    impl Drop for AffineOwner {
        fn drop(&mut self) {
            let current = thread::current().id();
            assert_eq!(current, self.created);
            let _ = self.dropping.send(current);
            let _ = self.close_release.recv_timeout(Duration::from_secs(3));
        }
    }
    async fn wait_closed(receipt: &mut tokio::sync::watch::Receiver<CaptureOwnerCompletion>) {
        tokio::time::timeout(Duration::from_secs(3), async {
            loop {
                if *receipt.borrow_and_update() != CaptureOwnerCompletion::Running {
                    break;
                }
                receipt.changed().await.expect("owner completion receipt");
            }
        })
        .await
        .expect("bounded capture owner close");
        assert_eq!(*receipt.borrow(), CaptureOwnerCompletion::Closed);
    }

    #[tokio::test]
    async fn blocked_open_acquire_and_close_keep_exact_owner_and_destination_charged() {
        let owners = Arc::new(AtomicUsize::new(0));
        let (opening_tx, opening_rx) = mpsc::sync_channel(1);
        let (open_release_tx, open_release_rx) = mpsc::sync_channel(1);
        let (acquiring_tx, acquiring_rx) = mpsc::sync_channel(1);
        let (acquire_release_tx, acquire_release_rx) = mpsc::sync_channel(1);
        let (dropping_tx, dropping_rx) = mpsc::sync_channel(1);
        let (close_release_tx, close_release_rx) = mpsc::sync_channel(1);
        let mut owner = CaptureOwner::start(
            7,
            owners.clone(),
            move || {
                let created = thread::current().id();
                opening_tx.send(created).unwrap();
                open_release_rx
                    .recv_timeout(Duration::from_secs(3))
                    .unwrap();
                Ok::<_, String>(AffineOwner {
                    created,
                    dropping: dropping_tx,
                    close_release: close_release_rx,
                    _not_send: Rc::new(()),
                })
            },
            move |capture, destination: Arc<AtomicUsize>| {
                acquiring_tx.send(capture.created).unwrap();
                acquire_release_rx
                    .recv_timeout(Duration::from_secs(3))
                    .unwrap();
                destination.store(9, Ordering::Release);
                Ok(destination)
            },
        )
        .unwrap();
        let owner_thread = opening_rx.recv_timeout(Duration::from_secs(3)).unwrap();
        assert_ne!(owner_thread, thread::current().id());
        assert!(owner.take_open_result().is_none());
        assert_eq!(owners.load(Ordering::Acquire), 1);
        let destination = Arc::new(AtomicUsize::new(0));
        assert!(owner.begin_acquire(destination.clone()).is_ok());
        assert!(owner.begin_acquire(destination.clone()).is_err());
        open_release_tx.send(()).unwrap();
        assert_eq!(
            acquiring_rx.recv_timeout(Duration::from_secs(3)).unwrap(),
            owner_thread
        );
        assert!(owner.take_open_result().unwrap().is_ok());
        assert!(owner.take_acquired().is_none());
        // Cancellation cannot release/recycle the in-flight destination.
        owner.stop();
        let mut closed = owner.close_receipt();
        assert_eq!(owner.completion(), CaptureOwnerCompletion::Running);
        assert_eq!(destination.load(Ordering::Acquire), 0);
        acquire_release_tx.send(()).unwrap();
        assert_eq!(
            dropping_rx.recv_timeout(Duration::from_secs(3)).unwrap(),
            owner_thread
        );
        assert_eq!(destination.load(Ordering::Acquire), 9);
        let finished_destination = owner.take_acquired().unwrap().unwrap();
        assert!(Arc::ptr_eq(&destination, &finished_destination));
        assert_eq!(
            owners.load(Ordering::Acquire),
            1,
            "native Drop still owns permit"
        );
        assert_eq!(owner.completion(), CaptureOwnerCompletion::Running);
        close_release_tx.send(()).unwrap();
        wait_closed(&mut closed).await;
        assert_eq!(owners.load(Ordering::Acquire), 0);
    }

    #[tokio::test]
    async fn cancelled_late_open_closes_on_owner_and_quarantine_bounds_further_opens() {
        let owners = Arc::new(AtomicUsize::new(0));
        let mut handles = Vec::new();
        let mut releases = Vec::new();
        let mut closes = Vec::new();
        for generation in [1, 2] {
            let (started_tx, started_rx) = mpsc::sync_channel(1);
            let (release_tx, release_rx) = mpsc::sync_channel(1);
            let (closing_tx, closing_rx) = mpsc::sync_channel(1);
            let (close_tx, close_rx) = mpsc::sync_channel(1);
            let owner = CaptureOwner::<(), (), String>::start(
                generation,
                owners.clone(),
                move || {
                    let created = thread::current().id();
                    started_tx.send(()).unwrap();
                    release_rx.recv_timeout(Duration::from_secs(3)).unwrap();
                    Ok(AffineOwner {
                        created,
                        dropping: closing_tx,
                        close_release: close_rx,
                        _not_send: Rc::new(()),
                    })
                },
                |_, ()| Ok(()),
            )
            .unwrap();
            started_rx.recv_timeout(Duration::from_secs(3)).unwrap();
            owner.stop();
            releases.push((release_tx, closing_rx));
            closes.push(close_tx);
            handles.push(owner);
        }
        assert!(
            CaptureOwner::<(), (), String>::start(3, owners.clone(), || Ok(()), |_, ()| Ok(()))
                .is_err()
        );
        for (release, closing) in releases {
            release.send(()).unwrap();
            closing.recv_timeout(Duration::from_secs(3)).unwrap();
        }
        assert_eq!(owners.load(Ordering::Acquire), 2);
        for (close, owner) in closes.into_iter().zip(handles) {
            let mut receipt = owner.close_receipt();
            close.send(()).unwrap();
            wait_closed(&mut receipt).await;
        }
        assert_eq!(owners.load(Ordering::Acquire), 0);
    }
    #[tokio::test]
    async fn stop_before_dequeue_never_invokes_acquire_and_waits_for_owner_close() {
        let pool = Arc::new(AtomicUsize::new(0));
        let (opened_tx, opened_rx) = mpsc::sync_channel(1);
        let (open_tx, open_rx) = mpsc::sync_channel(1);
        let (closing_tx, closing_rx) = mpsc::sync_channel(1);
        let (close_tx, close_rx) = mpsc::sync_channel(1);
        let calls = Arc::new(AtomicUsize::new(0));
        let worker_calls = calls.clone();
        let mut owner = CaptureOwner::start(
            9,
            pool.clone(),
            move || {
                opened_tx.send(()).unwrap();
                open_rx.recv_timeout(Duration::from_secs(3)).unwrap();
                Ok::<_, String>(AffineOwner {
                    created: thread::current().id(),
                    dropping: closing_tx,
                    close_release: close_rx,
                    _not_send: Rc::new(()),
                })
            },
            move |_, destination: Arc<AtomicUsize>| {
                worker_calls.fetch_add(1, Ordering::AcqRel);
                Ok(destination)
            },
        )
        .unwrap();
        opened_rx.recv_timeout(Duration::from_secs(3)).unwrap();
        let destination = Arc::new(AtomicUsize::new(0));
        owner.begin_acquire(destination.clone()).unwrap();
        owner.stop();
        let mut receipt = owner.close_receipt();
        open_tx.send(()).unwrap();
        closing_rx.recv_timeout(Duration::from_secs(3)).unwrap();
        assert_eq!(calls.load(Ordering::Acquire), 0);
        assert_eq!(owner.completion(), CaptureOwnerCompletion::Running);
        assert_eq!(pool.load(Ordering::Acquire), 1);
        // The actor must retain its destination until this close receipt, even
        // though the queue did not begin writing it.
        assert_eq!(destination.load(Ordering::Acquire), 0);
        close_tx.send(()).unwrap();
        wait_closed(&mut receipt).await;
        assert_eq!(calls.load(Ordering::Acquire), 0);
        assert_eq!(pool.load(Ordering::Acquire), 0);
    }

    #[tokio::test]
    async fn panic_quarantine_survives_recreated_authorities_using_the_same_pool() {
        let pool = Arc::new(AtomicUsize::new(0));
        for generation in [10, 11] {
            let owner = CaptureOwner::<(), (), String>::start(
                generation,
                pool.clone(),
                || -> Result<(), String> { panic!("injected native open panic") },
                |_, ()| Ok(()),
            )
            .unwrap();
            let mut receipt = owner.close_receipt();
            tokio::time::timeout(Duration::from_secs(3), async {
                while *receipt.borrow_and_update() == CaptureOwnerCompletion::Running {
                    receipt.changed().await.unwrap();
                }
            })
            .await
            .unwrap();
            assert_eq!(owner.completion(), CaptureOwnerCompletion::Panicked);
            drop(owner);
        }
        assert_eq!(pool.load(Ordering::Acquire), 2);
        assert!(
            CaptureOwner::<(), (), String>::start(12, pool, || Ok(()), |_, ()| Ok(())).is_err()
        );
        assert!(
            Arc::ptr_eq(&platform_pool(), &platform_pool()),
            "real actors use one process-lifetime pool"
        );
    }
}
