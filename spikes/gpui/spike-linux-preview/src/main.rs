//! Plan 260 spike S0.3: Videorc's Linux preview under GPUI's wgpu window.
//! Linux only; see `linux.rs` and the README.

#[cfg(target_os = "linux")]
mod linux;
#[cfg(target_os = "linux")]
mod presenter;

fn main() {
    #[cfg(target_os = "linux")]
    linux::main();
    #[cfg(not(target_os = "linux"))]
    {
        spike_summary::error("spike-linux-preview runs on Linux only (plan 260 S0.3)");
        std::process::exit(1);
    }
}
