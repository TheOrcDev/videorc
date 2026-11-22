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

## Guest captions lane (captions only)

The host speech contract above is unchanged: `cloud.speech.sync` and
`cloud.speech.audio` carry only the processed local host microphone, and only
that source feeds the one provider task that captions **and** Sidekick's
listening, voice commands and voice markers (S19) read. Guest audio never
becomes a host command.

On a talk show the guests on stage are captioned by a **second, separate,
captions-only lane** (`captions/guest_lane.rs`):

- The room renderer mixes the subscribed, unmuted **microphone** tracks of the
  guests on stage (never backstage guests, the host, the runner's return,
  LiveKit's recorder or screen audio) into one mono worklet mix. Its own
  renderer-only RPCs, `cloud.speech.guests.sync` (showId, sourceId, monotonic
  generation, guest count, unknown fields refused) and
  `cloud.speech.guests.audio` (the same bounded PCM as host audio), are the
  only way in. They never touch the host source, the host caption tap or the
  host provider task.
- **One** extra provider stream, whatever the number of guests. It runs only
  while Live captions is on and not blocked, the show is live from this
  computer (`CloudPhase::Live`, room owned), and the renderer reports at least
  one guest's audio. The renderer renews a two-second source lease every
  250 ms; zero guests, captions off or blocked, a lost room or sign-out stop
  the stream within one 100 ms tick and settle its lease with the audio sent.
- Guest words only ever become `captions.update` lines, with the lane's own
  `guests-…` session id, in arrival (spoken) order, in the same caption bar and
  under the same Live stream only / and recording choice. They never reach
  Sidekick listening, voice commands, voice markers, clip words, the host
  transcript or a recording's caption records. The Rust test
  `the_guest_lane_never_reaches_sidekick` fails if the lane's code names any of
  those entry points; `a_guest_command_is_only_ever_a_caption_line` and
  `guest_audio_never_enters_the_host_caption_tap` pin the behaviour; the
  renderer test pins that guest audio uses only the guest RPCs.
- `cloud.speech.overlay` and the S9 snapshot accept a caption picture from
  either live source: the host session over a valid host microphone, or the
  running guest lane. A muted host therefore still shows the guests' lines.
- Metering: each guest socket mints its own lease from the same monthly
  caption allowance (`/api/ai/captions/realtime-token`, settled through
  `/api/ai/captions/usage`). A refusal (allowance used up, Premium, sign-in)
  blocks captions exactly like a host refusal, which stops both streams. There
  is no chunked fallback for guests: an unavailable streaming transport pauses
  the lane for 60 seconds.
- Guests are told: the stage message carries `captions: true` while the lane
  is captioning, and the guest page shows "Live captions are on: what you say
  is transcribed." to guests on stage.

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
