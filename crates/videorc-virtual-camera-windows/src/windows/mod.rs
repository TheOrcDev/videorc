//! The Windows half: the shared section, HKLM registration, the frame source
//! the stream reads, the COM media source itself, the DLL exports and the
//! setup exe's work. Everything that can be pure lives one level up.

pub mod dll;
pub mod frame_source;
pub mod media_source;
pub mod registration;
pub mod section;
pub mod setup_exe;

/// The boot clock both sides stamp the ring with (milliseconds).
pub fn boot_clock_ms() -> u64 {
    // SAFETY: no arguments, no preconditions.
    unsafe { ::windows::Win32::System::SystemInformation::GetTickCount64() }
}
