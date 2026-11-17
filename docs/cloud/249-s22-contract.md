# Plan 249 S22 frozen contract (cloud ISO)

Owner: S22 thread G1wkh. Implementation in the isolated S22 worktrees only:
desktop `/Users/orcdev/projects/videorc-wt-249-s22`, web
`/Users/orcdev/projects/videorcweb-wt-249-s22` (branch `feat/249-s22-cloud-parity`).
Production stays disabled: `ISO_PRODUCTION_QUALIFIED = false` in web
`lib/cloud/iso/admission.ts`, with no environment toggle. Tests inject a
qualified permit through dependencies only.

## 1. Manifest v1 (all parsers)

Web `lib/cloud/iso/manifest.ts`, desktop `apps/desktop/src/shared/cloud-source-iso.ts`,
Rust `crates/videorc-backend/src/cloud_source_iso.rs`; shared fixture
`protocol-fixtures/cloud-source-iso.json` (identical to web `tests/fixtures/`).
Entry ids are `<subject>/<role>/g<n>`; subject is `host` or a guest id `g_…`.
Roles: `host-camera`, `host-microphone`, `host-aux`, `host-screen`,
`guest-camera`, `guest-microphone`, `guest-screen`, `guest-screen-audio`.
`host-aux` is the combined S3 soundboard + S8 system aux, one file, never stems.

`frameLayout` (video entries only; null for audio):

| Role          | v1 value                                                                                               |
| ------------- | ------------------------------------------------------------------------------------------------------ |
| `host-camera` | `{ basis: "unavailable", layout: "unknown", declared: null \| "opaque" \| "rgb-left-alpha-right:g8" }` |
| other video   | `{ basis: "role-opaque", layout: "opaque", declared: null }`                                           |

`declared` copies S13a's track-name descriptor
(`videorc:camera-frame:v1;frameLayout=…;generation=n`) as an untrusted
claim only. A layout of `unknown` must never be shown or exported as a normal
picture: label it "layout unknown" and do not offer playback or thumbnails as
a camera image. A trusted basis needs a later manifest version.

Failures: `start-failed`, `provider-failed`, `provider-aborted`,
`limit-reached`, `missing-output`, `stop-failed`, `start-unknown` (the start
call's outcome is unknown and no provider egress was found for it within the
recovery window).

## 2. Web durable state

`CloudShowMediaStateJson.iso?: IsoStateJson` (`db/schema.ts`, optional JSON,
no SQL migration), written only through `mediaStore.media.mutate`:

```ts
type IsoStateJson = {
  v: 1
  /** Host consent + limits. Null: ISO not requested for this show. */
  request: {
    atMs: number
    consentVersion: 'iso-consent-v1'
    maxActiveEntries: number
    maxMinutes: number
    costCeilingMicros: number
    /** The plan's recording retention; ISO files never outlive it. */
    retentionDays: number
  } | null
  /** Current per-guest consent; a withdrawal deletes the key. */
  guestConsent: Record<string, { atMs: number; version: 'iso-consent-v1' }>
  /** One manifest per program take ISO bound to (at most 8). */
  takes: Record<string, IsoManifestV1>
  /** Write-only ISO key pairs (Neon token ids, never secrets) to revoke. */
  keys: Array<{ id: string; branchId: string; atMs: number; expiresAtMs: number }>
  /** Why the last take admission was refused, shown to the host. */
  lastRefusal: { reason: string; atMs: number; takeId: string | null } | null
  /** Storage branch of the show's recording space, for signed reads. */
  storageBranchId: string | null
  /** Provider effects run only under this lease (30 s). */
  lease: { owner: string; untilMs: number } | null
}
```

## 3. Web HTTP (owner session; desktop sends its existing bearer)

- `GET /api/cloud/shows/:id/iso` → `200 { availability, iso: IsoStatus | null }`
  where `IsoStatus = { request, guestConsent: Array<{ identity, atMs }>, takes:
Array<{ manifest: IsoManifestV1; programRecordingId: string }> }`.
  `programRecordingId` = `recordingIdFor(takePrefix + "index.m3u8")`, the S20 /
  S21c canonical id of the take's mixed program recording.
- `POST /api/cloud/shows/:id/iso` JSON body, one of:
  - `{ action: "enable", consent: true, consentVersion: "iso-consent-v1", maxActiveEntries, maxMinutes, costCeilingMicros }`
  - `{ action: "disable" }`
  - `{ action: "reconcile" }`
    → `200 { availability, iso }`. Errors: `401`, `404`, `410 show-expired`,
    `400 { error: "invalid-request" }`, `403 { error: "iso-plan" }`,
    `409 { error: "not-qualified", ...availability }`,
    `409 { error: "iso-refused", reason }` (admission refusal code).
- S24 fence: enable, disable and reconcile run inside
  `IsoHttpDeps.controllerCommand(request, showId, "iso-enable|iso-disable|iso-reconcile", run)`
  after the owner and body checks. Its shape takes S24's
  `withControllerCommand` with no adapter (`run` returns `NextResponse`):
  `controllerCommand: (r, id, what, run) => withControllerCommand(r, id, {}, what, run)`.
  A refusal is S24's 409 with `controllerEpoch` and `error.code`
  `cloud-controller-stale` or `cloud-controller-required`, and nothing is
  written. Reads, the file route, guest consent and server ticks
  are never fenced.
- `GET /api/cloud/shows/:id/iso/file?take=tk_…&entry=<entryId>` →
  `200 { url, expiresAt, bytes, fileName, frameLayout, partial }` (10-minute
  presigned GET of that one object). `404 not-found`, `409 iso-file-not-ready`,
  `410 iso-expired` / `iso-file-missing`.

## 4. Guest consent (web)

- Guest show read (`GET /api/guest/:slug`) adds
  `iso?: { requested: true; consentVersion: "iso-consent-v1"; consented: boolean }`
  only while the host has an ISO request.
- `POST /api/guest/:slug/iso-consent` with the existing guest HttpOnly cookie,
  same-origin, body `{ show, consent: boolean, version: "iso-consent-v1" }` →
  `200 { consented: boolean, atMs: number | null }`. `409 iso-not-requested`.
  A withdrawal stops that guest's running ISO files (`consent-withdrawn`) on
  the next reconcile; files already recorded with consent stay listed.
- `GET /api/guest/:slug/iso-consent` (same guest auth, own 120/min IP budget)
  → `{ show, iso | null }`, so a guest already in the room sees a request made
  after they joined. A withdrawal is accepted even after the host disabled ISO
  while a consent is still stored. Disabling ISO clears every stored guest
  consent: a later request asks again.
- Pure helpers live in `lib/cloud/iso/consent.ts`:
  `applyGuestConsent(state, guestId, consent, now): IsoStateJson` and
  `guestIsoProjection(state, guestId)`.

## 5. Desktop RPC (backend; renderer contract mirrors exactly)

| Method                   | Params                                                                                                          | Result                                                                        |
| ------------------------ | --------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `cloud.iso.status`       | `{ showId }`                                                                                                    | `{ availability, iso }` (web JSON, manifests re-validated in Rust)            |
| `cloud.iso.enable`       | `{ showId, consent: true, maxActiveEntries, maxMinutes, costCeilingMicros }`                                    | `{ availability, iso }`                                                       |
| `cloud.iso.disable`      | `{ showId }`                                                                                                    | `{ availability, iso }`                                                       |
| `cloud.iso.import`       | `{ showId, takeId, outputDirectory, ffmpegPath? }` (output directory capability as `cloud.recordings.download`) | `{ jobId }`                                                                   |
| `cloud.iso.imports`      | `{}`                                                                                                            | `Array<{ showId, takeId, programRecordingId, records: IsoDownloadRecord[] }>` |
| `cloud.iso.cancelImport` | `{ jobId }`                                                                                                     | `{ ok: true }`                                                                |

Errors: `cloud-iso-not-qualified`, `cloud-iso-plan`, `cloud-iso-refused`,
`cloud-iso-controller` (S24 fence: `cloud-controller-stale` or
`cloud-controller-required`),
`cloud-iso-failed`, `cloud-iso-import-failed`, `resource-capability-rejected`,
`invalid-params`. Event `cloud.iso.import`:
`{ jobId, showId, takeId, entryId, state: "pending" | "downloading" | "complete" | "failed" | "expired", bytes, error, localSessionId }`.

`IsoDownloadRecord` is the Rust `IsoDownloadRecord` JSON (camelCase):
`{ entryId, objectKey, expectedBytes, state, attempts, localFileName, bytes, error }`.

Library registration of a complete import: one session row per ISO file,
`mode = "cloud-recording"`, id `cloud-iso-<takeId>-<subject>-<role>-g<n>`,
title from `plan_iso_import`, take group = the S20 local session of
`programRecordingId` when present, else `programRecordingId`; take role
`iso:<role>`. Diagnostics carry `cloudIso: { showId, takeId, entryId, role,
subject, generation, offsetMs, frameLayout, partial, overlap, programRecordingId }`.
A `frameLayout: "unknown"` file is registered but flagged; Library never
treats it as a normal picture. Partial files say partial. Writers take the
per-take claim guard first (S21c `claim_take_file` once integrated).
