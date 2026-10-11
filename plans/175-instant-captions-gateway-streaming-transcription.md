# Plan 175: Instant captions (gateway streaming transcription)

> **Executor instructions**: Follow this plan slice by slice. Run every "Done
> when" check before moving on. If anything in "STOP conditions" happens, stop
> and report; do not improvise. When done, update this plan's row in
> `plans/README.md` and fill in "As built". Gates run once at the end
> (owner rule): write and commit all slices first, then run S9.
>
> **Two repos.** Desktop slices live in this repo; web slices live in
> `~/projects/videorcweb` (deploy the web PR FIRST, the desktop falls back to
> chunked until it is live). Never read `videorcweb/.env`; the gateway key
> stays in Vercel and in the owner's shell for S1.
>
> **Drift check (run first)**:
> `git diff --stat 20d36819..origin/main -- crates/videorc-backend/src/captions.rs crates/videorc-backend/src/videorc_api.rs scripts/lib/fake-caption-service.mjs scripts/smoke-captions-contract.mjs scripts/smoke-captions-live-app.mjs apps/desktop/src/renderer/src/components/captions/captions-controls.tsx apps/desktop/src/renderer/src/lib/captions-ui.ts`
> and in videorcweb:
> `git diff --stat 76d7fc0a..origin/main -- lib/ai/captions.ts lib/ai/captions-chunk-route.ts app/api/ai/captions tests/ai-captions.test.ts tests/ai-captions-canary.test.ts db/schema.ts`
> If an anchor quoted below has moved, re-find it by the symbol name. If a
> _behaviour_ changed (not just a line number), that is a STOP condition.

## Status

- **Priority**: P1. Owner, 2026-10-10: "currently captions are late (probably
  good 3 - 5 seconds late), and it is not good, we need something more
  instant."
- **Effort**: L, 10 slices (S0 decisions, S1 bake-off, S2–S3 web, S4–S6
  desktop + smokes, S7 copy, S8 docs, S9 gates and rollout).
- **Risk**: MEDIUM–HIGH. Touches the live-caption transport (recording-studio
  gate), a Premium allowance (money), and a privacy surface (microphone audio
  leaving the machine). Everything is behind the existing server kill switch,
  and the chunked path stays as the fallback, so the blast radius of a bad
  slice is "captions are late again", not "captions are gone".
- **Depends on**: nothing merged. S1 needs the owner's gateway key for one
  afternoon.
- **Category**: Diagnose → Implementation (recording-studio trigger).
- **Planned at**: desktop `20d36819` (origin/main), web `76d7fc0a`,
  2026-10-11. Gateway facts verified against the live catalog on 2026-10-10
  and against `@ai-sdk/gateway` 4.0.110 / `@ai-sdk/provider-utils` 5.0.58.
- **Route**: Diagnose, fit 9. Model lane `fable-5` for S3, S4, S5 (metering
  and the Rust transport: multi-system, money, privacy). `gpt-5.5` for S1,
  S2, S6, S8 (config, probe, fakes, docs). `opus-4.8` for S7 (user-facing
  copy). Escalate to `fable-5` without asking if S6's smokes fail twice.

## Why captions are 3–5 s late (code read at `20d36819`)

Captions were designed streaming-first, but production runs the fallback.

1. **Production is the chunked path.** `docs/acceptance/2026-07-11-live-captions-reliability.md`
   records the realtime transport as KILL-SWITCHED and the production path
   as "the server-metered approximately three-second chunk path". The web
   readiness (`lib/ai/captions.ts:225-290`) reports
   `preferredTransport: "chunked"` whenever
   `VIDEORC_AI_CAPTIONS_REALTIME_DISABLED` is anything but an explicit
   `false`, and the desktop obeys it.
2. **A word waits for its chunk to close.** `CAPTION_CHUNK_SECONDS = 3.0`
   (`captions.rs:25`). `run_chunked_caption_session` (`captions.rs:7078`)
   fills a 3 s buffer, then uploads one WAV per request to
   `/api/ai/captions/chunks` with a 10 s request timeout
   (`videorc_api.rs:16`). The server reserves the seconds, calls the gateway
   REST transcription endpoint (`xai/grok-stt`, batch) and returns the whole
   chunk. Delay per word = 0–3 s waiting for the chunk + ~1–2 s upload and
   inference + cue render. That is the owner's 3–5 s. One in-flight upload
   plus eight queued chunks (`MAX_BUFFERED_CAPTION_CHUNKS`) means a slow
   network stretches it further before `Higher delay` is reported.
3. **The realtime path was the wrong tool.** `GatewayRealtimeCaptionTransport`
   (`captions.rs:5112-5345`) opens the gateway **voice** realtime socket for
   `xai/grok-voice-think-fast-1.0`, sends `session.update` with
   `input_audio_transcription` + `server_vad` + `create_response: false`, and
   reads the voice model's input-transcription side events. The July probe
   showed the voice model still auto-created assistant responses, so the
   code treats any `response-*` event as a safety failure
   (`RealtimeCaptionEvent::AssistantResponse`) and falls back to chunked.
4. **A direct socket could not be metered.** The desktop reported elapsed
   seconds to `/api/ai/captions/usage` (`report_usage`, `captions.rs:6338`;
   `videorc_api.rs:1292`). The web retired that route to a 503
   (`app/api/ai/captions/usage/route.ts`: "accepting elapsed seconds here
   would make the advertised allowance untrustworthy").
5. **Tuning the chunk is not a fix.** A 1 s chunk cuts words, triples
   requests and allowance writes, and still waits for the chunk to close.

## What changed on the gateway (verified 2026-10-10)

Since 2026-07-22 the Vercel AI Gateway has a dedicated **streaming
transcription** modality, separate from realtime voice. It is transcription
only: the model cannot create an assistant turn, so finding 3 is gone.

- **Catalog** (`GET https://ai-gateway.vercel.sh/v1/models`, tag
  `websocket-transcription`):

  | Model                                  | $/audio hour | PCM rate in docs | Latency controls (`providerOptions`)                                                                                       |
  | -------------------------------------- | -----------: | ---------------- | -------------------------------------------------------------------------------------------------------------------------- |
  | `openai/gpt-realtime-whisper`          |         1.02 | 24 kHz           | `openai.streaming.delay`: `minimal` / `low` / `medium` / `high` / `xhigh`; `openai.language`                               |
  | `spacexai/grok-stt` (streaming)        |         0.10 | 16 kHz           | `xai.streaming.interimResults`, `xai.streaming.endpointing` (ms), `xai.streaming.smartTurn`, `xai.keyterm`, `xai.language` |
  | `google/gemini-3.5-transcribe-live`    |         0.54 | 24 kHz           | none documented; 10-minute session cap reported by third parties                                                           |
  | `microsoft/mai-transcribe-2-streaming` |     unpriced | ?                | none documented                                                                                                            |

  The xAI namespace moved from `xai/` to `spacexai/`; the SDK accepts both
  (`isXaiTranscriptionModel`). `elevenlabs/eleven-scribe-2-realtime` is in
  the SDK docs but not in the catalog.

- **URL**: `wss://ai-gateway.vercel.sh/v4/ai/transcription-model?ai-model-id=<model>`
  (`toGatewayTranscriptionUrl`).
- **Auth**: `Sec-WebSocket-Protocol: ai-gateway-transcription.v1, ai-gateway-auth.<token>`
  (`getGatewayTranscriptionProtocols`). Same trick the desktop already uses
  for the voice socket, with a different marker (`captions.rs:5668`).
- **Token**: `POST https://ai-gateway.vercel.sh/v1/realtime/client-secrets`
  with `{ "model": "<id>", "routeKind": "transcription", "expiresIn": <s> }`
  → `{ token: "vcst_…", expiresAt }`. Single use, 60 s default, 300 s max,
  bound to the model it was minted for. The existing mint route only needs
  `routeKind` and the new URL.
- **Envelope** (`transcription-stream-envelope.ts`, v1):
  1. Client sends one TEXT frame
     `{"type":"transcription-stream.start","inputAudioFormat":{"type":"audio/pcm","rate":16000},"providerOptions":{…}}`.
  2. Audio rides BINARY frames of raw PCM s16le mono, each ≤ 64 KiB (the
     gateway rejects frames over 256 KiB).
  3. Client ends with TEXT `{"type":"transcription-stream.audio-done"}`; a
     plain close without it is an abort.
  4. Every server TEXT frame is one JSON part: `stream-start` (warnings),
     `transcript-delta` (`delta`, `id?`), `transcript-partial` (`text`,
     `id?`, `startSecond?`, `durationInSeconds?`), `transcript-final`
     (`text`, `id?`, `startSecond?`, `endSecond?`), `finish` (`text`,
     `segments[]`, `language?`, `durationInSeconds?`, `usage?`),
     `response-metadata`, `raw`, `error` (`{ message, type }` with types
     `authentication_error`, `forbidden`, `rate_limit_exceeded`,
     `model_not_found`, `invalid_request_error`, `failed_dependency`,
     `internal_server_error`).
  5. Server closes 1000 after `finish`; on failure it sends `error` then
     closes non-1000. A close without a prior `finish` is an error.
  6. Unknown types are ignored both ways.
- **Attribution**: the gateway's Custom Reporting API groups spend by
  `user` and `tag` (`GET /v1/report?group_by=user`, Pro plan, $5 per 1,000
  queries). Realtime sessions take `providerOptions.gateway.{user,tags}`;
  the transcription start frame carries `providerOptions`, so the same
  fields very likely attribute a streaming session. **Unverified** for
  WebSocket sessions; S1 checks it.

## Owner decisions (answer before S2)

Each has a recommendation. The slices assume the recommendation unless S1's
numbers say otherwise.

**Answered 2026-10-11:** the owner said "execute the entire plan and create a
pr", which takes every recommendation below (D1–D7) as written. S1 had not
run (no gateway key in the executing session), so D1 stands on its planning
assumption until the owner runs the bake-off.

| #   | Question                                      | Recommendation                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| --- | --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | Default streaming model                       | **Decide from S1's numbers, planning assumption `spacexai/grok-stt` streaming with `interimResults: true`, `endpointing: 300`.** It is the same model the chunked path already uses (no accuracy surprise), 16 kHz matches the existing DSP, and it is ten times cheaper: the 3,000-minute Premium allowance (`DEFAULT_MONTHLY_CAPTION_MINUTES`, "~$5/month at $0.10/hr") becomes **$51 per heavy user per month** on `gpt-realtime-whisper`. Switch the default to `openai/gpt-realtime-whisper` with `delay: "low"` only if S1 shows grok-stt's first partial more than ~400 ms behind, and then cut the allowance for that model (300 min) or make it a per-user option. `gemini-3.5-transcribe-live` is a fallback candidate only (session cap).                                                                                                                                                                                                                                                                                                                                                                            |
| D2  | How the allowance is enforced without a relay | **Leases at mint time, settled by the desktop, reconciled against the gateway.** `/api/ai/captions/realtime-token` reserves a fixed lease (10 min of audio) from the monthly allowance before minting, like a chunk reservation today; the desktop must `audio-done` + re-mint before the lease ends (an overlapping handover, no caption gap); the retired `/api/ai/captions/usage` route becomes `settle` and accepts the `finish.durationInSeconds` for a lease, bounded by the lease; a daily job reconciles the month's leases against `GET /v1/report?group_by=user&tags=feature:captions` and writes the difference to the ops dashboard. A client cannot mint past its allowance; the only trust gap is one socket held open past its lease, which S1 measures (does the gateway close a session when the minting token expires?) and reconciliation catches. The account-wide gateway spend cap stays the hard stop. Rejected: a relay that owns the socket (Vercel functions cannot hold a WebSocket; a second host adds a hop and an on-call surface), and trusting client elapsed time (the July objection stands). |
| D3  | Keep the chunked path                         | **Yes, unchanged**, as the fallback the desktop already implements. It is what `Higher delay` truthfully describes.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| D4  | Buddy listening (`purpose: listen`)           | **Rides the same socket, no new behaviour.** The realtime task already serves listen admissions (`admitted_orcle_audio`, `RealtimeAudioAdmissions`); the transport swap keeps that contract. Listen's own allowance and kill switch stay on the chunk route until a follow-up plan.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| D5  | Sample rate                                   | **Send what the model documents.** 16 kHz for grok-stt (today's `downmix_resample_to_16k_mono`). Add a 2:1 sibling (`downmix_resample_to_24k_mono`) for the OpenAI and Google models rather than upsampling 16 kHz. S1 also tries 16 kHz against `gpt-realtime-whisper`; if the gateway accepts it with no warning, the 24 kHz path is still built but not default.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| D6  | A user-facing delay knob                      | **No.** The provider options come from the server in the token response (`providerOptions`), so the owner can tune `delay` / `endpointing` per model with an env var and no release. The Captions page keeps its states: `Listening` (streaming), `Higher delay` (chunked), `Reconnecting`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| D7  | Rollout                                       | **Owner → small Premium cohort → all Premium**, through the existing `VIDEORC_AI_CAPTIONS_REALTIME_DISABLED` switch, kept fail-closed (only an explicit `false` enables). A per-user allowlist env (`VIDEORC_AI_CAPTIONS_STREAMING_USERS`) gates the cohort step.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |

## Design

### Wire contract the desktop speaks (replaces `GatewayRealtimeCaptionTransport`)

`GatewayStreamingCaptionTransport` in `captions.rs`:

- **Connect**: `token.url` from the mint route (now the
  `/transcription-model?ai-model-id=…` URL) with
  `Sec-WebSocket-Protocol` built from `token.subprotocols` (the web returns
  `["ai-gateway-transcription.v1", "ai-gateway-auth.<token>"]`; the desktop
  joins them, never hard-codes the marker). `tokio-tungstenite` already
  handles the handshake.
- **Start**: TEXT `transcription-stream.start` with
  `inputAudioFormat: { type: "audio/pcm", rate }` and the `providerOptions`
  object the token response carried (the desktop treats it as opaque JSON;
  the server owns model tuning and the `gateway.user` / `gateway.tags`
  attribution).
- **Audio**: every tap frame → existing downmix/decimate → one BINARY frame
  (20 ms at 16 kHz = 640 B; the 64 KiB rule is never close). No base64, no
  JSON per frame (today's `input_audio_buffer.append` base64-encodes every
  20 ms).
- **Stop**: TEXT `audio-done`, then read until `finish` or
  `CAPTION_FINAL_TRANSCRIPT_GRACE` (1.5 s), then close 1000. The
  `Message::Close(None)` on stop today (`captions.rs:5760`) becomes
  audio-done first.
- **Events → `RealtimeCaptionEvent`** (keep the enum; the session loop,
  `handle_realtime_event`, item retirement, SRT records and smokes all key
  off it):

  | Part                                        | Maps to                                                                                                                                                                      |
  | ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
  | `stream-start`                              | `ConfigurationAcknowledged` (warnings logged at info; an `unsupported` warning naming `providerOptions.*` is a health event, not a failure)                                  |
  | `transcript-partial`                        | `Partial { item_id: id ?? synthetic, transcript: text }`                                                                                                                     |
  | `transcript-delta`                          | accumulate per `id` into a partial, emit `Partial` with the running text                                                                                                     |
  | `transcript-final`                          | `Completed { item_id, transcript }`; `startSecond` / `endSecond` feed the timeline                                                                                           |
  | `finish`                                    | end of socket; `durationInSeconds` is the lease settlement amount                                                                                                            |
  | `error`                                     | `Error(RealtimeTransportFailure)` classified by `type` (auth/forbidden/model_not_found → terminal; rate_limit/failed_dependency/internal → transient, retry budget as today) |
  | `response-metadata`, `raw`                  | `Ignored`                                                                                                                                                                    |
  | anything `response*` / `conversation.item*` | `AssistantResponse` (keep the guard; it must never fire)                                                                                                                     |

- **Timeline anchoring**: today `SpeechStarted.audio_start_ms` anchors an
  item to the capture clock. The envelope has no speech-started event, so
  the anchor is `startSecond` from the first `transcript-partial` /
  `transcript-final` of an item (seconds since the socket's first audio
  byte, same frame of reference as `socket_audio_base_ms`). When a provider
  omits `startSecond`, fall back to "ms_sent at first partial minus a
  configured model lag" (`providerOptions` carries `videorc.anchorLagMs`,
  default 600). SRT timing must stay within the existing
  `caption_cues` tests' tolerance.
- **Lease rotation**: the token response carries `leaseSeconds` (600) and
  `leaseId`. At `leaseSeconds - 30` the loop mints the next token, opens
  socket B, switches the audio fan-out to B, sends `audio-done` on A, drains
  A's `finish`, settles A's lease with `durationInSeconds`, closes A. Items
  from A finalize before B's first partial (A's drain is bounded by the
  grace). A failed re-mint is a transient failure: keep A until its lease
  end, then fall back to chunked (today's `RealtimeOutcome::Fallback`).
- **Fallback**: unchanged. Any terminal outcome or exhausted retry budget →
  `run_chunked_caption_session`, one sequence namespace, `Higher delay`.
- **Resampling**: `downmix_resample_to_16k_mono` stays; add
  `downmix_resample_to_24k_mono` (2:1 boxcar) selected by the rate the token
  response names (`inputAudioFormat.rate`).

### Web: mint, lease, settle, reconcile

- `lib/ai/captions.ts`:
  - `DEFAULT_CAPTIONS_REALTIME_MODEL` → `"spacexai/grok-stt"` (D1);
    `DEFAULT_CAPTIONS_MODEL` (chunked) stays `xai/grok-stt` (the REST route
    accepts both namespaces; S2 proves it with the canary).
  - `getAiCaptionsRealtimeConfig` returns `mintUrl`, `routeKind:
"transcription"`, the `/transcription-model?ai-model-id=` WebSocket URL,
    `subprotocolMarker: "ai-gateway-transcription.v1"`, `inputAudioFormat`
    (rate by model), and `providerOptions` built from env:
    `VIDEORC_AI_CAPTIONS_STREAMING_OPTIONS` (JSON, validated) merged with
    `{ gateway: { user: <hashed user id>, tags: ["feature:captions", "env:<vercel env>"] } }`.
  - Readiness: `preferredTransport` keeps the wire name `"realtime"` (the
    desktop's `CaptionsTransport::Realtime` and renderer copy key off it);
    `realtime.model` tells the truth; a new reason
    `ready-realtime-cohort-only` when the allowlist excludes the user
    (desktop treats it as chunked).
- `app/api/ai/captions/realtime-token/route.ts`: the Premium gate and
  monthly sum stay; add the lease reservation (one `aiCaptionSessions` row
  per lease: `leaseId`, `leaseSeconds`, `settledSeconds: null`,
  `model`, `transport: "streaming"`), mint with `routeKind`, return
  `{ token, url, subprotocols, model, inputAudioFormat, providerOptions,
leaseId, leaseSeconds, expiresAt, quotaEnforced: true }`.
- `app/api/ai/captions/usage/route.ts` → `settle`: body
  `{ leaseId, durationSeconds }`; writes `min(durationSeconds,
leaseSeconds)` to the lease row once (idempotent); an unsettled lease
  counts as fully used for the monthly sum (fail-closed). Keep the 503 for
  bodies without a `leaseId` (old desktops).
- Reconciliation: `lib/ai/captions-reconcile.ts` + a daily cron route that
  calls `GET /v1/report?start_date=<month start>&end_date=<today>&group_by=user&tags=feature:captions`
  with the gateway key, compares per-user `request_count` / cost against
  settled leases, and writes a `captions-reconcile` operations health row
  (`lib/ai/operations-health.ts`) with the delta. No automatic blocking in
  this plan; the dashboard shows it (owner reads it during D7 rollout).
- Kill switch: `realtimeCaptionsDisabled` semantics unchanged (fail-closed).

### Smokes and the fake gateway

`scripts/lib/fake-caption-service.mjs` learns the new dialect beside the
old one (switch by the `realtimeDialect` option, default `transcription`):

- `/api/ai/captions/realtime-token` returns the new response shape.
- Upgrade path `/transcription-model`, protocols
  `ai-gateway-transcription.v1` + `ai-gateway-auth.*`.
- Rejects a connection whose first frame is not a valid
  `transcription-stream.start`; counts BINARY audio bytes; emits
  `stream-start`, scripted `transcript-partial` / `transcript-final` with
  `startSecond`, `finish` with `durationInSeconds`; scenarios for
  `error` + non-1000 close (transient and terminal types), close without
  `finish`, no `finish` after `audio-done`, and the lease rotation (the
  smoke asserts two connections and one settle call with the first lease
  id).
- The `assistantResponseOnNextAudio` scenario stays and now sends a bogus
  `response-created` part; the desktop must still fall back.

`scripts/smoke-captions-contract.mjs` and `scripts/smoke-captions-live-app.mjs`
assert the new frames (exact start frame, binary audio, audio-done, settle)
where they asserted `session.update` / `input_audio_buffer.append`.

### Copy (desktop)

- `captions-ui.ts` status presentation: `Listening` detail stays
  "Microphone speech is being transcribed."; `Higher delay` detail says
  "Captions are continuing in 3-second chunks." (truthful about the
  fallback). Any UI text that currently describes the production path as
  "a few seconds behind" says "live" instead. Grep for it in S7: there is
  no literal "3 s" in the renderer today; the acceptance doc's "higher
  delay" language is the only promise.
- Web privacy page already names OpenAI and the gateway; if D1 ends on
  grok-stt nothing changes; if on OpenAI, nothing changes either.

## Slices

### S0: Owner decisions

Confirm D1–D7 or change them. Done when: answers recorded above.

### S1: Bake-off and gateway facts (owner key, scratch, half a day)

The probe `scripts/probe-caption-stt-latency.mjs` (committed with this plan,
`pnpm probe:caption-stt`) speaks the exact envelope above and paces a spoken
PCM clip like a microphone. Run with the owner's key, never in CI:

```
say -v Samantha -o /tmp/clip.aiff "Welcome back to the stream everyone…"
ffmpeg -i /tmp/clip.aiff -ac 1 -ar 16000 -f s16le /tmp/clip-16k.pcm
ffmpeg -i /tmp/clip.aiff -ac 1 -ar 24000 -f s16le /tmp/clip-24k.pcm
AI_GATEWAY_API_KEY=… pnpm probe:caption-stt spacexai/grok-stt /tmp/clip-16k.pcm 16000 --mint
AI_GATEWAY_API_KEY=… pnpm probe:caption-stt openai/gpt-realtime-whisper /tmp/clip-24k.pcm 24000 --mint
AI_GATEWAY_API_KEY=… pnpm probe:caption-stt openai/gpt-realtime-whisper /tmp/clip-16k.pcm 16000 --mint
AI_GATEWAY_API_KEY=… pnpm probe:caption-stt google/gemini-3.5-transcribe-live /tmp/clip-24k.pcm 24000 --mint
```

Record in "As built", per model: first-partial time, median partial
cadence, final-after-last-byte, finish `usage`, warnings, and the transcript
against the spoken text. Then four facts:

1. `--mint` works with `routeKind: "transcription"` and the socket opens
   with the single-use token.
2. The start frame accepts `providerOptions.gateway.{user,tags}` (no
   `unsupported` warning) and the session appears within ~10 minutes in
   `GET /v1/report?group_by=user&tags=feature:captions` with cost.
3. Token expiry vs open session: mint with `expiresIn: 60`, keep streaming
   for 3 minutes. Note whether the gateway closes the socket at expiry.
4. Whether `gpt-realtime-whisper` accepts 16 kHz.

Done when: the numbers and facts are in "As built" and D1/D2/D5 are
confirmed or amended. STOP if fact 1 fails (then the gateway's
transcription tokens are not what the SDK documents, and the plan needs the
realtime-token path re-verified).

### S2: Web config, readiness and the mint route (videorcweb)

- `lib/ai/captions.ts` per "Web" above; `tests/ai-captions.test.ts` covers:
  default model, URL and subprotocols, `providerOptions` env parsing
  (invalid JSON → `captions-invalid-config`), attribution fields present,
  cohort allowlist reason code, kill switch still fail-closed.
- Mint route returns the new shape; old fields (`token`, `url`, `model`,
  `expiresAt`) keep their names so an older desktop still parses it.
- `tests/ai-captions-canary.test.ts`: the chunk canary still passes with
  `xai/grok-stt` and with `spacexai/grok-stt`.

Done when: `pnpm test -- tests/ai-captions*.test.ts`, `pnpm typecheck`,
`pnpm lint` on touched files are green; protected preview mints a token
(redacted) and the readiness reports `ready-realtime` with
`VIDEORC_AI_CAPTIONS_REALTIME_DISABLED=false` set on Preview only.

### S3: Leases, settle and reconciliation (videorcweb)

- Migration `00NN_caption_leases.sql`: columns on `aiCaptionSessions`
  (`lease_id`, `lease_seconds`, `settled_seconds`, `transport`, `model`),
  unique on `lease_id`. Unsettled leases count in full in
  `sumCaptionSecondsThisMonth` (fail-closed).
- Mint route reserves a lease atomically (same pattern as
  `captionChunkAllowance(...).reserve`), refuses when the lease would exceed
  the allowance with the existing `captions-quota-exhausted` code.
- `app/api/ai/captions/usage/route.ts` → settle (idempotent, bounded).
- `lib/ai/captions-reconcile.ts` + cron route + operations health row.
  Unit tests with a fake `/v1/report` response.

Done when: tests prove reserve → settle → sum, settle twice is a no-op,
settle above the lease is clamped, an unsettled lease blocks the next mint
once the allowance is reached, and the reconcile job computes the delta.
Migration applied to Preview; the serde-null trap checked (every new
nullable column is `Option` with `skip_serializing_if` on the desktop side
if it ever crosses the wire).

### S4: Desktop transport (Rust)

- `downmix_resample_to_24k_mono` + tests (2:1, mono/stereo, unsupported
  input → empty).
- `GatewayStreamingCaptionTransport`: `start_frame(rate, provider_options)`,
  `parse(part) -> RealtimeCaptionEvent`, `classify_error(part)`,
  `classify_close(code, reason)`. Table-driven unit tests from fixture
  frames recorded in S1 (redacted, in `crates/videorc-backend/tests/fixtures/`).
- `CaptionRealtimeToken` gains `subprotocols`, `input_audio_format`,
  `provider_options`, `lease_id`, `lease_seconds` (all `Option` +
  `skip_serializing_if`, see the serde-null trap); `mint_caption_realtime_token`
  parses the new response; `report_caption_usage` → `settle_caption_lease`.

Done when: `cargo test -p videorc-backend captions::` green; clippy clean on
the crate; no `session.update` / `input_audio_buffer.append` strings remain
outside tests that assert their absence.

### S5: Desktop session loop (Rust)

- `run_realtime_caption_session`: connect with the token's subprotocols,
  send the start frame, binary audio frames, `audio-done` on stop and on
  handover, `finish` drain, settle the lease, lease rotation with the
  overlapping handover, timeline anchoring from `startSecond`.
- Keep: retry budget, `TRANSCRIPT_WATCHDOG_TIMEOUT`, audio-ready / stall
  watchdogs, `AssistantResponse` → fallback, privacy teardown, sign-out
  join, sequence continuity into chunked.
- Lifecycle tests: handover keeps one monotonic sequence and settles the
  first lease; failed re-mint falls back after the lease; `error` of a
  terminal type stops with `Blocked`; close-without-finish counts against
  the retry budget; `finish.durationInSeconds` missing → settle with
  elapsed audio seconds.

Done when: the existing realtime lifecycle tests pass against the new
transport (renamed where the old protocol was in the name) plus the new
ones; `cargo test -p videorc-backend` for the captions module green.

### S6: Fake gateway and smokes

Per "Smokes and the fake gateway". `pnpm test:scripts` covers the fake's
new dialect (`scripts/lib/fake-caption-service.test.mjs`).

Done when: `pnpm smoke:captions-contract` and `pnpm smoke:captions-live`
pass on the debug backend with the fake in `transcription` dialect; the
live smoke's artifact still shows caption frames on the stream and the
captioned copy; `pnpm smoke:captions-dual-orientation` unchanged and green.

### S7: Copy

Per "Copy (desktop)". Load `videorc-design` first. No layout change.

Done when: `pnpm --filter @videorc/desktop test` (captions-ui, reader,
preflight) green; `Higher delay` only ever appears on the chunked path in
the smoke logs.

### S8: Docs

- `docs/acceptance/2026-10-xx-instant-captions.md`: S1 numbers, the four
  facts, smoke evidence, the staged acceptance table (owner real-mic run,
  cohort, all Premium).
- `AGENTS.md`: `smoke:captions-contract` / `smoke:captions-live` lines
  mention the transcription dialect; the "never read `videorcweb/.env`"
  rule is already there.
- `plans/README.md` row.

Done when: diff inspected; no key, token, URL with a token, or transcript
text in any doc.

### S9: Gates, owner acceptance, rollout

Desktop: `pnpm typecheck`, `pnpm lint`, `pnpm format:check`,
`pnpm test:scripts`, `pnpm --filter @videorc/desktop test`, `pnpm build`,
`cargo fmt --check --all`, `cargo test -p videorc-backend`,
`cargo clippy -p videorc-backend -- -D warnings`, `pnpm smoke:captions-contract`,
`pnpm smoke:captions-live`, `pnpm smoke:recording-studio` (or state the
ScreenCaptureKit block exactly as the July note did and run the captions
smokes as the closest gate). Web: `pnpm typecheck`, `pnpm lint`, `pnpm test`
(two known baseline failures: `contributors` metadata and `llms.txt`),
protected-preview canary `pnpm smoke:captions-production` **without**
`VIDEORC_CAPTIONS_CANARY_ALLOW_CHUNKED_ONLY`.

Rollout (D7): web PR merged and deployed first; owner sets
`VIDEORC_AI_CAPTIONS_REALTIME_DISABLED=false` and
`VIDEORC_AI_CAPTIONS_STREAMING_USERS=<owner id>` on Production; desktop PR
merged; owner runs a 60-second real-mic session and judges the delay by eye
(target: first words on screen under 1 s, finals under 1.5 s after a pause);
reconcile row reads zero delta for two days; cohort; all Premium (unset the
allowlist).

Done when: every gate above is green or its block is named; the acceptance
doc has the owner's by-eye verdict; both PRs merged.

## Out of scope

- On-device engines (Apple SpeechAnalyzer, Parakeet via sherpa-onnx). Noted
  as a later lever: zero network latency, zero per-hour cost, two native
  engines to own.
- Direct Deepgram / AssemblyAI / ElevenLabs sockets (second vendor, no
  per-user attribution on their temp tokens).
- Clean cut transcription (`transcript.rs`, Deepgram batch) and the
  publish-pack transcription: batch, unaffected.
- Caption styling, presets, the reader window, burn-in.
- Buddy listen's own allowance and kill switch (D4).
- A relay service.

## STOP conditions

- S1 fact 1 fails, or the gateway sends anything that is not the documented
  envelope (a `response*` part, a second start acknowledgement, audio
  echoed back).
- S1 fact 2 fails **and** the owner rejects the lease model: there is then
  no server-side metering story and the kill switch must stay on.
- `gpt-realtime-whisper` is chosen in D1 without the allowance change: the
  worst case is $51 per heavy user per month.
- Any smoke needs a transcript, token or key written to a committed file.
- The chunked fallback stops working at any slice (the live smoke's
  kill-switch scenario must stay green throughout).
- The Rust CI job approaches its 45-minute cap because of new lifecycle
  tests: trim fixtures, do not raise the cap.

## Verification summary

| Area                  | Gate                                                                                               |
| --------------------- | -------------------------------------------------------------------------------------------------- |
| Web config/mint/lease | `pnpm test -- tests/ai-captions*.test.ts`, typecheck, lint, Preview mint + readiness               |
| Desktop transport     | `cargo test -p videorc-backend captions::`, clippy                                                 |
| Desktop lifecycle     | realtime lifecycle tests + handover/settle tests                                                   |
| End to end            | `pnpm smoke:captions-contract`, `pnpm smoke:captions-live`, `pnpm smoke:captions-dual-orientation` |
| Recording studio      | `pnpm smoke:recording-studio` or the named block                                                   |
| Production            | protected-preview canary, owner 60 s real-mic run, reconcile delta                                 |

## As built (2026-10-11, desktop `plan-175-streaming-captions`, web `plan-175-streaming-captions-web` / videorc-web #80)

- **S1 not run.** No gateway key in the executing session. D1 stands on its
  planning assumption (`spacexai/grok-stt`, interim results, 300 ms
  endpointing). Owner runs `pnpm probe:caption-stt` before rollout.
- **S2-S3 (web #80):** as designed, with a separate `ai_caption_leases` table
  (migration 0021) instead of extra columns, so the month bucket keeps its
  atomic upsert. The old-desktop transport check runs before any usage read.
  Capabilities now report the allowance on both transports.
- **S4-S5:** `GatewayStreamingCaptionTransport` + `StreamingCaptionDecoder`
  replace the voice adapter. The envelope has no speech-start event, so the
  first text of an utterance synthesizes it. Lease handover is
  sequential, not overlapping: a pre-minted token, `audio-done`, a finals drain
  bounded by the 1.5 s grace, then the next socket. Frames wait in the tap
  channel, so no audio is lost. Socket errors fall back or reconnect and never
  end captions. Leases settle in `Drop`, because an explicit stop aborts the task.
  The contract smoke caught the settle-after-return version.
- **S6:** the fake speaks the envelope. The contract smoke adds lease handover
  (6 minted, 6 settled) and voice-dialect fallback.
- **S7:** the fallback copy says "3-second chunks".
- **Pre-existing, not this plan:** `smoke:captions-dual-orientation` fails on
  clean `origin/main` `20d36819` with the same raster geometry (portrait bar
  792 px on a 720 px canvas).
