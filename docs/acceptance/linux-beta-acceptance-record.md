# Public Linux acceptance record

The public Linux acceptance record is a small, machine-readable verdict for
one exact AppImage. It is not the evidence archive. Keep screenshots,
recordings, support bundles, hostnames, serial numbers, operator names,
local paths, workflow logs and presigned URLs in the private dated record
([linux-app-acceptance-template.md](linux-app-acceptance-template.md)).

`scripts/lib/linux-acceptance-record.mjs` validates both Linux record kinds,
and `pnpm test:scripts` runs it over every committed record in
`docs/acceptance/linux-alpha/` and `docs/acceptance/linux-beta/`.

| Track | Directory                          | Record kind                        | Waiver allowed           |
| ----- | ---------------------------------- | ---------------------------------- | ------------------------ |
| Alpha | `linux-alpha/<x.y.z>-alpha.N.json` | `videorc-linux-alpha-owner-waiver` | Yes, it is the only form |
| Beta  | `linux-beta/<x.y.z>-beta.N.json`   | `videorc-linux-beta-acceptance`    | **No** (plan 257 D11)    |

## Beta: physical acceptance on two Tier 1 boxes, no waiver

Copy [linux-beta-acceptance-record.template.json](linux-beta-acceptance-record.template.json)
to `docs/acceptance/linux-beta/<releaseId>.json` only after the
[physical acceptance checklist](linux-physical-acceptance-checklist.md)
passes on at least two physical boxes running different Tier 1 desktops.
Replace every placeholder; the template fails validation until then.

The record binds the verdict to:

- the exact `releaseId` (`<x.y.z>-beta.N`) and 40-character candidate source
  commit;
- `candidateIdentity`, `linux:<releaseId>:<sourceCommit>:sha256:<AppImage sha256>`
  (the same string the Alpha candidate lane uses);
- the AppImage `filename`, lowercase `sha256` and `sizeBytes`;
- `releaseSequence`: `{ "kind": "first-public-beta" }` for the first Linux
  Beta, then `{ "kind": "successor", "previousReleaseId": "<the immediately
preceding validated Beta>" }`; a skipped or uncommitted predecessor fails;
- `boxes`: two or more entries, each a different Tier 1 desktop id
  (`ubuntu-24.04-gnome-wayland`, `arch-hyprland-wayland`,
  `fedora-kde-plasma-6-wayland`), `architecture: "x64"`,
  `physicalHardware: true`, a canonical UTC `testedAt` not before the
  candidate's `releasedAt` and not in the future, and all 20 gates `PASS`.

There is no `NOT_APPLICABLE`, `BLOCKED` or bootstrap exception on any gate,
`betaToBetaUpdate` included: for the first Beta the update starts from the
newest Linux Alpha that updates itself (checklist step 10.1). No extra JSON
field is allowed anywhere, so the record cannot carry personal evidence.

**Any waiver for a Beta release is refused**: a record whose kind contains
`waiver`, whose status is `OWNER_WAIVED`, or that carries
`physicalAcceptance` or `decidedBy` fails with `beta-waiver-refused` for
any `-beta.N` release.

The 20 gates, in checklist order: `cleanInstall`, `protocolSignIn`,
`portalScreenGrant`, `restoreToken`, `screenOnlyRecording`,
`cameraOnlyRecording`, `screenCameraMicrophoneRecording`,
`desktopAudioRecording`, `liveSourceChange`, `vaapiPath`,
`softwareFallbackPath`, `globalShortcuts`, `liveCaptions`,
`allFourPlatformsLive`, `talkShowScreenShare`, `virtualCamera`,
`betaToBetaUpdate`, `ownedProcessCleanup`, `supportBundleRedaction`,
`artifactSignature`.

Records are immutable release history: never edit or delete one. A Beta
record PR must not be added to the CI `docs-record` allow-list
(`scripts/lib/ci-change-scope.mjs`), so it runs `pnpm test:scripts` and the
chain is validated before merge. Only the release owner commits it.

## Alpha: the owner waiver

Every Linux Alpha so far shipped on the release owner's waiver:

```json
{
  "schemaVersion": 1,
  "kind": "videorc-linux-alpha-owner-waiver",
  "status": "OWNER_WAIVED",
  "releaseId": "<x.y.z>-alpha.1",
  "sourceCommit": "<40-character candidate source commit>",
  "candidateIdentity": "linux:<releaseId>:<sourceCommit>:sha256:<AppImage sha256>",
  "artifact": {
    "filename": "Videorc-<x.y.z>-linux-x64.AppImage",
    "sha256": "<AppImage sha256>",
    "sizeBytes": 283971628
  },
  "decidedAt": "<canonical UTC timestamp, not before the candidate's releasedAt>",
  "decidedBy": "release-owner",
  "basis": "field-use-by-alpha-testers",
  "physicalAcceptance": { "performed": false }
}
```

- It claims no gate: `physicalAcceptance` is exactly `{ "performed": false }`.
- `candidateStoragePrefix` (`candidates/linux-alpha/<releaseId>/<sourceCommit>`)
  is optional, as older records carry it; `artifact.sizeBytes` is optional.
- The AppImage filename must match the release's version.
- In both kinds, `candidateIdentity` must equal
  `linux:<releaseId>:<sourceCommit>:sha256:<artifact.sha256>` from the
  record's own fields (`candidate-identity-mismatch`), before it is compared
  with the candidate. `0.15.0-alpha.1` and `0.16.0-alpha.1` were committed
  with a corrupted identity and repaired in #1645; this check stops it
  coming back.
- There is no Alpha PASS contract: a physical acceptance PASS is a Beta
  record.
