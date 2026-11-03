//! Plan 214 B3: activating and deactivating the Videorc Camera system
//! extension from Electron main through `OSSystemExtensionRequest`.
//!
//! macOS looks the extension up in the requesting process's own bundle
//! (`Contents/Library/SystemExtensions`), so the request must come from the
//! app itself. Electron main is that process, and this addon is how main
//! calls native code. Every outcome reaches JS through one callback that may
//! fire more than once: `needs-approval` (the request stays pending until the
//! person allows it in System Settings, or the app quits) and `replacing` (an
//! update found an older copy and we replace it) are followed later by
//! `completed`, `will-complete-after-reboot` or `failed`.
use std::cell::RefCell;

use dispatch2::DispatchQueue;
use napi::bindgen_prelude::*;
use napi::threadsafe_function::{ThreadsafeFunction, ThreadsafeFunctionCallMode};
use napi_derive::napi;
use objc2::rc::Retained;
use objc2::runtime::{NSObject, NSObjectProtocol, ProtocolObject};
use objc2::{DefinedClass, MainThreadMarker, MainThreadOnly, define_class, msg_send};
use objc2_foundation::{NSError, NSString};
use objc2_system_extensions::{
    OSSystemExtensionManager, OSSystemExtensionProperties, OSSystemExtensionReplacementAction,
    OSSystemExtensionRequest, OSSystemExtensionRequestDelegate, OSSystemExtensionRequestResult,
};

/// `NSError.domain` of every `OSSystemExtensionError`.
pub const OS_SYSTEM_EXTENSION_ERROR_DOMAIN: &str = "OSSystemExtensionErrorDomain";

type Callback =
    ThreadsafeFunction<CameraExtensionUpdate, (), CameraExtensionUpdate, Status, false, true>;

thread_local! {
    /// Requests in flight. A request keeps running only while something
    /// retains it and its delegate; a finished or failed one is dropped here.
    static PENDING: RefCell<Vec<(Retained<OSSystemExtensionRequest>, Retained<RequestDelegate>)>> =
        const { RefCell::new(Vec::new()) };
}

/// One step of an activation or deactivation request, as JS sees it.
#[napi(object)]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CameraExtensionUpdate {
    /// `needs-approval`, `replacing`, `completed`, `will-complete-after-reboot` or `failed`.
    pub kind: String,
    /// `activate` or `deactivate`.
    pub action: String,
    /// The extension bundle identifier the request named.
    pub identifier: String,
    /// `failed` only: the `OSSystemExtensionError` code (or the foreign domain's code).
    pub code: Option<i64>,
    /// `failed` only: the code's name, e.g. `unsupportedParentBundleLocation`.
    pub code_name: Option<String>,
    /// `failed` only: one plain sentence for the person, e.g. "Move Videorc to the Applications folder."
    pub reason: Option<String>,
    /// `failed` only: the system's own description, for diagnostics.
    pub detail: Option<String>,
    /// `replacing` only: the installed extension's version.
    pub existing_version: Option<String>,
    /// `replacing` only: the version inside this app bundle.
    pub new_version: Option<String>,
}

/// The plain reason for one `OSSystemExtensionError` code, with its name.
#[napi(object)]
pub struct CameraExtensionFailure {
    pub code: i64,
    pub code_name: String,
    pub reason: String,
}

/// Pure. Apple's `OSSystemExtensionError.Code` values, each mapped to its
/// name and to one sentence the Output page can show.
pub fn camera_extension_failure(code: i64) -> (&'static str, &'static str) {
    match code {
        1 => (
            "unknown",
            "Something went wrong while installing Videorc Camera. Quit and reopen Videorc, then try again.",
        ),
        2 => (
            "missingEntitlement",
            "This build of Videorc can't install Videorc Camera: it was signed without the system-extension entitlement.",
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

/// Pure. The update kind for a finished request.
pub fn result_kind(result: OSSystemExtensionRequestResult) -> &'static str {
    if result == OSSystemExtensionRequestResult::WillCompleteAfterReboot {
        "will-complete-after-reboot"
    } else {
        "completed"
    }
}

/// Pure. The `failed` update for an `NSError`'s domain, code and description.
pub fn failure_update(
    action: &str,
    identifier: &str,
    domain: &str,
    code: i64,
    detail: String,
) -> CameraExtensionUpdate {
    let (code_name, reason) = if domain == OS_SYSTEM_EXTENSION_ERROR_DOMAIN {
        camera_extension_failure(code)
    } else {
        (
            "foreignDomain",
            "macOS reported an error installing Videorc Camera.",
        )
    };
    CameraExtensionUpdate {
        kind: "failed".to_owned(),
        action: action.to_owned(),
        identifier: identifier.to_owned(),
        code: Some(code),
        code_name: Some(code_name.to_owned()),
        reason: Some(reason.to_owned()),
        detail: Some(if domain == OS_SYSTEM_EXTENSION_ERROR_DOMAIN {
            detail
        } else {
            format!("{domain} {code}: {detail}")
        }),
        existing_version: None,
        new_version: None,
    }
}

fn plain_update(kind: &str, action: &str, identifier: &str) -> CameraExtensionUpdate {
    CameraExtensionUpdate {
        kind: kind.to_owned(),
        action: action.to_owned(),
        identifier: identifier.to_owned(),
        code: None,
        code_name: None,
        reason: None,
        detail: None,
        existing_version: None,
        new_version: None,
    }
}

struct DelegateIvars {
    action: &'static str,
    identifier: String,
    callback: Callback,
}

define_class!(
    #[unsafe(super(NSObject))]
    #[thread_kind = MainThreadOnly]
    #[name = "VideorcCameraExtensionRequestDelegate"]
    #[ivars = DelegateIvars]
    struct RequestDelegate;

    unsafe impl NSObjectProtocol for RequestDelegate {}

    unsafe impl OSSystemExtensionRequestDelegate for RequestDelegate {
        #[unsafe(method(request:actionForReplacingExtension:withExtension:))]
        fn request_action_for_replacing_extension(
            &self,
            _request: &OSSystemExtensionRequest,
            existing: &OSSystemExtensionProperties,
            ext: &OSSystemExtensionProperties,
        ) -> OSSystemExtensionReplacementAction {
            // An update ships a newer extension: replace, never cancel. Apple
            // asks for the activation as early as possible so this runs at launch.
            let mut update =
                plain_update("replacing", self.ivars().action, &self.ivars().identifier);
            update.existing_version = Some(unsafe { existing.bundleShortVersion() }.to_string());
            update.new_version = Some(unsafe { ext.bundleShortVersion() }.to_string());
            self.emit(update);
            OSSystemExtensionReplacementAction::Replace
        }

        #[unsafe(method(requestNeedsUserApproval:))]
        fn request_needs_user_approval(&self, _request: &OSSystemExtensionRequest) {
            self.emit(plain_update(
                "needs-approval",
                self.ivars().action,
                &self.ivars().identifier,
            ));
        }

        #[unsafe(method(request:didFinishWithResult:))]
        fn request_did_finish_with_result(
            &self,
            request: &OSSystemExtensionRequest,
            result: OSSystemExtensionRequestResult,
        ) {
            self.emit(plain_update(
                result_kind(result),
                self.ivars().action,
                &self.ivars().identifier,
            ));
            forget_request(request);
        }

        #[unsafe(method(request:didFailWithError:))]
        fn request_did_fail_with_error(&self, request: &OSSystemExtensionRequest, error: &NSError) {
            let domain = error.domain().to_string();
            let detail = error.localizedDescription().to_string();
            self.emit(failure_update(
                self.ivars().action,
                &self.ivars().identifier,
                &domain,
                error.code() as i64,
                detail,
            ));
            forget_request(request);
        }
    }
);

impl RequestDelegate {
    fn new(mtm: MainThreadMarker, ivars: DelegateIvars) -> Retained<Self> {
        let this = Self::alloc(mtm).set_ivars(ivars);
        unsafe { msg_send![super(this), init] }
    }

    fn emit(&self, update: CameraExtensionUpdate) {
        self.ivars()
            .callback
            .call(update, ThreadsafeFunctionCallMode::NonBlocking);
    }
}

fn forget_request(request: &OSSystemExtensionRequest) {
    PENDING.with_borrow_mut(|pending| {
        pending.retain(|(kept, _)| !std::ptr::eq(&**kept, request));
    });
}

fn submit(
    action: &'static str,
    identifier: String,
    callback: Function<CameraExtensionUpdate, ()>,
) -> Result<()> {
    let mtm = MainThreadMarker::new().ok_or_else(|| {
        Error::from_reason("Camera extension requests must be made on the macOS main thread.")
    })?;
    if identifier.trim().is_empty() {
        return Err(Error::from_reason(
            "A camera extension bundle identifier is required.",
        ));
    }
    let callback = callback
        .build_threadsafe_function()
        .callee_handled::<false>()
        .weak::<true>()
        .build()?;
    let delegate = RequestDelegate::new(
        mtm,
        DelegateIvars {
            action,
            identifier: identifier.clone(),
            callback,
        },
    );
    let ns_identifier = NSString::from_str(&identifier);
    // Delegate callbacks on the main queue: Electron main drains it, and the
    // delegate and the pending list are main-thread state.
    let queue = DispatchQueue::main();
    let request = unsafe {
        if action == "activate" {
            OSSystemExtensionRequest::activationRequestForExtension_queue(&ns_identifier, queue)
        } else {
            OSSystemExtensionRequest::deactivationRequestForExtension_queue(&ns_identifier, queue)
        }
    };
    unsafe { request.setDelegate(Some(ProtocolObject::from_ref(&*delegate))) };
    PENDING.with_borrow_mut(|pending| pending.push((request.clone(), delegate)));
    unsafe { OSSystemExtensionManager::sharedManager().submitRequest(&request) };
    Ok(())
}

/// Asks macOS to activate the Videorc Camera extension from this app's
/// bundle. `callback` receives every update (see `CameraExtensionUpdate`).
/// Only a Developer ID signed, notarized app in /Applications succeeds; the
/// dev app and a build without the profiles fail with a mapped reason.
#[napi]
pub fn activate_camera_extension(
    identifier: String,
    callback: Function<CameraExtensionUpdate, ()>,
) -> Result<()> {
    submit("activate", identifier, callback)
}

/// Asks macOS to deactivate the extension (Health, "Remove Videorc Camera").
/// Turning the camera off never deactivates: the still says it is off (D12).
#[napi]
pub fn deactivate_camera_extension(
    identifier: String,
    callback: Function<CameraExtensionUpdate, ()>,
) -> Result<()> {
    submit("deactivate", identifier, callback)
}

/// The mapping JS can show for a code it stored earlier (diagnostics, tests).
#[napi]
pub fn camera_extension_failure_reason(code: i64) -> CameraExtensionFailure {
    let (code_name, reason) = camera_extension_failure(code);
    CameraExtensionFailure {
        code,
        code_name: code_name.to_owned(),
        reason: reason.to_owned(),
    }
}

#[cfg(test)]
mod tests {
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
    }

    #[test]
    fn names_follow_the_system_extensions_framework() {
        let expected = [
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
                OSSystemExtensionErrorCode::ExtensionMissingIdentifier,
                "extensionMissingIdentifier",
            ),
            (
                OSSystemExtensionErrorCode::DuplicateExtensionIdentifer,
                "duplicateExtensionIdentifer",
            ),
            (
                OSSystemExtensionErrorCode::UnknownExtensionCategory,
                "unknownExtensionCategory",
            ),
            (
                OSSystemExtensionErrorCode::CodeSignatureInvalid,
                "codeSignatureInvalid",
            ),
            (
                OSSystemExtensionErrorCode::ValidationFailed,
                "validationFailed",
            ),
            (
                OSSystemExtensionErrorCode::ForbiddenBySystemPolicy,
                "forbiddenBySystemPolicy",
            ),
            (
                OSSystemExtensionErrorCode::RequestCanceled,
                "requestCanceled",
            ),
            (
                OSSystemExtensionErrorCode::RequestSuperseded,
                "requestSuperseded",
            ),
            (
                OSSystemExtensionErrorCode::AuthorizationRequired,
                "authorizationRequired",
            ),
        ];
        for (code, name) in expected {
            assert_eq!(camera_extension_failure(code.0 as i64).0, name);
        }
    }

    #[test]
    fn the_applications_folder_and_system_settings_reasons_are_plain() {
        assert_eq!(
            camera_extension_failure(3).1,
            "Move Videorc to the Applications folder, then turn Videorc Camera on again."
        );
        assert!(
            camera_extension_failure(13)
                .1
                .starts_with("Allow Videorc Camera in System Settings")
        );
        assert!(camera_extension_failure(2).1.contains("entitlement"));
    }

    #[test]
    fn finished_results_map_to_two_kinds() {
        assert_eq!(
            result_kind(OSSystemExtensionRequestResult::Completed),
            "completed"
        );
        assert_eq!(
            result_kind(OSSystemExtensionRequestResult::WillCompleteAfterReboot),
            "will-complete-after-reboot"
        );
    }

    #[test]
    fn failure_updates_carry_the_mapping_and_keep_foreign_domains_apart() {
        let update = failure_update(
            "activate",
            "dev.theorcdev.videorc.camera",
            OS_SYSTEM_EXTENSION_ERROR_DOMAIN,
            3,
            "The parent bundle is not in /Applications".to_owned(),
        );
        assert_eq!(update.kind, "failed");
        assert_eq!(update.action, "activate");
        assert_eq!(update.code, Some(3));
        assert_eq!(
            update.code_name.as_deref(),
            Some("unsupportedParentBundleLocation")
        );
        assert_eq!(
            update.reason.as_deref(),
            Some("Move Videorc to the Applications folder, then turn Videorc Camera on again.")
        );
        assert_eq!(
            update.detail.as_deref(),
            Some("The parent bundle is not in /Applications")
        );

        let foreign = failure_update(
            "deactivate",
            "dev.theorcdev.videorc.camera",
            "NSCocoaErrorDomain",
            3,
            "nope".to_owned(),
        );
        assert_eq!(foreign.code_name.as_deref(), Some("foreignDomain"));
        assert_eq!(
            foreign.detail.as_deref(),
            Some("NSCocoaErrorDomain 3: nope")
        );
        assert_ne!(foreign.reason, update.reason);
    }

    #[test]
    fn napi_failure_reason_mirrors_the_table() {
        let failure = camera_extension_failure_reason(4);
        assert_eq!(failure.code, 4);
        assert_eq!(failure.code_name, "extensionNotFound");
        assert_eq!(failure.reason, camera_extension_failure(4).1);
    }
}
