//! Resolve bundle ids without a shell or filesystem search. Electron reads the native icon.
use napi::bindgen_prelude::*;
use napi_derive::napi;
use objc2::{MainThreadMarker, msg_send, rc::Retained, runtime::AnyObject};
use objc2_app_kit::NSWorkspace;
use objc2_foundation::NSString;

#[napi]
pub fn app_path_for_bundle_id(bundle_id: String) -> Result<Option<String>> {
    MainThreadMarker::new()
        .ok_or_else(|| Error::from_reason("App icons require the main thread"))?;
    if bundle_id.is_empty() || bundle_id.len() > 512 {
        return Ok(None);
    }
    unsafe {
        let url: Option<Retained<AnyObject>> = msg_send![&*NSWorkspace::sharedWorkspace(), URLForApplicationWithBundleIdentifier: &*NSString::from_str(&bundle_id)];
        let Some(url) = url else {
            return Ok(None);
        };
        let path: Option<Retained<NSString>> = msg_send![&*url, path];
        Ok(path.map(|p| p.to_string()))
    }
}
