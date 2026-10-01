//! Host pressure: how busy the whole computer is, and precedence for the
//! threads that keep a live session moving.
//!
//! 2026-10-01 field incident (plan 087): a live stream died while the host ran
//! at a load average of 65-79 on 10 cores with 17.6 GB of swap in use. Videorc
//! itself used 7% of one core. Every existing diagnostic measured Videorc; none
//! measured the computer, so the session record could only say "this Mac was
//! busy" and the numbers had to be reconstructed with `ps` afterwards.

use std::sync::Mutex as StdMutex;
use std::time::{Duration, Instant};

pub(crate) const HOST_OVERLOADED_CODE: &str = "host-overloaded";

/// Runnable work per logical core above which the host is overloaded. A load
/// of 1.0 per core is a full machine; at 2.0 every thread waits as long as it
/// runs. The incident sat between 6.5 and 7.9.
const HOST_OVERLOAD_LOAD_PER_CORE: f64 = 2.0;
/// Consecutive overloaded samples before the streamer is told. The 1-minute
/// load average is already smoothed, so this only filters a single spike.
const HOST_OVERLOAD_SAMPLE_THRESHOLD: u32 = 2;
/// The load average moves slowly; sampling it more often buys nothing.
const HOST_PRESSURE_SAMPLE_INTERVAL: Duration = Duration::from_secs(5);

#[derive(Debug, Clone, Copy, PartialEq)]
pub(crate) struct HostPressureSample {
    /// 1-minute load average: runnable and uninterruptibly waiting threads.
    pub(crate) load_average: f64,
    pub(crate) logical_cores: u32,
    /// Swap in use, where the platform reports it.
    pub(crate) swap_used_mb: Option<u64>,
}

impl HostPressureSample {
    fn load_per_core(self) -> f64 {
        self.load_average / f64::from(self.logical_cores.max(1))
    }

    pub(crate) fn is_overloaded(self) -> bool {
        self.load_per_core() >= HOST_OVERLOAD_LOAD_PER_CORE
    }

    /// `host_load=71.9/10 swap_used_mb=17579`, for diagnostics lines.
    pub(crate) fn diagnostics_fields(self) -> String {
        format!(
            "host_load={:.1}/{} swap_used_mb={}",
            self.load_average,
            self.logical_cores,
            self.swap_used_mb
                .map_or_else(|| "n/a".to_string(), |mb| mb.to_string()),
        )
    }

    fn overloaded_message(self) -> String {
        let swap = self
            .swap_used_mb
            .filter(|mb| *mb >= 1024)
            .map(|mb| format!(" and {:.1} GB of swap in use", mb as f64 / 1024.0))
            .unwrap_or_default();
        format!(
            "This computer is overloaded: a load of {:.0} on {} cores{swap}. Other apps are taking the time the stream and recording need, so they may freeze or stutter. Close heavy apps or pause background work.",
            self.load_average, self.logical_cores
        )
    }
}

#[cfg(unix)]
fn load_average() -> Option<f64> {
    let mut averages = [0.0_f64; 3];
    let samples = unsafe { libc::getloadavg(averages.as_mut_ptr(), 3) };
    (samples >= 1 && averages[0].is_finite()).then_some(averages[0])
}

#[cfg(not(unix))]
fn load_average() -> Option<f64> {
    // Windows has no load average; the Windows lane can grow a processor
    // queue length sample when a field report needs it there.
    None
}

#[cfg(target_os = "macos")]
fn swap_used_mb() -> Option<u64> {
    let mut usage = std::mem::MaybeUninit::<libc::xsw_usage>::zeroed();
    let mut size = std::mem::size_of::<libc::xsw_usage>();
    let rc = unsafe {
        libc::sysctlbyname(
            c"vm.swapusage".as_ptr(),
            usage.as_mut_ptr().cast(),
            &mut size,
            std::ptr::null_mut(),
            0,
        )
    };
    if rc != 0 || size != std::mem::size_of::<libc::xsw_usage>() {
        return None;
    }
    let usage = unsafe { usage.assume_init() };
    Some(usage.xsu_used / (1024 * 1024))
}

#[cfg(not(target_os = "macos"))]
fn swap_used_mb() -> Option<u64> {
    None
}

/// One sample of the whole computer, or `None` where it cannot be measured.
pub(crate) fn sample_host_pressure() -> Option<HostPressureSample> {
    let load_average = load_average()?;
    let logical_cores = std::thread::available_parallelism()
        .map(|cores| cores.get() as u32)
        .unwrap_or(1);
    Some(HostPressureSample {
        load_average,
        logical_cores,
        swap_used_mb: swap_used_mb(),
    })
}

#[derive(Default)]
struct HostOverloadWatch {
    session_id: String,
    overloaded_streak: u32,
    fired: bool,
    last_sampled_at: Option<Instant>,
}

/// Feed one host sample for a session; returns the notice text exactly once
/// per session, when the overload has held for the sample threshold.
fn host_overload_watch_update(
    watch: &mut HostOverloadWatch,
    session_id: &str,
    sample: HostPressureSample,
) -> Option<String> {
    if watch.session_id != session_id {
        *watch = HostOverloadWatch {
            session_id: session_id.to_string(),
            ..HostOverloadWatch::default()
        };
    }
    if !sample.is_overloaded() {
        watch.overloaded_streak = 0;
        return None;
    }
    watch.overloaded_streak = watch.overloaded_streak.saturating_add(1);
    if watch.fired || watch.overloaded_streak < HOST_OVERLOAD_SAMPLE_THRESHOLD {
        return None;
    }
    watch.fired = true;
    Some(sample.overloaded_message())
}

static HOST_OVERLOAD_WATCH: StdMutex<Option<HostOverloadWatch>> = StdMutex::new(None);

/// Called from a live session's diagnostics cadence. Rate-limits its own
/// sampling and returns the overload notice to publish, at most once per
/// session.
pub(crate) fn poll_host_overload_notice(session_id: &str) -> Option<String> {
    let mut guard = HOST_OVERLOAD_WATCH
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let watch = guard.get_or_insert_with(HostOverloadWatch::default);
    let now = Instant::now();
    if watch.session_id == session_id
        && watch
            .last_sampled_at
            .is_some_and(|at| now.duration_since(at) < HOST_PRESSURE_SAMPLE_INTERVAL)
    {
        return None;
    }
    let sample = sample_host_pressure()?;
    let notice = host_overload_watch_update(watch, session_id, sample);
    watch.last_sampled_at = Some(now);
    notice
}

#[cfg(target_os = "macos")]
mod qos {
    /// `QOS_CLASS_USER_INTERACTIVE` (`sys/qos.h`).
    pub(super) const QOS_CLASS_USER_INTERACTIVE: u32 = 0x21;

    unsafe extern "C" {
        pub(super) fn pthread_set_qos_class_self_np(qos_class: u32, relative_priority: i32) -> i32;
        #[cfg(test)]
        pub(super) fn pthread_get_qos_class_np(
            thread: libc::pthread_t,
            qos_class: *mut u32,
            relative_priority: *mut i32,
        ) -> i32;
    }
}

/// Give the calling thread precedence over ordinary work on a busy host.
///
/// Only threads that keep a live session moving call this: they wake once per
/// frame, do bounded work and sleep. At the default class they queue behind
/// every compile job on the machine; at this class the scheduler runs them
/// first. FFmpeg is a separate process and cannot be raised from here: macOS
/// lets a parent lower a child's class, never raise it.
#[cfg(target_os = "macos")]
pub(crate) fn promote_current_thread_for_live_media() {
    let status = unsafe { qos::pthread_set_qos_class_self_np(qos::QOS_CLASS_USER_INTERACTIVE, 0) };
    if status != 0 {
        tracing::warn!(
            status,
            thread = std::thread::current().name().unwrap_or("unnamed"),
            "could not raise a live media thread to user-interactive QoS"
        );
    }
}

#[cfg(not(target_os = "macos"))]
pub(crate) fn promote_current_thread_for_live_media() {}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample(
        load_average: f64,
        logical_cores: u32,
        swap_used_mb: Option<u64>,
    ) -> HostPressureSample {
        HostPressureSample {
            load_average,
            logical_cores,
            swap_used_mb,
        }
    }

    #[test]
    fn overload_is_load_per_core_not_raw_load() {
        // A full 10-core machine is busy, not overloaded.
        assert!(!sample(10.0, 10, None).is_overloaded());
        assert!(!sample(19.9, 10, None).is_overloaded());
        assert!(sample(20.0, 10, None).is_overloaded());
        // The 2026-10-01 incident.
        assert!(sample(71.9, 10, Some(17_579)).is_overloaded());
        // The same load on a much larger machine is fine.
        assert!(!sample(20.0, 32, None).is_overloaded());
        // A zero core count can never divide by zero.
        assert!(sample(3.0, 0, None).is_overloaded());
    }

    #[test]
    fn overload_notice_fires_once_per_session_after_it_holds() {
        let mut watch = HostOverloadWatch::default();
        let incident = sample(71.9, 10, Some(17_579));
        assert_eq!(host_overload_watch_update(&mut watch, "s1", incident), None);
        // One calm sample resets the streak.
        assert_eq!(
            host_overload_watch_update(&mut watch, "s1", sample(4.0, 10, None)),
            None
        );
        assert_eq!(host_overload_watch_update(&mut watch, "s1", incident), None);
        let message = host_overload_watch_update(&mut watch, "s1", incident)
            .expect("a sustained overload is reported");
        assert!(message.contains("a load of 72 on 10 cores"));
        assert!(message.contains("17.2 GB of swap"));
        assert_eq!(
            host_overload_watch_update(&mut watch, "s1", incident),
            None,
            "one notice per session"
        );
        // A new session is told again.
        assert_eq!(host_overload_watch_update(&mut watch, "s2", incident), None);
        assert!(host_overload_watch_update(&mut watch, "s2", incident).is_some());
    }

    #[test]
    fn overload_notice_leaves_out_trivial_swap() {
        let message = sample(40.0, 10, Some(200)).overloaded_message();
        assert!(!message.contains("swap"));
    }

    #[test]
    fn diagnostics_fields_name_load_cores_and_swap() {
        assert_eq!(
            sample(71.94, 10, Some(17_579)).diagnostics_fields(),
            "host_load=71.9/10 swap_used_mb=17579"
        );
        assert_eq!(
            sample(3.0, 8, None).diagnostics_fields(),
            "host_load=3.0/8 swap_used_mb=n/a"
        );
    }

    #[cfg(unix)]
    #[test]
    fn the_host_can_be_sampled() {
        let sample = sample_host_pressure().expect("unix hosts report a load average");
        assert!(sample.load_average >= 0.0);
        assert!(sample.logical_cores >= 1);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn a_live_media_thread_runs_at_user_interactive_qos() {
        let observed = std::thread::spawn(|| {
            promote_current_thread_for_live_media();
            let mut qos_class = 0_u32;
            let mut relative_priority = 0_i32;
            let status = unsafe {
                qos::pthread_get_qos_class_np(
                    libc::pthread_self(),
                    &mut qos_class,
                    &mut relative_priority,
                )
            };
            (status, qos_class)
        })
        .join()
        .expect("probe thread");
        assert_eq!(observed, (0, qos::QOS_CLASS_USER_INTERACTIVE));
    }
}
