fn main() {
    // Plan 260 S1.8 (S0.8's finding): libwebrtc's Objective-C categories (for
    // example +[NSString stringForStdString:]) load only with -ObjC; without
    // it the first PeerConnectionFactory throws an NSException on macOS.
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("macos") {
        println!("cargo:rustc-link-arg=-ObjC");
    }
}
