# Instant captions over gateway streaming transcription — acceptance, 2026-10-11

Scope: plan 175 (`plans/175-instant-captions-gateway-streaming-transcription.md`),
desktop branch `plan-175-streaming-captions` and web branch
`plan-175-streaming-captions-web`. This note contains no bearer, Gateway key,
client secret, WebSocket URL with a token, transcript text, or user data.

## What changed

Production captions were 3–5 s late because they ran the 3-second chunked
fallback; the July voice-model socket was kill-switched (it created assistant
turns and could not be metered). Plan 175 moves the streaming transport to the
Gateway's transcription-only WebSocket envelope and meters it with leases:

| Part      | Desktop                                                                                                                                                                                    | Web                                                                                                                                                  |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Mint      | Body names `transport: "transcription"` and the caption language                                                                                                                           | Old bodies → 503 (chunked); reserves a lease (≤ 600 s, ≤ remaining) in the caption month bucket, records it, mints with `routeKind: "transcription"` |
| Stream    | `transcription-stream.start` with the server's `providerOptions`, binary PCM (16 kHz, or 24 kHz for OpenAI/Google), `audio-done`; a per-socket decoder synthesizes the speech-start anchor | Default model `spacexai/grok-stt` with `interimResults` + 300 ms endpointing; attribution `gateway.user` (hashed) + `feature:captions` tag           |
| Lease     | Pre-mints the next lease, hands over 30 s before the lease ends, settles each lease with the provider's `finish` duration (or audio sent), settles spares with 0                           | Settle is idempotent and clamped; unsettled leases count in full                                                                                     |
| Reconcile | —                                                                                                                                                                                          | Daily cron compares settled leases with the Gateway report API by attribution user                                                                   |
| Fallback  | Voice-dialect tokens, socket policy/auth errors, ack timeout, transcript watchdog → chunked (`Higher delay`, "3-second chunks")                                                            | Kill switch unchanged and fail-closed; cohort allowlist `VIDEORC_AI_CAPTIONS_STREAMING_USERS`                                                        |

## Owner-run proof still required (in order)

| Row                                           | State | How                                                                                                                                                                                                                                                                                                               |
| --------------------------------------------- | ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| S1 bake-off                                   | OWED  | `AI_GATEWAY_API_KEY=… pnpm probe:caption-stt <model> <pcm> <rate> --mint` for `spacexai/grok-stt` (16 kHz), `openai/gpt-realtime-whisper` (24 kHz and 16 kHz), `google/gemini-3.5-transcribe-live` (24 kHz). Record first-partial, partial cadence, final-after-last-byte, `finish.usage`, warnings. Confirms D1. |
| S1 fact 1: transcription mint                 | OWED  | The `--mint` run opens the socket with the single-use token. STOP if it fails.                                                                                                                                                                                                                                    |
| S1 fact 2: attribution                        | OWED  | No `unsupported` warning naming `providerOptions.gateway`; the session appears in `GET /v1/report?group_by=user&tags=feature:captions` within ~10 min. If the start frame rejects `gateway`, set `VIDEORC_AI_CAPTIONS_STREAMING_ATTRIBUTION=false` before rollout.                                                |
| S1 fact 3: token expiry vs open socket        | OWED  | Mint with `expiresIn: 60`, stream 3 min. If the Gateway closes at expiry, the desktop reconnects within its retry budget (each healthy 30 s refills it); consider a shorter lease.                                                                                                                                |
| S1 fact 4: 16 kHz into `gpt-realtime-whisper` | OWED  | Only matters if D1 switches to OpenAI.                                                                                                                                                                                                                                                                            |
| Migration 0021 on Preview                     | OWED  | Applied by the Preview build's `db-migrate` step; the file is idempotent.                                                                                                                                                                                                                                         |
| Protected-preview canary                      | OWED  | `pnpm smoke:captions-production` without `VIDEORC_CAPTIONS_CANARY_ALLOW_CHUNKED_ONLY`, with `VIDEORC_AI_CAPTIONS_REALTIME_DISABLED=false` on Preview only.                                                                                                                                                        |
| Owner 60 s real-mic run                       | OWED  | Production with `VIDEORC_AI_CAPTIONS_STREAMING_USERS=<owner id>`. Target: first words on screen under 1 s, finals under 1.5 s after a pause. Judge by eye.                                                                                                                                                        |
| Reconcile delta                               | OWED  | Two days of zero unmatched report users before the cohort step.                                                                                                                                                                                                                                                   |
| Cohort → all Premium                          | OWED  | Widen, then unset, the allowlist.                                                                                                                                                                                                                                                                                 |

## Deterministic proof (this branch)

Gate results are recorded in the PR description for the commit that ships.
