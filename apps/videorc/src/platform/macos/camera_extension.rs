//! Videorc Camera's system extension request (plan 260 S2.6a, macOS): the
//! `OSSystemExtensionRequest` the Node addon made for Electron main
//! (`crates/videorc-native-preview-addon/src/camera_extension.rs`), as
//! videorc-rust's `desktop/camera_extension.rs` ported it into its app. The
//! only change is the hop to the main thread: GCD's main queue, which
//! GPUI's run loop drains, instead of Slint's event loop.
//!
//! macOS looks the extension up in the requesting process's own bundle
//! (`Contents/Library/SystemExtensions`), so the request comes from the app.
//! Every outcome reaches the core's controller
//! (`videorc_app_core::desktop::camera_extension`) through one sink that may
//! fire more than once: `needs-approval` (the request stays pending until the
//! person allows it in System Settings, or the app quits) and `replacing` (an
//! update found an older copy and replaces it) are followed later by
//! `completed`, `will-complete-after-reboot` or `failed`.
//!
//! Only a Developer ID signed bundle with the system-extension entitlement,
//! in /Applications, succeeds (owed to S5.1 and Phase 5); the dev app never
//! submits (the controller reports it unavailable first).

use std::cell::RefCell;

use dispatch2::DispatchQueue;
use objc2::rc::Retained;
use objc2::runtime::{NSObject, NSObjectProtocol, ProtocolObject};
use objc2::{AllocAnyThread, DefinedClass, MainThreadMarker, define_class, msg_send};
use objc2_foundation::{NSError, NSString};
use objc2_system_extensions::{
    OSSystemExtensionManager, OSSystemExtensionProperties, OSSystemExtensionReplacementAction,
    OSSystemExtensionRequest, OSSystemExtensionRequestDelegate, OSSystemExtensionRequestResult,
};
use videorc_app_core::desktop::camera_extension::{
    CameraExtensionAction, CameraExtensionBinding, CameraExtensionUpdate,
    CameraExtensionUpdateKind, UpdateSink,
};
use videorc_app_core::desktop::permissions::PermissionFuture;

/// `NSError.domain` of every `OSSystemExtensionError`.
pub const OS_SYSTEM_EXTENSION_ERROR_DOMAIN: &str = "OSSystemExtensionErrorDomain";

thread_local! {
    /// Requests in flight (main thread). A request keeps running only while
    /// something retains it and its delegate; a finished one is dropped.
    static PENDING: RefCell<Vec<(Retained<OSSystemExtensionRequest>, Retained<RequestDelegate>)>> =
        const { RefCell::new(Vec::new()) };
}

/// Apple's `OSSystemExtensionError.Code` values, each with its name and the
/// one sentence the Output page shows (the addon's table, byte for byte).
pub fn camera_extension_failure(code: i64) -> (&'static str, &'static str) {
    match code {
        1 => (
            "unknown",
            "Something went wrong while installing Videorc Camera. Quit and reopen Videorc, then try again.",
        ),
        2 => (
            "missingEntitlement",
            "This build of Videorc can't install Videorc Camera. Download Videorc again from videorc.com, then turn it on again.",
        ),
        3 => (
            "unsupportedParentBundleLocation",
            "Move Videorc to the Applications folder, then turn Videorc Camera on again.",
        ),
        4 => (
            "extensionNotFound",
            "This build of Videorc doesn't include Videorc Camera.",
        ),
        5 => (
            "extensionMissingIdentifier",
            "Videorc Camera is missing its bundle identifier. Reinstall Videorc.",
        ),
        6 => (
            "duplicateExtensionIdentifer",
            "Another copy of Videorc already provides Videorc Camera. Remove the other copy, then try again.",
        ),
        7 => (
            "unknownExtensionCategory",
            "This version of macOS doesn't accept Videorc Camera as a camera extension. Update macOS or reinstall Videorc.",
        ),
        8 => (
            "codeSignatureInvalid",
            "Videorc Camera's signature is invalid. Reinstall Videorc from videorc.com.",
        ),
        9 => (
            "validationFailed",
            "macOS refused Videorc Camera's bundle. Reinstall Videorc.",
        ),
        10 => (
            "forbiddenBySystemPolicy",
            "A policy on this Mac blocks camera extensions. Ask whoever manages it.",
        ),
        11 => (
            "requestCanceled",
            "The Videorc Camera install was cancelled.",
        ),
        12 => (
            "requestSuperseded",
            "A newer Videorc Camera request replaced this one.",
        ),
        13 => (
            "authorizationRequired",
            "Allow Videorc Camera in System Settings, then turn it on again.",
        ),
        _ => (
            "unrecognized",
            "macOS reported an error installing Videorc Camera.",
        ),
    }
}

/// The update kind for a finished request.
pub fn result_kind(result: OSSystemExtensionRequestResult) -> CameraExtensionUpdateKind {
    if result == OSSystemExtensionRequestResult::WillCompleteAfterReboot {
        CameraExtensionUpdateKind::WillCompleteAfterReboot
    } else {
        CameraExtensionUpdateKind::Completed
    }
}

/// The `failed` update for an `NSError`'s domain, code and description.
pub fn failure_update(
    action: CameraExtensionAction,
    identifier: &str,
    domain: &str,
    code: i64,
    detail: String,
) -> CameraExtensionUpdate {
    let ours = domain == OS_SYSTEM_EXTENSION_ERROR_DOMAIN;
    let (code_name, reason) = if ours {
        camera_extension_failure(code)
    } else {
        (
            "foreignDomain",
            "macOS reported an error installing Videorc Camera.",
        )
    };
    let mut update =
        CameraExtensionUpdate::plain(CameraExtensionUpdateKind::Failed, action, identifier);
    update.code = Some(code);
    update.code_name = Some(code_name.to_string());
    update.reason = Some(reason.to_string());
    update.detail = Some(if ours {
        detail
    } else {
        format!("{domain} {code}: {detail}")
    });
    update
}

pub struct DelegateIvars {
    action: CameraExtensionAction,
    identifier: String,
    sink: UpdateSink,
}

define_class!(
    #[unsafe(super(NSObject))]
    #[name = "VideorcAppCameraExtensionRequestDelegate"]
    #[ivars = DelegateIvars]
    pub struct RequestDelegate;

    unsafe impl NSObjectProtocol for RequestDelegate {}

    unsafe impl OSSystemExtensionRequestDelegate for RequestDelegate {
        #[unsafe(method(request:actionForReplacingExtension:withExtension:))]
        fn request_action_for_replacing_extension(
            &self,
            _request: &OSSystemExtensionRequest,
            existing: &OSSystemExtensionProperties,
            ext: &OSSystemExtensionProperties,
        ) -> OSSystemExtensionReplacementAction {
            // An update ships a newer extension: replace, never cancel.
            let mut update = self.plain(CameraExtensionUpdateKind::Replacing);
            update.existing_version = Some(unsafe { existing.bundleShortVersion() }.to_string());
            update.new_version = Some(unsafe { ext.bundleShortVersion() }.to_string());
            (self.ivars().sink)(update);
            OSSystemExtensionReplacementAction::Replace
        }

        #[unsafe(method(requestNeedsUserApproval:))]
        fn request_needs_user_approval(&self, _request: &OSSystemExtensionRequest) {
            (self.ivars().sink)(self.plain(CameraExtensionUpdateKind::NeedsApproval));
        }

        #[unsafe(method(request:didFinishWithResult:))]
        fn request_did_finish_with_result(
            &self,
            request: &OSSystemExtensionRequest,
            result: OSSystemExtensionRequestResult,
        ) {
            (self.ivars().sink)(self.plain(result_kind(result)));
            forget_request(request);
        }

        #[unsafe(method(request:didFailWithError:))]
        fn request_did_fail_with_error(&self, request: &OSSystemExtensionRequest, error: &NSError) {
            let ivars = self.ivars();
            (ivars.sink)(failure_update(
                ivars.action,
                &ivars.identifier,
                &error.domain().to_string(),
                error.code() as i64,
                error.localizedDescription().to_string(),
            ));
            forget_request(request);
        }
    }
);

impl RequestDelegate {
    fn new(ivars: DelegateIvars) -> Retained<Self> {
        let this = Self::alloc().set_ivars(ivars);
        unsafe { msg_send![super(this), init] }
    }

    fn plain(&self, kind: CameraExtensionUpdateKind) -> CameraExtensionUpdate {
        CameraExtensionUpdate::plain(kind, self.ivars().action, &self.ivars().identifier)
    }
}

fn forget_request(request: &OSSystemExtensionRequest) {
    PENDING.with_borrow_mut(|pending| {
        pending.retain(|(kept, _)| !std::ptr::eq(&**kept, request));
    });
}

/// The request and its delegate, built but not submitted: the delegate
/// answers on the main queue (the app's event loop drains it).
pub fn build_request(
    action: CameraExtensionAction,
    identifier: &str,
    sink: UpdateSink,
) -> Result<
    (
        Retained<OSSystemExtensionRequest>,
        Retained<RequestDelegate>,
    ),
    String,
> {
    if identifier.trim().is_empty() {
        return Err("A camera extension bundle identifier is required.".to_string());
    }
    let delegate = RequestDelegate::new(DelegateIvars {
        action,
        identifier: identifier.to_string(),
        sink,
    });
    let ns_identifier = NSString::from_str(identifier);
    let queue = DispatchQueue::main();
    let request = unsafe {
        match action {
            CameraExtensionAction::Activate => {
                OSSystemExtensionRequest::activationRequestForExtension_queue(&ns_identifier, queue)
            }
            CameraExtensionAction::Deactivate => {
                OSSystemExtensionRequest::deactivationRequestForExtension_queue(
                    &ns_identifier,
                    queue,
                )
            }
        }
    };
    unsafe { request.setDelegate(Some(ProtocolObject::from_ref(&*delegate))) };
    Ok((request, delegate))
}

/// Submits on the main thread: the request and its delegate are kept until
/// it finishes.
fn submit_on_main(
    action: CameraExtensionAction,
    identifier: &str,
    sink: UpdateSink,
) -> Result<(), String> {
    if MainThreadMarker::new().is_none() {
        return Err("Camera extension requests must be made on the macOS main thread.".to_string());
    }
    let (request, delegate) = build_request(action, identifier, sink)?;
    PENDING.with_borrow_mut(|pending| pending.push((request.clone(), delegate)));
    unsafe { OSSystemExtensionManager::sharedManager().submitRequest(&request) };
    Ok(())
}

/// The real binding: the request is made on the main thread.
pub struct SystemExtensionBinding;

impl CameraExtensionBinding for SystemExtensionBinding {
    fn submit(
        &self,
        action: CameraExtensionAction,
        identifier: String,
        on_update: UpdateSink,
    ) -> PermissionFuture<'_, Result<(), String>> {
        Box::pin(async move {
            let (reply, answer) = tokio::sync::oneshot::channel();
            DispatchQueue::main().exec_async(move || {
                let _ = reply.send(submit_on_main(action, &identifier, on_update));
            });
            answer
                .await
                .map_err(|_| "The main thread dropped the request.".to_string())?
        })
    }
}

#[cfg(test)]
mod tests {
    use std::sync::{Arc, Mutex};

    use objc2_foundation::NSDictionary;
    use objc2_system_extensions::OSSystemExtensionErrorCode;

    use super::*;

    #[test]
    fn every_documented_code_has_a_name_and_a_sentence() {
        for code in 1..=13 {
            let (name, reason) = camera_extension_failure(code);
            assert_ne!(name, "unrecognized", "code {code}");
            assert!(reason.ends_with('.'), "code {code}: {reason}");
            assert!(reason.contains("Videorc Camera") || reason.contains("camera extension"));
        }
        assert_eq!(camera_extension_failure(0).0, "unrecognized");
        assert_eq!(camera_extension_failure(99).0, "unrecognized");
        for (code, name) in [
            (OSSystemExtensionErrorCode::Unknown, "unknown"),
            (
                OSSystemExtensionErrorCode::MissingEntitlement,
                "missingEntitlement",
            ),
            (
                OSSystemExtensionErrorCode::UnsupportedParentBundleLocation,
                "unsupportedParentBundleLocation",
            ),
            (
                OSSystemExtensionErrorCode::ExtensionNotFound,
                "extensionNotFound",
            ),
            (
                OSSystemExtensionErrorCode::CodeSignatureInvalid,
                "codeSignatureInvalid",
            ),
            (
                OSSystemExtensionErrorCode::AuthorizationRequired,
                "authorizationRequired",
            ),
        ] {
            assert_eq!(camera_extension_failure(code.0 as i64).0, name);
        }
    }

    #[test]
    fn the_table_is_the_addons_byte_for_byte() {
        let addon = include_str!(
            "../../../../../crates/videorc-native-preview-addon/src/camera_extension.rs"
        );
        for code in 1..=14 {
            let (name, reason) = camera_extension_failure(code);
            assert!(addon.contains(&format!("\"{name}\"")), "{name}");
            assert!(addon.contains(&format!("\"{reason}\"")), "{reason}");
        }
    }

    fn recorder() -> (UpdateSink, Arc<Mutex<Vec<CameraExtensionUpdate>>>) {
        let updates = Arc::new(Mutex::new(Vec::new()));
        let kept = updates.clone();
        (
            Arc::new(move |update| kept.lock().unwrap().push(update)),
            updates,
        )
    }

    /// The request is built exactly as the addon built it, and never
    /// submitted: nothing reaches sysextd, the system state is untouched.
    #[test]
    fn the_request_names_the_extension_and_answers_through_its_delegate() {
        let (sink, updates) = recorder();
        let (request, delegate) = build_request(
            CameraExtensionAction::Activate,
            "dev.theorcdev.videorc.camera",
            sink,
        )
        .unwrap();
        assert_eq!(
            unsafe { request.identifier() }.to_string(),
            "dev.theorcdev.videorc.camera"
        );
        let attached = unsafe { request.delegate() }.expect("the delegate is set");
        assert!(std::ptr::eq(
            &*attached as *const _ as *const NSObject,
            &*delegate as *const _ as *const NSObject
        ));

        // The OS's answers, as sysextd would deliver them.
        unsafe {
            let _: () = msg_send![&*delegate, requestNeedsUserApproval: &*request];
            let _: () = msg_send![
                &*delegate,
                request: &*request,
                didFinishWithResult: OSSystemExtensionRequestResult::WillCompleteAfterReboot
            ];
            let error = NSError::errorWithDomain_code_userInfo(
                &NSString::from_str(OS_SYSTEM_EXTENSION_ERROR_DOMAIN),
                3,
                None::<
                    &NSDictionary<objc2_foundation::NSErrorUserInfoKey, objc2::runtime::AnyObject>,
                >,
            );
            let _: () = msg_send![&*delegate, request: &*request, didFailWithError: &*error];
            let foreign = NSError::errorWithDomain_code_userInfo(
                &NSString::from_str("NSCocoaErrorDomain"),
                4,
                None::<
                    &NSDictionary<objc2_foundation::NSErrorUserInfoKey, objc2::runtime::AnyObject>,
                >,
            );
            let _: () = msg_send![&*delegate, request: &*request, didFailWithError: &*foreign];
        }
        let updates = updates.lock().unwrap();
        let kinds: Vec<_> = updates.iter().map(|update| update.kind).collect();
        assert_eq!(
            kinds,
            [
                CameraExtensionUpdateKind::NeedsApproval,
                CameraExtensionUpdateKind::WillCompleteAfterReboot,
                CameraExtensionUpdateKind::Failed,
                CameraExtensionUpdateKind::Failed,
            ]
        );
        assert!(updates.iter().all(|update| {
            update.action == CameraExtensionAction::Activate
                && update.identifier == "dev.theorcdev.videorc.camera"
        }));
        assert_eq!(updates[2].code, Some(3));
        assert_eq!(
            updates[2].code_name.as_deref(),
            Some("unsupportedParentBundleLocation")
        );
        assert_eq!(
            updates[2].reason.as_deref(),
            Some("Move Videorc to the Applications folder, then turn Videorc Camera on again.")
        );
        assert_eq!(updates[3].code_name.as_deref(), Some("foreignDomain"));
        assert!(
            updates[3]
                .detail
                .as_deref()
                .unwrap()
                .starts_with("NSCocoaErrorDomain 4: ")
        );
    }

    #[test]
    fn a_deactivation_names_its_action_and_an_empty_identifier_is_refused() {
        let (sink, updates) = recorder();
        let (request, delegate) = build_request(
            CameraExtensionAction::Deactivate,
            "dev.theorcdev.videorc.camera",
            sink.clone(),
        )
        .unwrap();
        unsafe {
            let _: () = msg_send![
                &*delegate,
                request: &*request,
                didFinishWithResult: OSSystemExtensionRequestResult::Completed
            ];
        }
        let update = updates.lock().unwrap()[0].clone();
        assert_eq!(update.kind, CameraExtensionUpdateKind::Completed);
        assert_eq!(update.action, CameraExtensionAction::Deactivate);
        assert!(build_request(CameraExtensionAction::Activate, "  ", sink).is_err());
    }

    #[test]
    fn submitting_off_the_main_thread_is_refused_before_anything_is_sent() {
        let (sink, _) = recorder();
        // Test threads are never the process's main thread.
        assert_eq!(
            submit_on_main(
                CameraExtensionAction::Activate,
                "dev.theorcdev.videorc.camera",
                sink
            )
            .unwrap_err(),
            "Camera extension requests must be made on the macOS main thread."
        );
    }
}
