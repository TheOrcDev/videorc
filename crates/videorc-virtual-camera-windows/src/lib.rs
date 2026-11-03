//! Videorc Camera on Windows 11 (plan 214, workstream C).
//!
//! Three things live here:
//!
//! - **The media source** (C1): a Media Foundation software camera source
//!   (`IMFMediaSourceEx`, `IMFMediaStream2`, `IMFGetService`, `IKsControl`,
//!   `IMFSampleAllocatorControl`, its `IMFActivate` and class factory) that
//!   the Windows Frame Server loads out of this DLL after
//!   `MFCreateVirtualCamera`. It runs inside the Frame Server service, as
//!   Local Service in session 0, never in Videorc's process. One stream,
//!   NV12 1920×1080 at 30 fps. Microsoft's `Samples/VirtualCamera`
//!   `SimpleMediaSource` is the template; every method mirrors its contract.
//! - **The frame ring** ([`ring`]): a named `Global\` section the media source
//!   creates with a DACL ([`SECTION_SDDL`]) and the app opens from the user's
//!   session. A seqlocked three-slot NV12 ring with a header that carries the
//!   producer heartbeat and the viewer count (D13). Pure Rust, tested on any
//!   OS. When the ring is absent or stale for a second the camera shows the
//!   "Videorc isn't running" still ([`still`]).
//! - **Setup** (C2): `DllRegisterServer`/`DllUnregisterServer` and the tiny
//!   `videorc-camera-setup.exe` that copies the DLL under `%ProgramData%` and
//!   writes HKLM, once, elevated. [`setup`] holds the layout both the exe and
//!   the backend's detection read.
//!
//! The whole feature stays hidden in the app until a Windows box passes the
//! P0b spike (`virtual_camera_windows::PROVEN` in the backend).

pub mod ring;
pub mod setup;
pub mod still;

#[cfg(windows)]
pub mod windows;

/// The camera's name in every other app (D2). Windows appends
/// " Windows Virtual Camera" on its own.
pub const CAMERA_NAME: &str = "Videorc Camera";
/// D11: one format.
pub const CAMERA_WIDTH: u32 = 1920;
pub const CAMERA_HEIGHT: u32 = 1080;
pub const CAMERA_FPS: u32 = 30;
/// One frame at 30 fps, in Media Foundation's 100 ns units.
pub const FRAME_DURATION_100NS: i64 = 10_000_000 / CAMERA_FPS as i64;

/// The media source CLSID: what `MFCreateVirtualCamera` is handed as the
/// source id and what HKLM registers. Shared with the backend's
/// `VIRTUAL_CAMERA_WINDOWS_SOURCE_CLSID`.
pub const SOURCE_CLSID: &str = "{B629EEBB-4B8E-4CAB-A549-EB17570B1382}";
/// [`SOURCE_CLSID`] as the GUID's 128-bit value.
pub const SOURCE_CLSID_U128: u128 = 0xB629EEBB_4B8E_4CAB_A549_EB17570B1382;

/// The DACL the media source gives the shared section, as SDDL. The Frame
/// Server (Local Service, or System on some builds) and administrators own
/// it outright, the interactively logged-on user (Videorc) can read and
/// write it, everyone else can read it. A medium mandatory label with
/// no-write-up is stated so the app's medium-integrity process is allowed to
/// write whatever the creating service's integrity level is. A NULL DACL is
/// never acceptable (plan 214 C, STOP conditions).
pub const SECTION_SDDL: &str =
    "D:P(A;;GA;;;SY)(A;;GA;;;BA)(A;;GA;;;LS)(A;;GRGW;;;IU)(A;;GR;;;WD)S:(ML;;NW;;;ME)";

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_clsid_string_and_value_agree() {
        let hex = SOURCE_CLSID
            .trim_matches(|c| c == '{' || c == '}')
            .replace('-', "");
        assert_eq!(u128::from_str_radix(&hex, 16).unwrap(), SOURCE_CLSID_U128);
    }

    #[test]
    fn the_section_dacl_is_never_null_and_names_every_principal() {
        assert!(SECTION_SDDL.starts_with("D:P("));
        for principal in ["SY", "BA", "LS", "IU", "WD"] {
            assert!(
                SECTION_SDDL.contains(&format!(";;;{principal})")),
                "{principal}"
            );
        }
        assert!(SECTION_SDDL.contains("(A;;GRGW;;;IU)"), "the user writes");
        assert!(SECTION_SDDL.contains("(A;;GR;;;WD)"), "everyone reads");
        assert!(SECTION_SDDL.ends_with("S:(ML;;NW;;;ME)"));
    }

    #[test]
    fn one_frame_is_a_thirtieth_of_a_second() {
        assert_eq!(FRAME_DURATION_100NS, 333_333);
    }
}
