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
