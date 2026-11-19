# Plan 254: the fixes from the second live test

## Status and scope

- **Status:** PLANNED 2026-11-20. The owner said: "plan out how to fix everything from my live stream and execute, and create PRs for all of that. Merge to main and after all that, do all the tests on main to prepare us for release."
- **Source:** the owner's live test on 0.34.0, 2026-11-19, show `sh_IiWc0gZHBSbhrXREpQ6XRm` (unlisted YouTube). The owner joined as their own guest. Raw notes and log excerpts are in `~/videorc-incident-2026-11-19/live-test-2-findings.md` on the owner's Mac.
- **What already works** (no change): go live; mute and unmute; guest leave and rejoin; guest screen share; two screens (plan 251); captions; highlights; Mac → phone → Mac hand-off; the Stream Manager header; the join chime; a backend restart mid-show (auto-rejoin in about 5.5 s, controller kept).
- **Out of scope:** latency (plan 253), the scene HUD #1416.

## Findings and fixes

| # | Finding | Fix | Repo | Slice |
| --- | --- | --- | --- | --- |
| F1 | A guest who leaves stays on the stage (the Studio says "No picture yet", the stream says "Back in a moment") until the next stage change | The guests poll prunes a guest who has left from `on_stage`, the spotlight and the screen, then sends the stage | desktop (Rust) | S1 |
| F2 | Continuing on a phone: the portrait camera is cropped to the middle third, and in Solo the eyes are cut off | A portrait person source is drawn whole (`contain`) over a blurred fill of itself; any `cover` crop of a portrait source keeps the top third | web (program page) | S2 |
| F3 | The guest page's light/dark switch does nothing in the call | Hide the site theme switch while the call view is on screen (the call stays dark, plan 246 D2) | web (guest page) | S3 |
| F4 | After Mac → phone → Mac, Stream Manager says "YouTube ended" and shows no chat, while YouTube is live | Taking a show back restarts the chat follow for its destinations and refreshes the leg states from the runner, as a fresh backend's launch check already does | desktop | S4 |
| F5 | The Hide screen button can't be found in the Studio while a room is open | Hide screen is reachable from the Show stage while the room is open (its Screens section), one home per control | desktop (UI) | S5 |
| F6 | After a restart, a fenced call (the Discord claim on `/effects`) raced the controller renewal and got a 409 | Fenced cloud calls after a backend start wait for the kept-epoch renewal (#1565), or retry once after it | desktop (Rust) | S6 |
| F7 | Right after a backend start, the native mic is "missing or its identity is ambiguous" | Match the saved mic by name and UID when the CoreAudio id has drifted, and log the requested id next to the ids CoreAudio lists | desktop (Rust) | S7 |

## Decisions (owner checks with the defaults built)

- **D1 (F1).** An explicit Leave, or a Remove or Ban, takes the guest off the stage at once. A guest who only drops keeps "Back in a moment" (plan 249 D12) while the web still lists them as present. The guest list (`room.guests`) is the source; the LiveKit participant list alone never prunes.
- **D2 (F2).** Default: a portrait person source is drawn whole with a blurred fill in a landscape tile, the same way on every layout and output. **Owner check:** should continuing on a phone also offer a vertical (9:16) output? It's not built here, and is noted for a later plan.
- **D3 (F3).** Default: hide the switch in the call and keep the call dark. **Owner check:** a light call view is a later design task if wanted.
- **D4 (F5).** Hide screen keeps its home in Quick settings and the Stream Manager footer; while the Show stage replaces the Preview it is reachable from the Show stage too. The UX/IA law allows it as a link or toggle to the same state, never a second state.

## Slices

Each slice is one PR, leaves both repos green, and is merged as soon as it is ready (owner instruction).

| Slice | Repo | Route · model · fit | Done when |
| --- | --- | --- | --- |
| S1 (F1) | desktop | Implementation · fable · 9 | Rust unit tests: a left guest is pruned and the stage is sent once; a guest who only dropped is kept; spotlight and screen are cleared; no prune when the guest list is unknown. Targeted `cargo test`, clippy, fmt |
| S2 (F2) | web | Implementation · fable · 9 (on-air page) | Unit tests for the fit rule (portrait means contain plus blur; top-anchored cover), the bundle pin, and `run-stage-livekit.mjs` if the host is quiet |
| S3 (F3) | web | UI · opus · 7 | A guest page test: the switch is absent in the call view and present on the join and left screens |
| S4 (F4) | desktop | Diagnose → Implementation · fable · 9 | A test: hand off, take back, and expect the chat follow and the leg states restored with no manual step; Stream Manager shows chat |
| S5 (F5) | desktop | UI · opus · 8 | A component test: the Show stage offers Hide screen while sharing; both themes by eye |
| S6 (F6) | desktop | Implementation · fable · 8 | A Rust test: after a restart no fenced call goes out before the renewal; a 409 during the renewal window is retried once |
| S7 (F7) | desktop | Diagnose · fable · 8 | A Rust test: a drifted CoreAudio id still opens the saved mic by name and UID; the log names the requested and listed ids |

## After the merges: tests on main for release

CI (macOS, Windows, Linux); `smoke:cloud-talk-show` and `smoke:cloud-talk-show-managed`; `smoke:cloud-parity` cases graphics, privacy and handoff; web `smoke:guest-call` and `run-stage-livekit.mjs` (plan 253 S2 and S3 are owed too); a scene hotkey smoke for plan 231; then the release checklist.
