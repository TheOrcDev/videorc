# Managed media: the wire contract (plan 234)

Three lanes built against this file: the web server lane, the web program-page lane and the desktop lane. This revision records the code at the heads below. Where two lanes meet, this file is the only source. Change it first, then the code.

No prices, costs, keys or account ids belong here. This repo is public.

## How to read it

| Mark | Meaning |
| --- | --- |
| ◇ | Decided here, because the plan was silent or vague. Listed in section 17 |
| ⚠ | Not measured in Phase 0. The lane that builds it proves it first |
| **new** | An additive managed-media field or route, compared with the node contract. Field optionality is stated where used |

| Short name | Source |
| --- | --- |
| D | Desktop repo at `90e9e6b92`. Bare file names are under `crates/videorc-backend/src/` |
| W | Web repo at `3f74a19a`. Bare file names are under `lib/cloud/` |
| R | Runner repo `main`, `docs/wire-notes.md` unless a path is given |
| P0 | `docs/cloud/spike-livekit-managed-2026-11.md` (the Phase 0 note) |
| SDK | `livekit-server-sdk` 2.19.2 with `@livekit/protocol` 1.51.0 |

SDK field names come from Phase 0 and the checked web source. This revision checks code, not a new LiveKit measurement.

Unchanged conventions: instants are RFC 3339 UTC with milliseconds and durations are seconds (R:7-11). Orientations are `horizontal` and `vertical` on the desktop wire (D `cloud_show.rs:3888-3893`) and `h` and `v` toward LiveKit and the page. Errors are `{ "error": { "code", "message" } }` and every answer is `Cache-Control: private, no-store` (W `shows-route.ts:117-130`). A show id is `sh_` plus 22 base62 characters (W `shows.ts:8`).

## 1. The create answer

`POST /api/cloud/shows`. The request is unchanged: `CreateShowRequest` (D `cloud_show.rs:548-562`), parsed at W `shows.ts:383`.

```json
{
  "show": { "id": "sh_0123456789abcdefghijkl", "status": "ready", "kind": "solo", "nodeId": "livekit",
            "createdAt": "2026-11-13T20:00:00.000Z", "startedAt": null, "phaseSinceAt": null, "lastSeenAt": null,
            "endedAt": null, "endReason": null, "expiresAt": "2026-11-14T07:55:00.000Z", "holdMaxSeconds": 1800 },
  "ingest": [ { "orientation": "horizontal", "serverUrl": "<IngressInfo.url>", "streamKey": "<IngressInfo.streamKey>" } ],
  "control": { "kind": "web", "url": "", "token": "" },
  "allowance": { "enabled": true, "secondsPerMonth": 36000, "secondsUsed": 1200, "overageSeconds": 0, "resetAt": "…" }
}
```

| Field | Node answer today | Managed answer |
| --- | --- | --- |
| `show.*` | `serializeCloudShow` (W `shows.ts:299-313`) | Same function, same fields |
| `show.nodeId` | The node's id | `"livekit"`. The renderer contract needs a string (D `apps/desktop/src/shared/backend-rpc-contract.ts:6108`) |
| `show.expiresAt` | Create + 12 h + the hold (W `shows-route.ts:360-366`) | Create + 11 h 55 min (42,900 s). The hold no longer adds (D12) ◇ |
| `ingest[]` | The node's pairs, with `srt` (W `agent-client.ts:82-88`) | One per output. `serverUrl` and `streamKey` are LiveKit's, as returned. No `srt` block |
| `control.kind` | Absent | **new**: `"web"` |
| `control.url`, `control.token` | The node socket and the `vcs1` token | Empty strings ◇ |
| `allowance` | `buildCloudAllowanceBlock` | Same |

- The desktop feeds `{serverUrl}/{streamKey}` (D `recording.rs:27762-27766`), which is how Phase 0 addressed an ingress. Every Phase 0 ingress URL was `rtmps` with a DNS host, so `ingest_url_problem` (D `cloud_show.rs:956-986`) passes it as written.
- ◇ **`url` and `token` stay as empty strings**, not absent. `ShowControl` needs both (D `cloud_show.rs:643-648`). A build without web control that slips past section 12 fails its socket connect, ends the show and streams directly (D `cloud_show.rs:3114-3130`). With the fields absent its parse would fail and leave the show open.
- No `vcs1` show token is minted. A managed create must not need `VIDEORC_CLOUD_SHOW_SIGNING_KEY`, which fails closed today (W `shows-route.ts:323-331`).
- Desktop: `ShowControl.kind` is `Option<String>` with `#[serde(default)]`. A missing kind keeps the node path.
- **A create answer without `control.kind` means the node socket.** Any value other than `"web"` is a transport this build does not know: the desktop ends the show and streams directly with `cloud-node-unreachable`.

**Talk show.** The same, with `"kind": "talk"`, `"ingest": []` (no ingress, D6) and today's three blocks (W `shows-route.ts:600-610`), whose types stay (D `cloud_talk.rs:75-114`):

```json
{ "ingest": [], "control": { "kind": "web", "url": "", "token": "" },
  "room": { "url": "wss://<project>.livekit.cloud", "hostToken": "<jwt>", "name": "sh_…" },
  "invite": { "slug": "…", "url": "…", "expiresAt": "…" },
  "limits": { "guestsOnStage": 5, "roomSize": 10, "recordingRetentionDays": 30 } }
```

No runner token is minted. `returnWidth` and `returnHeight` in the request are accepted and ignored. `open_room` stores the ingest list without checking it (D `cloud_talk.rs:1230`), so an empty one is safe.

**Test show.** The solo answer with `"kind": "test"`, `expiresAt` 120 s after the create (W `shows.ts:110`), one ingress per output and no egress (D16).

Create errors added for a managed show:

| Status | `error.code` | When | Desktop |
| --- | --- | --- | --- |
| 422 | `cloud-quality` ◇ | ◇ A solo or test output is above 1920×1080 pixels or above 30 fps (D12). Talk creates are exempt: they have no ingress | **new** mapping to `CloudFallbackReason::CloudQuality` (D `cloud_show.rs:291`): direct, with the existing notice |
| 503 | `cloud-full` | Open managed shows are at the cap (section 11), or LiveKit answers `resource_exhausted` (an object limit, or HTTP 429 "egress minutes exceeded" once a plan's allowance is used) | Existing (D `cloud_show.rs:825`) |
| 503 | `cloud-node-unreachable` | LiveKit did not answer, or a call failed | Existing (D `cloud_show.rs:826`) |
| 503 | `cloud-disabled` | A managed secret of section 10 is missing | Existing |

◇ The show row and its media row are written in one database batch, with `state_json.createPending: true`. The marker is cleared only after the LiveKit create succeeds. The create route has `maxDuration: 60`; its LiveKit calls share a 40 s deadline and failed-create cleanup a 52 s deadline, both from the create's start. A failed create deletes its LiveKit objects and ends the row with its failure code.

◇ A `createPending` row still pending at 60 s is abandoned. For a missing media row, the state route acts immediately; the reaper waits until the create is 60 s old. Both end abandoned creates as `cloud-node-unreachable` and clean up their objects. This create failure counts toward no hourly limit (W `media/lifecycle.ts:49-66`, `media/reconcile.ts:425-431`).

## 2. Desktop → web routes

Rules for every route below:

- Auth is the desktop's bearer session, as on the other cloud routes (D `videorc_api.rs:3501-3517`). A show that is not the caller's answers 404, as End does (W `shows-route.ts:687-695`).
- Routes that act on an existing show work while `VIDEORC_CLOUD_DISABLED` is on, like End and current (W `shows-route.ts:616-620`).
- ◇ A desktop intent retries at most once, 1 s later, after a network error or a 5xx, never a 4xx. Both attempts and any wait for an earlier destination send share one deadline: 22 s for ordinary control, 7 s for `destinations.set` without `replace: true` (Reconnect and automatic resend). These fit inside the 25 s provider and 10 s Reconnect RPC watchdogs. A retry starts only with at least 3 s left: the delay and 2 s of useful work (D `cloud_control_web.rs:291-322`). Every route is safe to repeat.
- The web gives each LiveKit call 8 s. LiveKit's error text is never forwarded (section 8.5).
- ◇ Destinations, `legs/end`, recording and End share a 45 s deadline for their LiveKit calls, inside `maxDuration: 60`. Calls neither start nor keep waiting past it. Destinations, recording and `legs/end` write completed work before answering 503 `cloud-media-unavailable` for an unfinished operation. End returns 503 and keeps the row pending and its seat reserved until terminal egresses and deletion are confirmed; the reaper retries failed teardown. The show lease waits at most 5 s and expires after 65 s (section 9). The desktop's shorter deadline can expire before the web finishes; a missing answer does not prove no change occurred.

| Status | Common `error.code` | Meaning |
| --- | --- | --- |
| 400 | `invalid-request` | The body's shape. Names a field or an index, never a value |
| 401 | `unauthorized` | No session |
| 404 | `cloud-show-not-found` | No such show for this account |
| 409 | `cloud-show-ended` | The show is over |
| 409 | `cloud-control-mismatch` ◇ | The show runs on a node. Use the socket |
| 503 | `cloud-media-unavailable` ◇ | A LiveKit call failed or timed out |
| 503 | `cloud-storage-unavailable`, `cloud-tables-missing` | As today (W `readiness.ts:22-56`) |

| Route | Replaces | Sent today from |
| --- | --- | --- |
| `GET /api/cloud/shows/current` | `ingest.get` | D `cloud_show.rs:2780` (used at `:3443-3454`) |
| `PUT /api/cloud/shows/:id/destinations` | `destinations.set` | D `cloud_show.rs:3274`, `:3605`, `:2528`; `cloud_talk.rs:1599` |
| `POST /api/cloud/shows/:id/legs/end` | `legs.end` | D `cloud_talk.rs:1634` |
| `GET /api/cloud/shows/:id/state` | `hello`, `welcome`, `state`, `ping` | D `cloud_show.rs:1250`, `:1935-1976`, `:2363` |
| `PUT /api/cloud/shows/:id/hold-image` | `hold.image.set` | D `cloud_show.rs:2765`, `:2322` |
| `PUT /api/cloud/shows/:id/stage` | `stage.set` | D `cloud_talk.rs:511-532` |
| `POST /api/cloud/shows/:id/recording` | `recording.start`, `recording.stop` | D `cloud_talk.rs:1545-1556` |
| `POST /api/cloud/shows/:id/end` | `show.end` on the socket | D `cloud_show.rs:3542`, `:3279`, `:4392` |
| `POST /api/cloud/shows/:id/lost` | unchanged | D `cloud_show.rs:2678-2682` |

Not replaced by a route: `return.set` (section 6.4), and `overlay.set` and `overlay.clear`, which become byte streams (section 6.3).

### 2.1 `GET …/current`

```json
{
  "show": { "…": "as in section 1" },
  "control": { "kind": "web", "url": "", "token": "" },
  "ingest": [{ "orientation": "horizontal", "serverUrl": "…", "streamKey": "…" }]
}
```

- `ingest` is read from `ListIngress({ roomName })` on every call and never stored. If LiveKit does not answer it is omitted, and the resume fails with today's message (D `cloud_show.rs:3447-3452`).
- `CurrentShowResponse` already reads all three (D `cloud_show.rs:680-689`), and a resume needs `control` present (D `cloud_show.rs:3657-3659`).
- A test show is never listed (W `shows-route.ts:636-639`). No open show: `{ "show": null }`.

### 2.2 `PUT …/destinations`

Body mirrors `HandoverDestination` (D `cloud_show.rs:1196-1203`) and the frame at D `cloud_show.rs:1224-1248`.

```json
{ "destinations": [ { "id": "youtube-main", "platform": "youtube", "label": "YouTube",
                      "orientation": "horizontal", "url": "rtmps://…/live2/<key>" } ],
  "replace": true }
```

| Field | Type and limit |
| --- | --- |
| `destinations` | 1 to 16 items (R `crates/protocol/src/control.rs:96`) |
| `id` | Non-empty string, at most 1,024 bytes, unique in the list (R same file `:99`) |
| `platform`, `label` | Strings, at most 1,024 bytes |
| `orientation` | `horizontal` or `vertical`, and one of the show's outputs |
| `url` | At most 4,096 bytes (R same file `:97`), then the guard of section 8.1 |
| `replace` | Optional boolean. Sent only when true, as today |

◇ `id`, `platform` and `label` must be plain stored text: a NUL, any C0 or C1 control character, DEL, a lone surrogate or `://` gives 400 `invalid-request`. The message names the field, never its value.

Success: 200 `{ "ok": true, "rev": 12, "refused": [ { "id": "custom-1", "code": "destination-trailing-slash" } ] }`.

- `refused` is omitted when empty. It names ids and codes, never a URL.
- ◇ **Not all or nothing.** Accepted destinations are applied. A refused one appears in `legs[]` as `failed` with a fixed message (section 8.5).
- Every destination refused: 422 `cloud-destinations-refused` with the same `refused[]`. The desktop treats it as today's refused hand-over (D `cloud_show.rs:3275-3307`). LiveKit's egress quota hit: 503 `cloud-full`.

What the web does per destination. This is the runner's upsert (R:163-177), limited by one fact: LiveKit removes a stream by its URL, and the web keeps none (section 18, item 2).

| The `id` | The leg now | The web does |
| --- | --- | --- |
| New | — | No egress for that orientation: `StartEgress` with this request's accepted URLs of that orientation. Egress running: `UpdateStream` add |
| Known, same leg ref and full-address identity | `connecting` or `live`, not flagged `resend` | Nothing |
| Known, same leg ref and full-address identity | `reconnecting`, `failed`, or flagged `resend` | `UpdateStream` remove, then add. The remove is skipped when LiveKit already lists the stream `FAILED`. Clears `resend` |
| Known, different leg ref or full-address identity | Any, without `replace` | Refused: `destination-changed`. Send the full list with `replace` |
| Not in the list | Any, without `replace` | Nothing |
| `replace: true` | Every running leg of the orientation is named with the same ref and full-address identity | The upsert above, nothing more |
| `replace: true` | Some running leg is not named, or is named with another ref or full-address identity | `StopEgress`, then `StartEgress` with this request's list. Every platform of that orientation reconnects. The current separate recording egress carries on. Only the disabled shared-egress path needs a new take (section 13.2) ◇ |

Idempotent: the same list sent twice changes nothing on a leg that runs. Two requests at once for one show take the lease of section 9.

◇ Before `StartEgress`, the web writes `startInFlight` on the orientation. If the answer is lost, the next lease holder reconciles LiveKit's egresses and stops unnamed ones before clearing the marker. A start with an unknown outcome keeps the marker.

◇ The desktop stamps retained destination lists with an internal generation. End livestream and Stop invalidate it before waiting for a PUT already in flight, then send their stop after that PUT. Stale retries and automatic resends cannot revive the list. Only a fresh explicit destinations intent reopens sending. The generation never enters the HTTP body (D `cloud_control_web.rs:1368-1401`, `cloud_talk.rs:1836-1839`, `cloud_show.rs:3924-3959`).

◇ A side whose egress died by itself three times in 10 minutes refuses destination requests with 503 `cloud-media-unavailable` for 10 minutes from the third death (section 15).

### 2.3 `POST …/legs/end`

Body, **new**, additive and optional: `{ "destinations": [ { "id": "youtube-main", "url": "rtmps://…" } ] }`.

- The node intent has no body (R:227-240). The desktop sends the list it holds in memory (`ActiveShow.destinations`, D `cloud_show.rs:1302`) and clears it only after the answer (D `cloud_talk.rs:1636-1641`).
- Talk shows only. A solo show: 409 `cloud-legs-end-solo`, as the runner refuses it (R:279-285).
- ◇ The current path stops each streaming egress and leaves the separate recording egress running. It clears every leg, failed and refused legs included. A malformed JSON body or invalid body shape gives 400 `invalid-request`; no body is valid.
- The disabled shared-egress path (section 6.5) removes its URLs with `UpdateStream` when the body names every live leg; otherwise it stops and starts a segments-only egress as a new take.
- Afterwards `legs` is `[]`, `destinationsSet` stays `true` and `phase` stays as it was (R:255-268). Success: `{ "ok": true, "rev": 13 }`, also with no legs left (R:269-270).

### 2.4 `PUT …/hold-image`

Body: `{ "pngBase64": "<standard base64>" }`, today's intent field for field (D `cloud_show.rs:2765`) ◇.

- Solo shows. A talk show: 409 `cloud-hold-image-talk` (it uses the `hold` overlay slot, section 6.3).
- The decoded bytes are a PNG of at most 2 MiB (2,097,152 bytes) and 1,920 pixels a side. ◇ The desktop fits the image before this request, down to 2 MiB and 1,920 pixels a side; a node still accepts 8 MiB (D `cloud_control_web.rs:73-79`).
- 413 `hold-image-too-large`. 400 `hold-image-invalid` (not a PNG).
- Success: `{ "ok": true, "version": "<12 hex of the SHA-256>" }`. `state.holdImageSet` becomes `true`.
- Best effort, as today (D `cloud_show.rs:2755-2769`): a refusal leaves the default card and never fails a start. There is no clear; the image is deleted when the show ends.

### 2.5 `PUT …/stage`

Body is `CloudStage` as it serializes (D `cloud_talk.rs:478-491`), the fields of the frame at D `cloud_talk.rs:511-532`.

```json
{ "layout": "side-by-side", "onStage": ["host:sh_…", "g_…"], "spotlight": "g_…", "screen": "host:sh_…", "hostShape": "rounded" }
```

| Field | Rule |
| --- | --- |
| `layout` | `solo`, `side-by-side`, `screen-people` or `spotlight` (D `cloud_talk.rs:329-336`) |
| `onStage` | At most 8 identities (D `cloud_talk.rs:56`), each 1 to 128 characters, no control character (D `cloud_talk.rs:499-501`) |
| `spotlight`, `screen`, `hostShape` | Optional. `hostShape` is `rounded` or `circle` |
| Each identity | ◇ `host:<showId>`, or `g_` plus 22 base62 characters that is in the room: a guest must be among the room's participants (LiveKit's list, read again when the copy is older than 2 s). The host is always accepted, since it may be between connections. Anything else, in `onStage`, `spotlight` or `screen`: 422 `invalid-stage` (W `media/stage.ts`, `media/room.ts`) |

◇ A bad body shape, layout, identity shape or optional field gives 400 `invalid-request`.

The web writes it to the room's metadata (section 6.1) and answers `{ "ok": true, "rev": 14 }`. `state.room.stageSet` is then `true`. A solo show: 409 `cloud-stage-solo`.

### 2.6 `POST …/recording`

Body: `{ "on": true }`.

| Answer | When |
| --- | --- |
| 200 `{ "ok": true, "rev": 15 }` | Started, stopped, or already in that state |
| 409 `cloud-recording-solo` | Not a talk show |
| 409 `cloud-recording-no-target` | The show has no recording target (today's `problem: "no-target"`, R:724-726) |
| 409 `cloud-recording-on-air` ◇ | Only the disabled shared-egress path, while live streams share the recording egress. Unreachable in the current app (section 13.2) |
| 503 `cloud-full`, `cloud-media-unavailable` | LiveKit refused or failed |

### 2.7 `POST …/end` and `POST …/lost`

- **End.** Success is `{ "ok": true }`, also for an ended show. Managed End first persists `endRequested`, freezes media mutations, and stops the known and listed egresses under the lease. `ENDING` is not confirmation: the row ends only after terminal egresses are confirmed and room/ingress deletion succeeds. Until then it returns 503 `cloud-media-unavailable`, keeps the seat, and the reaper retries. No new public phase is added. Tests and abandoned creates that never received destinations may release immediately with deferred cleanup.
- **Lost.** Unchanged request (`LostShowReport`, D `cloud_show.rs:693-702`) and answer (`{ "show": … }`, D `cloud_show.rs:706-710`). The web asks LiveKit instead of a node (section 15).

## 3. `GET …/state?since=<rev>`

The answer is `{ "rev", "state" }` ◇. `state` deserializes as `RunnerState` with no change (D `cloud_show.rs:1054-1091`); `rev` sits beside it because it is not part of the show's state.

```json
{
  "rev": 42,
  "state": {
    "phase": "hold",
    "liveSeconds": 1234,
    "hold": {
      "active": true,
      "since": "2026-11-13T20:20:34.000Z",
      "reason": "feed-lost",
      "remainingSeconds": 1741
    },
    "feeds": [{ "orientation": "horizontal", "connected": false }],
    "legs": [
      {
        "id": "youtube-main",
        "platform": "youtube",
        "label": "YouTube",
        "orientation": "horizontal",
        "state": "live",
        "since": "2026-11-13T20:00:07.000Z"
      }
    ],
    "destinationsSet": true,
    "restarts": 0,
    "holdImageSet": false,
    "desktopConnected": true,
    "program": { "audioRmsDb": -100.0, "audioSilentSeconds": 59, "blackSeconds": 0 }
  }
}
```

| Block | Deserializer | Managed source |
| ------------------ | ------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `phase` | D `cloud_show.rs:1057-1058`, read at `:1527-1534` | Section 4 |
| `endReason` | D `cloud_show.rs:1059-1060` | Section 4. Only with `phase: "ended"` |
| `hold` | `CloudHoldStatus`, D `cloud_show.rs:332-342` | Section 4. Omitted when no hold is active. `remainingSeconds` is worked out at answer time |
| `liveSeconds` | D `cloud_show.rs:1063-1064` | Seconds since the first on-air beacon, hold included (R:13-18). Worked out at answer time |
| `feeds[]` | `CloudFeedStatus`, D `cloud_show.rs:344-351` | One per ingress. `connected` from `ingress_started` and `ingress_ended`. `kbps` from `ListIngress`, cached 2 s, omitted when LiveKit reports 0 ⚠ |
| `legs[]` | `RunnerLeg`, D `cloud_show.rs:1121-1137` | Section 8.3. `legs[].resend` is **new** and optional (section 8.4) |
| `destinationsSet`  | D `cloud_show.rs:1071-1072`, read at `:2111-2114` | `false` whenever any orientation needs repair, even while another streams or is held by the restart cap. Otherwise `true` while a streaming egress is `STARTING` or `ACTIVE`, after `legs/end`, or when all remaining sides have terminal destination failures or are held. Pending End and explicit `legs/end` suppress resends. It is already `true` in the `rev` a `PUT …/destinations` answer names, not first at `egress_started`: otherwise the desktop reads a dead egress and sends the list again |
| `restarts` | D `cloud_show.rs:1075-1076`, read at `:2115-2117` | Times a streaming egress ended by itself while the show was open, except one whose every stream was `FAILED` ◇. Not the count of egresses started. An egress the web stopped itself (`replace`, `legs/end`, End) never counts |
| `holdImageSet` | D `cloud_show.rs:1079-1080` | A hold image is stored |
| `desktopConnected` | Not read by the desktop (R:316-322) | A state poll in the last 15 s |
| `program` | `CloudProgram`, D `cloud_show.rs:1096-1115` | The primary page's beacons (section 5.3). `avSkewMs` is never sent (D15) |
| `room` | `RunnerRoomState`, D `cloud_talk.rs:225-248` | Section 6.2. Talk shows only |
| `recording` | `RunnerRecordingState`, D `cloud_talk.rs:289-304` | Section 13.2. Talk shows only |

- `kbps`: every Phase 0 reading of an ingress's `averageBitrate` was 0. A feed without `kbps` reads as unmeasured, never slow (D `cloud_show.rs:4010-4019`).
- `legs[].resend`, if the desktop stores it: `Option<bool>` with `#[serde(default, skip_serializing_if = "Option::is_none")]`.

**`rev`** is a whole number per show. It starts at 1 at the create, grows by one on every material change and never goes back.

- Material: `phase`, `hold.active`, `hold.reason`, a feed's `connected`, a leg added, removed or changing `state` or `resend`, `destinationsSet`, `restarts`, `holdImageSet`, a program counter leaving 0 or returning to 0, anything in `room` but `sinceMs`, and `recording.active` or `problem`.
- Not material: clocks (`liveSeconds`, `remainingSeconds`, `recording.seconds`), `kbps`, `audioRmsDb`, and a counter that only grows.

**Long-poll rules.**

| Case | Answer |
| --- | --- |
| No `since` | At once. This is the socket's `welcome` (D `cloud_show.rs:1949-1950`) |
| `since` is less than, or greater than, the current `rev` | At once |
| `since` equals `rev` | Wait. Look at `rev` once a second, as the guests list does (W `talk.ts:107-108`). Answer the moment it grows |
| The wait runs out | 200 with the same `rev` and the state as it is now ◇ |
| The show is over | At once, whatever `since` is: `{ "rev", "state": { "phase": "ended", "endReason": "…", "liveSeconds": n, "feeds": [], "legs": [] } }` ◇ |
| `since` is not a whole number | 400 `invalid-request` |

| The show ◇ | Longest wait |
| --- | --- |
| Calm: `live`, no hold, every program counter 0, nobody but the host in the room | 25 s |
| A hold is active, or `phase` is `starting`, or a program counter is above 0, or it is a test show | 2 s |
| A talk show with anyone but the host in the room | 5 s |

- ◇ **Why a 200 at the timeout, and why the short waits.** Clocks and counters are right only at the moment of an answer. The runner sends a state at least every 2 s, and the watchdog reads counters that must pass 3, 10 and 20 s (D `watchdog/checks.rs:29`, `:59-60`). The short wait gives the desktop that cadence while something is wrong and stays quiet otherwise. A 200 is also what the desktop's reader takes (D `videorc_api.rs:1996`) and what the guests list does (W `talk-route.ts:346-386`).
- `desktopConnected`: every poll stamps the show, at most once every 5 s. The flag is true while the stamp is under 15 s old.

◇ The whole state answer fits a 30 s budget, under the desktop's 35 s timeout and the route's `maxDuration: 40`. Each participant or bitrate read has at most 2 s, clipped to the remaining budget; a read due with no time left is skipped. When a poll ends an abandoned create or a test show, it ends the row and answers the end at once; LiveKit's teardown is left to the reaper's next tick, as for any ended show (W `managed-route.ts`).

**The desktop's poll loop.** The request timeout is 35 s, as the guests poll (D `videorc_api.rs:28-29`). After a 200 the next poll starts 250 ms later with `since` set to the answer's `rev`. After a failure it waits 1, 2, 4, 8, then 15 s (D `cloud_show.rs:92`), reset by a 200. The first poll after a failure carries no `since`, so the answer comes at once and the status can read connected again. A state whose `rev` is below the `rev` of a route answer the desktop already holds is dropped once. `CloudStatus.connected` is true after a 200 and false after the first failed poll. There is no `hello`, `ack` or `ping`: a route's own answer is its ack.

| Answer | The desktop |
| --- | --- |
| 200, `phase` not `ended` | Absorbs the state exactly as a socket frame (D `cloud_show.rs:2415-2511`) |
| 200, `phase: "ended"` | The show is over with `endReason` (D `cloud_show.rs:2385-2386`). Stop polling |
| 401 | Stop polling. The show stays held. Sign-in starts the launch check again |
| 404 | Ask `current`. Gone there too: the show is gone (D `cloud_show.rs:2643-2653`). Listed there: back off and poll again |
| 409 `cloud-show-ended` | Read as `phase: "ended"` |
| 409 `cloud-control-mismatch` | Ask `current` and use the control it names |
| 5xx, timeout, network error | Back off. From the second failure, ask `current` after each one, as today (D `cloud_show.rs:2631`). Unknown is never "gone" |

## 4. Phase and hold

A show with both orientations has two pages. ◇ `phase`, `hold`, `program` and `liveSeconds` come from the **primary** page: `h` when the show has a horizontal output, else `v`. The other page's beacons only move its own legs to `live`.

| `phase` | Enters when | Source |
| --- | --- | --- |
| `starting` | The create. Stays until the first on-air beacon | Web |
| `live` | The primary page's first beacon with `phase: "live"`. The page sends it at its first decoded frame, the moment it logs `START_RECORDING` (R:61-64) | Beacon |
| `live` (test show) | `ingress_started`. A test show has no page | Webhook |
| `live` (talk show) ◇ | `participant_joined` for `host:<showId>`. It then never becomes `hold` | Webhook |
| `hold` | A primary beacon with `phase: "hold"` | Beacon |
| `hold` (fallback) | `ingress_ended` for the primary feed, and no beacon said `hold` within 5 s. `since` is the webhook's time | Webhook |
| `live` again | A primary beacon with `phase: "live"` after a hold. The page sends it when its return fade starts | Beacon |
| `ended` | The table below | Web |

- `ending` is never sent for a managed show. The desktop sets its own flag (D `cloud_show.rs:3535`).
- `hold.reason` is always `feed-lost`. Managed shows have no manual hold.
- `hold.since` is the moment the page's 1.5 s stall clock fired (R:43-47). The web works it out as `received − (beacon.at − beacon.hold.sinceAt)`, so the page's clock offset does not matter ◇. `hold.remainingSeconds` is `holdMaxSeconds − (now − since)`, never below 0.
- `ingress_started` alone never makes a streaming show `live`: only a decoded frame at the page does (the on-air rule, D4). A late beacon never reopens an ended show.

| `endReason` | When | Desktop message |
| -------------------------- | ----------------------------------------------------------------------------------------------- | ---------------------- |
| `host-ended` | `POST …/end` | — |
| `no-feed` | ◇ No feed 60 s after a solo or test create; never a talk show | D `cloud_show.rs:2174` |
| `hold-limit` | The room closed by `departure_timeout` during a hold, or the reaper found a hold past its limit | D `cloud_show.rs:2172` |
| `max-show` | 11 h 55 min, or 30 s after a test show's first frame | D `cloud_show.rs:2173` |
| `egress-lost` ◇ | No streaming egress for 60 s on a solo show, and no desktop to re-send | Generic |
| `media-lost` ◇             | The lost route confirmed no room and no active egress, (section 15); API silence is unknown     | Generic                |
| `room-finished` | `room_finished` outside a hold (W `livekit-webhook.ts:47`) | Generic |
| `expired` | The reaper, past `expiresAt` | Generic |
| `cloud-node-unreachable` ◇ | An abandoned create (section 1) | Create failure |

◇ Talk creates keep the existing 600 s empty timeout, shows-per-hour limit and invite expiry. The invite is revoked when the show ends. There is no `runner-silent` rule for a managed show and no `no-feed` end for a talk room.

## 5. The program page

### 5.1 The URL

`<VIDEORC_CLOUD_PROGRAM_BASE_URL>/cloud/program/v1` (D20). Static, no cookies, no account data, `noindex`, a strict content security policy. A deploy never changes `v1` under a running show; a breaking change is `v2`.

| Query | Set by | Value |
| --- | --- | --- |
| `show` | The web, in `customBaseUrl` | The show id |
| `k` | The web | `solo` or `talk` |
| `pt` | The web | The page token (section 5.2) |
| `rec` | The web | `1` on a recording-only egress (section 13.2). Absent otherwise |
| `layout` | LiveKit, from `TemplateSource.layout` | `h` or `v`. The page's orientation |
| `url`, `token` | LiveKit | The room's WebSocket URL and the recorder's join token |

- `customBaseUrl` is `…/cloud/program/v1?show=<id>&k=<kind>&pt=<token>`. Phase 0 proved a base URL keeps its own query (P0, S0.5).
- ⚠ The names LiveKit appends were taken from what the Phase 0 pages read (`url`, `token`, `layout`), not from LiveKit's template documentation. The page reads them with `URLSearchParams`, in any order, and ignores any other name.
- LiveKit stores this URL in the egress record, so nothing in it may be a secret that matters elsewhere.
- The page's content security policy lets it connect to `*.livekit.cloud` and to the one origin its own `url` parameter names, when that is a well-formed `wss:` URL. Which host LiveKit Cloud's recorder is handed is not measured ⚠, and the page holds nothing a hostile `url` could reach.

### 5.2 The page token

Same three-part shape as the show token (W `show-token.ts:9-13`), its own tag:

```
vcp1.<base64url(payload JSON)>.<base64url(HMAC-SHA256 of the ASCII "vcp1.<payload>")>
payload: { "v": 1, "show": "<showId>", "o": "h" | "v", "role": "program", "iat": <s>, "exp": <s> }
```

- `exp` is the show's `expiresAt` plus 15 minutes.
- ◇ HMAC-SHA256, keyed by `VIDEORC_CLOUD_PROGRAM_TOKEN_KEY` (32 bytes). The web alone mints and checks it, so it needs no public half.
- It authorises exactly two things: beacons for that show and orientation, and that show's hold image. No account, no other show, no other write.
- The page sends it as `Authorization: Bearer <pt>`. Both routes are on the page's own origin, so no CORS rule is needed. A bad, expired or mismatched token answers 401 `program-token-refused` with no detail.

### 5.3 `POST /api/cloud/program/beacon`

Headers: `Authorization: Bearer <pt>`, `Content-Type: application/json`. At most 4 KiB.

```json
{ "v": 1, "show": "sh_…", "o": "h", "boot": "k3Jd82LmQp0a", "seq": 17, "at": 1794000000123, "joined": true,
  "phase": "hold", "hold": { "reason": "feed-lost", "sinceAt": 1794000000001 },
  "program": { "audioRmsDb": -100.0, "audioSilentSeconds": 3, "blackSeconds": 0, "frozenSeconds": 4 },
  "shown": { "onStage": ["host:sh_…", "g_…"], "screen": "g_…", "away": ["g_…"] } }
```

| Field | Rule |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `show`, `o` | Must match the token |
| `boot` | 12 base62 characters, made once per page load ◇ |
| `seq` | Starts at 1 per `boot`, grows by one per beacon ◇ |
| `at` | The page's `Date.now()` |
| `phase` | `waiting` (no frame yet), `live` or `hold` |
| `hold` | Only with `phase: "hold"`. `sinceAt` is the page's `Date.now()` when its stall clock fired |
| `program` | ◇ Optional, each field optional. D15's fields, defined as the runner's (R:390-396). First appears 1 to 2 s after the solo feed's first frame, or after the talk stage is drawn. `frozenSeconds` only during a hold, once it is 3 or more. Never `avSkewMs` |
| `shown` | ◇ Talk shows only. `onStage` is the layout as drawn, so it can be shorter than the stage; `screen` is present only for a drawn screen tile. `away` lists everyone on stage with no camera frame for 5 s, drawn or not, including people the 60 s re-flow dropped (W `program/stage.ts`, `shownOf`) |
| `joined` | ◇ Optional boolean. The page sends `true` only while connected to the room with its overlay handlers registered; absent at load and while rejoining. A join counts each time it goes from absent to `true` within a `boot`, and at a new `boot` |
| `join`      | Optional positive per-boot epoch; grows each time `joined` becomes true, preserving reconnects shorter than the beacon interval                                                                                                                                                                    |
| `rec` | `true` on a recording-only page |

When the page sends one:

1. ◇ An ordinary page sends at load: `seq` 1 with `phase: "waiting"`. A recording-only page follows rule 5 instead.
2. ◇ At once when `phase`, `hold`, `shown` or `joined` changes, or a program counter leaves 0 or returns to 0.
3. Never more than one a second. Changes inside that second fold into the next beacon.
4. Every 10 s otherwise, with the current values.
5. ◇ A recording-only page (`rec=1`) waits until it has joined, then follows the same change and 10 s heartbeat rules while connected. It remains silent before joining and during disconnection.

◇ A network error or 5xx retries at 1, 2, 4, 8, then every 10 s, with a new `seq` and the latest snapshot. Another 4xx is not retried; 410 stops the sender. Before sending, the page measures UTF-8 JSON bytes. Above 4 KiB it drops `shown` first, then `program`, keeping the page identity, phase, hold and `joined` (W `program/beacon.ts:167-195`).

Answer: 200 `{ "ok": true, "holdImage": "<version>" }`, or `"holdImage": null`. The page fetches the image again when the version changes. Errors: 400 `invalid-beacon` (the shape, a size over 4 KiB, or `show` or `o` not the token's), 401 `program-token-refused`, 410 `cloud-show-ended` (the page stops sending).

Stale and out-of-order beacons:

- Same `boot`, `seq` not above the stored one: dropped, answered 200.
- ◇ A new ordinary `boot` becomes the page of that orientation; beacons from remembered old boots are dropped. `room.pageJoins` grows at a boot's first beacon with `joined: true` (never at its load beacon), and again each time a later beacon of the same boot says `joined: true` after one without it or with a higher `join` epoch: a page that lost and rejoined its room missed every byte stream sent meanwhile, so the desktop sends untimed overlays again and clears empty slots. A duplicate or stale beacon never counts.
- ◇ A beacon with `rec: true` keeps independent `recordPage` state, using the same sequencing and join rules. It never replaces the ordinary page or changes stream `phase`, `hold` or `program`. While recording, its fresh `shown` is the fallback for the Program monitor.
- A counter above 0 is stored with its arrival time. A state answer adds the whole seconds since then.
- No primary beacon for 25 s: `program` and `room.shown` leave the state.

### 5.4 `GET /api/cloud/program/hold-image?show=<id>&v=<version>`

`Authorization: Bearer <pt>`. Solo shows. 200 `image/png` with `Cache-Control: private, no-store`; `v` only defeats caches. No image: 204 with no body, and the page draws the default card. 401 `program-token-refused`. 410 `cloud-show-ended`.

### 5.5 Room identities and what the page draws

| Identity | Who | The page |
| --- | --- | --- |
| `feed-h`, `feed-v` | The ingress of that orientation | Solo: draws the one named by `layout`, full frame, and plays its audio. Ignores the other |
| `host:<showId>` | The host (W `livekit.ts:112-114`) | Talk: camera, microphone and screen share, when the stage names them |
| `g_` plus 22 base62 | A guest (W `talk.ts:43-44`) | Talk: the same, when the stage names them |
| `EG_…` | LiveKit's recorder (P0, "Assumptions") | Never drawn, never counted |
| Anything else, `runner:` included | Not ours | Ignored |

- A talk page subscribes to the camera and microphone of everyone on stage and to the screen share the stage names, never to anyone backstage (R:747-752).
- ◇ Managed webhooks handle solo and test shows too. `feed-h`, `feed-v` and `EG_…` are media identities, not foreign people, and write no room-minutes row (W `media/room.ts:46-52`, `media/webhook.ts`).

### 5.6 Console lines and hold timings

| Line | Logged |
| --- | --- |
| `START_RECORDING` | Once per page load. Solo: at the feed's first decoded frame, never before. Talk: when the page has a stage from room metadata. A `rec=1` page follows the same rule |
| `END_RECORDING` | ◇ Once, only after a room was joined: when it closes for good, the page is removed, the show is over, or the 60 s rejoin window expires. Never for an initial join failure |

The egress sends nothing to a platform before `START_RECORDING`.

◇ Initial join failures retry at 1, 2, 4, 8, then every 10 s while the page lives and the show is not over. SDK `Reconnecting` and `Reconnected` invoke the same lost/joined hooks. An unexpected disconnect after a successful join gets a 60 s rejoin window, beginning at SDK reconnect with the same backoff; a solo page holds through it. Explicit room end or removal is final. A successful rejoin keeps the same boot and does not log `START_RECORDING` again (W `program/source.ts:65-98`, `:122-222`).

| Hold step (D5) | Value |
| --- | --- |
| No new frame, then the hold begins | 1,500 ms |
| The last frame stays | 1,000 ms |
| Fade to the card, in silence | 300 ms |
| Steady frames before the return | 1,000 ms, with no gap over 250 ms (R:48-51) |
| Fade back | 300 ms |
| Frames back during the freeze | The picture carries on. No card |
| Tolerance in the browser test | 100 ms (W6) |

The card is "Be right back", Noto Sans 500, on `#0D0D0F`. A custom image replaces it. Measured on LiveKit: the card is up 2.7 to 2.9 s after the last frame (P0, S0.2).

### 5.7 Rules the page must keep

From P0, "What the program page must do". The page lane keeps each one and tests the ones a browser test can see.

- [ ] Own the video element's stream. Never `attach()`.
- [ ] Never stretch the video. Draw it at its own size and scale the box.
- [ ] Keep a copy of the picture beneath it. Copy at most twice a second.
- [ ] Never pipe frames through script.
- [ ] Treat a frame of 2×2 pixels as the end marker, not a picture.
- [ ] Use the element's `resize` event as the first sign the track ended.
- [ ] Decide the hold on a clock, not when work finishes.
- [ ] Count decoded frames as well as frame callbacks while covered.
- [ ] Load the font itself. Do not rely on the recorder having it.
- [ ] ◇ The talk mix limiter is an AudioWorklet with a 5 ms look-ahead at −1 dBFS. The solo page plays one feed without a limiter; its Web Audio meter listens beside the sound path.
- [ ] Play each remote voice in a media element too, or Chrome feeds Web Audio nothing.
- [ ] Log `START_RECORDING` exactly once.

## 6. Talk shows

### 6.1 Stage state is room metadata

```json
{ "v": 1, "stage": { "layout": "side-by-side", "onStage": ["host:sh_…", "g_…"], "spotlight": "g_…", "screen": "host:sh_…", "hostShape": "rounded" } }
```

- `stage` is the accepted `PUT …/stage` body, unchanged. The layout names are the fixture's (`protocol-fixtures/talk-show-layout.json`).
- Only the web writes it: at `CreateRoom` (the host alone on `solo`, the runner's default, R:690-691) and on each `PUT …/stage`. At most 4,096 bytes. No names: the page reads each participant's name from the room.
- The page looks up the fixture by canvas, layout and number of people (1 to 6). `onStage[0]` is the host and fills the first slot. A `spotlight` guest takes the second slot. Past 6 people the page draws the first 6.
- Guests read the same metadata. The host's `videorc.stage` data message (W `guest-wire.ts:18`) stays as it is.

### 6.2 `state.room`

| Field | Managed source |
| --- | --- |
| `connected` | The room exists. True from the create to `room_finished` |
| `participants[]` | ◇ `ListParticipants`, refreshed on each participant webhook and a poll's first look, then again at the end of its wait, cached 2 s and subject to the 30 s budget. Host first, then join time and identity. `role` from the identity, `onStage` from metadata, `sinceMs` since the join |
| `participants[].video`, `audio`, `muted`, `screen` | From each participant's tracks, defined as the runner's (R:705-707) |
| `participants[].quality` | Always `"good"`. LiveKit's server does not report it (D `cloud_talk.rs:367-375`) |
| `participants[].away`, `hostAway` | The primary page's `shown.away`. `hostAway` is also true while the host is not in the room |
| `layout`, `stage` | The metadata |
| `stageSet` | True once a `PUT …/stage` succeeded, and from then on, so the desktop never re-sends (D `cloud_show.rs:2489-2498`) |
| `returnEnabled` | Always `false` |
| `shown` | The primary page's `shown`, without `away`. Absent while no page beacons |
| `pageJoins` | **new**, optional. Section 6.3 |

◇ Participants and their sanitized display names live in `state_json.participants` during the show, so joins, leaves and track changes can move `rev`. The host sorts first. Names are removed at End and by the reaper's ended-show scrub (section 15).

`pageJoins` on the desktop: `RunnerRoomState.page_joins: Option<u32>` with `#[serde(default, skip_serializing_if = "Option::is_none")]`. It does not enter `CloudStatus`, so the renderer contract is untouched.

### 6.3 Overlays are byte streams

Sent by the host's renderer on its own room connection. ◇ The backend retains the current images in desktop memory; the web and page persist none.

| Topic | Body | Attributes (all strings) |
| --- | --- | --- |
| `videorc.overlay.set` | The image bytes | `v`: `"1"`. `slot`: `card`, `takeover` or `hold`. `o`: `h` or `v`. `x`, `y`, `w`, `h`: 0 to 1 of the canvas. `ttl`: optional whole seconds, at least 1 ◇ |
| `videorc.overlay.clear` | UTF-8 JSON `{ "v": 1, "slot": "…", "o": "…" }` | None |

- The fields are today's `overlay.set` and `overlay.clear` (D `cloud_talk.rs:1675-1703`), slot by slot (D `cloud_talk.rs:667-683`), with the rect rule of D `cloud_talk.rs:802-812`.
- The image is PNG, JPEG or WebP, at most 2 MiB ◇. The stream's MIME type says which. The page fits it inside the rect, centred (R:694-695). ◇ Slot `hold` covers the full talk frame as soon as it is set, above the other overlays. It stays until cleared or its TTL expires; clearing it reveals the stage. A talk page has no automatic hold card.
- **The page accepts both topics only from `host:<showId>`.** Any other sender is dropped. A guest cannot send one anyway: guests have no `canPublishData` (W `livekit.ts:246`), and the host has it (W `livekit.ts:219`).
- A page that joins later saw none of it. So when `room.pageJoins` grows, the desktop sends its current untimed overlays (`takeover`, `hold`) again ◇. A card with a `ttl` is not re-sent.
- ◇ Rect numbers are plain unsigned decimals, with 1 to 4 digits before the point and at most 12 after it; no signs or exponent. `ttl` is 1 to 7 digits and at least 1 second. The existing inside-canvas rect rule still applies.
- ◇ The renderer uses livekit-client `streamBytes`, writes the bytes and closes the stream. A set must finish reading in 30 s; a clear in 5 s. A clear is processed independently, and a late set cannot overwrite a newer clear or set. Over the size, a bad attribute, unknown slot or stalled stream is dropped.
- ◇ `cloud.room.overlay` hands the renderer `{ op: "set", showId, slot, orientation, rect, ttlSeconds?, mimeType, imageId }` or `{ op: "clear", showId, slot, orientation }`. It fetches set bytes from the backend's token-checked `GET /cloud/overlays/:imageId?token=…`. The backend fits images to 2 MiB and replays untimed overlays on a `pageJoins` increase or the host renderer's room reconnect (D `cloud_talk.rs:845-900`).

### 6.4 The return

`cloud.return.set` on a managed show does nothing on the wire. The backend answers the RPC with today's error code `cloud-return-failed` (D `main.rs:11910-11918`) and the message "The program return is not available on this show." `state.room.returnEnabled` stays `false`.

### 6.5 When an egress starts and stops

| Event | Egress |
| --- | --- |
| The room opens | None |
| Go Live (`PUT …/destinations`) | One streaming egress per orientation that has a destination |
| Record, with or without a live stream ◇ | One separate segments-only egress per output, always on a `rec=1` page |
| Go Live while recording ◇ | Starts a streaming egress. The recording carries on separately |
| `legs/end` ◇ | Stops streaming, leaves recording and room open |
| Stop recording ◇ | Stops the recording egress, leaves streaming and room open |
| Close the room (`POST …/end`) | Every egress is stopped |

◇ Shared stream-and-segments egress is implemented behind `recordSharesFirstEgress`, but no app caller enables it. Only that disabled path starts Record with an empty stream output, adds URLs to it on Go Live, can need a new take on `replace` or `legs/end`, and can refuse Stop recording with `cloud-recording-on-air`. An empty stream output remains unmeasured ⚠ (W `media/recording.ts:329-332`).

## 7. The LiveKit calls

All through SDK 2.19.2. `showId` is the room name everywhere.

| Object | The reconcile pass finds it, with no database row, by |
| --- | --- |
| Room | Its name is a show id: `^sh_[0-9A-Za-z]{22}$` |
| Ingress | `roomName` is the show id. `name` is `<showId>-h` or `<showId>-v`. `participantIdentity` is `feed-h` or `feed-v` |
| Egress | `roomName` is the show id. Orientation is `request.source.layout`. A recording-only egress has `rec=1` in `customBaseUrl` and no stream output |

Anything on the project that matches none of these is not ours and is never touched.

```ts
rooms.createRoom({ name: showId,
  emptyTimeout: 120,                  // talk: 600, today's value (W talk.ts:103)
  departureTimeout: holdMaxSeconds,   // the hold limit (D5)
  maxParticipants, metadata })        // talk only

// One per output. Exactly as Phase 0 ran it.
ingress.createIngress(IngressInput.RTMP_INPUT, {
  name: `${showId}-h`,
  roomName: showId,
  participantIdentity: 'feed-h',
  participantName: 'feed-h',
  enableTranscoding: true,
  video: new IngressVideoOptions({
    source: TrackSource.CAMERA,
    encodingOptions: {
      case: 'options',
      value: new IngressVideoEncodingOptions({
      videoCodec: VideoCodec.DEFAULT_VC,   // H264_HIGH is refused (P0)
      frameRate: output.fps,               // at most 30
        layers: [
          new VideoLayer({
            quality: VideoQuality.HIGH,
            width: output.width,
            height: output.height,
            bitrate: 12_000_000
          })
        ]
      })
    }
  }),
  audio: new IngressAudioOptions({
    source: TrackSource.MICROPHONE,
    encodingOptions: { case: 'preset', value: IngressAudioEncodingPreset.OPUS_STEREO_96KBPS }
  })
})

// One per orientation.
egress.startEgress(
  new StartEgressRequest({
  roomName: showId,
    source: { case: 'template', value: new TemplateSource({ layout: 'h', customBaseUrl }) },
    encoding: {
      case: 'advanced',
      value: new EncodingOptions({
        width: 1920,
        height: 1080, // 1080 × 1920 for "v"
        framerate: 60,
        videoCodec: VideoCodec.H264_HIGH,
    videoBitrate: 6000,                   // kbps
    keyFrameInterval: 2,                  // seconds
        audioCodec: AudioCodec.AAC,
        audioBitrate: 160,
        audioFrequency: 48000
      })
    },
  outputs: [
    // Streaming request only; a separate recording request has segments only. ◇
      ...(urls !== null
        ? [
            new Output({
              config: {
                case: 'stream',
                value: new StreamOutput({ protocol: StreamProtocol.RTMP, urls })
              }
            })
          ]
        : []),
      ...(segments
        ? [
            new Output({
              // talk recording request only
              config: {
                case: 'segments',
                value: new SegmentedFileOutput({
                  filenamePrefix: `${takePrefix}seg`,
                  playlistName: `${takePrefix}index.m3u8`,
                  segmentDuration: 2
                })
              }, // always 2 s (D10)
              storage: new StorageConfig({
                provider: {
                  case: 's3',
                  value: new S3Upload({
                    accessKey,
                    secret,
                    region,
                    endpoint,
                    bucket,
                    forcePathStyle: true
                  })
                }
              })
            })
          ]
        : [])
    ]
  })
)
```

| Call | Request |
| --- | --- |
| `UpdateStream` | `egress.updateStream(egressId, addOutputUrls, removeOutputUrls)` |
| `StopEgress` | `egress.stopEgress(egressId)` |
| `ListEgress` | `egress.listEgress({ roomName: showId })`. The reconcile pass: `egress.listEgress({ active: true })` |
| `ListIngress` | `ingress.listIngress({ roomName: showId })`. The reconcile pass: `ingress.listIngress({})` |
| `ListRooms` | `rooms.listRooms([showId])`. The reconcile pass: `rooms.listRooms()` |
| `ListParticipants` | `rooms.listParticipants(showId)` |
| `DeleteIngress` | `ingress.deleteIngress(ingressId)` |
| `DeleteRoom` | `rooms.deleteRoom(showId)`. "Not found" is success, as today (W `livekit.ts:363-369`) |
| `UpdateRoomMetadata` | `rooms.updateRoomMetadata(showId, JSON.stringify(metadata))` |

- ◇ The ingress layer is the output's own size. Phase 0 measured 1920×1080 at 12 Mbps only. ⚠ Other sizes, and every vertical value, are not measured. A 16 Mbps layer never starts (P0, S0.1).
- ◇ The egress output is always 1080p60 at 6 Mbps (D4), whatever size and `videoKbps` the create asked for. Talk shows use the same encoding. ⚠ Phase 0 ran the talk page at 30 fps.
- Never a file output: its 3-hour limit would end the show (D10).
- ◇ Talk rooms also get `departureTimeout: holdMaxSeconds`. No runner keeps the room open any more, so the default 20 s would close it when the host relaunches alone.
- ◇ Talk `maxParticipants` is today's value (W `shows-route.ts:412`) plus 4, for up to four recorders. ⚠ Cloud counts a recorder in `numParticipants` (P0); whether it counts against the cap is not measured. Solo rooms set no cap.
- `ListEgress` fills only the older fields: stream results are in `result.value.info` and segment results in `result.value`. Direct answers and webhooks may fill `streamResults` and `segmentResults`. Every reader takes whichever is not empty (P0, S0.3).
- `StartEgress` needs the project-wide `roomRecord` grant (P0, S0.4). Only the server's API key calls it. Host and guest tokens keep `roomRecord: false` (W `livekit.ts:214`).
- ◇ Each recording take gets its own `storage:write` key pair on the show's branch, expiring 15 minutes after `show.expiresAt`. Only its revocation id and branch metadata are stored; its secret is never stored. Section 13.2 gives the revocation rules.

**Webhooks.** The handler keeps its checks and its once-per-event-id rule (W `livekit-webhook.ts:99-119`). Every write stays idempotent. A lost webhook is repaired by the reconcile pass within a minute.

| Event | Changes |
| --- | --- |
| `ingress_started` | That feed's `connected` is true. A test show becomes `live` |
| `ingress_ended` | That feed's `connected` is false. Starts the 5 s hold fallback |
| `egress_started` | The egress is known and `STARTING`. Its legs are `connecting` |
| `egress_updated` | Status and stream results are matched to legs (section 8.3). The first `ACTIVE` starts the meter (section 14) |
| `egress_ended` | ◇ The meter's last row. A segments result becomes a recording (section 13.2). Every stream `FAILED`: legs `failed`, `restarts` unchanged. Other self-ended streaming egresses increment `restarts` and their legs leave. `destinationsSet` is false whenever any side needs repair, even with another side running, terminal or held by the restart cap (section 15). Pending End and explicit `legs/end` suppress resends. Web-stopped egresses never count |
| The four of today | As today. Participant events refresh `room.participants`; the roles `feed` and `egress` write no minutes row. `room_finished` during a hold ends the show `hold-limit` |

## 8. Stream keys

### 8.1 The guard

Run on every URL before it is sent anywhere. The first row that matches refuses it. LiveKit's own behaviour is from P0, S0.4.

| # | The URL | Code |
| --- | --- | --- |
| 1 | ◇ Over 4,096 bytes, outside printable ASCII, has a space, control character or `#`, or does not match the URL shape | `destination-malformed` |
| 1a | ◇ A broken percent escape anywhere (authority, path or query), or a literal `/` in the query | `destination-malformed` |
| 2 | ◇ Scheme is not exactly lowercase `rtmp` or `rtmps`; capitals and `srt` are refused | `destination-scheme` |
| 3 | Has user info (`@` in the authority; LiveKit shows the password) | `destination-userinfo` |
| 4 | ◇ Authority is not a DNS-style host or bracketed IP, optionally followed by a 1 to 5 digit port | `destination-malformed` |
| 5 | Fewer than an app and a key segment, or an empty segment before the final trailing slash | `destination-no-app` |
| 5a | ◇ More than two named path segments: LiveKit would show a possible secret in the middle whole | `destination-malformed` |
| 6 | The path ends with `/` (LiveKit shows the whole key) | `destination-trailing-slash` |
| 7 | ◇ The last path segment is under 12 characters, or, with a query, its last parameter value is under 12 | `destination-key-too-short` |
| 7a | ◇ LiveKit's redaction pattern would cut it differently from the web | `destination-malformed` |
| 8 | A known id with a different leg ref, without `replace` | `destination-changed` |
| — | Anything else | Accepted |

- **The key piece** LiveKit redacts is the last path segment plus `?` and the query when present. The floor is not measured on this combined string: each possible secret end must pass separately ◇.
- ◇ Without a query, LiveKit shows at most six of a 12-character key. With a query it shows the first three of the path's last segment and the last three of the query's last value: both must have at least 12 characters. A query item without `=` uses the whole last item as its value. The guard checks encoded characters as written, without decoding; malformed percent escapes in the query itself are not checked (W `media/destination-guard.ts:132-142`, `:186-200`).
- ◇ The accepted platform shapes include YouTube, Twitch, Kick, X, Facebook and custom `rtmp://host/app/key`. A Twitch `?bandwidthtest=true` suffix is refused because its final value is too short. A platform name alone does not exempt a URL from the guard.

### 8.2 The leg ref

The web's redaction of an accepted URL is `<scheme>://<host>[:<port>]/<path without the last segment>/{abc...xyz}`: the key piece becomes `{`, its first three characters, `...`, its last three, `}`. A test pins it against the P0 table.

| Ref | The exact string that is hashed |
| ------------- | ------------------------------------------- |
| `ref` | `"vlr1\n" + showId + "\n" + redactedUrl` |
| `tail` ◇ | `"vlr1t\n" + showId + "\n" + "{abc...xyz}"` |
| `identityRef` | `"vlr1i\n" + showId + "\n" + fullUrl`       |

Hash: HMAC-SHA256 over the UTF-8 bytes. Key: `VIDEORC_CLOUD_LEG_REF_KEY` (32 bytes). Encoding: base64url, no padding (43 characters). All three hashes are stored per leg; no URL or substring is stored. `tail` exists because LiveKit may rewrite a Twitch host (P0, S0.4), so the URL it reports is not the one sent.

◇ Distinct destination IDs with the same redacted ref within an orientation are refused as `destination-ambiguous` before LiveKit side effects. The full-URL identity HMAC detects a key rotation even when redacted refs collide; it forces replacement. Legacy rows without identity refs are replaced conservatively. Ambiguous legacy matches fail visibly rather than assigning one result to the wrong leg.

### 8.3 Matching LiveKit's results to legs

For each entry in `streamResults` or `result.value.info`:

1. Hash the entry's `url` (already redacted by LiveKit) into `ref`. A leg of that egress with that `ref` is the match.
2. No match: hash its last `{…}` into `tail`. If exactly one unmatched leg has that `tail`, it is the match.
3. Still none: the entry is ignored and counted in a log line by code.
4. ◇ **Newest wins.** A leg stores `addedAt`, when its URL was last sent. Ignore stream entries whose start or end predates `addedAt` by more than 1 s (clock-skew tolerance). Of those left, an entry without a start time is newer than any started entry, then the greatest `startedAt` wins, then the last in the list. A newer `ACTIVE` entry without a retry can revive a failed leg (W `media/legs.ts:90-144`).

| LiveKit says | `legs[].state` |
| --- | --- |
| The URL was sent, no entry yet, or the egress is `STARTING` | `connecting` |
| `ACTIVE`, `retries` not above the stored count | `live` |
| `ACTIVE`, `retries` above the stored count | `reconnecting` |
| `FAILED` while the egress is `ACTIVE` | `failed` |
| `FAILED` or `FINISHED` on an egress that is `ENDING`, `COMPLETE`, `ABORTED` or `LIMIT_REACHED` | `ended` for an ordinary teardown. ◇ A self-ended egress whose every stream is `FAILED` keeps failed destination legs instead (section 15) |
| `FINISHED` on an active egress | The leg leaves the list |
| Refused by the guard | `failed` |

`since` is when the leg entered its state. The states are the five the desktop maps (D `cloud_show.rs:1172-1179`).

### 8.4 A show's only destination (D9)

LiveKit reports nothing when the last stream dies: it stays `ACTIVE` with `retries: 1`, and `retries` never clears (P0, S0.3). The web cannot reconnect it alone, because it holds no URL (section 18, item 2).

1. On `egress_updated` or a reconcile read, for an egress with exactly one stream that is not `FINISHED` or `FAILED`: if its `retries` is above the stored count, store the new count and go on.
2. If that leg was kicked under 5 minutes ago, or the show has had 3 kicks: set the leg `failed`. Stop. This is the guard against loops.
3. Else set the leg `reconnecting` and `resend: true`, and record the kick.
4. The desktop sees `resend: true` on a leg it holds a URL for, and sends `PUT …/destinations` with that one destination and no `replace` (the Reconnect call, D `cloud_show.rs:3577-3610`). At most once per leg per 30 s.
5. The web removes and adds the URL (section 2.2) and clears `resend`.
6. A desktop with no URL (resumed after a relaunch, D `cloud_show.rs:3589-3595`) cannot. After 30 s with `resend` still true the web sets the leg `failed` with the Stop-and-go-live message.

### 8.5 The rule, as a test

**No destination URL, and no part of a stream key, is ever written to the database, a log line, an error report or an HTTP body.**

- A URL lives in the request handler's memory, goes to `StartEgress` or `UpdateStream` in that request, and is dropped.
- The web never logs or returns LiveKit's error text for an egress call: LiveKit repeats the URL in a refusal (P0, S0.4). Errors are logged by code and status only.
- `legs[].error` is one of a closed list, chosen by the web ◇: `Videorc Cloud can't carry this stream address.` (the guard), `Could not connect to the platform.` (`FAILED`), `The platform stopped answering.` (8.4 step 2), `Stop, then go live again to reconnect.` (8.4 step 6).
- The test (W2's "done when"): drive create, destinations, a refusal, a LiveKit error that echoes the URL, a webhook and an end with a marked key. Then search every store row, every captured log line and every response body for the key, for any 8 characters of it, and for the URL. Zero matches. The desktop's managed smoke runs the same scan (C6).

## 9. Database

`0034` (the seam lane) adds `cloud_shows.media` (`node` or `livekit`, default `node`) and makes `cloud_shows.node_id` and `cloud_show_usage.node_id` nullable. A managed show stores `node_id` as NULL and answers `nodeId: "livekit"`.

`0035_add_cloud_managed_media.sql`, in the style of `0033`:

```sql
-- Managed media (plan 234): what the web must remember about a show on
-- LiveKit to build its state. Secret-free: no URL, no key, no token.
CREATE TABLE IF NOT EXISTS cloud_show_media (
  show_id text PRIMARY KEY REFERENCES cloud_shows (id) ON DELETE CASCADE,
  rev bigint NOT NULL DEFAULT 1,
  state_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  h_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  v_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  legs_json jsonb NOT NULL DEFAULT '[]'::jsonb,
  on_air_at timestamptz,
  hold_since_at timestamptz,
  desktop_seen_at timestamptz,
  restarts integer NOT NULL DEFAULT 0,
  kicks integer NOT NULL DEFAULT 0,
  page_joins integer NOT NULL DEFAULT 0,
  usage_seq integer NOT NULL DEFAULT 0,
  usage_cut_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS cloud_show_media_updated_at_idx ON cloud_show_media (updated_at);

-- A solo show's custom hold image. Deleted when the show ends.
CREATE TABLE IF NOT EXISTS cloud_show_assets (
  show_id text NOT NULL REFERENCES cloud_shows (id) ON DELETE CASCADE,
  kind text NOT NULL,
  version text NOT NULL,
  content_type text NOT NULL,
  bytes bytea NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (show_id, kind),
  CONSTRAINT cloud_show_assets_kind_check CHECK (kind IN ('hold-image')),
  CONSTRAINT cloud_show_assets_size_check CHECK (octet_length(bytes) <= 2097152)
);
```

| Column | Holds |
| --- | --- |
| `rev` | Section 3. Bumped in the same statement as the change |
| `state_json` | ◇ `built` (the last material state), `createPending`, `holdImage`, `lease`, `legsEnded`, `roomMissingAt`, `reconciledAt`, `usage.holds`, `usage.pending`; talk: `stage`, `stageSet`, `participants`, `recordingTarget`, `takeKeys` |
| `h_json`, `v_json` | ◇ Per orientation: ingress id, feed status and timing; streaming and recording egress ids, statuses, starts and ends; `egressStopping`, `startInFlight`, `pastEgresses`, `destinationsHeld`, `egressDeaths`, `restartsHeldUntil`; take ids and revocation ids; `page` with boot, seq, joined, remembered boots, beacon and arrival time; `recBoots` |
| `legs_json` | Per leg: `id`, `platform`, `label`, `orientation`, `state`, `since`, `error`, `ref`, `tail`, `retries`, `kickedAt`, `resend`, and ◇ `addedAt` |
| `on_air_at`, `hold_since_at`, `desktop_seen_at` | The anchors of `liveSeconds`, `hold` and `desktopConnected` |
| `usage_seq`, `usage_cut_at` | Section 14 |

- ◇ One row per show, with a column per orientation, not a row per orientation. `rev` and the state are per show, and one row makes the bump one statement.
- ◇ Neon HTTP cannot keep a transaction open across application code. A mutation reads the row and its Postgres `xmin`, computes the change, then uses one fixed database batch to lock and update only that version. A lost compare-and-set race re-reads and recomputes. `rev` moves with the update, so webhooks cannot overwrite each other.
- ◇ Operations that call LiveKit between writes take an expiring lease in `state_json.lease: { owner, until }`. Acquisition and release each use one statement. The lease lasts 65 s, outliving a 60 s route; a second request checks every 500 ms for at most 5 s, then answers 503. No database transaction stays open while LiveKit runs (W `media/media-store.ts:18-31`, `media/lease.ts:20-25`).
- `cloud_show_media` joins the readiness list (W `readiness.ts:10-15`) for managed routes only.

## 10. Configuration

Names only. A missing key is logged by name; a value is never logged.

| Variable | Values | Unset means |
| --- | --- | --- |
| `VIDEORC_CLOUD_MEDIA` | `node`, `livekit` | `node`. Read at create; each show keeps its own |
| `VIDEORC_CLOUD_MAX_SHOWS` | A whole number, 0 or more | 1 ◇ (section 11) |
| `VIDEORC_CLOUD_LEG_REF_KEY` | 32 bytes, base64 or base64url | Managed creates answer 503 `cloud-disabled` |
| `VIDEORC_CLOUD_PROGRAM_TOKEN_KEY` | 32 bytes, base64 or base64url | The same |
| `VIDEORC_CLOUD_PROGRAM_BASE_URL` | `https://host`, no path or query | `https://www.videorc.com` |
| `VIDEORC_CLOUD_RECONCILE_UNKNOWN` | `1` | Objects of shows this database does not know are left alone outside production (section 15) |
| `LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET`, `LIVEKIT_WEBHOOK_KEY`, `LIVEKIT_WEBHOOK_SECRET` | As today (W `livekit.ts:22-28`) | Managed creates answer 503 `cloud-disabled`; talk shows `cloud-rooms-unavailable`, as today |
| `VIDEORC_CLOUD_RECORDINGS_*` | As today (W `recordings.ts:43-54`) | No recording target |
| `VIDEORC_CLOUD_DISABLED`, `VIDEORC_CLOUD_USERS`, `VIDEORC_CLOUD_PUBLIC`, `VIDEORC_CLOUD_TALK_SHOWS_DISABLED` | As today (W `switches.ts`) | As today |
| `VIDEORC_CLOUD_SHOW_SIGNING_KEY`, `VIDEORC_CLOUD_NODES`, `VIDEORC_CLOUD_NODE_SECRETS` | Node path only | Not needed for a managed show |

Desktop, unchanged: `VIDEORC_APP_VERSION` (D `performance_check.rs:405`), and in dev builds only `VIDEORC_API_BASE_URL` and `VIDEORC_CLOUD_FEED_CA_FILE`.

## 11. Limits and timers

| What | Value | Enforced by |
| --- | --- | --- |
| Hold limit | `holdMaxSeconds`: 300, 900, 1,800 or 3,600 (D `cloud_show.rs:78`) | The room's `departure_timeout`, which starts when the feed's participant has left (D5) |
| A silent feed that stays in the room | Up to about 100 s past the limit (P0, S0.2) | The reaper ends a hold past `holdMaxSeconds` as `hold-limit` |
| Room nobody joined | `empty_timeout` 120 s (talk: 600 s) | LiveKit |
| No feed after a solo or test create ◇ | 60 s, then `no-feed`; talk shows are exempt | The reaper |
| Show length | 11 h 55 min from the create, then `max-show` | The reaper, before LiveKit's 12-hour stop |
| Destinations | 16 per request and per show | `PUT …/destinations` |
| Quality (D12) ◇ | Solo and test: 1920×1080 pixels and 30 fps per output. Talk is exempt. Above: `cloud-quality` | The create |
| Stream sent to platforms | 1080p60, H.264 High, 6 Mbps, 2 s keyframes, AAC 48 kHz | `StartEgress` |
| Hold image | 2 MiB, PNG, 1,920 pixels a side | `PUT …/hold-image` |
| Overlay | 2 MiB | The page |
| Stage | 8 identities; room metadata 4,096 bytes | `PUT …/stage` |
| Beacon ◇ | 4 KiB, cut `shown` then `program`; one a second; every 10 s, except recording-only pages | The page and the route |
| State long-poll | 25 s; 2 s and 5 s per section 3 | The state route |
| `desktopConnected` | A poll in the last 15 s | The web |
| Lost report | Feed down 20 s (D `cloud_show.rs:97`), then at most one a minute (D `cloud_show.rs:100`) | The desktop |
| Return to picture | 7 s after a re-push (the bar set at G0). The page's own share is 1.3 s | Measured, not enforced |
| Test show | 30 s after its first frame; the row expires at 120 s | The web |
| Creates per hour | 12 shows, 6 tests (W `shows.ts:116-124`) | As today |
| Capacity (D13) | `VIDEORC_CLOUD_MAX_SHOWS` open managed shows, test shows included. Over it: 503 `cloud-full` | The create |
| Kicks (section 8.4) | One per leg per 5 minutes, three per show | The web |
| LiveKit call | 8 s | The web |
| Control request ◇ | 45 s for LiveKit calls; `maxDuration` 60 s | The web |
| Create ◇ | 40 s for LiveKit calls, 52 s for failure cleanup; `maxDuration` 60 s | The web |
| State answer ◇ | 30 s normal polling budget; each LiveKit read at most 2 s; `maxDuration` 40 s | The state route (section 3) |
| Desktop intent ◇ | 22 s ordinary; 7 s destinations without `replace`; retries share it | Inside the 25 s provider / 10 s Reconnect RPC watchdog |
| Show lease ◇ | 65 s TTL; wait at most 5 s, poll every 500 ms | The web |
| Self-ended streaming egresses ◇ | Three in 10 min per orientation, then 10 min refusal | The web |
| Room join / rejoin ◇ | Retry 1, 2, 4, 8, then 10 s; rejoin window 60 s | The page |
| Overlay read ◇ | Set 30 s; clear 5 s, independent of sets | The page |
| Unused take key ◇ | Revoke at once under lease, otherwise after 65 s; all keys 5 min after show end | Webhook and reaper |

◇ The capacity default is 1: the project holds two ingress objects, which is one solo show with both orientations (P0). The owner raises it with the plan.

## 12. Desktops before web control (D17)

| What | Value |
| --- | --- |
| The constant (web) | `FIRST_WEB_CONTROL_DESKTOP_VERSION = "0.26.0"` |
| Why that value | The checked app is at 0.25.2 (D `apps/desktop/package.json:3`). The next minor is the first build with web control |
| Version on the capabilities path ◇ | `User-Agent: Videorc-Desktop/<version>` (D `videorc_api.rs:1806`, `performance_check.rs:476-478`). `GET /api/ai/capabilities` has no body, and nothing else carries it |
| Version on a create | `client.version` in the body (D `cloud_show.rs:564-583`, W `shows.ts:428-434`) |

The rule, while `VIDEORC_CLOUD_MEDIA` is `livekit`:

1. The `cloud` block's `enabled` is `false` in `GET /api/ai/capabilities` and `GET /api/cloud/allowance` when the User-Agent is not `Videorc-Desktop/<major>.<minor>.<patch>` or its version is below the constant. Every other field of the block is unchanged.
2. ◇ Every create, talk and test included, whose `client.version` is missing or below the constant answers 403 `cloud-not-entitled`.
3. Compare the three numbers. A suffix after the patch is ignored.

What an older client is told: nothing but `enabled: false`. It then streams directly and says nothing, as an unentitled account does (D `cloud_show.rs:1873-1876`). A dev backend with no `VIDEORC_APP_VERSION` reports the crate's 0.9.0 (D `performance_check.rs:480-486`) and reads as old, so managed smokes set the variable.

## 13. Test shows and recording

### 13.1 Test shows (D16)

1. The desktop creates `kind: "test"`. The web makes the room and one ingress per output, and no egress. It counts against the capacity cap.
2. The desktop polls `…/state` (2 s wait) and pushes its 10 s pattern to each ingress (D `cloud_show.rs:3776`, `:4273-4297`).
3. `ingress_started` sets the feed `connected` and the phase `live`. The desktop takes its time-to-live from the first `live` state (D `cloud_show.rs:4312`).
4. Each answer carries `feeds[].kbps` when LiveKit reports one. The desktop keeps the readings above 0 (D `cloud_show.rs:4300-4310`).
5. The desktop calls `POST …/end`. The web deletes the ingresses and the room. There is no `show.end` to send.
6. A desktop that died: the web ends the show `max-show` 30 s after its first frame, at the next poll or reaper tick, and at 120 s regardless.

The verdict rules stay (D `cloud_show.rs:3955-4039`). A test show costs no cloud seconds and is never offered for resume.

### 13.2 Recording (D10)

Talk shows only. A **take** is one egress's segment list for one orientation ◇. Its files live in the show's bucket on its own Neon branch, under today's prefix (W `recordings.ts:140-141`):

```
talk/<userId>/<showId>/<o>/<takeId>/index.m3u8        the playlist
talk/<userId>/<showId>/<o>/<takeId>/seg_<number>.ts   2 s segments
talk/<userId>/<showId>/<o>/<takeId>/EG_<egressId>.json  LiveKit's manifest
```

`<o>` is `h` or `v`. `<takeId>` is `tk_` plus 12 base62 characters, made by the web before `StartEgress`. `takePrefix` in section 7 is the folder with its trailing slash.

| Step | The web |
| --- | --- |
| `{ "on": true }` ◇ | One separate segments-only egress per output on a `rec=1` page, whether live or not. `recording.active` becomes true |
| `{ "on": false }` ◇ | `StopEgress` for the recording egress; live streams carry on |
| Disabled shared path, `{ "on": false }`, on air ◇ | 409 `cloud-recording-on-air`. No app caller enables this path (section 6.5) |
| `egress_ended` with a segments result | One `cloud_recordings` row: `object_key` is the playlist's key, `seconds` and `bytes` from the result, `state` `complete` when it has at least one segment, else `failed` |

`state.recording` (D `cloud_talk.rs:289-304`): `active` while an egress with a segments output is `STARTING` or `ACTIVE`; `since` when the oldest such egress started; `seconds` is now minus `since`; `bytes` is 0 while it runs ⚠ (LiveKit reports the size at the end); `orientations` lists the outputs recording now as `horizontal` and `vertical`; `problem` is `no-target` when the show has no recording target.

◇ At each recording start, each orientation's take gets a fresh `storage:write` key pair for the show's branch. It expires 15 minutes after the show's limit. `state_json.takeKeys` remembers its revocation id, branch and mint time before `StartEgress`; its secret exists only in that request.

◇ An ended or unused take's key is revoked when nothing on the row writes with it: immediately under the show lease, otherwise once it is 65 s old. Every remaining key is due 5 minutes after the show's end, including keys still marked in use. Failed revocations stay for retry; successful ones leave `takeKeys` and the orientation's key-id fields. Each reaper tick retries the revocations of every ended show whose row still holds key ids (up to 50 shows a tick) until the key's own expiry, 15 minutes after the show's limit; past it the id is dropped without asking Neon (W `media/recording.ts`, `media/reconcile.ts`).

The playlist the desktop fetches:

- **new** `GET /api/cloud/recordings/:id/playlist`, bearer auth. 200 `application/vnd.apple.mpegurl`: the take's `index.m3u8` with every segment line replaced by a presigned GET URL that lives 6 hours ◇. 404 `cloud-recording-not-found`, also for a node recording. Storage/configuration or playlist failures give 503 `cloud-recordings-unavailable` ◇. A failure minting a take key on the Record route instead gives 503 `cloud-media-unavailable`.
- ◇ The backend fetches the segments itself over HTTPS, verifying certificates and hostnames, without forwarding the account bearer to storage. Four segments download at once, each with up to three attempts. The dev-only extra feed CA may add trust; verification stays on. Redirects to HTTP are refused (D `videorc_api.rs:1820-1840`, `:3967-4002`).
- ◇ Presigned URLs stay in memory. The backend writes a private temporary directory of local segments and a playlist naming only local files. It rejects nested playlists, keys, maps and unsupported URI-bearing tags. FFmpeg remuxes with `-c copy` and `-protocol_whitelist file`; it opens no network address. Completion, cancellation or failure cleans up the temporary files and owned partial MP4. A completed MP4 gets an unoccupied name in the output folder.

| Route | For a managed recording |
| --- | --- |
| `GET /api/cloud/recordings` | The same item plus **new** `format: "segments"` and an absolute `playlistUrl` ◇. `downloadUrl` is `""`, so the field stays a string. A node recording gains `format: "mp4"` |
| `GET /api/cloud/recordings/:id/download` | 409 `cloud-recording-needs-desktop` ◇. The account page points to the desktop |
| `POST /api/cloud/recordings` (node-signed) | Node shows only |

◇ Downloads are desktop jobs, not long RPC calls (D `cloud_control_web.rs:588-644`; `apps/desktop/src/shared/backend-rpc-contract.ts:6390-6416`):

| Desktop RPC or event | Shape |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `cloud.recordings.download` RPC ◇ | `{ id, outputDirectory?, outputDirectoryCapability?, ffmpegPath? }` → `{ jobId }` immediately. The directory capability is resolved before the backend call |
| `cloud.recordings.downloads` RPC        | No params → an array of download events: running jobs and up to 32 latest terminal results. Read on attach, reconnect and event lag; newer events win over an in-flight snapshot                                   |
| `cloud.recordings.cancelDownload` RPC ◇ | `{ jobId }` → `{ ok: true }` |
| `cloud.recordings.download` event ◇ | `{ jobId, recordingId, state, doneSegments?, totalSegments?, path?, error? }`. `state` is `running`, `done`, `failed` or `cancelled`. Progress counts segments; `path` is the finished MP4, errors contain no URLs |

◇ A repeated download while that recording's job runs returns the same job. Cancellation kills and reaps an owned FFmpeg child, cleans partial files and emits a terminal event; shutdown cancels and joins the jobs. The renderer's recording list contains facts and format, never presigned URLs.

◇ At recording expiry, maintenance deletes the playlist, then its row. A failed delete keeps the row for retry. Segments and manifests go with the show's storage branch when it expires; deleting a recording row alone does not remove each segment.

## 14. The meter (D11)

**A cloud second** of a managed show is a wall-clock second in which at least one of its egresses is `ACTIVE`, by LiveKit's own `startedAt` and `endedAt`. Two egresses at once count once. Holds count. ◇ An egress in `STARTING`, or one that never reached `ACTIVE`, counts nothing. LiveKit's ended record supplies its own start and end even when the web missed the active event. No time after the show's `endedAt` counts. A talk show with its room open and no egress counts nothing; a test show counts nothing. An egress whose only destination died still counts (D9).

Rows go to `cloud_show_usage`, counted once on `(show_id, seq)` as today (W `meter.ts:446-448`):

| Written by | Row |
| --- | --- |
| The reaper, every minute, for each open managed show with active time | ◇ One row per unbroken active span since `usage_cut_at`, with consecutive `seq` values. `hold_seconds` is the part spent in `hold`; `live_seconds` is the rest. `node_id` is NULL |
| `egress_ended`, when no other egress of the show is active | The same, up to that egress's `endedAt` |

◇ Usage is claim-then-insert. One compare-and-set mutation moves `usage_seq` and `usage_cut_at` and parks the claimed rows in `state_json.usage.pending`. Inserts then deduplicate on `(show_id, seq)`; successful rows leave the pending list. A later tick finishes interrupted inserts with the same sequence numbers. There is no open application transaction joining claim and insert.

◇ Every instant is floored to a whole second. Overlapping streaming and recording spans merge, so simultaneous egresses count once. The daily reconcile looks at non-test managed shows ended in the last 3 days. It first flushes pending usage, then compares with LiveKit's own ended records, capped at the show's `endedAt`. Missing intervals become pending rows at their original timestamps under the show lease; inconsistent intervals are skipped; excess seconds come off the newest rows. If LiveKit omits a known egress or usage is still pending, the show is skipped. The normal month reconcile follows (W `media/usage.ts`).

## 15. Failures

| Failure | `state` the desktop sees | Its next call |
| --------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| The computer or its network drops | `phase: "hold"`, the feed `connected: false` | Resume: `GET current`, then feed the same ingress. No destinations are sent (D `cloud_show.rs:3484-3495`) |
| One of several destinations dies | That leg `reconnecting`, then `failed` after about 31 s | The watchdog's Reconnect: `PUT …/destinations` with that one id |
| The only destination dies | That leg `reconnecting` with `resend: true` | `PUT …/destinations` with that one id, by itself (section 8.4) |
| A destination is refused by the guard | That leg `failed` with the fixed message | None |
| The streaming egress ends with every stream `FAILED` ◇ | Those legs `failed`, `restarts` unchanged; `destinationsSet: true` only if no other side needs repair | Explicit Reconnect; no automatic full-list resend |
| The streaming egress dies otherwise ◇                           | Its legs leave; `restarts` plus one. `destinationsSet: false` for any repairable dead side, even with another side running or held | `PUT …/destinations` with the full list, no `replace`                                                     |
| The third such death in 10 min on an orientation ◇              | Legs `failed`: `Stop, then go live again to reconnect.`; `destinationsSet: true` only if no other side needs repair                                                   | Requests naming only held sides give 503 `cloud-media-unavailable` for 10 min from that death             |
| The egress dies, the desktop is gone | — | The web ends the show `egress-lost` after 60 s |
| The room closes at the hold limit | `phase: "ended"`, `endReason: "hold-limit"` | None. Go Live starts a new show |
| The feed cannot connect for 20 s, or LiveKit as a whole is down | Any | `POST …/lost` |
| videorc.com is unreachable | No answers. `connected: false`, the last state stays | Back off and poll. Never direct. No destination change until it returns |
| A webhook is lost | Stale for up to a minute | None. The reconcile pass repairs it |
| The state route answers 404 | — | `GET current` (section 3) |

**The lost route**, for a managed show. The desktop posts it when its own feed leg has been down 20 s, whatever the last poll said, with `controlLost` set to whether that poll failed. Its claims are only logged, as today (W `shows-route.ts:748-750`). Direct legs open only after the answer says the show ended (D `cloud_show.rs:2690-2701`).

| LiveKit answers | The web |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| The room exists | Keeps the show. The hold covers it |
| No room, and no active egress | Ends it `media-lost`. The answer is the ended show |
| Only network failures or timeouts, twice, 4 s each ◇                   | Keeps the show: unknown is not permission to open direct legs                                                 |
| Any HTTP error, including 429 or 500, or no usable web configuration ◇ | Keeps the show: an HTTP answer proves LiveKit is there; a configuration failure proves nothing about the room |

**The reconcile pass** (the reaper's tick) reads `ListRooms`, `ListIngress` and `ListEgress` and, by the names of section 7, cleans ended shows' objects and rebuilds open shows' legs, feeds and meter. ◇ A missing room ends a show only when a second list by its name is also empty, no egress runs, and two ticks in a row find that result. `roomMissingAt` remembers the first finding and clears when the room is seen. A failed list is unknown, never gone. Omission of a known egress never makes it terminal; only explicit provider evidence does. Retired recording IDs are also inspected for missed completion webhooks while a room stays open.

◇ The managed tick budgets LiveKit calls to 40 s, with at most 15 s per show. It visits the oldest `reconciledAt` first, so a skipped show gets priority next tick. For 10 minutes after a talk show ends, it also reads its egresses and files takes whose ended webhook was lost.

◇ Every tick retries deleting all ended shows' hold images and scrubs `state_json.participants` and `state_json.built.room`. Names and images left by interrupted End cleanup are removed this way. It also revokes due take keys (section 13.2).

Objects named by a show id this database has **no row for** may be another environment's live show. They are touched only when `VERCEL_ENV` is `production` or `VIDEORC_CLOUD_RECONCILE_UNKNOWN` is `1`, and only once the show's objects are 10 minutes old. ◇ An unknown ingress is removed only if `ListRooms` succeeded in the same tick: the ingress carries no age of its own. Otherwise it is left alone and counted. One LiveKit project per database is still the rule; this guard only lowers the cost of breaking it.

## 16. File ownership

A lane edits only its own rows. A file not listed belongs to no lane: ask the orchestrator.

| Repo | Lane | Owns |
| --- | --- | --- |
| Web | Web server | `lib/cloud/**` except `lib/cloud/program/**`. `app/api/cloud/**`, including `app/api/cloud/program/**`, the new `…/shows/[id]/{destinations,legs,state,hold-image,stage,recording}` routes and `…/recordings/[id]/playlist`. `db/migrations/0035_add_cloud_managed_media.sql`, `db/schema.ts`. `tests/cloud-*.test.ts` except `tests/cloud-program-*.test.ts`. `tests/fixtures/cloud-*`. `docs/cloud.md`, `.env.example`, `vercel.json`, `next.config.ts`, `package.json` |
| Web | Web program page | `app/cloud/program/v1/**`. `lib/cloud/program/**` (the page's client modules). `public/cloud/program/v1/**`. `tests/cloud-program-*.test.ts` and `tests/browser/cloud-program/**` |
| Desktop | Desktop | `crates/videorc-backend/src/cloud_show.rs`, `cloud_talk.rs`, `cloud_control_web.rs`, the cloud section of `videorc_api.rs`, the cloud seam in `recording.rs`. `apps/desktop/src/renderer/src/lib/talk-show-room*.ts`. `scripts/smoke-cloud-solo-managed-app.mjs`, `scripts/smoke-cloud-talk-show-managed-app.mjs` and their fake web under `scripts/lib/`. `protocol-fixtures/cloud-managed-wire.json`. `package.json` scripts |
| Desktop | Orchestrator | `docs/cloud/managed-media-wire.md` (this file), `plans/234-*.md`, `protocol-fixtures/talk-show-layout.json` |

- The page lane sets its headers (content security policy, `noindex`) inside its own folder and does not edit `next.config.ts`. It adds no dependency: `livekit-client` 2.23.0 is already in `package.json`.
- The provider seam is `lib/cloud/media/{index,types,node}.ts` and migration `0034`. The managed server implementation is `lib/cloud/media/livekit.ts` and its supporting modules.

Shared constants. Each has one source. The server imports the page's wire module directly ◇. Cross-repo values are copied and pinned by tests. Copies must agree with this contract.

| Constant | Its one file | Used by, with a pinning test |
| --- | --- | --- |
| Beacon JSON, hold timings, overlay topics and attributes, query names, console lines | Web `lib/cloud/program/wire.ts` (page lane) | ◇ The server imports it directly. `lib/cloud/media/program-wire.ts` is gone. `tests/cloud-program-wire-pin.test.ts` prevents a copy, and `tests/cloud-program-meets-server.test.ts` exercises both halves together |
| Route paths, error codes, `rev` rules, wait times, leg states, end reasons, the closed leg messages, overlay topics | Desktop `protocol-fixtures/cloud-managed-wire.json` (desktop lane) | Web `tests/fixtures/cloud-managed-wire.json` (server lane), with a test that the web's constants match it |
| The layout geometry | Desktop `protocol-fixtures/talk-show-layout.json` | Web `public/cloud/program/v1/talk-show-layout.json` (page lane). A test pins its SHA-256: `94a0e80ea8cd65d67dd7d3daf6f18b35dacb76f419eae0567a815d1b1ccb461a` |
| `FIRST_WEB_CONTROL_DESKTOP_VERSION` | Web `lib/cloud/media/client-version.ts` (server lane) | Not copied. The desktop only has to ship as 0.26.0 or later |

## 17. ◇ Decisions made here

| # | Decision | Why | Settles |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------- | ----------------------------------- |
| 1 | `control` carries `url: ""` and `token: ""` | Today's `ShowControl` needs both; an old build then goes direct, never stuck | Wire shape |
| 2 | State is `{ rev, state }` | `RunnerState` parses unchanged | D8 |
| 3 | The wait's timeout answers 200 with the same `rev` | The desktop's reader needs a body; the guests list does the same | D8 |
| 4 | The wait is 2 s in a hold or trouble, 5 s with guests, 25 s calm | Keeps the runner's 2 s cadence where clocks and counters matter | D8 |
| 5 | An ended show answers `phase: "ended"` at once | Reuses the desktop's ended path | D8 |
| 6 | The primary page (`h`, else `v`) decides phase, hold and program | One show has one phase | D8 |
| 7 | A talk show is `live` once the host joined and never holds | No feed exists to lose; the away plate covers the host | D6, D8 |
| 8 | `restarts` counts egresses that died, not egresses started | A Record press must not read as a restart | D8 |
| 9 | ◇ Beacons carry `boot`, `seq` and optional `joined`; a new ordinary boot replaces the page, and its first `joined: true` counts once | Orders beacons; overlays replay only after handlers are ready | Wire shape |
| 10 | Beacon times are relative to the page's own clock | The recorder's clock offset cannot skew `hold.since` | D8 |
| 11 | The page token is HMAC-SHA256 | One party mints and checks it | D20 |
| 12 | Hold image is `{ pngBase64 }`, served to the page by version | Mirrors today's intent; the beacon answer tells the page when it changed | Wire shape |
| 13 | Refused destinations do not fail the others | One bad custom URL should not take a show off every platform | D7 |
| 14 | ◇ The last path segment and, when present, last query value each need 12 characters | Either end may be the secret LiveKit partly shows | D7 |
| 15 | Two leg refs, `ref` and `tail` | LiveKit may rewrite a Twitch host | D7, D8 |
| 16 | `legs[].error` is from a closed list | LiveKit's text can carry a URL | D7 |
| 17 | The only-destination fix asks the desktop to re-send (`resend`) | The web holds no URL to add back | D9 |
| 18 | `replace` restarts the egress when it must drop a leg | The web holds no URL to remove with | D8 |
| 19 | `legs/end` takes an optional URL list | The same reason, when a recording shares the egress | Wire shape |
| 20 | ◇ Stop recording on air is refused only on the disabled shared-egress path | Current app recordings have a separate egress and can stop on air | D10 |
| 21 | A take is one egress's segment list, under `<o>/<takeId>/` | The id must exist before the egress does | D10 |
| 22 | Playlist URLs live 6 hours | A long download must start every segment in time | D10 |
| 23 | Managed recordings answer `downloadUrl: ""` and `format` | Keeps the item's type | D10 |
| 24 | Overlays: two topics, 2 MiB, PNG, JPEG or WebP | A clear needs a body; photos are large as PNG | D6 |
| 25 | ◇ `room.pageJoins` grows at a boot's first `joined: true` and tells the desktop to re-send untimed overlays | Byte streams are not replayed; load can precede ready handlers | D6 |
| 26 | `cloud.return.set` answers `cloud-return-failed` | The existing code for that RPC | D6 |
| 27 | Above 1080p30 the create answers 422 `cloud-quality` | The desktop cannot know the provider before it creates | D12 |
| 28 | The ingress layer is the output's own size | No upscale before the page | D4 |
| 29 | The egress is always 1080p60 at 6 Mbps, talk shows too | D4 fixes one encoding | D4 |
| 30 | Talk rooms get the hold limit as `departure_timeout`, and 4 more seats | No runner holds the room open; recorders may count | D6 |
| 31 | `cloud_show_media` is one row per show | `rev` and the state are per show | Database |
| 32 | Capacity defaults to 1 | The project holds one show today | D13 |
| 33 | The version on the capabilities path is the User-Agent | Nothing else carries it there | D17, W8 |
| 34 | Lost: two silences leave the show open | Silence is unknown; only confirmed absent media permits direct fallback | D9 |
| 35 | `egress-lost` after 60 s with no desktop | Nobody holds the keys | D9 |
| 36 | Managed `expiresAt` is the create plus 11 h 55 min | The hold no longer adds | D12 |
| 37 | ◇ Desktop intents spend one 22 s deadline, or 7 s without destination `replace`; one useful retry at most | Fits the 25 s / 10 s RPC watchdogs, including retry and ordering wait | Section 2 |
| 38 | ◇ Web control LiveKit calls share 45 s inside a 60 s route; create uses 40 s / 52 s cleanup | Leaves time to write partial outcomes before the host kills the function | Sections 1, 2 |
| 39 | ◇ The whole state answer fits 30 s, with at most 2 s per LiveKit read; a poll that ends a show answers at once and leaves teardown to the reaper | Fits every answer under the desktop's 35 s | Section 3 |
| 40 | ◇ End livestream and Stop invalidate the destination generation and follow an in-flight PUT | Retained lists and retries cannot revive a stopped stream | Sections 2.2, 2.3 |
| 41 | ◇ Destination text refuses controls, lone surrogates and `://` | Stored labels and ids cannot carry addresses or break JSON storage | Section 2.2 |
| 42 | ◇ Guard requires ASCII, lowercase scheme and exactly app/key; rejects query slashes and broken escapes anywhere | Matches LiveKit's redaction shape; LiveKit refuses a broken escape and repeats the URL in its error | Section 8.1 |
| 43 | ◇ Store a domain-separated full-address HMAC for equality; reject redacted-ref ambiguity between distinct destination ids | Detect rotated keys without storing URLs or keys; provider results must identify one leg | Section 8.2 |
| 44 | ◇ Leg results respect `addedAt` with 1 s tolerance; no-start entries win, then latest start and list order | Old failed entries must not defeat a new add | Section 8.3 |
| 45 | ◇ `legs/end` clears every leg and rejects malformed bodies with 400 | Explicit End livestream must also clear failed and refused legs | Section 2.3 |
| 46 | ◇ Stage shape errors are 400; an identity of another form, or a guest not in the room, is 422; the host is always accepted | The page can draw only people in the room | Section 2.5 |
| 47 | ◇ A beacon retries network/5xx at 1, 2, 4, 8, then 10 s with a new seq; rec pages wait for joined | Failed delivery must not lose page readiness or phase | Section 5.3 |
| 48 | ◇ Beacons drop `shown`, then `program`, above 4 KiB; program fields are optional | Keeps phase and readiness deliverable when optional data grows | Section 5.3 |
| 49 | ◇ `shown` describes drawn tiles; `away` lists everyone on stage with no camera frame for 5 s, drawn or not | The stage and its visible layout can differ | Section 5.3 |
| 50 | ◇ Initial joins retry; an unexpected lost room gets 60 s; END only follows a joined room | A failed join is not the end of the recording | Section 5.6 |
| 51 | ◇ Only the talk mix uses the limiter; solo meters beside one feed | A single feed needs no voice-summing limiter | Section 5.7 |
| 52 | ◇ Talk hold overlays show immediately and clear back to the stage; decimals and positive whole TTLs | Talk has no automatic hold; attributes stay unambiguous | Section 6.3 |
| 53 | ◇ Overlay sends use `streamBytes`; reads time out at 30 s / 5 s, with independent clears | A stalled image cannot block a clear or overwrite newer work | Section 6.3 |
| 54 | ◇ `cloud.room.overlay` hands image ids to the renderer over the token-checked local byte route | Backend builds images, while only the renderer owns the room connection | Section 6.3, contradiction 1 |
| 55 | ◇ Room people sort host first, persist sanitized names, and refresh at first look and wait end | Track and name changes must move rev; ended shows retain no room names | Section 6.2 |
| 56 | ◇ Record always starts a separate segments-only egress on rec=1; sharing is off | Independent Record and Go Live must stop independently until sharing is measured | Sections 6.5, 13.2, contradiction 5 |
| 57 | ◇ Each take gets a write-only key until limit + 15 min; revocation ids are retained until revoked | Allows early revocation without storing the secret | Sections 7, 13.2 |
| 58 | ◇ Unused keys revoke under lease or after 65 s; all are due at end + 5 min; failed revocations are retried until the key's own expiry | Protects starts in flight while bounding post-show writes | Sections 13.2, 15 |
| 59 | ◇ Playlist URLs are absolute; retrieval storage failures are 503 recordings-unavailable; mint failures are media-unavailable | Distinguishes file retrieval from Record control | Section 13.2 |
| 60 | ◇ Expiry deletes playlist then row; segments leave with the storage branch | Failed deletes retry, and one take is not one MP4 object | Section 13.2 |
| 61 | ◇ Recording download returns a job id, reports progress by event and accepts cancellation | Long downloads must not sit inside an RPC watchdog | Section 13.2 |
| 62 | ◇ Backend fetches verified HTTPS segments; FFmpeg reads only local files | Presigned URLs stay in memory and FFmpeg cannot fetch remote input | Section 13.2 |
| 63 | ◇ Usage claims pending rows before deduplicated inserts | Neon HTTP cannot hold a transaction across application work | Section 14 |
| 64 | ◇ Meter floors instants to seconds, merges active spans and caps at show end; daily repair looks back 3 days | Counts active time once, even with missed events and late egress ends | Section 14 |
| 65 | ◇ Row mutations use xmin compare-and-set in a batch; media operations use a 65 s lease with 5 s wait | No application-spanning transaction; concurrent writes and calls stay ordered | Section 9 |
| 66 | ◇ JSON stores lifecycle markers, egress history, pending usage, page boots and take revocation metadata | Reconcile must recover interrupted requests without a URL or secret | Section 9 |
| 67 | ◇ Create batches both rows; pending at 60 s is abandoned; missing media ends at once on state, after 60 s on reaper | Interrupted creates must not strand capacity or an infinite state retry | Section 1 |
| 68 | ◇ End marks pending and web-stopped egresses before teardown; failure returns 503 and retains the seat until confirmed | Late webhooks must not count intentional stops as crashes; pending cleanup must not permit double streaming | Section 2.7 |
| 69 | ◇ Talk keeps existing empty timeout, rate and invite rules; quality exempts talk, old-client gate covers all kinds | No ingress or runner exists to justify solo feed rules for a room | Sections 1, 4, 12 |
| 70 | ◇ All-streams-failed ends are destination failures; other deaths cap at three per 10 min per side | Wrong keys and repeated crashes must not cause endless automatic restart | Sections 3, 15 |
| 71 | ◇ Reconcile confirms missing rooms by name across two ticks; unknown ingress cleanup needs a successful room list | One missing or failed list is not proof a live room is gone | Section 15 |
| 72 | ◇ Reaper budgets calls to 40 s / 15 s per show, visits oldest first, scrubs ended images and names | Slow shows must not starve others or retain interrupted cleanup | Section 15 |
| 73  | ◇ Lost treats network failures and timeouts as unknown; only confirmed absent media allows ending                                                | Control-plane silence cannot prove media vanished                                                   | Section 15                          |
| 74 | ◇ Server imports program/wire directly; pin and integration tests exercise both halves | A second copy can drift even when both lanes compile | Section 16 |

## 18. Contradictions

Resolved items retain their original numbers. They are no longer open choices.

| # | Contradiction | Settled by |
| --- | --- | --- |
| 1 | Overlays and “no new RPC or event” | ◇ `cloud.room.overlay` and the local image route hand backend images to the renderer, which uses room byte streams (section 6.3) |
| 2 | D7 forgets URLs, but D8/D9 need removals and reconnects | Desktop resends URLs for Reconnect and `legs/end`; replace restarts an egress when removal needs a URL it lacks. No URL is retained (decisions 17 to 19) |
| 3 | `kbps` is promised, but Phase 0 read 0 | Omit zero bitrate; desktop treats absence as unmeasured (section 3) |
| 4 | D8 counts starts, but desktop reads restarts as crashes | Count self-ended streaming egresses, except all-streams-failed ends; never Record or web stops (sections 3, 15) |
| 5 | A shared egress cannot stop recording on air | ◇ Sharing is disabled. Record uses a separate rec=1 egress, so Stop recording leaves streams running; the dormant refusal is documented (sections 6.5, 13.2) |
| 6 | Create accepts output settings, but D4 fixes platform encoding | Managed egress is always 1080p60 at 6 Mbps; solo/test ingress is limited to 1080p30, talk creates are exempt (sections 1, 7) |
| 7 | “Field for field” is impossible for quality, running bytes and avSkewMs | `participants[].quality` is `good`, running recording bytes are 0, avSkewMs is absent (sections 3, 6.2, 13.2) |
| 8 | Desktop accepts 8 MiB hold images; route accepts 2 MiB | ◇ Desktop fits managed uploads to 2 MiB and 1,920 pixels a side before sending (section 2.4) |
| 9 | C4 asks for an ingress URL guard change | Existing guard already accepts RTMPS on a DNS host. No change needed for the measured LiveKit shape (section 1) |
| 11 | Old webhook handler ignores solo shows and calls feed/recorder identities foreign | ◇ Managed handler covers solo/test and recognizes media identities without room minutes (sections 5.5, 7) |

Open contradictions and unmeasured behavior:

**10. The desktop copy.** _Settled:_ a managed show's warning counts down to its `expiresAt` (11 h 55 min from create), a node show keeps the on-air rule, and the `cloud-quality` toast no longer names a resolution: "Videorc Cloud can't carry this stream's quality yet." (D `apps/desktop/src/renderer/src/lib/cloud-toasts.ts`). The backend's own fallback detail still says 1080p60; the renderer never shows it.

**12. Not measured by this revision.** The template query names come from Phase 0. Vertical values, the talk page at 60 fps, an empty stream output and a recorder's seat against `maxParticipants` still carry ⚠. Sharing stays disabled; reading its implementation does not prove LiveKit accepts it.

◇ **13. Stage membership and away coverage.** _Settled:_ the stage route checks a guest against the room's participants (section 2.5), and the page lists everyone away, drawn or not (section 5.3).

◇ **14. The whole state deadline.** _Settled:_ a poll that ends an abandoned create or a test show answers at once and leaves teardown to the reaper, so every state answer fits 30 s.

◇ **15. Overlay changes during a page rejoin.** _Settled:_ a later `joined: true` beacon after a beacon without it, or with a higher join epoch, increments `pageJoins` within the same boot. The desktop replays untimed overlays and clears empty slots. Duplicate and stale beacons do not increment the counter (section 5.3).


### Post-merge review additions

Managed talk RPC follow-up calls share the initial 22 s budget so a slow
Go Live followed by platform metadata cannot exceed the renderer watchdog.
The node transport retains its create and socket deadlines. Before provider
selection, Open the room bounds local test cancellation and camera handover to
1 s, reserving the existing 20 s create timeout and at least 1 s for managed
control within 22 s. A failed managed open remembers the show id before
returning; background End has a fresh 22 s budget, and only confirmed cleanup
forgets that id. Camera return also has its own bounded task. Recording download
snapshots recover missed terminal events; cancellation of an absent job
triggers a snapshot refresh. These additions do not change node media.
