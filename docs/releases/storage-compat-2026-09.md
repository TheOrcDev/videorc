# Release storage compatibility — September 2026

Slice S0 of the vault plan "2026-09-20 - Videorc Release Storage Hetzner
Primary R2 Mirror Plan". The release uploader depends on S3 features that
S3-compatible providers implement unevenly, so every candidate origin is probed
against a real bucket before any release is pointed at it.

```sh
pnpm probe:release-storage-compat -- --origin r2
pnpm probe:release-storage-compat -- --origin hetzner
```

`r2` reads the uploader's normal `VIDEORC_RELEASE_UPLOAD_S3_*` /
`VIDEORC_DOWNLOAD_S3_*` environment. Any other origin reads
`VIDEORC_RELEASE_UPLOAD_<ORIGIN>_S3_*`. The probe uses the uploader's own config
parser, SigV4 signer and TLS-pinned transport, writes two 256 KiB objects under
`compat-probe/<timestamp>/`, and deletes them.

## Origins

| Origin  | Endpoint                              | Bucket             | Region       | Backend  |
| ------- | ------------------------------------- | ------------------ | ------------ | -------- |
| r2      | `<account>.r2.cloudflarestorage.com`  | `videorc-releases` | `auto`       | R2       |
| hetzner | `https://fsn1.your-objectstorage.com` | `videorc-releases` | `eu-central` | Ceph RGW |

Hetzner: project `videorc`, Falkenstein, private, object lock off, created
2026-09-21. Hetzner S3 credentials are valid for **every bucket in the
project** and cannot be scoped to a prefix or to read-only, so the project holds
nothing but release storage.

## Results

Run 2026-09-21 from Spain.

| #   | Check                                                 | hetzner           | r2                    |
| --- | ----------------------------------------------------- | ----------------- | --------------------- |
| 1a  | `If-None-Match: *` creates a missing object           | PASS              | PASS                  |
| 1b  | `If-None-Match: *` refuses an existing object (412)   | PASS              | PASS                  |
| 2a  | `If-Match: <etag>` replaces a pointer                 | **unquoted only** | PASS (quoted)         |
| 2b  | `If-Match: <stale etag>` is refused (412)             | PASS              | PASS                  |
| 3a  | `x-amz-checksum-sha256` round trips on HEAD           | **absent**        | PASS                  |
| 3b  | A body that does not match its signed hash is refused | PASS (400)        | PASS                  |
| 4   | `x-amz-meta-videorc-sha256` survives HEAD             | PASS              | PASS                  |
| 5a  | Presigned GET returns the exact bytes                 | PASS              | PASS                  |
| 5b  | Presigned GET honours `Range` (206)                   | PASS              | PASS                  |
| 5c  | Presigned GET honours `response-content-disposition`  | PASS              | PASS                  |
| 6   | TLS peer                                              | Let's Encrypt     | Google Trust Services |
| 7   | DELETE removes the scratch objects                    | PASS              | PASS                  |

R2 passes all twelve checks. That is the baseline: it shows the probe drives a
known-good origin correctly, so a Hetzner deviation is not explained by a broken
request. It does not by itself prove the cause of each deviation, so the two
findings below were each confirmed directly (the unquoted ETag by a second
request in the same run, the pointer overwrite through the uploader itself).

## Findings for Hetzner

**Verdict: GO, with two per-origin adaptations** (both implemented in
`releaseUploadOriginCapabilities`, `scripts/lib/release-upload-s3.mjs`). Neither hard no-go
condition (1 or 2 failing) occurred: conditional creates and conditional
pointer updates are both enforced.

1. **`If-Match` needs the bare ETag.** Hetzner returns the usual quoted entity
   tag (`"9b2c…"`) but answers `412 PreconditionFailed` when that quoted value
   is sent back in `If-Match`. The same digest without quotes is honoured, and a
   stale bare ETag is still refused with the stored bytes unchanged.
   `buildReleasePutCondition` therefore takes the origin capability
   `ifMatchEtagForm: 'quoted' | 'unquoted'`.
2. **`x-amz-checksum-sha256` is not returned.** Only this header was tested. The
   PUT is accepted with
   `x-amz-checksum-sha256`, but HEAD with `x-amz-checksum-mode: ENABLED` never
   returns it. The uploader's remote re-verification
   (`envelope.checksumSha256 === sha256Base64FromHex(...)`) cannot pass on this
   origin, so the capability `checksumHeaders: false` drops only that header
   from the envelope check. Every object is still bound exactly: the uploader
   always downloads the object and compares its SHA-256 and size, and
   `x-amz-meta-videorc-sha256` must match.
   Upload integrity is unaffected: a body that does not match the signed
   `x-amz-content-sha256` is refused with `XAmzContentSHA256Mismatch`.
3. **TLS.** The endpoint presents a Let's Encrypt certificate, so the built-in
   policy for `*.your-objectstorage.com` is
   `allowedIssuerOrganizations: ["Let's Encrypt"]`. Let's Encrypt leaves rotate
   roughly every 60–90 days, so an SPKI pin is not practical here. An issuer
   allowlist for a public CA is a weaker guard than R2's, because anyone can get
   a Let's Encrypt certificate for a host they control. They cannot get one for
   `fsn1.your-objectstorage.com`, and the normal chain and hostname checks still
   apply. The forged LaLiga certificates are self-signed and fail both.
4. Presigned, ranged and content-disposition GETs behave exactly like R2, so
   the web redirect routes and electron-updater's differential download need no
   origin-specific handling beyond the region in the credential scope.

## Proven against the live buckets (2026-09-21)

- `pnpm release:sync:origins -- --live --from r2 --to hetzner` copied the live
  set (16 objects, about 670 MB: changelog, macOS latest manifest and 0.9.97
  release, macOS update feed, Windows pilot manifest, installer and feed), each
  read back and hashed on Hetzner. A second run reported every object as already
  identical.
- A scratch pointer was created, overwritten and re-published on Hetzner through
  `publishReleaseUploadArtifact` (`uploaded`, `uploaded`, `skipped`), which
  exercises the unquoted `If-Match` path end to end.
- `pnpm release:upload:preflight:macos` reports both origins reachable, with
  `r2` as primary.

## Neon

Slice N0 of the vault plan "2026-09-22 - Videorc Object Storage to Neon Plan".
Owner decision 2026-09-22: Neon Object Storage becomes the single release
origin, and R2 and Hetzner are retired after a soak.

```sh
pnpm probe:release-storage-compat -- --origin neon
```

| Field    | Value                                                                                           |
| -------- | ----------------------------------------------------------------------------------------------- |
| Endpoint | `https://br-shiny-dust-b2da46yj.storage.c-6.eu-central-1.aws.neon.tech` (per branch, host only) |
| Style    | Path-style only, SigV4 only                                                                     |
| Region   | `eu-central-1` (short AWS form in the SigV4 scope)                                              |
| Project  | `videorc-releases` (Frankfurt), bucket `releases`, `private` (see `neon.ts`)                    |
| TLS peer | Issuer O=Amazon (CN Amazon RSA 2048 M01/M04), subject `*.storage.c-N.<region>.aws.neon.tech`    |

### Results

Run 2026-09-22 with a credential carrying `storage:read` and `storage:write`.

| #   | Check                                                 | neon                                                                                         |
| --- | ----------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| 1a  | `If-None-Match: *` creates a missing object           | PASS                                                                                         |
| 1b  | `If-None-Match: *` refuses an existing object (412)   | PASS (stored bytes unchanged)                                                                |
| 2a  | `If-Match: <etag>` replaces a pointer                 | PASS (quoted)                                                                                |
| 2b  | `If-Match: <stale etag>` is refused (412)             | PASS                                                                                         |
| 3a  | `x-amz-checksum-sha256` round trips on HEAD           | PASS                                                                                         |
| 3b  | A body that does not match its signed hash is refused | PASS (400 `BadDigest`)                                                                       |
| 4   | `x-amz-meta-videorc-sha256` survives HEAD             | PASS                                                                                         |
| 5a  | Presigned GET returns the exact bytes                 | PASS                                                                                         |
| 5b  | Presigned GET honours `Range` (206)                   | PASS                                                                                         |
| 5c  | Presigned GET honours `response-content-disposition`  | **FAIL** (header absent)                                                                     |
| 6   | TLS peer                                              | Amazon, leaf SPKI SHA-256 `be20ccfc35a00221d84fd37972001dcb4f63ae2c69d449c6293e5a640921ff83` |
| 7   | DELETE removes the scratch objects                    | PASS                                                                                         |

### Findings for Neon

**Verdict: GO, with one mitigation for 5c.**

1. **Capabilities equal the S3 defaults** (`checksumHeaders: true`,
   `ifMatchEtagForm: 'quoted'`). Neon has its own entry in the
   `releaseUploadOriginCapabilities` rule table so a later difference is a
   one-line change.
2. **5c: presigned GETs ignore `response-content-disposition`.** The web
   download routes ask for an attachment disposition through that query
   parameter; on Neon it is dropped. Mitigation at write time: the uploader
   stores `Content-Disposition: attachment; filename="<basename>"` (signed) on
   every installer object (`.dmg`, `.exe`), on every origin, derived from the
   object key (`releaseArtifactContentDisposition` in
   `scripts/lib/release-upload-s3.mjs`). `release:sync:origins` publishes
   through the same function, so copies get it too. Updater zips, blockmaps,
   feeds and manifests never carry it. An installer object that already exists
   on an origin is reused as is, so only objects written after this change
   carry the header.
3. **Credentials need both scopes.** A credential with only `storage:write`
   gets 403 on HEAD and GET, contrary to Neon's docs that say write includes
   read. The uploader always reads before and after it writes, so every
   release credential (local uploader and GitHub Actions) must carry
   `storage:read` and `storage:write`.
4. **TLS.** The endpoint presents an Amazon-issued certificate. Any host
   matching `<label>.storage.c-<N>.<region>.aws.neon.tech` (anchored, see
   `isNeonStorageHostname`) gets `allowedIssuerOrganizations: ["Amazon"]`
   built in. Lookalike hosts still fail closed with `missing-tls-policy`.
   Amazon leaves rotate, so the SPKI above is a record, not a pin.
5. Neon keys are scoped per branch lineage, not per bucket or prefix, so
   isolation is the dedicated project. `expires_at` is not enforced; revoke
   keys explicitly.

Still to measure in N0: presign max `X-Amz-Expires`, a 150 MB single-part PUT,
a soft-deleted key on HEAD and on an `If-None-Match: *` re-PUT, and 20
parallel GETs looking for `503 SlowDown`.
