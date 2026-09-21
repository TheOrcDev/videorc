# Public Windows Alpha acceptance record

The public acceptance record is a deliberately small, machine-readable verdict
for one exact signed candidate. It is not the evidence archive. Keep screenshots,
recordings, support bundles, hardware identifiers, operator identity, local
paths, workflow logs, presigned URLs, and security scan output in private
release evidence.

Copy `windows-alpha-acceptance-record.template.json` to
`docs/acceptance/windows-alpha/<releaseId>.json` only after the complete dated
`windows-app-acceptance-template.md` run passes on physical Windows 11 x64
hardware. Replace every placeholder. The template is intentionally invalid
until that happens.

The JSON contract binds the verdict to:

- exact release ID and 40-character candidate source commit;
- exact candidate identity and private R2 prefix;
- installer filename, lowercase SHA-256, and exact Authenticode publisher;
- canonical UTC test time and physical Windows 11 x64 hardware;
- `PASS` for every required physical gate, except the exact first-public-Alpha
  bootstrap described below.

No extra JSON fields are allowed. This prevents the public record from becoming
an accidental container for personal or sensitive evidence.

Schema version 2 requires `releaseSequence`. A successor record names the
immediately preceding, validated PASS `previousReleaseId` and must set
`alphaToAlphaUpdate.status` to `PASS`. For the first public Windows Alpha only,
use `{ "kind": "first-public-alpha" }` and set that one gate to
`{ "status": "NOT_APPLICABLE", "reason": "first-public-alpha" }`. Promotion
loads and validates the complete acceptance chain from trusted `main`; it
rejects the bootstrap form after the first record and rejects skipped,
uncommitted, malformed, or non-PASS predecessors. Acceptance records are
immutable release history and must never be deleted.

Commit the JSON, then use its immutable public GitHub URL in the promotion
workflow. Accepted forms are:

```text
https://github.com/TheOrcDev/videorc/blob/<40-character-record-commit>/docs/acceptance/windows-alpha/<releaseId>.json
https://raw.githubusercontent.com/TheOrcDev/videorc/<40-character-record-commit>/docs/acceptance/windows-alpha/<releaseId>.json
```

Branches, tags, redirects, query strings, other hosts/repositories/directories,
and a future website acceptance route are rejected. The record commit must be
an ancestor of the current trusted-main promotion checkout. It is the later
commit that adds the verdict; the JSON `sourceCommit` remains the exact candidate
commit it certifies.

Before dispatching public promotion, validate the committed record locally by
using the same inputs as the protected workflow:

```powershell
$env:VIDEORC_RELEASE_ID = '<releaseId>'
$env:VIDEORC_RELEASE_SOURCE_COMMIT = '<candidate source commit>'
$env:VIDEORC_RELEASE_EXPECTED_SHA256 = '<installer sha256>'
$env:VIDEORC_WINDOWS_PUBLISHER_NAME = '<exact publisher CN>'
$env:VIDEORC_WINDOWS_ACCEPTANCE_RECORD_URL = '<commit-pinned GitHub URL>'
pnpm release:acceptance:windows
```

That command expects the exact pending candidate `release.json` in the release
directory, fetches only the fixed GitHub raw host without redirects, enforces a
64 KiB limit, verifies the complete contract, and changes only
`acceptanceStatus` and `acceptanceRecordUrl` in the manifest.

## Owner waiver

The release owner may decide to publish a Windows Alpha without the physical
acceptance pass, for example when the alpha is already in field use. That
decision is recorded with its own kind, never as a PASS:

```json
{
  "schemaVersion": 1,
  "kind": "videorc-windows-alpha-owner-waiver",
  "status": "OWNER_WAIVED",
  "releaseId": "<releaseId>",
  "sourceCommit": "<40-character candidate source commit>",
  "candidateIdentity": "windows:<releaseId>:<sourceCommit>:sha256:<installer sha256>",
  "candidateStoragePrefix": "candidates/windows/<releaseId>/<sourceCommit>",
  "installer": { "filename": "…", "sha256": "…", "publisherName": "…" },
  "decidedAt": "<canonical UTC timestamp, not before the candidate's releasedAt>",
  "decidedBy": "release-owner",
  "basis": "field-use-by-alpha-testers",
  "physicalAcceptance": { "performed": false },
  "releaseSequence": { "kind": "first-public-alpha" }
}
```

- It claims no gate. `physicalAcceptance.performed` must be `false`; a waiver
  that claims the test it replaces is rejected.
- It binds the exact candidate and the release sequence like a PASS record, so
  nothing is rebuilt and no predecessor is skipped.
- Promotion marks `release.json` `acceptanceStatus: "waived"`, not `"pass"`.
  videorc-web must show that status before the Windows state goes `public`.
- **Only the release owner writes and commits this file.** A release agent must
  not author it: the file is the owner's decision, not evidence.
