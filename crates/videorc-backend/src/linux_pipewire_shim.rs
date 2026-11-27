//! Linux: keeps libwebrtc's PipeWire stubs away from the backend's own PipeWire.
//!
//! LiveKit's libwebrtc (`webrtc-sys`) statically links its own *stubs* for 13
//! libpipewire functions (`pw_init`, `pw_stream_new`, ...): each is
//! `jmp *pw_x_ptr`, a function pointer that stays null until libwebrtc itself
//! runs `InitializeStubs` (only when it starts a Wayland screen capturer).
//! Because the stubs sit in the executable, the linker binds the `pipewire`
//! crate's references to them, not to the real `libpipewire-0.3.so` it links.
//! The first PipeWire call the backend made on its own (the Sounds monitor and
//! the join chime, the portal screen stream) then jumped through a null
//! pointer: SIGSEGV, 6 s into a talk show on ogre.
//!
//! `build.rs` passes `-Wl,--wrap=<name>` for each of these functions, which
//! sends every reference to them (the Rust crate's and libwebrtc's own) to the
//! `__wrap_<name>` below. Each one finds the real function with
//! `dlsym(RTLD_DEFAULT, <name>)` (the stubs are not exported, so the lookup
//! reaches libpipewire) and calls it. The stubs' pointers are never used.
//!
//! One shape serves all 13: their arguments are integers and pointers (at most
//! six) and their results an int or a pointer, so six `usize` arguments and a
//! `usize` result pass through the System V and AAPCS64 integer registers
//! unchanged; an argument the real function does not take is ignored by it.
//!
//! Keep this list the same as `build.rs`'s `PIPEWIRE_STUBBED`.
#![cfg(all(target_os = "linux", backend_room))]

use std::ffi::CStr;
use std::sync::atomic::{AtomicUsize, Ordering};

/// The real function `name` in libpipewire, found once.
fn resolve(slot: &AtomicUsize, name: &CStr) -> usize {
    let cached = slot.load(Ordering::Relaxed);
    if cached != 0 {
        return cached;
    }
    // SAFETY: `name` is a NUL-terminated C string; RTLD_DEFAULT searches the
    // loaded libraries in the global scope.
    let found = unsafe { libc::dlsym(libc::RTLD_DEFAULT, name.as_ptr()) } as usize;
    if found == 0 {
        // A call that cannot be forwarded must not return garbage to PipeWire.
        eprintln!(
            "videorc: libpipewire has no {}; the backend cannot use PipeWire.",
            name.to_string_lossy()
        );
        std::process::abort();
    }
    slot.store(found, Ordering::Relaxed);
    found
}

macro_rules! forward {
    ($($wrap:ident => $real:literal),+ $(,)?) => {$(
        /// # Safety
        /// Called by the linker's `--wrap` redirect with the arguments of the
        /// libpipewire function of the same name.
        #[unsafe(no_mangle)]
        pub unsafe extern "C" fn $wrap(
            a: usize,
            b: usize,
            c: usize,
            d: usize,
            e: usize,
            f: usize,
        ) -> usize {
            static SLOT: AtomicUsize = AtomicUsize::new(0);
            let target = resolve(&SLOT, $real);
            // SAFETY: `target` is the libpipewire function; see the module note.
            let function: unsafe extern "C" fn(usize, usize, usize, usize, usize, usize) -> usize =
                unsafe { std::mem::transmute(target) };
            unsafe { function(a, b, c, d, e, f) }
        }
    )+};
}

forward! {
    __wrap_pw_context_connect => c"pw_context_connect",
    __wrap_pw_context_connect_fd => c"pw_context_connect_fd",
    __wrap_pw_context_destroy => c"pw_context_destroy",
    __wrap_pw_context_new => c"pw_context_new",
    __wrap_pw_core_disconnect => c"pw_core_disconnect",
    __wrap_pw_init => c"pw_init",
    __wrap_pw_stream_add_listener => c"pw_stream_add_listener",
    __wrap_pw_stream_connect => c"pw_stream_connect",
    __wrap_pw_stream_dequeue_buffer => c"pw_stream_dequeue_buffer",
    __wrap_pw_stream_destroy => c"pw_stream_destroy",
    __wrap_pw_stream_new => c"pw_stream_new",
    __wrap_pw_stream_queue_buffer => c"pw_stream_queue_buffer",
    __wrap_pw_stream_update_params => c"pw_stream_update_params",
}

#[cfg(test)]
mod tests {
    /// The names `build.rs` wraps are the ones forwarded here.
    #[test]
    fn the_wrapped_list_is_the_forwarded_list() {
        let source = include_str!("linux_pipewire_shim.rs");
        let build = include_str!("../build.rs");
        let listed = build
            .split("const PIPEWIRE_STUBBED: [&str; ")
            .nth(1)
            .and_then(|rest| rest.split("];").next())
            .expect("build.rs lists the stubbed functions");
        let names: Vec<&str> = listed.split('"').skip(1).step_by(2).collect();
        assert_eq!(names.len(), 13, "{names:?}");
        for name in &names {
            assert!(
                source.contains(&format!("__wrap_{name} => c\"{name}\"")),
                "{name} is wrapped by build.rs but not forwarded"
            );
        }
        // And nothing is forwarded that build.rs does not wrap.
        assert_eq!(source.matches("=> c\"pw_").count(), names.len());
    }
}
