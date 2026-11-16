# Cloud parity baseline harness

Plan 249 separates source support from artifact evidence. S0 provides fixtures,
registry validation and the maintained executable baseline. It does not fix or
enable a production media feature. Live acceptance has **not run**.

## Lightweight checks

```sh
pnpm test:cloud-parity
```

This checks the complete feature inventory, dependencies, case ownership,
seven-surface declarations, unqualified capability refusal, report states,
loopback-only destinations, explicit role grants (including signed tokens),
redaction, WAV/Y4M fixtures, stem isolation and codec-tolerant pixel helpers.
It starts no app, browser, device, LiveKit, FFmpeg, build or paid service. The
small token test starts only the local fixture HTTP server and closes it.
`test:scripts` discovers these tests normally. Format scripts cover new files.

## Deferred baseline invocation

**Do not run during the current implementation sequence.** The user deferred
smoke and heavy tests until all merges on main. The later command is:

```sh
VIDEORC_PARITY_WEB_ROOT=/path/to/clean-installed-web-fixture-checkout \
  pnpm smoke:cloud-parity -- --case baseline
```

Prerequisites: an already-built desktop dev app/backend in the desktop worktree,
installed desktop and web dependencies (including Playwright, tsx/esbuild),
Chrome (`VIDEORC_SMOKE_CHROME`), local `livekit-server`, OpenSSL, FFmpeg and
ffprobe. Existing launcher path overrides apply. This harness performs no
build, dependency installation or migration. Desktop dependencies were populated from cache by the focused-test invocation;
no desktop app build or web fixture setup was performed in S0. The supplied web checkout is read-only and must
have no tracked modifications; untracked files are not imported as source.

The case uses a fresh private app profile, the existing local managed-control
fixture, no platform destinations and synthetic camera/microphone inputs.
Each guest runs the real web `GuestRoom` and its connection/media/track hooks;
only admission API answers and getUserMedia inputs are fixtures. The program
uses the real document, security headers and emitted v1 assets through the
web's maintained fixture server. All page requests are constrained to loopback.
The guest wrapper supplies plain video sizing: this proves returned media,
not pixel-identical guest UI layout. No web source edits or Next build occur.

Host camera/mic use the actual desktop publisher. Host/guest camera colors have
a moving clock marker. Mic, soundboard, system and two guest tones are distinct
(440/1000/660/880/1320 Hz). System is a future routing-case fixture, not an S0
system-audio acceptance claim. Every guest uses production-shaped camera/mic
sources without data or metadata authority. The recorder is hidden and
subscribe-only. Legacy smoke callers retain their existing grant behavior.

## Evidence and failure behavior

The baseline records continuous browser video for program and both guests;
it decodes those recordings to RGB frames and inspects camera/card/takeover
markers. Separately recorded Opus artifacts capture the program's actual
post-limiter destination and each guest's attached audio elements. Those
artifacts are decoded to PCM and measured at each fixture tone. Guest return
checks require the host and other guest, with the guest's own tone below
−60 dBFS. Program and guest captures are separate; they do not certify encoded
managed output, hardware speaker AEC, precise A/V sync or production egress.

Soundboard import/play and manual Avatar Say use existing app commands and the
maintained synthetic avatar pack. A missing command or failed import fails the
case; successful commands alone never prove viewer output. Soundboard/avatar
presence or absence is observed in artifacts. Either observation is valid for
the baseline, so later repairs cannot make it fail by removing a known gap.
The current inventory's predicted gaps are labelled source findings until run.

`baseline.json` starts `not-run` and becomes `passed` only after all required
observations and cleanup succeed. It retains desktop/web revisions, desktop
diff hash, program bundle hash, template v1, artifact hashes/paths, measured
observations and named failures. Managed/device acceptance always stays
`not-run` in this local case. Runtime secrets and generated media stay outside
git; error messages redact ephemeral credentials and URLs. App/process cleanup
uses the existing owned-resource launcher, never broad process scans.

New cases are owned by the 32-slice ledger. All names other than `baseline`,
including `all`, currently fail explicitly as not implemented; no success exit
for a skipped or unimplemented case. Add each implementation at its owning
slice, preserve evidence distinctions, and update inventory only with actual
source and acceptance evidence. Do not enable dynamic alpha, native bridges,
higher profiles, replay or ISO based on local fixtures alone.

## S1 controls case (not run)

The maintained entrypoint also accepts `--case controls`. Do not run it in this
implementation sequence. It extends the baseline with initial microphone mute
and camera None, tile and mixer clicks, the application hotkey handler, a paired
Stream Deck client, the signed phone client and the agent MCP listener. Every
mute is checked against decoded program audio, with guest tones still audible;
unmute must restore the host tone. Complete captures and full-window measurements
are retained; control assertions allow one second for WebRTC/the takeover fade
to settle and require silence/restoration in the remaining decoded window.
This is a bounded functional check, not a measured latency qualification.
It checks camera unpublication and independent
record/live Stop while the room stays open and native recording stays idle.

The isolated fake Chromium devices are explicitly selected and their labels
aliased to an explicit DEV fixture catalog in the test process. No physical
camera/microphone is required by these seeded browser-device controls. No production
matcher changes for fake devices. Missing fixture devices fail the case.
This is not evidence for real-device selection or OS hotkey registration.
The phone protocol uses loopback here; off-loopback LAN qualification remains
with the deferred remote-LAN smoke. Remote/agent enablement is confined to the
disposable profile and cleaned up; existing owner access is never expanded.

Controls also requires the existing all-program takeover silence implementation
in web PR #118, including its emitted v1 bundle. Older web code must fail that
assertion. D3 speech-only/auxiliary routing remains a later slice. Controller
record/stream Stop against the fake web does not prove encoded managed egress
has ended. `controls.json` preserves managed and physical-device acceptance as
`not-run`; it cannot qualify production media.
