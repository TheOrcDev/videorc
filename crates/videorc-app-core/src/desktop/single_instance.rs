//! One instance at a time (plan 220 S2.6a): Electron's
//! `requestSingleInstanceLock` and `second-instance`, per data directory.
//!
//! The first launch takes an exclusive lock on `videorc-app.lock` in the
//! data directory (the OS releases it when the process ends, crash or not),
//! listens on a loopback port and writes the port with a fresh 256-bit
//! token to `videorc-app.instance` (owner-only). A second launch on the
//! same directory cannot take the lock: it reads that file, hands its
//! `videorc://` links to the first over the port with the token, and exits;
//! the first brings its main window up and runs the links, as Electron's
//! `second-instance` handler does. A launch on another profile
//! (`--profile`, `VIDEORC_USER_DATA_DIR`) is another instance, as in
//! Electron.
//!
//! The file names are the Rust app's own: Electron's `SingletonLock` in the
//! same directory is never touched (owed: the two apps excluding each other
//! on one profile, docs/rust-ui/desktop-integration.md).

use std::fs::{File, OpenOptions, TryLockError};
use std::io::{self, BufRead, BufReader, Read, Write};
use std::net::{SocketAddr, TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

pub const LOCK_FILE: &str = "videorc-app.lock";
pub const INSTANCE_FILE: &str = "videorc-app.instance";
/// The longest message a second launch may send.
const MAX_MESSAGE_BYTES: u64 = 64 * 1024;
/// How long a second launch waits for the first to publish its port (the
/// first may still be starting).
pub const HANDOFF_WAIT: Duration = Duration::from_secs(5);
const IO_TIMEOUT: Duration = Duration::from_secs(3);

/// What the first instance publishes.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct InstanceInfo {
    pub pid: u32,
    pub port: u16,
    pub token: String,
}

/// What a second launch sends.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Handoff {
    pub token: String,
    pub links: Vec<String>,
}

/// The first instance: it holds the lock while it lives.
#[derive(Debug)]
pub struct Primary {
    _lock: File,
    listener: Option<TcpListener>,
    token: String,
    info_path: PathBuf,
    pub info: InstanceInfo,
}

/// Another process holds the lock.
#[derive(Debug)]
pub struct Secondary {
    info_path: PathBuf,
}

#[derive(Debug)]
pub enum Acquired {
    Primary(Primary),
    Secondary(Secondary),
}

fn random_token() -> String {
    let mut bytes = [0_u8; 32];
    getrandom::fill(&mut bytes).expect("the OS random source");
    base64url(&bytes)
}

/// Unpadded base64url (the smoke server's encoding, kept local so the
/// single-instance lock does not depend on the smoke module).
fn base64url(bytes: &[u8]) -> String {
    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let n = (u32::from(chunk[0]) << 16)
            | (u32::from(*chunk.get(1).unwrap_or(&0)) << 8)
            | u32::from(*chunk.get(2).unwrap_or(&0));
        let symbols = chunk.len() + 1;
        for index in 0..symbols {
            out.push(ALPHABET[((n >> (18 - 6 * index)) & 63) as usize] as char);
        }
    }
    out
}

fn constant_time_equal(left: &[u8], right: &[u8]) -> bool {
    let mut different = left.len() ^ right.len();
    for index in 0..left.len().max(right.len()) {
        let a = left.get(index).copied().unwrap_or(0);
        let b = right.get(index).copied().unwrap_or(0);
        different |= usize::from(a ^ b);
    }
    different == 0
}

/// Writes `text` to `path` readable by its owner only, through a rename so a
/// reader never sees half of it.
fn write_private(path: &Path, text: &str) -> io::Result<()> {
    let temporary = path.with_extension("instance.tmp");
    {
        let mut options = OpenOptions::new();
        options.write(true).create(true).truncate(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options.open(&temporary)?;
        file.write_all(text.as_bytes())?;
        file.sync_all()?;
    }
    std::fs::rename(&temporary, path)
}

/// Takes the lock in `dir`, or finds the instance that holds it.
pub fn acquire(dir: &Path) -> io::Result<Acquired> {
    std::fs::create_dir_all(dir)?;
    let lock = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(dir.join(LOCK_FILE))?;
    let info_path = dir.join(INSTANCE_FILE);
    match lock.try_lock() {
        Ok(()) => {}
        Err(TryLockError::WouldBlock) => return Ok(Acquired::Secondary(Secondary { info_path })),
        Err(TryLockError::Error(error)) => return Err(error),
    }
    let listener = TcpListener::bind(SocketAddr::from(([127, 0, 0, 1], 0)))?;
    let token = random_token();
    let info = InstanceInfo {
        pid: std::process::id(),
        port: listener.local_addr()?.port(),
        token: token.clone(),
    };
    write_private(&info_path, &serde_json::to_string(&info)?)?;
    Ok(Acquired::Primary(Primary {
        _lock: lock,
        listener: Some(listener),
        token,
        info_path,
        info,
    }))
}

/// How long a relaunched process waits for the instance that relaunched it
/// to let go of the lock ([`acquire_after_relaunch`]).
pub const RELAUNCH_LOCK_WAIT: Duration = Duration::from_secs(10);

/// [`acquire`] for a process the app started to replace itself (Reopen
/// Videorc after a permission grant): the old instance may still hold the
/// lock while it quits, and a plain `acquire` would make this launch the
/// secondary and hand its links to the instance that is going away. Retries
/// until this launch is the primary or `wait` passes; after that it is what
/// `acquire` last found. The relaunch marks the new process (an argument or
/// variable it sets) so only that launch waits.
pub fn acquire_after_relaunch(dir: &Path, wait: Duration) -> io::Result<Acquired> {
    let until = Instant::now() + wait;
    loop {
        match acquire(dir)? {
            Acquired::Primary(primary) => return Ok(Acquired::Primary(primary)),
            secondary if Instant::now() >= until => return Ok(secondary),
            Acquired::Secondary(_) => std::thread::sleep(Duration::from_millis(50)),
        }
    }
}

impl Primary {
    /// Serves second launches on a thread: each handoff's links reach
    /// `on_handoff` (an empty list still asks for the window).
    pub fn serve(
        &mut self,
        on_handoff: impl Fn(Vec<String>) + Send + 'static,
    ) -> io::Result<JoinHandle<()>> {
        let listener = self
            .listener
            .take()
            .ok_or_else(|| io::Error::other("the instance is already served"))?;
        let token = self.token.clone();
        std::thread::Builder::new()
            .name("videorc-instance".into())
            .spawn(move || {
                for stream in listener.incoming() {
                    let Ok(stream) = stream else { continue };
                    if let Some(links) = read_handoff(stream, &token) {
                        on_handoff(links);
                    }
                }
            })
    }
}

impl Drop for Primary {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.info_path);
    }
}

/// One connection: the token checked in constant time, the links taken, "ok"
/// answered. Anything else is refused and dropped.
fn read_handoff(stream: TcpStream, token: &str) -> Option<Vec<String>> {
    let _ = stream.set_read_timeout(Some(IO_TIMEOUT));
    let _ = stream.set_write_timeout(Some(IO_TIMEOUT));
    let mut writer = stream.try_clone().ok()?;
    let mut line = String::new();
    BufReader::new(stream.take(MAX_MESSAGE_BYTES))
        .read_line(&mut line)
        .ok()?;
    let handoff: Option<Handoff> = serde_json::from_str(line.trim()).ok();
    match handoff {
        Some(handoff) if constant_time_equal(handoff.token.as_bytes(), token.as_bytes()) => {
            let _ = writer.write_all(b"ok\n");
            Some(handoff.links)
        }
        _ => {
            let _ = writer.write_all(b"refused\n");
            None
        }
    }
}

impl Secondary {
    /// Hands `links` to the first instance, waiting up to `wait` for it to
    /// publish its port. The pid it reached on success.
    pub fn hand_off(&self, links: &[String], wait: Duration) -> io::Result<u32> {
        let deadline = Instant::now() + wait;
        loop {
            match self.try_hand_off(links) {
                Ok(pid) => return Ok(pid),
                Err(error) if Instant::now() >= deadline => return Err(error),
                Err(_) => std::thread::sleep(Duration::from_millis(100)),
            }
        }
    }

    fn try_hand_off(&self, links: &[String]) -> io::Result<u32> {
        let info: InstanceInfo = serde_json::from_str(&std::fs::read_to_string(&self.info_path)?)
            .map_err(io::Error::other)?;
        let mut stream =
            TcpStream::connect_timeout(&SocketAddr::from(([127, 0, 0, 1], info.port)), IO_TIMEOUT)?;
        stream.set_read_timeout(Some(IO_TIMEOUT))?;
        stream.set_write_timeout(Some(IO_TIMEOUT))?;
        let message = serde_json::to_string(&Handoff {
            token: info.token.clone(),
            links: links.to_vec(),
        })?;
        stream.write_all(message.as_bytes())?;
        stream.write_all(b"\n")?;
        let mut answer = String::new();
        BufReader::new(stream.take(64)).read_line(&mut answer)?;
        if answer.trim() == "ok" {
            Ok(info.pid)
        } else {
            Err(io::Error::other(format!(
                "the running instance (pid {}) refused the handoff",
                info.pid
            )))
        }
    }
}

#[cfg(test)]
mod tests {
    use std::sync::mpsc;

    use super::*;

    #[test]
    fn a_second_launch_hands_its_links_to_the_first_and_another_profile_is_its_own() {
        let dir = tempfile::tempdir().unwrap();
        let Acquired::Primary(mut primary) = acquire(dir.path()).unwrap() else {
            panic!("the first launch must take the lock");
        };
        assert_eq!(primary.info.pid, std::process::id());
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(dir.path().join(INSTANCE_FILE))
                .unwrap()
                .permissions()
                .mode();
            assert_eq!(mode & 0o777, 0o600);
        }
        let (sender, received) = mpsc::channel();
        let _server = primary
            .serve(move |links| {
                let _ = sender.send(links);
            })
            .unwrap();

        let Acquired::Secondary(second) = acquire(dir.path()).unwrap() else {
            panic!("a second launch on the same directory must not take the lock");
        };
        let links = vec!["videorc://buddy".to_string()];
        assert_eq!(
            second.hand_off(&links, Duration::from_secs(2)).unwrap(),
            std::process::id()
        );
        assert_eq!(
            received.recv_timeout(Duration::from_secs(2)).unwrap(),
            links
        );
        // A plain second launch still reaches the first (it shows its window).
        second.hand_off(&[], Duration::from_secs(2)).unwrap();
        assert!(
            received
                .recv_timeout(Duration::from_secs(2))
                .unwrap()
                .is_empty()
        );

        let other = tempfile::tempdir().unwrap();
        assert!(matches!(
            acquire(other.path()).unwrap(),
            Acquired::Primary(_)
        ));
    }

    #[test]
    fn a_wrong_token_is_refused_and_reaches_nothing() {
        let dir = tempfile::tempdir().unwrap();
        let Acquired::Primary(mut primary) = acquire(dir.path()).unwrap() else {
            panic!("primary");
        };
        let (sender, received) = mpsc::channel();
        let _server = primary
            .serve(move |links| {
                let _ = sender.send(links);
            })
            .unwrap();
        let mut stream =
            TcpStream::connect(SocketAddr::from(([127, 0, 0, 1], primary.info.port))).unwrap();
        stream
            .write_all(b"{\"token\":\"guess\",\"links\":[\"videorc://buddy\"]}\n")
            .unwrap();
        let mut answer = String::new();
        BufReader::new(stream).read_line(&mut answer).unwrap();
        assert_eq!(answer.trim(), "refused");
        assert!(received.recv_timeout(Duration::from_millis(200)).is_err());
    }

    #[test]
    fn the_lock_frees_when_the_first_instance_ends() {
        let dir = tempfile::tempdir().unwrap();
        let first = acquire(dir.path()).unwrap();
        assert!(matches!(first, Acquired::Primary(_)));
        drop(first);
        assert!(!dir.path().join(INSTANCE_FILE).exists());
        assert!(matches!(acquire(dir.path()).unwrap(), Acquired::Primary(_)));
    }

    #[test]
    fn a_relaunch_waits_for_the_quitting_instance_and_then_takes_the_lock() {
        let dir = tempfile::tempdir().unwrap();
        let old = acquire(dir.path()).unwrap();
        assert!(matches!(old, Acquired::Primary(_)));
        // Still held for the whole wait: the relaunch ends up the secondary.
        assert!(matches!(
            acquire_after_relaunch(dir.path(), Duration::from_millis(150)).unwrap(),
            Acquired::Secondary(_)
        ));
        // The old instance quits a moment after the relaunch started.
        let quitting = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(300));
            drop(old);
        });
        let started = Instant::now();
        let relaunched = acquire_after_relaunch(dir.path(), Duration::from_secs(5)).unwrap();
        quitting.join().unwrap();
        let Acquired::Primary(primary) = relaunched else {
            panic!("the relaunch must take the lock once the old instance lets go");
        };
        assert!(started.elapsed() >= Duration::from_millis(250));
        assert_eq!(primary.info.pid, std::process::id());
    }

    #[test]
    fn a_second_launch_with_no_first_listening_fails_after_its_wait() {
        let dir = tempfile::tempdir().unwrap();
        let secondary = Secondary {
            info_path: dir.path().join(INSTANCE_FILE),
        };
        assert!(secondary.hand_off(&[], Duration::from_millis(300)).is_err());
    }
}
