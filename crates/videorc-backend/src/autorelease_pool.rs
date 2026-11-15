/// Threads Rust spawns have no autorelease pool that empties before they exit:
/// an object Metal autoreleases there (a command buffer, once per frame)
/// lives until the thread exits. Wrap each frame of such a loop in this.
pub fn with_autorelease_pool<R>(work: impl FnOnce() -> R) -> R {
    #[cfg(target_os = "macos")]
    {
        objc2::rc::autoreleasepool(|_| work())
    }
    #[cfg(not(target_os = "macos"))]
    {
        work()
    }
}

#[cfg(all(test, target_os = "macos"))]
mod tests {
    use super::with_autorelease_pool;
    use objc2::rc::Weak;
    use objc2_metal::{MTLCommandQueue, MTLCreateSystemDefaultDevice, MTLDevice};

    #[test]
    fn a_frame_in_the_pool_frees_its_command_buffer() {
        let Some(queue) =
            MTLCreateSystemDefaultDevice().and_then(|device| device.newCommandQueue())
        else {
            eprintln!("skipping: no Metal device available in this environment");
            return;
        };
        let new_frame = || Weak::from_retained(&queue.commandBuffer().expect("command buffer"));

        let without_pool = new_frame();
        if without_pool.load().is_none() {
            eprintln!("skipping: this Metal driver does not autorelease its command buffers");
            return;
        }
        let in_pool = with_autorelease_pool(new_frame);

        assert!(
            in_pool.load().is_none(),
            "the pool must free the frame's command buffer"
        );
    }
}
