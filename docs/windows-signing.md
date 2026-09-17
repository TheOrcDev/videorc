# Windows signing and protected release environments

Windows Alpha release installers are Authenticode-signed with Azure Trusted
Signing. The candidate workflow first builds and tests a resource-edited but
unsigned application without Azure authority. A separate protected job signs
that exact staging directory and creates the NSIS installer; it never falls
back to unsigned output.

`apps/desktop/electron-builder.windows-signed.cjs` enables executable resource
editing, forces code signing, requires SHA-256 signing/timestamping, and takes
the exact certificate Common Name from `VIDEORC_WINDOWS_PUBLISHER_NAME`.
Artifact and promotion validation compare that server-owned value with
`Get-AuthenticodeSignature`; a different valid signer is rejected.

## One-time owner setup

1. Create an Azure Trusted Signing account in the chosen region.
2. Complete organization or individual identity validation.
3. Create a Public Trust certificate profile.
4. Create a Microsoft Entra application for GitHub OIDC, add a federated
   credential bound to the repository's `windows-alpha-release` environment,
   and grant it **Artifact Signing Certificate Profile Signer** only on the
   exact certificate profile scope. Use audience
   `api://AzureADTokenExchange`. Verify the repository's actual GitHub OIDC
   subject format before creating the credential; repositories using immutable
   owner/repository IDs must bind those claims rather than a guessed legacy
   subject.
5. Configure the GitHub environment `windows-alpha-release` with required
   reviewers and prevent unreviewed branches/tags from deploying.
6. Keep the private candidate bucket/account non-public. Create separate R2
   credentials for candidate write, candidate read, and final Windows release
   write. Do not grant delete, bucket administration, macOS-prefix, or unrelated
   object permissions.

The candidate writer needs conditional `PutObject` plus object `HEAD`/read on
`candidates/windows/*` so it can reject collisions and verify each write. The
candidate reader needs only `GetObject` on that prefix. The final writer needs
object read/write on the canonical Windows release, updater, and changelog
prefixes because it verifies immutable bytes and the current feed before PUT.

Repository variable (available to the unsigned job without granting a protected
environment or any signing authority):

- `VIDEORC_WINDOWS_PUBLISHER_NAME` — exact certificate Common Name

Protected `windows-alpha-release` environment variables:

- `AZURE_TENANT_ID`
- `AZURE_CLIENT_ID`
- `AZURE_SUBSCRIPTION_ID`
- `VIDEORC_WINDOWS_SIGNING_ENDPOINT`
- `VIDEORC_WINDOWS_SIGNING_ACCOUNT_NAME`
- `VIDEORC_WINDOWS_CERTIFICATE_PROFILE_NAME`
- `VIDEORC_RELEASE_UPLOAD_S3_BUCKET`
- `VIDEORC_RELEASE_UPLOAD_S3_REGION`
- `VIDEORC_RELEASE_UPLOAD_S3_ENDPOINT_URL` — HTTPS account endpoint without the
  bucket suffix

Protected environment secrets:

- `VIDEORC_WINDOWS_CANDIDATE_WRITE_S3_ACCESS_KEY_ID`
- `VIDEORC_WINDOWS_CANDIDATE_WRITE_S3_SECRET_ACCESS_KEY`
- `VIDEORC_WINDOWS_CANDIDATE_READ_S3_ACCESS_KEY_ID`
- `VIDEORC_WINDOWS_CANDIDATE_READ_S3_SECRET_ACCESS_KEY`
- `VIDEORC_WINDOWS_RELEASE_WRITE_S3_ACCESS_KEY_ID`
- `VIDEORC_WINDOWS_RELEASE_WRITE_S3_SECRET_ACCESS_KEY`

There is no Azure client secret, certificate credential, username/password, or
other long-lived Azure credential in GitHub. The protected signing job alone
has `id-token: write`; pinned `azure/login` exchanges the GitHub environment
identity for a short-lived Azure CLI session. Trusted Signing excludes every
other `DefaultAzureCredential` source, and the patched builder fails if any
long-lived Azure credential environment variable is present.

The unsigned job has `contents: read`, no protected environment, and no OIDC
permission. It produces only resource-edited `win-unpacked` bytes plus an exact
file/publisher/release/source hash manifest. A one-day GitHub Actions artifact
carries that unsigned handoff. The protected job rechecks current `main`,
verifies both the Actions artifact digest and every manifest-bound file, and
prewarms NSIS before login. It then downloads exact TrustedSigning, Windows SDK
Build Tools, Trusted Signing Client, and `sign` package versions and verifies
their committed SHA-256 digests. A pnpm patch makes electron-builder import only
the preinstalled TrustedSigning 0.5.0 module; it cannot invoke PowerShellGet or
install a mutable latest module. The job signs every staged executable, builds
the NSIS installer from `--prepackaged`, and immediately runs `az logout` plus
`az account clear` before validation or candidate storage.

Candidate and final release storage credentials operate only inside their
named upload/download steps. They are not job-level environment variables.

The workflows pin `actions/checkout`, `actions/setup-node`,
`actions/upload-artifact`, `actions/download-artifact`, `azure/login`, and
`pnpm/action-setup` to exact commit SHAs verified against their upstream release
tags. Rust is installed with `rustup` already present on the GitHub-hosted
Windows runner, avoiding an unpinned Rust setup action.

Before enabling the federated credential, verify the repository's current OIDC
subject customization. With the legacy environment subject it is exactly
`repo:TheOrcDev/videorc:environment:windows-alpha-release`; repositories opted
into immutable owner/repository-ID claims must use the observed immutable
subject instead. Bind the exact subject and audience only—never a wildcard
branch, repository, or organization subject.

## Local Windows diagnostics

Use an isolated Windows 11 x64 checkout. Never paste values into tracked files,
and never create a client secret as a shortcut. The protected candidate
workflow is the canonical production signing path. Local work may build and
inspect the unsigned staging contract:

```powershell
$env:VIDEORC_WINDOWS_PUBLISHER_NAME = '<exact certificate CN>'
$env:VIDEORC_RELEASE_ID = '<numeric package version>-alpha.1'
$env:VIDEORC_RELEASE_SOURCE_COMMIT = '<full lowercase commit>'
$env:VIDEORC_WINDOWS_ACCEPTANCE_STATUS = 'pending'
pnpm package:desktop:windows:unsigned
pnpm release:staging:verify:windows
```

An authorized signing operator may validate the non-secret service coordinates
after an interactive Azure CLI login, but must not treat that local session or
local output as a releasable candidate:

```powershell
$env:VIDEORC_WINDOWS_SIGNING_ENDPOINT = 'https://<region>.codesigning.azure.net'
$env:VIDEORC_WINDOWS_SIGNING_ACCOUNT_NAME = '<account>'
$env:VIDEORC_WINDOWS_CERTIFICATE_PROFILE_NAME = '<profile>'
az login --tenant '<tenant-id>'
az account set --subscription '<subscription-id>'
pnpm release:secrets:windows
az logout
az account clear
```

The unsigned workflow path force-fetches the pinned FFmpeg archive before
package preflight. A cached staged executable is not accepted as proof of the
archive pin. Preflight also requires a clean checkout, matching changelog entry,
Windows 11 x64 tooling, icon, and committed FFmpeg policy metadata.
Every correction increments the numeric desktop package version and keeps the
`-alpha.1` suffix; same-core `alpha.2` releases cannot advance electron-updater.

Run `smoke:local-gates:windows` only against the installed exact private
candidate on physical acceptance hardware, with
`VIDEORC_WINDOWS_ACCEPTANCE_REQUIRE_INSTALLED=1`. A GitHub-hosted runner cannot
substitute for those device gates.

Set the web deployment's `VIDEORC_WINDOWS_DOWNLOAD_PUBLISHER_NAME` to the exact
same value as `VIDEORC_WINDOWS_PUBLISHER_NAME`. Download manifest validation
must reject a missing or different publisher.

## Signature and handoff evidence

`pnpm release:validate:windows` requires:

- Authenticode status `Valid`;
- signer Common Name exactly equal to the configured publisher;
- timestamp countersignature;
- installer SHA-256 and byte size matching `release.json`;
- exact checksum sidecar and matching update feed;
- blockmap, backend, FFmpeg, FFprobe, license, and source offer.

The candidate workflow stores those exact validation files privately with the
installer. The promotion workflow downloads them and reruns validation; it does
not recreate the unpacked directory or rebuild any binary. Preserve the
candidate and promotion workflow URLs in private acceptance evidence. The
short-lived GitHub artifact contains only the unsigned handoff and is never
release or acceptance evidence. Never treat a green unsigned build or a
different local installer as signing or acceptance evidence.
