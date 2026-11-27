/// The libpipewire functions libwebrtc statically stubs (a null pointer until
/// libwebrtc starts its own capturer). `src/linux_pipewire_shim.rs` forwards
/// each to the real library; keep the two lists the same.
const PIPEWIRE_STUBBED: [&str; 13] = [
    "pw_context_connect",
    "pw_context_connect_fd",
    "pw_context_destroy",
    "pw_context_new",
    "pw_core_disconnect",
    "pw_init",
    "pw_stream_add_listener",
    "pw_stream_connect",
    "pw_stream_dequeue_buffer",
    "pw_stream_destroy",
    "pw_stream_new",
    "pw_stream_queue_buffer",
    "pw_stream_update_params",
];

fn main() {
    let target_os = std::env::var("CARGO_CFG_TARGET_OS").unwrap_or_default();
    // Plan 260 S1.8 (D9): `backend_room` marks the platforms where the backend
    // holds the talk show's room itself (the LiveKit dependency in Cargo.toml
    // is on the same list). Elsewhere `cloud.room.owner` answers
    // `backend: false`.
    println!("cargo::rustc-check-cfg=cfg(backend_room)");
    // Windows only with the `windows-room` feature (the LiveKit dependency is
    // optional there).
    let windows_room =
        target_os == "windows" && std::env::var_os("CARGO_FEATURE_WINDOWS_ROOM").is_some();
    if matches!(target_os.as_str(), "macos" | "linux") || windows_room {
        println!("cargo::rustc-cfg=backend_room");
    }
    let static_crt = std::env::var("CARGO_CFG_TARGET_FEATURE")
        .unwrap_or_default()
        .split(',')
        .any(|feature| feature == "crt-static");
    if windows_room && !static_crt {
        println!(
            "cargo::warning=the windows-room feature needs RUSTFLAGS=\"-C target-feature=+crt-static\"; without it the link fails with LNK2038"
        );
    }
    // Plan 260 S1.8 (S0.8's finding): libwebrtc's Objective-C categories (for
    // example +[NSString stringForStdString:]) load only with -ObjC; without
    // it the first PeerConnectionFactory throws an NSException on macOS.
    if target_os == "macos" {
        println!("cargo:rustc-link-arg=-ObjC");
    }
    // Linux: libwebrtc's PipeWire stubs would take the backend's own PipeWire
    // calls (the Sounds monitor, the portal stream) and jump through null
    // pointers. Send every reference to a forwarder that calls the real
    // libpipewire (`linux_pipewire_shim.rs`).
    if target_os == "linux" {
        for name in PIPEWIRE_STUBBED {
            println!("cargo:rustc-link-arg=-Wl,--wrap={name}");
        }
    }
}
