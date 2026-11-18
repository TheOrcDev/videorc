# S15 host speech interfaces

Desktop owner: `S6z:P60l3:G55dg`. Source integration starts from S7b
`68c623f07754e755af0def3d9ed24383059bd36f` and reconciles actual S9 desktop
`894810e69650ea71812d78efd6f0771216144836` / web
`c419182892fda1aec058df86710cc425458b0f16`. No peer worktrees modified.

## Capture and consent

`attachHostSpeech(client, track, showId, muted, current)` consumes only the
actual processed **local host microphone** track after successful publication.
It does not acquire a device, stop the shared track, subscribe to a guest or
read the auxiliary mix. S7b native mode retains its development gate and has
no new qualification. Browser AEC uses its existing single capture.

The renderer-only `cloud.speech.sync` RPC carries showId, sourceId, monotonic
source generation, published and muted. It cannot grant consent: existing
caption/listening intent and existing metered provider API remain authoritative.
`cloud.speech.audio` carries mono float samples at 16–48 kHz, at most 100 ms,
one renderer request in flight. Backend admission is capped at realtime plus
200 ms of burst; the source lease is two seconds. Source changes, mute,
disconnect and ownership loss revoke audio and cancel queued/in-flight work.
Native capture frames cannot enter a room-owned caption tap. Native encoder
start/stop/failure cannot reset or drain room cues into an unrelated native SRT.
Room cues persist in the local host transcript, not a native artifact with an
unproven clock mapping. No microphone or encoder session is fabricated.

S8 leaves this track ownership intact. Its system capture remains aux and is
never a speech input. S24 must call
`captions::cloud_host::ownership_lost(&AppState, show_id).await` on its ownership
watch: admission/intent retirement precedes provider joining. Existing cloud
show/on-air ownership is also checked before PCM and provider upload. S24's
controller epoch is not reused as the microphone generation. This named S24
watch integration is pending its publication; no uncommitted controller code
was copied.

## Clocks and persistence

Transcript cues persist by show/source/provider-session/sequence in the additive
local `cloud_host_transcript` table. Final revisions upsert, partials do not
append. Persistence failures emit a redacted visible diagnostic; failed reads
surface an unavailable transcript, not a saved claim. Maximum 10,000 retained cues; owner query returns latest 500. No PCM is
persisted. Sign-out joins speech and purges this local private transcript before
credential removal; failed cleanup blocks the existing privacy boundary.

Cue offsets are `processed-host-source`. The separate observational clock
projection uses canonical show.createdAt and UTC observed at source admission,
with basis `show-created-at-wall-estimate` and **unmeasured uncertainty**. Missing
server origin yields unavailable mapping, never zero. This is not an RTP,
provider, encoder or native-clock synchronization claim. S13a's native
originUs/incarnation are not yet committed and are not fabricated or overloaded.

## Public caption picture

The existing rasterizer/latest-wins worker sends `cloud.speech.overlay` with the
current caption provider session, absolute utterance expiry and independent
stream/recording booleans. Backend validates that live consented source before
installing either orientation. Native overlay RPC cannot bypass that room fence.
S9 snapshot generation rechecks the source after preparing graphics.

The S3/S4 capability extension is `graphics.static.captions: 1`. Old pages remain
incompatible until reload; static version 1 alone never authorizes captions.
The relay preserves this sanitized flag while discarding stale applied receipts,
and never grants guest static graphics. No private transcript/provider state
enters the graphics envelope.

`GraphicsKind` adds `caption`, at most one; max layers is seven, aggregate budget
stays six MiB. Local-only `outputRects` resolves the native caption/highlight
collision independently for each output, then is stripped from public wire.
Order is banner, caption, chat, avatar, bubble, highlight. Absolute cue expiry
is never renewed by transport or style refresh. Removing a caption clears its
painted layer even while another asset decode is stalled. Source polling is
bounded at 500 ms; partials coalesce through existing latest-wins raster work.

## Qualification

All productionQualified observations remain false. No smoke, app/device/managed
acquisition, paid model call or full Rust build has run. The maintained captions
case injects a real local fake speech gateway into the actual desktop and
program-page harness; screenshots are decoded and glyph pixels measured,
including independent output flags, partial/final replacement, host-only
listening, mute/off/room-close zero upload, and SQLite persistence over relaunch.
Simulation/unit tests are not final A/V or production qualification.
