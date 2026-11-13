# Local Videorc Camera repair: CMIO unknown signing identity

Source base: `426fc149b1ffae37bb76065661ae8d1fd2c297a0` (Videorc 0.25.0).

## Reproduction and cause

After replacing the old 0.0.2 prototype extension with 0.25.0, Google Meet
displayed `Videorc isn't running` while Videorc was running with the camera
switch on. The extension repeatedly logged:

```text
refused a sink client signed as unknown
```

The installed backend had the expected Developer ID signature, signing
identifier `videorc-backend`, and team `C2PA37RB58`. CMIO nevertheless reported
the literal `unknown`. `SinkAccessPolicy` accepted nil and empty identities
as unverified but denied that sentinel, preventing the producer from opening
the sink. The extension's producer word remained `unknown`.

## Change

Treat exactly `unknown` as unavailable identity information under the existing
unverified-client policy. Keep concrete identities subject to the allowlist.
Log the actual unavailable identity value when accepting an unverified client.
Add regression coverage for the observed sentinel and rejection of other
identities containing the word `unknown`.

## Verification

- The new sentinel regression failed on the original source (`denied` versus
  `allowedUnverified`) and passed with the fix.
- Full Swift extension build and all 25 XCTest cases passed.
- All 53 camera-extension identifier, packaging and bundle-check tests passed.
- All 26 virtual-camera smoke contract tests passed.
- The production Swift extension built successfully. The maintained local
  signing script signed an app copy with the existing Developer ID identity
  and provisioning profile. Apple notarization and stapling succeeded;
  Gatekeeper reported `accepted`, `source=Notarized Developer ID`.
- With the owner's authorization, installed that local app at
  `/Applications/Videorc.app`, version 0.25.0, development build 0.25.1d1.
  This is a local repair, not a published release. The original app is
  preserved under `apps/desktop/release/camera-fix/Videorc.original.app` in
  this checkout.
- macOS activated extension `0.25.0/0.25.1d1`. The extension logged
  `sink client signing id unavailable (reported unknown); accepted unverified`
  and `producer word: on`; the backend connected to its sink.
- Verified the owner's existing Chrome Google Meet pre-join preview:
  `Videorc Camera` selected, camera on, live camera and screen composition
  visible. Meet mirrors its self-preview.
- A separate AVFoundation reader received 189 frames in 6.43 seconds
  (29.4 fps), 1920x1080 BGRA, using eight IOSurfaces.
- The packaged `smoke:virtual-camera` gate was attempted but could not acquire
  the shared host lock, held by `videorc-rust-wt/lane-studio`'s
  `scripts/rust-ui-baseline.mjs`. No full-smoke assertion was judged. Report:
  `/tmp/videorc-camera-fix-smoke-report.json`. The owner explicitly waived a
  full-smoke rerun for this PR. The focused live readback does not exercise
  its recording, privacy, content-correlation, or lifecycle checks.

The regular Videorc app remains running with the user's saved profile and
camera output enabled. No meeting was joined and no release was published.
