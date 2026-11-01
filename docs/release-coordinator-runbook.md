# Resumable desktop release coordinator

Plan 066 implements an opt-in controller. `VIDEORC_RELEASE_CONTROLLER_ENABLED` must remain absent or `false` until the rollout gates below pass. Merging this code does not migrate an in-flight release. Legacy release commands and D3 remain available before cutover.

## Provision and rehearse

1. Run `pnpm release:provision` to inspect the declarative contract. This is read-only and is **not a readiness pass**. `--apply-environments` creates the three missing environments with an exact `main` branch policy, no wait timer and no reviewers. It refuses to remove existing reviewer protections. The existing `windows-alpha-release` reviewer remains required; the authorized agent's `gh` session approves it after checks.
2. Create separate private STATE and DATA storage destinations. Configure the `VIDEORC_RELEASE_CONTROL_S3_*` and `VIDEORC_RELEASE_CONTROL_DATA_S3_*` variables printed by the provisioner. STATE holds state, results and capability probes; DATA holds immutable intents, payloads and evidence. Do not reuse a public release bucket. Only the `release-control` environment receives the STATE writer key. Every worker and local macOS host receives a **read-only STATE key** plus its DATA credential. A label or separate project alone does not make a key read-only.
3. For Neon, use separate projects/branch lineages and create worker STATE keys with `--scope storage:read`; the controller STATE key needs `storage:write`. Provider scope must deny PutObject, even within the worker's own prefix. Do not rely on `expires_at` (currently not enforced). Use the environment role secret names referenced in the workflows (`..._READ_...`, `..._SUBMIT_...`, `..._WRITE_...`, `..._SIGN_...`, `..._FINALIZE_...`) and never place a STATE writer key in repository secrets. DATA may use a separate provider write credential because it cannot alter STATE; every intent/evidence identity is validated by the controller. Restrict DATA prefixes further where the provider supports it.
4. Configure dedicated public writer keys in `release-publication`; signing credentials stay in `windows-alpha-release`. Store installs run without storage credentials. Review `pnpm release:provision -- --readiness`: it checks exact branch policies, reviewer capability, secret names, flag and in-flight legacy jobs, and reports external evidence separately.
5. Dispatch `release-control.yml` on protected main with `probe=true` while the feature flag remains false. This tests conditional create/update and creates a sanitized snapshot. With each real worker STATE credential, run `pnpm release:provision -- --verify-worker-authority`; a harmless canary PUT **must receive HTTP 403**. An unexpectedly writable key fails readiness. No production pointer is touched by this test.
6. Run `pnpm release:rehearse -- --scenario all` locally. To exercise the actual provider, supply two dedicated `videorc-release-rehearsal-*` buckets and `VIDEORC_RELEASE_CONTROL_PREFIX=videorc-release-control/staging-<name>`, then add `--remote`. Production destination overlap is denied. The remote test transfers dummy immutable artifacts and pointers, injects lost responses after each mutable PUT, reconciles the same generation, exercises a real stale ETag and verifies mirror history with two missed versions. It leaves namespaced evidence for inspection. It does not sign a candidate or validate hosted runner timings.
7. On protected main, perform three exact candidate rehearsals (one cold, two warm, one interrupted and resumed on a fresh host). Record API run/attempt IDs, immutable artifact digests and watcher observations. Required source/runtime/packaged gates and real physical acceptance remain mandatory. Verify the standard and `/api/updates/mirror/` routes. Compare measured timings with Plan 066 targets; no speed target is claimed from local tests.
8. During a quiet cutover window, confirm no legacy publisher, unresolved D3 publication or unknown controller generation exists. Set the feature flag only after all evidence passes. Do not cancel or migrate signing/publication already in progress. A failed rollout remains on the legacy entry points. Reverting the flag is safe only when controller publication has no active/unknown claim.

Neon scope reference: https://neon.com/docs/storage/authentication

## Prepare one release

Prepare canonical changelog files for both intended platforms in a temporary directory. Use:

```sh
pnpm release:start -- --version 0.9.999 --entries /absolute/path/to/entries
```

The command checks the authorized Windows reviewer before work, creates a release branch and updates the desktop package version and both exact entries. It prepares reviewable files; follow the repository commit checkpoint and open **one** preparation PR. After its checks and merge, activate its exact protected-main SHA:

```sh
pnpm release:start -- --activate --request release-0.9.999 --version 0.9.999 \
  --source <merged-40-character-sha> --origin-identity <configured-origin-digest>
pnpm release:watch -- --request release-0.9.999 --cache cold
```

`pnpm release:provision -- --origin-identity` prints the digest of the configured primary/mirror identities without loading writer secrets. The controller independently recomputes it and rejects mismatch. The source is frozen; a later main version does not invalidate it. A change to release tooling policy requires reconciliation and fails closed. A same-version request with different source, origins or signed bytes is refused.

Run macOS on the authorized keychain host **in parallel** with the Windows watcher:

```sh
pnpm release:build:macos -- --request release-0.9.999
```

Follow that command's maintained build/stage instructions. macOS signing cannot move to an arbitrary runner. Its durable build receipt binds source, DMG/ZIP/feed hashes and signing attempt. A safe pre-sign compilation failure can retry; an unknown signing attempt must be inspected rather than signed again. Supply the real macOS acceptance receipt before staging. Windows source gates and unsigned packaging run concurrently; signing starts only after both succeed. Superseded unsigned runs may be cancelled by exact registered run ID. Signing, staging and publication are never auto-cancelled.

## Status, approval and acceptance

`pnpm release:status -- --request <id>` reports each platform, exact runs/attempts, execution steps, workflow elapsed time, blocker and next action. Watcher observations are persisted in `dist/release-watch/<id>.json`; this is a cache/evidence file, not authority. Queue/approval intervals between observations remain unknown. `--cache cold|warm` labels timing evidence and reports sample percentiles; do not call a warm sample cold or infer cache hits from elapsed time. `release:record` writes a Markdown record and the sanitized timing JSON into `docs/releases/`.

`pnpm release:watch -- --request <id>` approves only the exact eligible protected Windows deployment using the authorized local `gh` reviewer session. It checks workflow/ref/run/attempt, candidate source, canonical Windows alpha identity, successful unprivileged prerequisites, current request and exact acceptance where required. The job token cannot approve itself. `--dry-run` performs no remote mutation. Legacy exact-run status/sign approval remains available with `--run`, `--source` and `--release-id`; legacy promotion continues through its maintained runbook until cutover.

A signed Windows candidate automatically gets a private pilot promotion. Public promotion waits for a committed acceptance record:

```sh
pnpm release:accept -- --request <id> --record-url <commit-pinned-record-url>
pnpm release:resume -- --request <id>
```

Physical Windows acceptance, or the existing explicit owner-authored waiver path, is still required. The agent cannot synthesize acceptance or waive it. Successful builds are not runtime acceptance.

## Resume and recovery

- `release:resume -- --request <id>` reconstructs from durable state and immutable artifacts. Local checkpoint loss does not cause re-signing.
- A failed or definitively missing **unsigned** build can use `release:retry-build -- --request <id>`. It creates a new correlation while retaining abandoned dispatch evidence. This is forbidden after signing starts.
- A lost signing dispatch response is reconciled against its correlation/run ID. Ambiguous signing remains blocked; do not dispatch a replacement or rerun signing to manufacture the same identity.
- A failed publication owns its durable generation until `pnpm release:recover -- -f request_id=<id> -f platform=windows -f stage=public` inspects remote writes and finishes the same exact transaction. A newer request cannot steal an unknown generation. Immutable payload transfers happen before the short shared publication job; that job only checks identities and updates conditional pointers.
- `pnpm release:sync:controlled` prepares missing immutable history outside the lane and reconciles current pointers inside it. Mirrors cannot move backward, even if a mirror is ahead of primary. Old local pending files cannot replay stale pointers after cutover.
- D3 keeps its special guarded path and shared publication lane. It additionally requires explicit controller quiescence at cutover. Linux private candidate creation stays supported; direct Linux public publication is refused after cutover until it gets an equivalent finalizer.

## Verify and announce

```sh
pnpm release:verify:production -- --request <id> --platform windows
pnpm release:announce -- --request <id> --platform windows --channel discord
pnpm release:record -- --request <id>
```

Production verification uses the canonical public updater, signed-in download, exact release page and configured mirror routes. Set the authenticated website cookie as required by the verifier; it is never forwarded to storage or written to receipts. The local operator needs no Windows/public writer credential. Primary live with mirrors pending is reported separately.

Announcement defaults to a preview; sending requires its explicit authorization flag and webhook environment. Only the exact published changelog entry is used. Announce Windows only after public promotion. Announce Linux only after a public Linux download exists; the controller still refuses Linux public publication until it has a finalizer. Never print `VIDEORC_DISCORD_RELEASE_WEBHOOK`. A confirmed Discord message is idempotent; an unknown response requires reconciling the actual message ID before another send. Blog mode creates a reviewable exact-release draft; publishing the external blog is a separately tracked action. The old Discord entry point refuses uncontrolled sends after cutover.

## Verification evidence in this PR

Local Node logic, conditional transport adapters, authority-denial tests, state/fault tests and workflow syntax are executable without signing. Hosted cold/warm timings, actual provider rehearsal, real signing, physical acceptance, live environment provisioning and cutover remain external rollout gates. The feature flag remains disabled until those gates pass.

## Supervise the local watcher

On the authorized macOS operator host, use a per-request user LaunchAgent so closing the chat or terminal does not stop approvals. First verify `gh auth status` and the foreground `release:status` command in the same user account. Save the following as `~/Library/LaunchAgents/com.videorc.release-0.9.999.plist`, substituting the request and **absolute** checkout/log paths. Create the log directory first. Do not put tokens, webhook URLs, cookies or storage credentials in this file; `gh` uses the operator's existing credential store.

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.videorc.release-0.9.999</string>
  <key>ProgramArguments</key>
  <array>
    <string>/opt/homebrew/opt/node@24/bin/node</string>
    <string>/Users/orcdev/projects/videorc/scripts/release.mjs</string>
    <string>watch</string><string>--request</string><string>release-0.9.999</string>
    <string>--cache</string><string>warm</string>
  </array>
  <key>WorkingDirectory</key><string>/Users/orcdev/projects/videorc</string>
  <key>EnvironmentVariables</key>
  <dict><key>PATH</key><string>/opt/homebrew/opt/node@24/bin:/opt/homebrew/bin:/usr/bin:/bin</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>ThrottleInterval</key><integer>60</integer>
  <key>StandardOutPath</key><string>/Users/orcdev/projects/videorc/dist/release-watch/release-0.9.999.stdout.log</string>
  <key>StandardErrorPath</key><string>/Users/orcdev/projects/videorc/dist/release-watch/release-0.9.999.stderr.log</string>
</dict>
</plist>
```

Validate and load it:

```sh
mkdir -p /Users/orcdev/projects/videorc/dist/release-watch
plutil -lint "$HOME/Library/LaunchAgents/com.videorc.release-0.9.999.plist"
launchctl bootstrap "gui/$(id -u)" "$HOME/Library/LaunchAgents/com.videorc.release-0.9.999.plist"
launchctl print "gui/$(id -u)/com.videorc.release-0.9.999"
```

The watcher exits successfully when every requested platform is live or superseded; successful exit does not restart it. Errors restart at most once per 60 seconds. Watch the stderr log and durable `release:status`: repeated terminal build failures require unsigned retry or reconciliation, not indefinite unattended retries. On expired GitHub credentials, unload the agent, renew `gh auth login`, verify exact status, then bootstrap again. It resumes the same durable request and signing identity.

Unload on completion or when taking over manually:

```sh
launchctl bootout "gui/$(id -u)/com.videorc.release-0.9.999"
```

The plist syntax is tested as part of implementation review. No LaunchAgent is installed by repository commands or this PR.
