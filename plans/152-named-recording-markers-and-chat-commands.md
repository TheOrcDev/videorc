# Plan 152: Named recording and livestream markers through Orcle and chat commands

Create a titled marker by saying “Orcle, make a marker here for Shadcn New
Library” or entering `/marker Shadcn New Library` in Stream Manager. Both
routes save the same kind of point on the recording or livestream timeline,
with a title and an accurate session timestamp. The point identifies where
that subject starts. The command and its confirmation stay local.

## Implementation record

Branch: `feat/named-session-markers`, based on main `b41fd6a5`.
The isolated worktree preserves unrelated work in the original checkout.
The PR was rebased onto `78d2a7b3` after watch streaks/chat links merged.
The marker plan became 152 because the merged feature owns plan 151.
Both IPC additions survive in the combined 121-method inventory.

Final PR review revisions preserve a stopped capture's lost-reply recovery,
but create a fresh operation when a new capture starts. Deleted receipts clear
the pending retry. Unknown durations show a timestamp list without proportional
pins. Shared provider readiness cannot replace a blocked or ended marker scope's
status. Cancelled chunk turns retain only grammar ownership through the next
500 ms pause, including split wake words, without retaining title text.
The maintained smoke delays both speech transports by 3.5 seconds and compares
markers with the audio/segment timestamps in the finished caption artifact.
The Orcle regression also probes its router to prove command-parser requests
reach the fake whose counter is asserted.

- S1: additive marker storage, typed RPCs, immutable creation payloads, deleted
  operation receipts and stable pagination are implemented. Storage tests pass.
- S2: local classification, completion/help, a strict detached-window relay,
  capture context, outcome recovery, IME handling and draft preservation are
  implemented. Focused desktop tests pass.
- S3: a lazy Library dialog and separate report link show marker points,
  original-video seeks, stream-only timestamps, rename and delete. Creation
  confirmations offer Undo by the persisted marker ID.
- S4: the bounded voice grammar shares wake/negation vocabulary and preserves
  raw titles. The chunked path assembles acoustic turns before saving; realtime
  completions use provider item identity. Partial titles, gaps, long turns and
  consent retirement cannot become saved markers.
- S5: capture-owned voice admission joins the existing provider and its account,
  Premium, service flag, consent and Listen gates without starting live chat.
  Stream Manager shows listening readiness separately from chat status.
- S6: `pnpm smoke:session-markers` exercises the actual detached composer,
  chunked and realtime provider callbacks, consent cancellation, livestream
  with Record off, durable mutations and a finished artifact analyzer.
  Its real Library scenario also repeats a seek and renames a marker through
  the typed frontend RPC contract. Broad verification is recorded below.

Local Rust test compilation uses a worktree-only test-profile optimization
level of 0 to reduce compile time. Production/dev recording stays at the
repository's optimization level 2. This local configuration is not committed.
`RUST_MIN_STACK=16777216` gives the unoptimized test binary enough stack for
the existing preview warm-up test. CI retains the repository's normal profile.

### Local verification, 2026-10-05

- Full Rust suite after final review: 3,206 passed, 13 ignored; Rust format and Clippy pass.
- Full desktop suite after final review: 306 files, 3,331 passed, one skipped. Node logic suite:
  1,936 passed. Typecheck, lint, production build and renderer asset budget pass.
  Lint retains the existing `captureConfig` dependency warning in `use-studio`.
- JS production and Rust dependency advisory audits pass; no dependencies added.
- `smoke:session-markers` proves the actual 320 px detached composer in both
  themes, no-chat local creation, complete split-chunk titles, realtime voice,
  consent cancellation, both typed and voice stream-only markers, durable
  deletion receipts, and finished-video timestamp bounds. The Library viewer
  repeats the original-video seek and saves a rename through the real frontend.
  With both transports delayed 3.5 seconds, saved voice points match the
  independent caption artifact's audio/segment timestamps within 2 ms.
  The smoke waits for the intended capture's available marker context before
  submitting; the earlier composer-count check could see the previous capture.
- `smoke:orcle-commands` and `smoke:cohost-fake` cover existing chat commands.
  Pure regression coverage also forwards a wake-only chunk to the existing
  detector with wake required, while assembling the split marker prefix.
- `smoke:recording-studio` ran its unit, audio, scene and artifact steps before
  stopping at a transient unavailable camera in the freeform smoke. The same
  freeform step subsequently passed all 98 trusted gestures and artifact
  checks. Every remaining maintained gate passed when run sequentially,
  including captions, all-layout recordings, app-quit finalization, enforced
  Record/Stop latency, Comments relay, native preview lifecycle/placement,
  real ScreenCaptureKit recording, Notes invisibility and system audio.
- Optional device extensions passed: real-device preview interaction stress
  with a 59.866-second analyzed recording, real-screen layout switches in
  recording and record+stream modes, and source-complete native-preview
  recording with four live layout updates. The layout check's initial
  immediate Starting response passed on an unchanged retry.

The whole master command is not represented as a single green run: its
recovered step and the remaining steps provide the recorded coverage. No
encoding profile, container, FPS, Windows process test, remote intent or LAN
event changed. No release or deployment is part of this implementation.

## Status and scope

- **Status: IMPLEMENTED and locally verified, 2026-10-05.** All six
  implementation slices are on `feat/named-session-markers`. GitHub records
  PR checks and the merge result; local gate evidence is above.
- **Source baseline:** locally available `origin/main` at `b41fd6a5`, desktop
  0.9.131. The shared checkout is older (`15206746`,
  `feat/windows-owner-waiver`). Do not implement against that older source.
- **Ownership:** one implementation owner for the recording, speech and
  detached-window contracts; product/design review for the composer and
  Library surfaces. Cross-system correctness is the main risk.
- **Owner clarification:** “both for recording and livestream so I can later
  know where is that marker starting on timeline.” Creation covers active
  recordings and livestreams; saved timeline markers must visibly identify
  the marked starts. This plan interprets livestream support to include
  Record off. Such streams keep marker metadata even without local video.
  Creating additional markers during saved-video playback is a later extension.
- **Entitlements:** typed commands and marker browsing/editing are manual
  recording features. Addressed Orcle voice commands retain Premium, account,
  listening, service-switch and Cloud AI consent requirements.
- **Prerequisites:** current main includes plans 097/098's ownership and
  consent fixes and plan 140's command grammar. Verify those contracts still
  hold before editing. Plans 149/150 are not dependencies.

Implementation must use an isolated worktree of current main, preserve the
shared checkout's changes, read `AGENTS.md`, and recheck the baseline paths.
Every slice below must leave existing clip marks and chat sending working.

## What exists and what must change

| Current main                                                                                                                                                                                | Consequence for this plan                                                                                                   |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `clip_marks.rs` stores voice/manual marks in SQLite and exposes `clip.mark`, `clip.marks.list` and `clip.marked`.                                                                           | Reuse recording ownership, time and storage conventions; add titled point markers.                                          |
| `clip_marks` stores `id`, `session_id`, `at_seconds`, `source`, `phrase`, `created_at`; deletion follows the session.                                                                       | Add a discriminator and title without rewriting legacy rows or using `phrase` as a title.                                   |
| `moments.rs` turns a clip mark into a preceding range, usually up to 30 seconds, snapped to captions.                                                                                       | A point marker must remain separate from that derived range. Its timestamp must not move when captions are available.       |
| `cohost_command.rs` handles wake words, replay detection and commands across transcript finals. Its words retain normalized text and arrival time, not original title text or media timing. | Preserve raw title spans and recording timing in the marker parser; normalized words alone cannot recover a title.          |
| Addressed voice commands are currently armed by an Orcle live-chat session.                                                                                                                 | Recording-only voice marking needs an explicit recording speech scope; removing chat checks from moderation would be wrong. |
| Caption callbacks retain immutable recording targets separately from Orcle speech consent/epochs.                                                                                           | Keep that separation; admitted voice marker work must also retain its own consent and recording ownership.                  |
| `ChatPane.Composer` calls `onSend` for every submission, checks provider length limits, and disables input without writable providers.                                                      | Classify local commands first, and give them availability and validation independent of chat delivery.                      |
| The detached Stream Manager asks Electron main to broker commands to the main renderer, which owns the backend RPC connection.                                                              | Extend that bounded, validated relay; keep backend credentials out of the detached window.                                  |
| `CommentsViewSnapshot` carries chat view state, with no independent active-recording context.                                                                                               | Relay a small session-marker availability projection, separate from the chat session.                                       |
| `SessionPlayer` already supports media grants and programmatic seeking. Library's ordinary Play action opens the default player.                                                            | Add a lazy marker viewer using the existing in-app player; do not assume default players can seek to a marker.              |

Relevant sources are under `crates/videorc-backend/src/`,
`apps/desktop/src/shared/`, `apps/desktop/src/renderer/comments/main.tsx`,
`apps/desktop/src/renderer/src/components/stream-manager/`, and
`docs/orcle-commands*.md`. All observations above refer to the pinned main
revision, not the older working branch.

## Product behavior

### Create a marker

| Input                                              | Result                                                                                                |
| -------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `/marker Shadcn New Library`                       | Save “Shadcn New Library” at the active recording or stream time when the backend admits the command. |
| `/marker`                                          | Save an untitled marker, displayed as “Marker”.                                                       |
| “Orcle, make a marker here for Shadcn New Library” | Save the recognized title at the spoken marker command's recording or stream time.                    |
| “Orcle, add a marker called Shadcn New Library”    | Same behavior.                                                                                        |
| “Orcle, mark this as Shadcn New Library”           | Same behavior.                                                                                        |
| “Orcle, make a marker here”                        | Save an untitled marker.                                                                              |
| “clip that” or the existing Mark clip control      | Preserve the existing clip-mark behavior.                                                             |
| `/help`                                            | Show local command syntax; no provider call.                                                          |
| `//marker Shadcn New Library`                      | Explicitly send literal `/marker Shadcn New Library` through ordinary chat delivery.                  |

Voice marker commands require the wake word even when wake-word-free chat
commands are enabled. Supported wake aliases use the existing rules; weak
aliases such as “Oracle” require a recognized marker verb. Negated commands
(“Orcle, don't make a marker”) and ordinary discussion about markers do not
save anything. The English phrases above are v1; do not claim unrestricted
natural-language understanding or add a cloud command-parser round trip.

Trim the title's edges and preserve its interior spelling, case, punctuation
and Unicode. Validate a maximum of **120 Unicode code points**, using the
same rule in Rust and TypeScript. Reject control characters, multiline titles
and overlong explicit titles; never silently truncate. A missing title is
valid. Speech spelling is what transcription produced; do not invent a
brand-name correction. The saved title can be renamed later.

### Availability and outcomes

- A marker is saved when the selected recording or livestream capture is
  ready. Recording-only sessions, recorded streams and stream-only sessions
  are eligible; local recording output is not required for marker metadata.
- A stream with Record off still saves a marker on that stream's timeline.
  It does not silently start local recording or promise a local video.
  Existing “clip that” marks keep their recording-output requirement.
- Starting, stopping, idle, disconnected and stale-session requests have
  distinct refusals. No success appears before the database commit.
- In a history chat view, local commands do not target that old stream or a
  different active recording. “Back to live to mark the current recording”
  explains the required action.
- `/marker` works with Orcle off, without Premium, and with zero writable
  chat providers. Voice marking needs an eligible Orcle speech scope and
  already-authorized transcription; it must never turn on Cloud AI itself.
- Confirm with `Marker saved at 12:34 · Shadcn New Library`, or
  `Marker saved at 12:34` for an untitled marker. Use a quiet toast and a
  local composer status line; offer Undo for the just-created marker.
  Do not insert a fabricated viewer message, increment chat/activity totals,
  highlight the text on stream, or speak the confirmation into the recording.
- On failure, retain the typed draft. On an ambiguous timeout, say
  “Checking whether the marker was saved…” and reconcile the same operation;
  do not create a fresh operation on retry.

### Finding markers afterward

Add **Markers** to the session's Library row menu, available for recordings
and streams with and without an Orcle report. A lazy dialog shows local video
in `SessionPlayer` and a chronological list of exact timestamp + title rows.
Clicking or pressing Enter on a row seeks to that point without autoplay.
The same marker can be selected twice and must seek twice; use the player's
imperative handle rather than an unchanged `seekToMs` prop.

Each row offers Rename and Delete through the existing menu/dialog
components. A completed stream without local video shows the timestamped list
and a timeline based on its known captured duration, with no playback action.
If duration is unavailable, show the list until that fact is known. Missing or
finalizing media keeps the marker list readable and explains why playback is
unavailable. Empty, loading and error states are explicit. Reloading or
restarting Videorc restores the same list.

The Orcle stream report may expose a separate **Markers** list or a link to
that dialog. Do not mix point markers into its range-based Moments list.
Show marker pins at their exact positions on the original session timeline,
with title/time on focus or hover. Selecting one seeks to its marked start
when local video exists; it never snaps to a caption or a derived clip range.
Compose existing shadcn Slider, Button, Tooltip and Popover primitives instead
of replacing the player controls. Closely spaced pins may share a chooser,
but every marker remains individually accessible in the list. Give repeated
labels their timestamps to distinguish them. Cover zero, near-end and crowded
positions, resize, keyboard navigation and both themes.

## Storage and command contracts

### One recording store with distinct meanings

Extend the existing `clip_marks` table through the established additive
migration mechanism:

- `mark_kind TEXT NOT NULL DEFAULT 'clip'`, with new rows using `marker`;
- `label TEXT NULL` for an optional marker title;
- `create_payload_hash TEXT NULL` for the immutable normalized creation
  payload (session, original title and source, excluding admission time);
- `revision INTEGER NOT NULL DEFAULT 0`, starting at 1 for new markers;
- `deleted_at TEXT NULL` for durable deletion receipts.

Legacy inserts retain the `clip` default. `list_clip_marks` explicitly selects
`mark_kind = 'clip'`, so old clip DTOs, Moments and Clean cut retain their
semantics. New marker accessors select `marker`. Share persistence helpers
where useful; do not create a second metadata file or overloaded `phrase`.

The marker DTO is `{id, sessionId, atSeconds, label?, source, createdAt, revision}`,
with `source: 'voice' | 'manual'`. Slash input is manual. Absent optional fields
are omitted, never null. The operation UUID is also the marker ID, providing
durable idempotency without a second operation table. A repeated ID returns
the current row only when its creation-payload hash agrees; conflicting reuse
is refused. Renaming does not change that hash. Check a persisted operation
before active-session admission, so retry after Stop can recover an earlier
success. A deleted ID returns `marker-deleted` and cannot create a new row.
Database uniqueness, not an in-memory debounce, arbitrates simultaneous
requests. Define the canonical hash encoding once, including absent versus
present title; the trusted backend computes it for both creation routes.

Reads exclude deleted rows. Rename increments the marker revision. Delete
retains its ID, session, hash and incremented revision with `deleted_at`,
clearing the title and any phrase; repeating Delete changes nothing.
These receipts cascade with session deletion. Events and replies carry
revisions so a delayed response cannot restore an earlier title or deleted row.

Provide typed RPCs:

| RPC                     | Parameters and result                                                                                                                                                     |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `session.marker.create` | `{operationId, sessionId, label?}` → persisted marker. Time and manual source are assigned by the backend.                                                                |
| `session.markers.list`  | `{sessionId, cursor?, limit?}` → `{markers, nextCursor?}` in recording-time order, with stable ID tie breaking. Default page 200, maximum 500; no silent list truncation. |
| `session.marker.get`    | `{sessionId, markerId}` → a discriminated found / deleted / absent result; found carries the marker, deleted carries its revision. Used to reconcile a timed-out create.  |
| `session.marker.rename` | `{sessionId, markerId, label?}` → updated marker.                                                                                                                         |
| `session.marker.delete` | `{sessionId, markerId}` → deletion outcome; already absent is an idempotent success.                                                                                      |

Create takes an expected capture session ID, not the chat session ID or a
free-form file path. No renderer parameter may supply voice provenance or
arbitrary recording time. The internal voice entry point takes a trusted
admitted speech envelope with immutable recording ownership and file time.
Both routes call the same marker commit operation after their admission
checks. Marker get/rename/delete cannot touch a legacy clip row.

Named-marker ownership registers both recording and stream-only capture
sessions. `MarkTarget.records_to_file` remains a fact used by legacy clip
marks, not a named-marker admission gate. Preserve the legacy detector's
file-only registration while giving named utterance assembly bounded ownership
for every eligible capture; an absent local output must not discard its words.

Emit `session.marker.created` with the persisted DTO, and a bounded
`session.marker.changed` event for rename/delete. Include marker and session
IDs and revisions so consumers can deduplicate and ignore unrelated sessions. A replayed
create returns the existing result without another created event. An accepted
late voice commit also refreshes a marker list already open for its recording.

Register mutations and observations in the backend's exhaustive RPC execution
policy and renderer access inventory. Update Rust DTOs, TS types, runtime
schemas, fixtures and Electron contracts together. Keep these methods/events
off remote roles and `LAN_EVENTS`; no remote extension is required.

Session deletion cascades to markers. A remux retaining the session identity
retains them. Markers refer to the original recording timeline: do not attach
unchanged timestamps to a time-shifted Clean cut export or imply that an
external player can read SQLite metadata.

### Time, lifecycle and retries

- **Typed:** resolve the exact active recording under its existing short
  lock; verify the expected session and ready capture state;
  capture `capture_elapsed_seconds()` once. Queue delay after admission
  cannot change that saved time. A delayed A request must never stamp B.
- **Voice:** retain the first marker verb's capture-relative timestamp, adding segment
  offsets to the capture anchor. If no finer timing exists, use the admitted
  utterance/item's capture-relative start; document this lower precision.
  Never substitute transcript arrival, wall-clock time or a renderer timer.
- Recording and stream markers use the authoritative source capture timeline.
  Read local media availability from the owning session when browsing;
  marker metadata does not depend on that media existing. Remote platform ingest
  delay and archived-VOD offsets are not inferred: this release does not
  publish provider chapters or promise direct platform-VOD seeking.
- Voice requests retain recording owner, utterance identity, admitted speech
  epoch and cancellation ownership. Check those fences again before commit.
  Consent revocation/sign-out cancels pending named-marker work, even if
  explicit captions continue; ordinary legacy clip routing remains independent.
- An utterance admitted before a normal Stop may finish against A during its
  existing graceful caption drain. It cannot migrate to B or revive a pruned
  owner. A typed command admitted after stopping begins is refused.
- Replayed finals and operation retries create one row. Distinct explicit
  marker requests, even with the same title within ten seconds, create
  distinct rows. Do not apply the legacy ten-second clip dedupe window to
  named markers. Ownership retention remains bounded and tied to provider
  drain evidence introduced in plan 097.
- Delete after a successful create cannot be undone by a delayed retry of
  that create. Keep the durable deletion receipt described above; an
  in-memory list of deleted IDs does not survive restart.

## Voice parsing and completion

Implement a pure, bounded marker grammar alongside the existing command
grammar in `cohost_command.rs`, sharing wake-word and negation rules. Keep
original text spans and media timing alongside normalized matching tokens.
Do not repurpose the four-word viewer-name limit or normalized `heard` field
as marker titles. Titles are bounded by the title limit and utterance limit,
not by a comment-author grammar.

A recognized marker utterance is consumed once at the caption command-routing
boundary. It must not also reach “clip that” matching inside the title,
become an Unknown chat command, answer a pending removal card, or call the
cloud command parser. Existing highlight/remove/clear utterances still use
their current detector and confirmation flow. Define and test a routing
result such as not-marker / pending-marker / completed-marker / refused-marker
so incomplete title handling cannot fall through to another action.

The complete title can span multiple transcription finals. In particular,
“Orcle make a marker here for Shadcn” followed by “New Library” must produce
one title, not “Shadcn” followed by an unrelated phrase.

- Realtime: use the existing provider item/utterance completion and timing
  evidence; do not treat a partial transcript as final.
- Chunked: fixed three-second chunk completion is not end of speech. Use
  the existing PCM speech-energy helper to record an utterance boundary
  after **500 ms of silence**, and associate it with ordered chunk identities.
  This is lightweight metadata on the existing audio path, not a new capture
  stream or a change to transcription chunk scheduling.
- Wait for all transcript chunks belonging to that bounded utterance before
  committing. An out-of-order response must not shorten the title. A missing
  or failed chunk yields a visible unsuccessful outcome, never partial success.
- A chunk can contain multiple utterances. Use segment timing and the retained
  audio boundaries to exclude later speech from the title. If a provider
  offers too little timing to separate those turns, request a repeat instead
  of attaching unrelated words. Keep the unavailable outcome explicit.
- Bound candidates to **10 seconds of utterance audio** and the existing
  provider upload/drain deadlines. Continued speech beyond the limit asks the
  user to repeat a shorter marker command. A timer must not guess that a slow
  provider response means the title is complete.
- On a valid unlabelled command, silence/completion closes it and saves an
  untitled marker. An explicit but empty label introducer (“called …”) is
  incomplete and must not silently become an untitled marker.

For a recording or livestream without chat, use a capture-owned voice scope in the same
caption/listen coordinator. Eligible Orcle listening starts the existing
transcription intent without presenting captions or starting chat analysis.
Explicit captions can also supply speech under the existing consent rules.
Keep Premium, account, settings, service-switch, cancellation and speech-epoch
checks authoritative. Do not relax live-chat/moderation session fences to
make recording-only markers work. The UI must show listening readiness and
failure for this mode, without claiming the chat cohost is live.

## Stream Manager command routing and interaction

Add a small pure classifier and command registry, initially only `marker`
and `help`. Match the first complete command token after trimming leading
whitespace, case-insensitively; preserve the remainder as raw title text.

- Plain text keeps the current `CommentsSendOperation` and destination flow.
- A leading `/` is local command syntax. Known, malformed and unknown local
  commands never call `onSend`. `/markre` shows an unknown-command message and
  `/marker` usage. `//` is the explicit literal-send escape. URLs and slashes
  later in ordinary text remain ordinary messages.
- Classify before provider length validation, destination selection,
  pending-chat checks, or reply-to-question metadata. A marker neither marks
  an Orcle question answered nor clears the selected chat destinations.
- Show the existing composer when either live chat or the active recording
  command context is available. Zero writable providers disable ordinary
  sending, not typing or local marker execution. History remains read-only
  until Back to live; a history snapshot cannot supply a marker target.
- Relay a small marker context from Studio, independent of
  `LiveChatSnapshot.sessionId`: expected recording ID, create availability and
  reason. It carries no media path or backend credential. Missing context
  fails closed, including the first detached-window frame and reconnect.
- Route through a dedicated typed Electron marker request using the existing
  comments command broker. Validate sender, operation ID, session ID and
  title at main and again at backend admission. Reconnect or close/reopen
  must not reissue a draft automatically.
- Typing `/` opens a compact shadcn command suggestion with
  `/marker [title]` and `/help`. Arrow keys select, Tab completes, Enter
  completes a selected suggestion first; a subsequent Enter executes.
  Esc dismisses suggestions without clearing the draft. IME composition must
  not submit. No key in a text field answers an Orcle moderation card.
- Once `/marker` is selected, replace the destination affordance with
  `Local · current session`; apply the title counter instead of provider
  caps. Keep local pending/error state separate from message delivery state.
  A chat send already in flight need not block a marker.
- Success clears only the submitted draft. If the user typed a new draft
  while the request was pending, preserve it. Failure leaves the command
  intact; retry reuses its operation ID until it is reconciled or edited.

Use the Videorc design and shadcn skills: existing InputGroup, Command,
Popover, Badge, DropdownMenu, Dialog, ScrollArea, Button, Kbd and sonner
compositions; Phosphor icons and semantic tokens. Both themes, keyboard-only
use and 320 px detached-window width are acceptance targets. Keep this code
and the marker viewer lazy; do not expand the main renderer's eager graph.

## Ordered implementation slices

### S1 Storage and trusted marker operations

Implement the migration, marker DTO/accessors, create/list/get/rename/delete,
durable idempotency and deletion receipts. Keep existing clip accessors
explicitly scoped to clip rows. Add RPC policies, role restrictions, TS/Rust
schemas and shared fixtures. Prove timestamp admission and session identity
with controllable clocks and lock-boundary tests.

**Done when:** legacy database migration is repeatable; old clip contracts
pass unchanged; titled/untitled markers survive reopen; create retries and
delete-then-retry never duplicate or resurrect markers; storage errors cannot
emit success; a stale A request cannot mark B.

### S2 Stream Manager slash command

Add the pure classifier/registry, dedicated marker relay, recording context
projection and local submit state. Make command input available with no
writable providers and during recording-only capture. Add command completion,
help and precise local feedback. Preserve provider picks, ordinary send
correlation, drafts, history mode and reply metadata.

**Done when:** the owner's exact `/marker Shadcn New Library` creates one
row; the same input causes zero provider-send calls; local failures keep the
draft; read-only providers, concurrent chat send, history and window
reconnect behave as specified.

### S3 Marker browsing and correction

Add the lazy Library marker dialog with chronological rows, visible labeled
timeline pins, `SessionPlayer` seeking, rename/delete, Undo and explicit state
copy. Include a saved stream timeline when no local video exists. Add a separate report
entry for stream markers. Use paginated storage reads and refresh the correct
session on marker events without rolling back a newer local result.

**Done when:** a saved marker remains visible after restart, seeks to its
exact point on repeated selection, can be renamed/deleted, and is usable
without Premium or an Orcle report. Missing media does not hide metadata.
Existing Moments and Clean cut produce the same ranges as before.

### S4 Orcle marker grammar and utterance assembly

Implement raw-title parsing, media timing, bounded utterance completion and
single-consumer routing through both actual chunked/realtime callbacks.
Recordings retain immutable targets; named markers additionally obey Orcle
admission fences. Do not modify provider chunk size or caption presentation.

**Done when:** the exact spoken example saves the complete title once, at
spoken time despite delayed transcription; split/out-of-order finals,
negations, title words such as “clip that”, replay and consent revocation
have regression coverage through production callback seams.

### S5 Recording-only voice scope

Make eligible voice marker listening work with an active recording or stream
and no live-chat session, through the existing caption coordinator. Add explicit
listening readiness/error presentation. Preserve live chat command gating,
service pauses, Premium lapse and stop/drain ordering.

**Done when:** recording-only voice creates a marker without starting a
chat cohost or visible captions; disabling listening/consent or signing out
prevents later named-marker writes; a delayed A utterance cannot mark B;
ordinary recorded livestream voice commands still pass their existing suite.

### S6 Maintained acceptance and documentation

Extend `smoke:orcle-commands` with named-marker fixtures and zero cloud-command
parse assertions. Extend the Comments window probe or add a clearly named
maintained renderer smoke for actual composer submission and marker relay.
Use fakes for chat/speech services and an analyzed recording artifact.
Update `docs/orcle-commands.md`, `docs/orcle-live.md`, the desktop-internal
contract sections and the plan index with observed evidence.

**Done when:** voice and typed commands each produce one durable titled
marker through the real app, correct timestamps are inside the finalized
artifact for recorded sessions, stream-only timestamps persist without media,
no provider receives command text, and all applicable gates below
have recorded results. Backend-only RPC success is insufficient composer QA.

## Verification requirements

Use focused checks while implementing each slice, then broader gates for the
completed feature. The planning change itself is docs-only.

| Area                        | Required evidence                                                                                                                                                                                                                                                |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Storage and RPC             | Legacy migration/reopen/cascade, stable pagination, title validation, idempotency, deleted-operation receipts, persistence failure, role refusal and exhaustive policy inventory tests.                                                                          |
| Command parser and composer | Marker/help/unknown/literal classification; zero `onSend` for local input; Unicode limits; no truncation; no writable providers; IME/Enter/Tab/Esc; pending-chat independence; new draft preservation; unchanged provider/reply behavior.                        |
| Voice                       | Exact examples, untitled command, negation, wake aliases, multi-chunk title, delayed/out-of-order and replayed finals, both real callback seams, lower-precision timing, incomplete provider result, recording-only scope and ordinary chat-command regressions. |
| Lifecycle                   | Deterministic A stop → B start while A final is delayed; consent false → true; sign-out; Premium lapse; service pause; bounded retained owners; graceful drain; ambiguous create → retry → Undo → retry.                                                         |
| Window and browsing         | Main/Comments sender checks, projection seed/reconnect/history, exact repeated seek, rename/delete/event refresh, missing media and reload; dark/light, 320 px, keyboard and screen-reader feedback.                                                             |

Required commands against the implementation worktree:

- `cargo test -p videorc-backend clip_marks::tests::`
- `cargo test -p videorc-backend cohost_command::tests::`
- `cargo test -p videorc-backend captions::tests::`
- `cargo test -p videorc-backend cohost::tests::`
- The new focused marker storage/RPC tests, then
  `cargo test -p videorc-backend`
- `cargo fmt --check --all`
- `cargo clippy -p videorc-backend -- -D warnings`
- `pnpm --filter @videorc/desktop test`
- `pnpm test:scripts`
- `pnpm typecheck`, `pnpm lint`, `pnpm format:check`
- `pnpm build`, `pnpm check:renderer-assets`
- `pnpm smoke:cohost-fake`, `pnpm smoke:orcle-commands`
- `pnpm probe:comments-window` and the maintained actual-composer scenario
- `pnpm smoke:recording-studio`, because the complete feature extends
  recording speech/listening lifecycle; include finished-artifact analysis
- `pnpm smoke:record-latency:gate` for S5 and any altered start/stop/drain path

Run the device suite when native capture/listening integration is touched and
the macOS host has the required grants; otherwise record the exact permission
block and closest focused probe. No encoding profile, FPS or preview surface
change is planned; add their specific gates only if implementation reaches
those paths. New RPCs/events must not accidentally expand remote allowlists;
run remote-control/LAN gates if shared relay/authorization code is changed.
Any changed Windows async/process test also needs AGENTS.md's PowerShell 7
25-repeat focused filters and three full-suite runs.

In the fake speech smoke, deliberately delay transcription by several
seconds. Compare the saved point to the seeded audio/command offset, not to
RPC completion; use a tolerance determined by supplied segment precision.
Inspect the finalized file with ffprobe/ffmpeg to establish its playable
duration and timestamp alignment. Do not rely on file size or manual playback.

## Deferred extensions and execution boundaries

- Marker creation during saved-video playback, imported-video authoring,
  explicit `/marker at 12:34`, retroactive offsets and voice rename/delete.
- Additional slash actions such as highlight/remove, viewer-issued commands,
  Phone remote and Stream Deck named-marker entry points.
- Embedded MP4/MKV chapters, sidecar export, external-player integration,
  burned-in overlays, clip export and Clean cut timeline remapping/protection.
- New transcription providers, languages, model-based title correction or a
  web API change. Existing speech transport may already use the cloud; the
  marker parser and typed route add no new cloud processing.

If utterance completion cannot be proved from retained audio/chunk ownership,
make that evidence part of S4 before shipping; do not accept partial titles as
success. If recording-only listening requires changing entitlement or consent
policy rather than session ownership, surface the concrete policy decision
before implementing it. Record scope changes in this plan.

## Acceptance scenario

1. Start a local recording. With authorized Orcle listening, say
   “Orcle make a marker here for Shadcn New Library”. Observe one complete
   titled marker at the command's recording time.
2. In Stream Manager, enter `/marker Shadcn New Library`. Observe a second
   marker at the current recording time, even with no writable provider.
3. Go live with recording enabled and repeat both routes. Confirm no command
   text or local receipt reaches the fake platform chat.
4. Stop, restart Videorc, open Library → Markers and select each row. Verify
   the corresponding point in the original recording; rename one and undo
   creation of another without changing any chat row or clip moment.
5. Repeat a livestream with Record off. Both routes still save titled
   markers, visible later on the saved stream timeline without local playback.
6. Repeat with an unknown command, a delayed transcript and a stop/start
   boundary. Each refusal is clear; nothing lands on the wrong session or is
   reported saved without persistence.
