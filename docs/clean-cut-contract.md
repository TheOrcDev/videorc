# Clean cut: web ↔ desktop contract (plan 119)

This is the single source of truth for the wire shapes between the desktop app
and videorc-web for Clean cut. Identical copies live in both repos at
`docs/clean-cut-contract.md`. A change to one copy must land in both.

All routes use the same session auth as every other `/api/ai/*` route:
`Authorization: Bearer <session token>`.

Errors use the existing AI error envelope,
`{"error": {"code": "...", "message": "..."}}`, with the HTTP statuses shown
below. The desktop maps `error.code` to a reason code. Unknown codes are shown
with their `message` and are never parsed as a closed enum.

The contract has three parts:

- A. A route that transcribes audio chunks word for word.
- B. The capabilities fields that advertise Clean cut.
- C. The analysis job that finds retakes and condensed selections.

## A. Verbatim transcription chunks

### Request

`POST /api/ai/transcripts/chunks`, as `multipart/form-data`.

| Field | Type | Rules |
| --- | --- | --- |
| `audio` | file | `audio/wav`, canonical RIFF/WAVE, PCM s16le, mono, 16 000 Hz. At most 120 s and 4 000 000 bytes. |
| `sessionClientId` | string | The desktop session id. 1–120 chars of `[A-Za-z0-9._:-]`. |
| `chunkIndex` | integer | ≥ 0. |
| `chunkStartMs` | integer | ≥ 0. Where the chunk starts in the recording. Echoed only, never trusted for metering. |
| `language` | string, optional | A BCP-47 code such as `en`. Absent means auto-detect. |

### Server order

Each check runs in this order, and the first failure answers.

1. Authenticate.
2. Validate the form and the WAV header, then compute the seconds from the
   WAV data.
3. Check `VIDEORC_AI_DISABLED`.
4. Check the blocklist.
5. Check that cloud AI is allowed (Premium).
6. Check `VIDEORC_AI_CLEAN_CUT_DISABLED`.
7. Check that the provider is configured.
8. Atomically reserve the seconds in the month bucket
   `cleancut-quota-YYYY-MM`, against `VIDEORC_AI_CLEAN_CUT_MONTHLY_MINUTES`
   (default 1200).
9. Call the provider.

Caption allowance totals must exclude `cleancut-quota-%` rows. Nothing about
the audio or the transcript is stored. Only the metered seconds are kept.

The provider comes from env: `VIDEORC_AI_VERBATIM_TRANSCRIPTION_PROVIDER`
(default `deepgram`) and `VIDEORC_AI_VERBATIM_TRANSCRIPTION_MODEL` (default
`nova-3`). The default request asks Deepgram for `filler_words=true` and
`punctuate=true`, and reads `results.channels[0].alternatives[0].words[]`
(`punctuated_word` when present, else `word`).

### Response 200

```json
{
  "chunkIndex": 3,
  "chunkSeconds": 119.84,
  "language": "en",
  "text": "So um today we are going to build the thing.",
  "words": [
    { "text": "So", "startMs": 40, "endMs": 220, "confidence": 0.98 },
    { "text": "um", "startMs": 260, "endMs": 610, "confidence": 0.91, "filler": true }
  ],
  "remainingSeconds": 64000,
  "monthlySecondsLimit": 72000
}
```

Response rules:

- `startMs` and `endMs` are integers, relative to the start of the chunk, and
  never decrease along the array.
- `confidence` is optional, between 0 and 1.
- `filler` is optional and only ever `true`. The server sets it when the
  provider tags a filler, or when the lowercased word with punctuation stripped
  is one of `um`, `uh`, `uhm`, `umm`, `erm`, `er`, `ah`, `hmm`, `mm`. The
  desktop checks the same lexicon itself as well.
- `language` is the detected or requested language, or `null`.
- `remainingSeconds` and `monthlySecondsLimit` are integers, or `null` when
  unlimited.

### Errors

| Status | `error.code` | When |
| --- | --- | --- |
| 401 | `unauthorized` | No session, or an invalid session. |
| 400 | `invalid-transcript-chunk` | The form or WAV is malformed, or the audio is longer than 120 s or bigger than 4 000 000 bytes. |
| 403 | `premium-required` | Cloud AI is not allowed for this account. |
| 403 | `ai-access-blocked` | The account is on the blocklist. |
| 503 | `clean-cut-disabled` | `VIDEORC_AI_DISABLED` or `VIDEORC_AI_CLEAN_CUT_DISABLED` is set. |
| 503 | `clean-cut-provider-unconfigured` | The provider env or key is missing. |
| 429 | `clean-cut-monthly-quota-exhausted` | The reservation would exceed the monthly limit. The reservation is not taken. |
| 502 | `clean-cut-provider-error` | The provider failed or timed out. The reservation is kept, as the caption route does. |

## B. Capabilities

`GET /api/ai/capabilities` gains new keys only. Nothing existing changes.

```json
{
  "features": { "cleanCutEnabled": true },
  "cleanCut": {
    "supported": true,
    "available": true,
    "reasonCode": null,
    "maxChunkSeconds": 120,
    "maxChunkBytes": 4000000,
    "monthlySecondsLimit": 72000,
    "remainingSeconds": 64000,
    "modes": ["clean", "condensed"],
    "workflowKind": "post-recording-clean-cut"
  }
}
```

`features.cleanCutEnabled` is true only when the kill switch is off and the
provider is configured.

`cleanCut.reasonCode` is `null` when `available` is true. Otherwise it is one
of `disabled`, `premium-required`, `provider-unconfigured` or
`quota-exhausted`. New codes may be added later.

On the desktop:

- `features.cleanCutEnabled` is `#[serde(default)]`.
- `cleanCut` is `#[serde(default, skip_serializing_if = "Option::is_none")]`.
- `reasonCode` is an `Option<String>`, never a closed enum.
- A server that omits the block means Clean cut is not available.

## C. Analysis job

### Create

`POST /api/ai/jobs`, with a JSON body. This is the existing route. The new
`workflowKind` is accepted alongside the default `post-recording-publish-pack`.

```json
{
  "sessionClientId": "<desktop session id>",
  "workflowKind": "post-recording-clean-cut",
  "clientRequestId": "cleancut:<sessionId>:<mode>:<16 hex of a hash of the input>",
  "clientVersion": "videorc-desktop/0.9.130",
  "consentToUploadAudio": true,
  "inputJson": {
    "mode": "clean",
    "durationMs": 1834200,
    "language": "en",
    "segments": [
      { "id": "s1", "startMs": 0, "endMs": 4200, "text": "So today we are going to build the thing." }
    ],
    "targetDurationSeconds": 900,
    "mustKeep": [{ "fromId": "s40", "toId": "s44", "reason": "clip-mark" }]
  }
}
```

Input rules:

- `mode` is `clean` or `condensed`.
- `segments` are sentences in time order. Each `id` is unique, 1–24 chars of
  `[A-Za-z0-9_-]`, and each `text` is 1–2 000 chars.
- At most 25 000 segments, and at most 1 200 000 characters of text in total.
- `targetDurationSeconds` and `mustKeep` are used only for `condensed`. The
  target is between 120 and 3 600. `mustKeep` reasons are `clip-mark` or
  `chat-peak`, and are free-form beyond that.
- `clientRequestId` dedupes the same way as every other job. The `cleancut:`
  prefix keeps it from ever colliding with a publish job.
- Clean-cut jobs are limited by their own `VIDEORC_AI_CLEAN_CUT_DAILY_JOBS`
  (default 20) and the existing monthly job cap.

### Poll

`GET /api/ai/jobs/{id}` returns the existing owner job snapshot.
`artifacts.cleanCut` appears only on clean-cut jobs, and only once
`status` is `completed`.

```json
{
  "status": "completed",
  "workflowKind": "post-recording-clean-cut",
  "artifacts": {
    "cleanCut": {
      "mode": "clean",
      "drops": [
        {
          "fromId": "s12",
          "toId": "s13",
          "kind": "retake",
          "confidence": 0.82,
          "reason": "Restarted the same sentence; the later take is kept."
        }
      ],
      "beats": [
        {
          "fromId": "s40",
          "toId": "s61",
          "title": "Deploying to Vercel",
          "importance": 0.9,
          "hook": false,
          "close": false
        }
      ],
      "keeps": [{ "fromId": "s1", "toId": "s9", "title": "Intro" }],
      "windows": { "total": 8, "completed": 8 }
    }
  }
}
```

Field rules:

- `drops` is always present. It may be empty for `condensed`.
- `kind` is `retake` or `false_start`, and the desktop must accept unknown
  kinds by ignoring them.
- `beats` and `keeps` appear for `condensed` only.
- `keeps` is the ordered selection whose total length hits the target within
  ±10%. It always contains the hook and the close, and every `mustKeep` range.
- Every `fromId` and `toId` refers to a segment from the request. The server
  drops anything else, and `fromId` comes at or before `toId` in segment order.
- `windows` reports progress.

Old desktops never create this kind. Publish-pack jobs and their artifacts are
unchanged.
