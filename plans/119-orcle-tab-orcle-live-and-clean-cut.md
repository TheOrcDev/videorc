# Plan 119: The Orcle tab (Publish removed): Orcle Live and Clean cut

> Executor: implement the phases below in order. Use one isolated worktree of
> current main per phase and per repo, with one branch and one PR each. First
> read `AGENTS.md` and `CLAUDE.md`. For any UI slice, also read
> `.claude/skills/videorc-design/SKILL.md`. Commit and push per slice. Run the
> phase gates once, at the end of the phase. Planning authorizes no merge, no
> release and no production setting change.

## Status and decisions

- Status: **EXECUTING 2026-10-03.** The owner said: "Pick defaults and execute
  the entire plan and create a pr."
  - Desktop branch: `feat/119-orcle-tab`. Web branch: `feat/119-orcle-clean-cut`.
  - Owner-only work stays owed:
    - S0 calibration on the owner's recordings (decision 16 defaults are used
      until then);
    - acceptance A1–A3;
    - the verbatim-transcription provider key in the Vercel env.
- Defaults picked by the orchestrator, 2026-10-03:
  - Decision 7: no clip-mark file export. Marks are moments in the report and
    pins in Clean cut review.
  - Decision 9: the publish-pack web routes keep serving installed desktops.
  - Decision 11: Clean cut allowance `VIDEORC_AI_CLEAN_CUT_MONTHLY_MINUTES`
    defaults to 1,200.
  - S8 (carry-over) is deferred, not built.
  - Verbatim provider default: Deepgram `nova-3` with `filler_words=true`,
    configured by env.
- Priority P1. Effort XL: about 20 agent-days over four phases in two repos.
  Phase 0 is about 1–2 days, Phase 1 about 5, Phase 2 about 9–11 and Phase 3
  about 4. Each phase ships on its own.
- Risk by phase:
  - Phase 1: MEDIUM. The deletion is wide, consent changes owner, and the
    contract validators are closed.
  - Phase 2: HIGH. It adds new cloud transcription, a cutter that must keep
    audio and video exact, and a local media protocol with Range support.
  - Phase 3: MEDIUM-HIGH. AI selection quality.
- Baselines:
  - Desktop `origin/main` `6f9995eb`: 0.9.129 plus PRs #546–#563, which
    include plans 097 and 098.
  - Web `origin/main` `5e429e03`.
- Path conventions:
  - Rust paths are relative to `crates/videorc-backend/src/`.
  - Renderer paths are relative to `apps/desktop/src/renderer/src/`.
  - `main/…` means `apps/desktop/src/main/…`, `shared/…` means
    `apps/desktop/src/shared/…`, `preload/…` means `apps/desktop/src/preload/…`
    and `comments/…` means `apps/desktop/src/renderer/comments/…`.
  - Paths that start with `apps/`, `scripts/`, `docs/` or `protocol-fixtures/`
    are repo-relative.
  - Web paths are relative to the videorc-web repo (`~/projects/videorcweb`).
  - Line numbers are from the baselines; re-check them after the drift check.
- Owner asks, 2026-10-03:
  - "I'm probably the most power user of Videorc and I'm not using
    [Publish] at all. It is very hard to understand and I don't see any value."
  - "I don't want publish helpers, I want AI features that are useful for
    people who are making videos and livestreaming." The owner wants a tab that
    feels special, with "1 or 2 really powerful features".
  - The pick: "1. Orcle live in your livestreams with everything that we
    already have and 2. Clean cut: 'Stop recording, and the edited version is
    already there.'"
  - Then: "we are completely removing publish and adding new Orcle".
- Owner route: Orchestrator (fit 10), because the work spans two repos and
  about eight subsystems.
- Model lanes (set per slice below):
  - `fable-5`: engine, media, AI quality and reviews.
  - `opus-4.8`: UI and copy.
  - `gpt-5.5`: mechanical implementation, smokes and docs. In a harness
    without `gpt-5.5`, use `opus-4.8`.
- Commit prefixes:
  - Desktop: `feat(orcle):` for the tab, Orcle Live and the report;
    `refactor(publish)!:` for the removal; `feat(clean-cut):`.
  - Web: `feat(ai):` and `docs(site):`.
- Execution rules (owner):
  - One branch and one PR per phase. Commit and push each slice.
  - Run the Rust compile, targeted tests and smokes once at the end of the
    phase. A cheap mid-way `pnpm typecheck` is fine.
  - Use targeted `cargo test` filters, not the full suite.
  - Run vitest, `pnpm build` and `pnpm lint` with `PATH=/opt/homebrew/bin:$PATH`
    (arm64 Node).
  - Judge `check:renderer-assets` by raw bytes against main. CI is the gate.

### Drift check

```sh
git diff --stat 6f9995eb..origin/main -- \
  apps/desktop/src/renderer/src/components/tabs/ai-tab.tsx \
  apps/desktop/src/renderer/src/components/workspace-nav.tsx \
  apps/desktop/src/renderer/src/components/app-shell.tsx \
  apps/desktop/src/renderer/src/components/cohost-settings-section.tsx \
  apps/desktop/src/renderer/src/components/tabs/library-tab.tsx \
  apps/desktop/src/renderer/src/hooks/use-studio.tsx \
  apps/desktop/src/renderer/src/lib/post-stream-pack.ts \
  apps/desktop/src/shared/backend-rpc-contract.ts \
  apps/desktop/src/main/index.ts \
  crates/videorc-backend/src/cohost.rs crates/videorc-backend/src/cohost_ack.rs \
  crates/videorc-backend/src/ai.rs crates/videorc-backend/src/publish_clips.rs \
  crates/videorc-backend/src/storage.rs crates/videorc-backend/src/noise_cleanup.rs \
  crates/videorc-backend/src/main.rs crates/videorc-backend/src/protocol.rs
# web
git diff --stat 5e429e03..origin/main -- lib/ai app/api/ai lib/pricing.ts components
```

Fold in any changes that already landed. If a contract changed materially,
revise this plan before building.

### What exists today (measured)

**Publish, which is being removed**

- `components/tabs/ai-tab.tsx` is 1,206 lines. It is loaded lazily at
  `components/app-shell.tsx:49` and rendered at `:393-398`. It holds:
  - five pipeline cards;
  - "Cloud AI: step 0" (`:214-284`);
  - Generate and Export pack (`:326-407`);
  - Social posts;
  - Clips (`:994-1105`);
  - the Lab (`:738-811`);
  - the Publish pack and "Copy YouTube description" (`:813-851`).
- The tab's metadata is at `components/workspace-nav.tsx:52`: id `ai`, label
  `Publish`, group `library`, shortcut ⌘9 (`:83`). Its icon, `PublishIcon`, is
  Phosphor `Sparkle` (`components/icons.tsx:150`).
- Every output ends at the clipboard. Clips are 16:9 stream-copy trims, and
  nothing in the Lab edits anything.
- The auto post-stream pack is on by default whenever Orcle listening is on
  (`lib/post-stream-pack.ts:56-60`). It runs from `hooks/use-studio.tsx:6105-6107`
  and `:13651-13680`.
- Other entry points:
  - Library "Open in Publish (AI)" (`components/tabs/library-tab.tsx:879-886`,
    menu item `:909-912`, header copy `:252`).
  - The `videorc:open-publish` listener (`app-shell.tsx:226-242`).
- Backend RPCs that only Publish uses: `ai.run_post_recording` (`main.rs:11690`),
  `ai.publish_pack.export` (`:11765`), `ai.clips.suggest` (`:11703`) and
  `ai.clip.export` (`:11716`).
- Orphan RPCs with no caller: `ai.artifacts.list` (`:11746`) and `ai.jobs.get`
  (`:9199`).
- Code: the `ai.rs` workflow (`run_ai_workflow:40`, export `:925-1003`, render
  `:1267`) and `publish_clips.rs`.
- The `ai_artifacts` table stays:
  - `sessions.list` joins it for `aiArtifactCount` and `readyAiArtifactKinds`
    (`storage.rs:3799-3811`, `:3938-3965`), and the support bundle reads it.
  - The renderer validators for those fields are closed
    (`shared/backend-rpc-contract.ts:1597-1614`).
  - `AiArtifactKind` is a closed enum (`protocol.rs:4847-4859`).
- `lib/publish-pipeline.ts:1-5` claims a "lockstep copy check" with the web, but
  none exists in either repo. The web copy (`lib/publish-pipeline.ts`) has had
  no importers since web `f611a0af`, and the two copies have already drifted.

**Consent**

- Consent is one renderer-only flag, `localStorage['videorc.aiConsent']`
  (`use-studio.tsx:497`, `:3147-3153`).
- Orcle reads it in three places:
  - `cohost.start` sends it as `consentToProcessChat` (`:3954`).
  - The Comments-window relay passes it (`:4128`).
  - The "grant" command sets it (`:4148`).
- Publish's step 0 is the only main-window switch that grants or revokes it
  (`ai-tab.tsx:254-264`). Settings says the consent is "set in Publish"
  (`components/cohost-settings-section.tsx:155-156`).
- Since plan 098 (PR #546), consent changes apply mid-session.

**Orcle (code name `cohost`)**

- Orcle runs only during a live-chat session, which means only while
  streaming. The renderer starts it when `settings.enabled` is on and the
  Premium gate (`live-cohost`) allows it (`use-studio.tsx:3947-3975`).
- Every stop path ends in `CohostEngine::stop_session` (`cohost.rs:3570`), which
  drops all state. The only Orcle data that is persisted is the `app_settings`
  key `cohostSettings`. The module doc promises memory-only storage
  (`cohost.rs:7-8`).
- Counters today: `messages_seen` and `questions_total`.
  - Answered, dismissed and replied all land in one id set,
    `dismissed_questions`.
  - Questions resolved by voice stay in `recently_resolved` for 60 s.
  - Posting a recap sends no signal to the backend.
  - Who greeted which first-timer lives in the `AuthorLedger` (`cohost_ack.rs`).
- The live UI is the Orcle pane in Stream Manager, which is mounted only in the
  detached Comments window (`components/stream-manager/stream-manager.tsx:555-652`,
  `comments/main.tsx:342-384`). The main window shows a session-panel row that
  opens it (`components/studio/session-panel.tsx:322-348`).
- Settings live in Settings → Orcle (`lib/settings-tabs.ts:16`,
  `components/tabs/settings-tab.tsx:107-111`). `CohostSettingsSection` takes no
  props (`cohost-settings-section.tsx:82`). Every default is off
  (`cohost.rs:479-491`).
- Several entry points write `enabled` alone:
  - the status popover (`components/cohost-status.tsx:143-153`);
  - the nudge (`stream-manager.tsx:781`);
  - the listen card (`comments/main.tsx:373-375`).
- RPCs: `cohost.status`, `.start`, `.stop`, `.question.*`, `.flag.dismiss`,
  `.promise.*`, `.recap.*`, `.author.greeted`, `.settings.get` and
  `.settings.set`. Event: `cohost.state` (`main.rs:9011-9145`; policy lists at
  `:5274-5285` and `:5450-5451`).
- A new settings field means updating 14 `CohostSettingsPatch` literals in
  `cohost.rs`, 2 in `live_chat.rs` and 1 in `recording.rs`.

**Clip that**

- Marks are voice or manual; the remote, the shortcut and the Stream Manager
  button all record manual marks. They are saved in `clip_marks`
  (`storage.rs:6209-6219`), but only while recording.
- Their only reader is Publish → Clips, through `ai.clips.suggest`.
  `clip.marks.list` has no UI caller.
- The toast says "Find it in Publish → Clips after the session."
  (`shared/clip-marks.ts:27`).

**Media, derived sessions, FFmpeg**

- There is no `<video>` or `<audio>` anywhere.
- The only content scheme is `videorc-asset` (`main/index.ts:13279-13310`). Its
  privileges (`:13619-13624`) are `standard`, `secure`, `supportFetchAPI` and
  `stream`. It returns `net.fetch(pathToFileURL(...))` without Range support
  (`:13305`).
- The CSP already allows `media-src 'self' data: blob: file: videorc-asset:`
  (`shared/renderer-security-policy.ts:276`).
- Windows are sandboxed, and the permission handler denies fullscreen
  (`main/web-contents-security.ts:36-57`). Library Play opens the OS player.
- Noise cleanup is the derived-session pattern to copy:
  - `noise_cleanup.rs`: start `:204-246`; a worker that waits for the
    maintenance slot `:321-517`; progress from `-progress pipe:1` `:1109-1119`;
    a capability probe `:903-948`.
  - Table `noise_cleanup_jobs` (`storage.rs:6154-6186`).
  - The derivative insert `complete_noise_cleanup_derivative`
    (`storage.rs:2878-2945`).
  - Startup requeue (`main.rs:607`) and shutdown interrupt (`:691`).
  - The file-operation journal accepts the kinds `import|duplicate|noise-cleanup`
    (`storage.rs:4081`) and is reconciled at startup (`main.rs:473`).
  - Starting a capture cancels maintenance work (`ffmpeg_work.rs:55-83`).
- **Trap: a new `processingKind` value breaks older apps.**
  - The renderer validates `processingKind` as the literal `'noise-cleanup'`,
    with `allowUnknown: false` (`shared/backend-rpc-contract.ts:1619`).
  - An older app that reads a row with any other value rejects all of
    `sessions.list`, so Library and recording break.
  - Dev builds share the packaged app's profile (`main/index.ts:13629-13631`).
  - This is the same class of bug as the 2026-08-17 container outage
    (`storage.rs:7228-7248`).
  - Library labels a derivative only when `processingKind === 'noise-cleanup'`
    (`library-tab.tsx:552-565`).
- FFmpeg is the LGPL 8.1 build on every platform (`vendor/ffmpeg/README.md`).
  - macOS: `h264_videotoolbox`.
  - Windows: `h264_mf`, plus optional `h264_qsv`, with `libopenh264` as the
    fallback.
  - Linux: `h264_vaapi` (after a runtime probe) or `libopenh264`.
  - The recording's encoder table is at `recording.rs:12399-12440`.
  - No code uses `silencedetect`, `loudnorm` or a video `trim` today.
- Finalization runs in this order:
  1. Instant Stop commits the session row.
  2. A background job exports the MP4, writes the SRT, probes the file, commits,
     makes the poster and enqueues the post-recording quality gate
     (`recording.rs:9710-9974`).
  3. The gate waits 30 s and may repair the MP4 in place (`recording.rs:843`,
     `:10208`).
  4. The renderer hears `recording.finalization` (`use-studio.tsx:6087-6107`).

**Transcripts**

- Live captions write `<recording>.srt` in cues of about 3 s
  (`captions.rs:813-870`, `:25`).
- Word timings are never saved, and there is no local speech-to-text engine.
- `extract_audio` makes 16 kHz mono AAC (`ai.rs:1010-1056`).

**Web AI (videorc-web)**

- Transcription providers (`lib/ai/transcription.ts:487-766`):
  - OpenAI `gpt-4o-mini-transcribe`, which returns text only.
  - Deepgram `nova-3`, which keeps only `alternatives[0].transcript` and drops
    the word timings.
  - Gateway `openai/whisper-1`, which returns segments but takes no provider
    options.
- Nothing requests filler words. Audio is capped at 25 MB, and Vercel caps
  request bodies at 4.5 MB.
- Caption chunks:
  - Model `xai/grok-stt`; 16 kHz mono WAV, at most 30 s.
  - Seconds are metered in `ai_caption_sessions` under the keys `quota-YYYY-MM`
    and `listen-quota-YYYY-MM`.
  - The caption total excludes only `listen-quota-%` (`lib/ai/captions.ts:723-737`).
- Jobs:
  - Premium allows 20 per day and 500 per month across all job kinds
    (`lib/ai/jobs.ts:235-257`).
  - Idempotency is keyed on `(userId, clientRequestId)`.
  - There is no chunking or map-reduce helper, and the transcript cap is 120k.
- Capabilities:
  - The desktop ignores unknown keys: `AiCapabilities` has no
    `deny_unknown_fields` (`protocol.rs:4466`).
  - Never add values to existing enums such as
    `AiCapabilitiesCaptionsReasonCode`, or to existing arrays.
  - Web tests compare `features` and `limits` exactly
    (`tests/ai-capabilities.test.ts`).
- Publish copy on the site:
  - Pricing and plans: `lib/pricing.ts:40-43` and its consumers;
    `lib/account/plan-features.ts:59-62,78` and its test;
    `app/account/page.tsx:85,189-191`.
  - Marketing components: `components/premium.tsx`, `components/app-showcase.tsx`,
    `components/features.tsx:85`, `components/faq.tsx:20,102`, and the footer,
    manifesto, final-cta, pricing and blog-CTA lines.
  - Metadata: `lib/metadata.ts:25,51,369,382` and `lib/structured-data.ts:106-107`.
  - Guides: `lib/multistream-guide.ts:130,154`, and `lib/orcle-guide.ts:74` with
    `tests/orcle.test.ts:97`.
  - Legal: `app/privacy/page.tsx` and `app/terms/page.tsx`.
- No AI route sets `maxDuration`. The Orcle server keeps no state and produces
  no end-of-stream summary.

**Release gate**

- `scripts/lib/capture-decay-release-acceptance.mjs:60-110` marks most files
  this plan touches as capture-sensitive. That includes `use-studio.tsx`,
  `app-shell.tsx`, `library-tab.tsx`, `main/index.ts`, `main.rs`, `protocol.rs`,
  `storage.rs` and any new module.
- So each phase release needs a fresh D3 acceptance, as the release runbook
  describes.

### Decisions (the recommendation is taken; ⚑ marks a choice the owner may override)

1. **One tab, one identity.**
   - The tab keeps id `ai`, so deep links, smokes, ⌘9 and
     `data-videorc-tab-trigger` keep working.
   - New metadata: label `Orcle`, group `stage`, so it sits directly under
     Studio and above Setup.
   - A hand-drawn `OrcleIcon` (an orc head in the style of the logo) replaces
     both `PublishIcon` (Sparkle) and the Robot `CohostIcon`, so Orcle has one
     mark everywhere. It follows the `KickIcon` pattern (`icons.tsx:283-298`):
     a 256 grid, `currentColor`, legible at 16 px.
   - Page description: "Your AI producer while you're live." in Phase 1, then
     "Live with you. Edits after." once Clean cut ships.
   - No toolbar buttons, per the owner rule.
2. **Publish is deleted, not hidden.**
   - That includes the post-stream pack auto-run. It must go in the same slice
     that removes its switch, or cloud jobs keep running with no visible
     control.
   - Old desktops keep working against the web (decision 9).
3. **Consent has one home: the Orcle tab.**
   - It keeps the same flag (`videorc.aiConsent`), shown as "Cloud AI" with
     copy that lists exactly what it covers: Orcle reading chat and hearing you
     as text, and in Phase 2, uploading recording audio for Clean cut.
   - It is granted inside the Orcle Live and Clean cut switch flows and revoked
     in the tab. There is no second consent store.
4. **Orcle Live is one switch: "Orcle joins my streams".**
   - On means: sign in and Premium if needed, then consent, then
     `cohost.settings.set {enabled: true, listen: true}`. Off means
     `{enabled: false}`.
   - The granular switches move under Customize.
   - The card names three powers. Final copy is settled in S2 with the design
     skill:
     - **Never miss a question.** Questions from every platform, grouped, each
       with a drafted answer you approve. Answer out loud and Orcle clears it.
     - **Chat stays safe.** Spam, scams and abuse are flagged against your own
       rules. Orcle never acts on its own.
     - **The room, handled.** Orcle greets first-timers, reminds you of your
       promises, nudges you during dead air, tells you when viewers say your
       audio broke, and can put the comment you're talking about on screen.
   - "Alpha" stays until A1 passes (S7).
5. **Settings → Orcle moves into the tab**, so every setting has one home. A
   remembered last Settings tab of `orcle` falls back to the default.
6. **Every stream leaves a report.**
   - It is local, saved per session, and deleted with the session.
   - It holds counts by outcome, the questions with their outcomes, open
     promises, greetings and alerts.
   - Code and wire names follow the Orcle rename rule (code stays `cohost`):
     table `cohost_reports`, RPCs `cohost.report.get` and
     `cohost.report.latest`, event `cohost.report.saved`.
   - The module doc and the privacy copy change, because live state stays in
     memory but the report is saved on this computer.
7. **"Clip that" marks live in the report as moments.**
   - Moments are computed when the report is read: marks plus the top 3 chat
     peaks, each snapped to the SRT with an excerpt.
   - There is no file export. ⚑ If the owner wants "Save this part" back, the
     Phase 2 review can add it cheaply.
   - From Phase 2, moments are pins in Clean cut review, and Condensed keeps
     them.
8. **Library changes.**
   - "Open in Publish (AI)" is removed.
   - The row menu gains "Orcle report" in Phase 1 and "Clean cut" in Phase 2.
   - Clean-cut derivatives get a badge and "· cut from {source}".
9. **Old clients keep working.**
   - The web keeps the publish-pack routes and the capabilities shape
     unchanged, with no forced shutdown. ⚑ The owner could shut them off with
     the `features.*` flags.
   - Deleting those routes is a follow-up plan, once `jobs.byWorkflow` shows no
     post-recording jobs for 30 days.
10. **Site copy follows each phase release.** Phase 1 replaces Publish with
    Orcle Live; Phase 2 adds Clean cut.
11. **Clean cut product rules.**
    - Eligible: finalized Videorc recordings with a local MP4 (mode `record` or
      `record+stream`), at least 10 s long, not imported and not derived.
    - Output: a new session named "<title> (Clean cut)", saved next to the
      source. The source is never modified.
    - Re-rendering replaces the same derived file and row.
    - Auto-run is opt-in once, through "Make a clean cut of every recording".
    - Premium, signed in and Cloud AI consent are all required.
    - A monthly allowance applies. ⚑ The owner sets the number after S0
      measures the cost per hour.
    - Filler removal is English-only in v1. Silences, head and tail trimming
      and retakes work in any language.
12. **Storage safety.**
    - Never write a new `processing_kind` value. Clean-cut derivatives store
      NULL there and set `derived_from_session_id`. The link lives in
      `clean_cut_jobs.output_session_id`, and `sessions.list` exposes
      `cleanCutOfSessionId` through a join.
    - Before using the shared file-operation journal with a new kind, prove what
      an older backend's startup reconcile does with an unknown kind. If it
      errors, use a separate table.
    - S4 also ships a tolerant `processing_kind` reader as defense in depth. It
      does not license writing new values.
13. **Player: scoped grants with Range support.**
    - A main-window-only IPC mints a short-lived grant for one session's
      finalized MP4.
    - A new host, `videorc-asset://session-media/<grantId>`, serves it with
      206/416 support. No CSP change is needed.
    - Custom controls; fullscreen stays denied.
14. **Transcription for Clean cut.**
    - The desktop cuts the audio into chunks of at most 120 s.
    - A new stateless web route transcribes each chunk word for word, keeping
      fillers. It meters seconds in its own bucket, and its provider comes from
      env.
    - The server stores nothing. The desktop stitches the chunks and keeps the
      transcript locally.
15. **Analysis for Clean cut.**
    - A new job kind, `post-recording-clean-cut`, works through the transcript
      in windows, by sentence id, with a server-side provenance check.
    - It returns retakes and false starts; Phase 3 adds beats.
    - Silences and fillers are cut on the desktop from word timings.
16. **Cut rules.** These are defaults, calibrated in S0.
    - Head: cut until 0.3 s before the first word. Tail: cut from 0.6 s after
      the last word.
    - Silent gaps with no words longer than 1.0 s shrink to 0.4 s; they are not
      removed outright.
    - Wordless gaps that are not silent (music, game sound, typing) shrink only
      when longer than 4 s, and then to 1.5 s.
    - Fillers are cut with 30 ms padding, clamped to the neighbouring words.
    - Retakes and false starts are applied at confidence 0.6 or higher. Lower
      ones are kept as switched-off suggestions.
    - Kept slivers shorter than 250 ms are absorbed.
    - Every boundary snaps to the source's frame grid.
    - 10 ms audio fades at each join; video cuts are hard.
17. **Render rules.**
    - One FFmpeg pass.
    - Platform encoder fallback chain, as listed for S13.
    - Bitrate matched to the source; same size, fps and BT.709 tags;
      `+faststart`.
    - Every audio track is cut the same way.
    - Validated before publishing: the duration must equal the kept duration
      within 1 frame, and audio and video must match within 1 frame.
18. **Heavy work never competes with a live session.**
    - Clean cut uploads and renders run only in the idle maintenance slot.
    - Starting a capture preempts and re-queues them.
    - Nothing uploads while a capture is live.
19. **Quality bars.**
    - **A1, Orcle Live, from one real stream:**
      - at least 95% of genuine viewer questions are caught within 30 s;
      - no duplicate groups;
      - at least 70% of drafted replies are sendable as is or with a tiny edit;
      - zero false flags on friendly banter at the default sensitivity;
      - answered-on-air clears the right question at least 80% of the time;
      - the report's numbers match the stream.
    - **A2, Clean:**
      - zero bad cuts on a 10-minute tutorial, and at most 2 on a 30-minute
        video;
      - audio and video within 1 frame at the end;
      - for a 30-minute recording, ready within 10 minutes of Stop when the
        machine is idle.
    - **A3, Condensed:** the owner would publish the 15-minute version of a real
      2-hour stream after at most 3 segment toggles.
20. **Rollout.**
    - Phase 1 ships as a desktop release. The web copy deploys once that
      release is public.
    - Phase 2 deploys the web first, behind the capability flag, then ships the
      desktop release.
    - Phase 3 follows the same order as Phase 2.

## Slices

### Battle order

| Phase | Slice | Repo | Depends on |
| --- | --- | --- | --- |
| 0 | S0 Clean cut prototype on real recordings | none (findings doc) | — |
| 1 | S1 Orcle report and moments (backend) | desktop | — |
| 1 | S2 Orcle tab with Orcle Live | desktop | — |
| 1 | S3 Report card and Library entry | desktop | S1, S2 |
| 1 | S4 Remove Publish | desktop | S1–S3 |
| 1 | S5 Site copy and privacy | web | copy approved; deploys after the desktop release |
| 1 | S6 Smokes, probe, docs | desktop | S4 |
| 1 | S7 Review and owner acceptance A1 | both | S6 |
| 1 | S8 Carry missed questions into the next stream ⚑ optional | desktop | S7 |
| 2 | S9 Verbatim transcription chunks | web | S0 GO |
| 2 | S10 Clean-cut analysis job | web | S9 |
| 2 | S11 Session media grants and player | desktop | — |
| 2 | S12a Clean-cut jobs and transcription | desktop | S9 (or fake) |
| 2 | S12b The cut list | desktop | S12a, S10 (or fake) |
| 2 | S13 Render and derived session | desktop | S12b |
| 2 | S14 Clean cut card and review | desktop | S11, S13 |
| 2 | S15 Auto clean cut after Stop | desktop | S14 |
| 2 | S16 Fakes, smoke, docs | desktop | S15 |
| 2 | S17 Review and owner acceptance A2 | both | S16 |
| 3 | S18 Condensed selection | web | S17 |
| 3 | S19 Condensed mode | desktop | S18 |
| 3 | S20 Review and owner acceptance A3 | both | S19 |

### Phase 0: prove it

#### S0. Clean cut prototype on real recordings (fable-5, Diagnose; throwaway)

- **Goal:** prove that Clean cut can sound natural and run fast before any
  product code is written.
- **Depends on:** none. The owner provides three recordings: a ~10-minute
  tutorial, a ~30-minute talking-head video and a ~2-hour record+stream
  session.
- **Touches:** only the findings doc. Scripts live in the scratchpad or `/tmp`
  and are never committed (AGENTS.md).
- **Steps:**
  1. Transcribe each recording word for word, keeping fillers. Try Deepgram
     `nova-3` with `filler_words=true`, reading `words[]`. Also try one Gateway
     model if it exposes word timings.
     - Filler recall: measure it on a hand-checked 3-minute excerpt.
     - Word-boundary error: measure it in ms on 20 sampled words.
  2. Run `silencedetect` at 2–3 thresholds and compare the results with the
     gaps between words. Note the music and typing segments.
  3. Have a strong text model mark retakes and false starts by sentence id,
     with the prompt sketched in S10. Measure precision on the tutorial, where
     the owner marks the true retakes.
  4. Build a cut list with the decision 16 rules. Render it with the bundled
     FFmpeg, using frame-snapped cuts and trying 5, 10 and 20 ms fades. Measure
     render speed (× realtime) per recording on the owner's Mac.
  5. The owner watches the three outputs and reports bad cuts.
- **Done when:** `docs/acceptance/2026-10-xx-clean-cut-prototype.md` records:
  - the provider choice;
  - filler recall and boundary error;
  - silence thresholds and fade length;
  - retake precision and render speed;
  - the owner's GO or NO-GO;
  - the final decision 16 defaults.

  No media is committed.
- **Out of scope:** product code and UI.

### Phase 1: the Orcle tab ships (Orcle Live; Publish gone)

#### S1. Backend: Orcle report and moments (fable-5)

- **Goal:** every stream leaves a saved Orcle report that can be read later.
- **Depends on:** none.
- **Touches:**
  - `cohost.rs` and `cohost_ack.rs`.
  - A new `moments.rs`, holding `mark_moments`, `merge_moments`,
    `rank_chat_spike_moments`, `snap_to_cues` and `cue_excerpt`, moved with
    their tests from `publish_clips.rs`.
  - `CaptionCue` and `parse_srt` move out of `ai.rs` into `captions.rs` or a
    new `transcript.rs`.
  - `storage.rs`, `protocol.rs`, and `main.rs` (dispatch, plus the policy
    lists at `:5274-5285` and `:5450-5451`).
  - `shared/backend.ts`, `shared/backend-rpc-contract.ts`, `protocol-fixtures/`
    and `scripts/smoke-cohost-fake.mjs`.
- **Steps:**
  1. Add counters to `CohostSession` for each outcome:

     | Area | Counters (with source) |
     | --- | --- |
     | Questions | `markedAnswered` (`cohost.question.answered`); `dismissed` (`cohost.question.dismiss`; keep the current behaviour but count it separately); `replied` (`own_send_delivered` with a question id); `answeredOnAir` (`resolve_by_voice`); `restored`; `shownOnStream` (`observe_overlay`) |
     | Flags | raised, by kind and severity (count each new flag id once, in the merge loop near `cohost.rs:1925-1968`); dismissed |
     | Promises | heard; kept (done plus server-fulfilled); dismissed (split the shared arm at `main.rs:9078`); reminded |
     | Recap | offered, drafted, dismissed. Posting has no signal, so it is not counted |
     | Greetings | first-timers seen, and greeted by voice, by chat or manually |
     | Alerts | kinds raised, with peak viewers |

     For greetings, add an `AuthorLedger` accessor that walks `authors` with
     `first_message`. Do not use `first_timers`, which gets pruned.
  2. Keep a per-session question log, capped at 200 questions. For each:
     - text, up to 5 asker names, platforms, priority and first seen;
     - outcome: `open`, `answered-on-air`, `replied`, `marked-answered`,
       `dismissed` or `shown`.

     Also keep the promises still open at stop, capped at 20.
  3. Add `CohostSessionReport` with `version: 1`. Every optional field is
     `#[serde(default, skip_serializing_if = …)]`, to avoid the serde-null trap.
     Readers treat an unknown version as unavailable, never as an error.
  4. Change `stop_session` to build the report before `take()` and return it.
     - All four callers (`:4192`, `:4293`, `:4346`, `:4413`) save it after
       releasing the engine lock.
     - If the same session id comes back (Orcle turned off and on mid-stream,
       or a consent change), merge the reports: sum the counts, union the
       questions by id keeping the latest outcome, and keep the earliest
       `startedAt`.
  5. Create `cohost_reports` in `Database::migrate`:

     ```sql
     cohost_reports(
       session_id  TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
       version     INTEGER NOT NULL,
       report_json TEXT NOT NULL,
       updated_at  TEXT NOT NULL
     )
     ```

     Merge-upsert in one transaction. If the session row is missing, skip and
     log instead of failing.
  6. Compute moments on read; never store them. A moment is a clip mark or one
     of up to 3 chat peaks from `live_chat_messages`, snapped to the SRT cues
     with an excerpt.
  7. Add RPCs and an event:
     - `cohost.report.get {sessionId}` returns
       `{sessionId, report: CohostSessionReport|null, moments: Moment[], chat: {messages, byPlatform}}`.
     - `cohost.report.latest {}` returns the newest session that has a report,
       or else the newest streamed session.
     - Event `cohost.report.saved {sessionId}`.
     - Register them in the policy lists and the TS contract. Schemas stay
       closed and every optional field is optional. Add a protocol fixture.
  8. Rewrite the module doc at `cohost.rs:7-8`: live state stays in memory;
     after each stream a short report (counts, questions, open promises) is
     saved on this computer and deleted with the recording.
- **Done when:**
  - Rust tests cover:
    - every action bumps exactly one counter;
    - the mid-stream off/on merge;
    - the missing-session skip;
    - a serde round trip with optional fields missing;
    - a saved report through each of the four stop paths.
  - `pnpm smoke:cohost-fake` asserts that a report row exists, with the
    expected question and flag counts.
  - Contract tests are green.
- **Out of scope:** UI, carry-over, Publish.

#### S2. Renderer: the Orcle tab with Orcle Live (opus-4.8, UI/Product Design)

- **Goal:** the sidebar shows "Orcle" under Studio, and one switch turns Orcle
  Live on.
- **Depends on:** none.
- **Touches:**
  - Nav and icons: `components/workspace-nav.tsx`, `components/icons.tsx`,
    `lib/shortcuts.ts:24`.
  - `components/app-shell.tsx`: mount a new lazy `OrcleTab` in place of
    `AiTab`, and drop `selectedSessionId`, `openInAi` and the
    `videorc:open-publish` listener.
  - New files: `components/tabs/orcle-tab.tsx`, `lib/orcle-tab-view.ts` and its
    tests.
  - Orcle settings and copy: `components/cohost-settings-section.tsx`,
    `lib/settings-tabs.ts`, `components/tabs/settings-tab.tsx`,
    `lib/cohost-view.ts:210`.
  - `hooks/use-studio.tsx`: add `setOrcleLive`, and remove the post-stream pack
    wiring at `:2098-2105`, `:3909-3911`, `:6105-6107`, `:6301-6303` and
    `:13651-13680`.
  - Entry points that write only `enabled`: `components/cohost-status.tsx`,
    `components/stream-manager/stream-manager.tsx:781`,
    `comments/main.tsx:373-375`.
  - Tests: `workspace-nav.test.ts`, `settings-tabs.test.ts:49,58` and
    `settings-layout.test.ts:30,37,126`. The consent tests in
    `studio-provider.integration.test.ts` (`:7761`, `:7820`, `:7929`, `:8034`)
    must stay green.
- **Steps:**
  1. Identity, per decision 1. Draw `OrcleIcon` and review it by eye in both
     themes. Replace the `PublishIcon` and `CohostIcon` call sites.
  2. Page: a `PageHeader` with title "Orcle" and description "Your AI producer
     while you're live."
  3. The Orcle Live card:
     - A status line: Off · On, joins your next stream · Live now · Needs
       attention, with a plain reason from the existing presence and readiness
       helpers.
     - The switch "Orcle joins my streams".
     - The three powers.
     - While live, "Open Stream Manager" opens the Comments window, like the
       session-panel row does.
     - Gate states from the existing `liveCohostGate`: signed out shows Sign in;
       no Premium shows View Premium.
  4. Add `setOrcleLive(on)` to `use-studio.tsx` and expose it on the studio
     context.
     - On: if consent is missing, show the consent dialog with decision 3's
       copy. Then `setAiConsent(true)`, then one
       `cohost.settings.set {enabled: true, listen: true}`.
     - Off: `{enabled: false}`.
     - Point the Comments-window entry points (status popover, nudge, listen
       card) at the same behaviour through the existing relay.
  5. Customize, collapsed by default:
     - Mount `CohostSettingsSection` without its "Enable Orcle" switch (the
       card owns it now), and fix the "set in Publish" copy.
     - Add the Cloud AI row. It is the single home for `aiConsent` (grant and
       revoke), and its copy names Orcle reading chat and hearing you.
  6. Remove Settings → Orcle. A remembered `orcle` settings tab falls back to
     the default. Change "Turn it on in Settings → Orcle." to "Turn it on in the
     Orcle tab (⌘9)."
  7. Remove the post-stream pack auto-run and its preference now, because its
     switch disappears with Publish.
- **Done when:**
  - Renderer tests cover:
    - the nav identity;
    - `setOrcleLive`, including consent then settings patch, and the off path;
    - revoking consent;
    - removal of the Settings tab, and its fallback;
    - no `ai.run_post_recording` call on finalization, checked in the provider
      integration test.
  - `pnpm typecheck` passes.
  - By-eye screenshots of the tab in dark and light: glass, semantic colours
    only, untinted toasts.
- **Out of scope:** the report card (S3) and deleting Publish files (S4).

#### S3. Renderer: the report card and Library entry (opus-4.8)

- **Goal:** after a stream, the Orcle tab shows what Orcle caught.
- **Depends on:** S1, S2.
- **Touches:**
  - `components/tabs/orcle-tab.tsx`.
  - New `components/orcle-report-card.tsx`, plus `lib/orcle-report-view.ts`
    and its tests.
  - `components/tabs/library-tab.tsx`: remove the Publish button and menu item,
    add "Orcle report", and update the header copy at `:252`.
  - `shared/clip-marks.ts:27`.
  - `hooks/use-studio.tsx`: fetch the report and listen for
    `cohost.report.saved`.
  - Tests: `library-noise-cleanup.test.ts:48-58` (menu order).
- **Steps:**
  1. Build the "Last stream" card.
     - Header: date, duration and platforms.
     - Stats row: questions caught, answered on air, replied and missed; flags;
       promises kept and open; first-timers greeted; on screen.
     - Lists:
       - missed questions, each with text, askers and platform icons;
       - open promises;
       - moments: "You said 'clip that'", "Marked" and chat peaks, each with
         its time and excerpt;
       - alerts.
     - If Orcle was off for the last stream, show the moments and chat stats,
       plus "Turn on Orcle to also catch questions."
  2. Add a small session switcher for recent streamed sessions. A Library row
     menu item, "Orcle report", opens the tab on that session.
  3. Change the clip-mark toast to "Clip marked at 12:34" with the description
     "It's in your stream report in Orcle." This covers voice and manual marks.
- **Done when:**
  - View-model tests cover counts, empty states, caps and platform grouping.
  - The Library menu tests are updated.
  - A by-eye check passes with a real report from the fake-smoke session.
- **Out of scope:** carry-over (S8) and Clean cut links (S14).

#### S4. Remove Publish (gpt-5.5, Implementation)

- **Goal:** no Publish code, copy or RPC remains, and the shared
  infrastructure stays.
- **Depends on:** S1–S3.
- **Delete in the renderer:**
  - Whole files: `components/tabs/ai-tab.tsx`, `lib/publish-pipeline.ts`,
    `lib/post-stream-pack.ts` and its test, `hooks/use-post-stream-pack-auto.ts`,
    `lib/ai-workflow-status.ts` and its test.
  - `lib/ai-readiness.ts` and its test, unless the Orcle tab reuses it.
  - Parts of files:
    - The Publish-only helpers in `lib/format.ts:205-301` (keep `dayLabel`).
    - The `backendClient.ts:134-135` timeouts.
    - The Publish types in `shared/backend.ts` (`3029-3052`, `3091-3107`).
    - These studio-context items: `aiRunningSessionId`, `exportRunningSessionId`,
      `runAiWorkflow`, `exportPublishPack`, `suggestClips` and `exportClip`.
    - The AI-artifact detail fetch and the `ai.artifacts.changed` listener, if
      nothing else reads them.
  - **Keep:** `aiConsent`, `aiCapabilities` and `aiQuota`; the captions UI reads
    the last two (`captions-controls.tsx:188,303-307`).
- **Delete in the backend:**
  - Dispatch and policy entries for `ai.run_post_recording`,
    `ai.publish_pack.export`, `ai.clips.suggest`, `ai.clip.export`,
    `ai.artifacts.list` and `ai.jobs.get`.
  - The `ai.rs` workflow, export and render code, and their tests.
  - What's left of `publish_clips.rs` (the helpers moved in S1).
  - The dead-code cascade that `clippy -D warnings` will flag:
    `storage.rs` `save_ai_artifact`, `list_ai_artifacts` and
    `default_artifacts_dir`, plus the job and upload client functions in
    `videorc_api.rs`.
  - Delete `extract_audio` too if clippy flags it. S12a brings back what it
    needs.
  - **Keep:** the `ai_artifacts` table, its `sessions.list` join and
    `AiArtifactKind`. Old rows, the support bundle and the closed validators
    depend on them.
- **Defense in depth:** add a tolerant `processing_kind` reader. The backend
  maps unknown values to `None`, like `normalized_session_container`, and the
  renderer schema accepts the known set. Decision 12 still forbids writing new
  values.
- **Copy and docs:**
  - Update `README.md:11-13,49-51` and `docs/icon-set.md:26,128`.
  - Fix the comments in `page.tsx:15`, `navigable-row.tsx:9` and
    `kebab-menu.tsx:27`, and the stale comment in `cohost-pane.tsx:64-65`.
  - Leave historical acceptance records, changelogs and release records as
    they are.
- **Done when:**
  - This search returns only intentional hits, which the PR lists:
    `rg -n "Publish|publish-pipeline|post-stream-pack|ai\.run_post_recording|ai\.clips\.suggest|ai\.clip\.export|openInAi|open-publish" apps/desktop/src crates/videorc-backend/src`
  - Clippy is clean with `-D warnings`.
  - The RPC inventory test (`main.rs:14346-14358`, at least 175 arms) still
    passes.
  - Contract tests are green.
- **Out of scope:** the web.

#### S5. Web: site copy and privacy (opus-4.8 copy, gpt-5.5 tests)

- **Goal:** the website sells Orcle instead of Publish, and the privacy page
  describes the report.
- **Depends on:** copy approved by the owner. Deploy after the Phase 1 desktop
  release is public.
- **Touches:**
  - Every web file listed under "Web AI" above.
  - Delete the orphan `lib/publish-pipeline.ts`.
  - The substring filter in `lib/account/plan-features.ts:78`.
  - Tests: `tests/account-plan-features.test.ts:85`, `tests/orcle.test.ts:97`.
  - Fix the doc drift in `docs/ai-gateway.md:142,256`.
- **Steps:**
  1. Premium feature lines become "Orcle Live: your AI producer in every
     stream", and "AI publish pipeline" disappears. Clean cut lines come with
     Phase 2.
  2. The Orcle guide says a "clip that" lands in your stream report.
  3. The privacy page says Orcle keeps a per-stream report on your computer,
     and that nothing new is stored on Videorc servers.
- **Done when:**
  - Web `pnpm typecheck` and `pnpm test` are green.
  - `rg` finds no "Publish" product copy outside blog history.
- **Out of scope:** removing the publish-pack API, which old desktops still
  call (decision 9).

#### S6. Smokes, probe and docs for Phase 1 (gpt-5.5)

- **Goal:** maintained checks cover the report and the new tab.
- **Touches:**
  - `scripts/smoke-cohost-fake.mjs`: the report assertions, if S1 did not
    already add them.
  - A renderer probe that opens ⌘9 and finds the Orcle Live switch. Extend the
    tab list in `scripts/capture-ui-pages.mjs`.
  - A `docs/orcle-live.md` page covering the switch, consent, the report and
    privacy.
- **Done when:** `pnpm smoke:cohost-fake` and `pnpm test:scripts` are green,
  and the probe passes on the dev app.

#### S7. Review and owner acceptance A1 (fable-5, Review route)

- **Steps:**
  1. Review the Phase 1 PRs for:
     - the serde-null trap on every new optional field;
     - closed validators;
     - consent having a single home, with both grant and revoke;
     - no cloud call without consent;
     - the report's privacy copy;
     - a complete deletion.
  2. The owner streams for at least 45 minutes: multistream, recorded, with
     Orcle turned on through the new switch.
  3. A maintained script prints the session's chat (`live_chat_messages`, with
     question heuristics) next to the report's questions, as a local review
     sheet. The owner labels the genuine questions. No chat text is committed.
     - Call it `scripts/orcle-acceptance-sheet.mjs`, add a package script, and
       cover its pure parts in `test:scripts`.
     - If it doesn't earn a place in the tree, run it from the scratchpad
       (AGENTS.md: no untracked probes in the repo).
  4. Score against A1 (decision 19). Record numbers only, with no chat text, in
     `docs/acceptance/2026-10-xx-orcle-live.md`.
- **Done when:** either A1 passes and "(alpha)" is removed from the Orcle copy,
  or the failures are filed as follow-up plans and "alpha" stays.

#### S8. Optional: carry missed questions into the next stream (opus-4.8 UI, fable-5 backend) ⚑

- **Goal:** unanswered questions and open promises from the last stream come
  back when the next one starts.
- **Design:**
  - In the report, each item and the list as a whole get "Bring to next
    stream". The picks are stored in the `app_settings` key `orcleCarryOver`
    as JSON, capped at 20, newest first.
  - During the next stream, the Orcle pane shows a "From last stream" section
    with Done and Dismiss. This is renderer-only; the engine is not seeded.
  - The list clears after that stream.
- **Done when:** tests pass and the by-eye check passes.

### Phase 2: Clean cut

#### S9. Web: verbatim word-timed transcription chunks (gpt-5.5; provider eval fable-5)

- **Goal:** the desktop can get a word-timed transcript of a whole recording
  that keeps "um" and "uh".
- **Depends on:** S0 GO, which picks the provider.
- **Touches:**
  - New `app/api/ai/transcripts/chunks/route.ts`.
  - `lib/ai/transcription.ts`: a verbatim mode that returns `words[]`.
  - `lib/ai/captions.ts`: share the month-bucket helpers, and exclude the new
    prefix in `captionAllowanceRowsFilter`.
  - `lib/ai/jobs.ts`: the kill switch, and an access check modelled on
    `evaluateAiListenAccess` (`:347-412`).
  - `lib/ai/capabilities.ts` and its tests; `docs/ai-gateway.md`.
- **Steps:**
  1. Request: multipart `audio` (16 kHz mono PCM WAV, at most 120 s and 4 MB),
     plus `sessionClientId`, `chunkIndex`, `chunkStartMs` and an optional
     `language`. Validate the WAV like the caption-chunk route does, and
     compute the seconds server-side.
  2. Gate, in this order:
     1. global disable;
     2. blocklist;
     3. cloud AI (Premium);
     4. `VIDEORC_AI_CLEAN_CUT_DISABLED`;
     5. reserve the seconds atomically in `cleancut-quota-YYYY-MM`, against
        `VIDEORC_AI_CLEAN_CUT_MONTHLY_MINUTES` (owner sets it; placeholder
        1,200).

     Exclude the new prefix from caption totals.
  3. Provider: `VIDEORC_AI_VERBATIM_TRANSCRIPTION_{PROVIDER,MODEL}`, defaulting
     to S0's pick. For Deepgram `nova-3`, use `filler_words=true` and read
     `results.channels[0].alternatives[0].words[]`.
     - Response: `{chunkIndex, chunkSeconds, language, words[{text, startMs, endMs, confidence?, filler?}], text, remainingSeconds, monthlySecondsLimit}`.
     - Times are relative to the chunk. Nothing is stored.
  4. Capabilities: add `features.cleanCutEnabled` and a top-level
     `cleanCut{supported, available, reasonCode, maxChunkSeconds, monthlySecondsLimit, remainingSeconds, modes, workflowKind}`.
     Add new keys only.
  5. Add an eval fixture: a short WAV with known "um"s and "uh"s. Commit it only
     if it is tiny and synthetic, or the owner approves. The test asserts that
     fillers are kept and times are monotonic.
- **Owner action:** add the provider key to the Vercel env. Agents never read
  `.env` files.
- **Done when:** web `pnpm typecheck` and `pnpm test` are green, covering the
  route's gating order, the quota reservation and its exclusion from caption
  totals, the kill switch, the word mapping and the capability shape.

#### S10. Web: the clean-cut analysis job (fable-5)

- **Goal:** given a long transcript, return the retakes and false starts by
  sentence id, plus beats for Phase 3.
- **Depends on:** S9's capability block.
- **Touches:**
  - `lib/ai/jobs.ts`: the kind `post-recording-clean-cut` and a per-kind daily
    limit.
  - `lib/ai/job-runner.ts`: dispatch by kind, and checkpoint each window under
    the run lease.
  - New `lib/ai/clean-cut.ts`: schemas, prompt, windowing, provenance check,
    reduce.
  - `app/api/ai/jobs/route.ts`: accept the kind, and set `maxDuration`.
  - Tests and eval fixtures.
- **Steps:**
  1. Input: `{mode: 'clean'|'condensed', durationMs, targetDurationSeconds?, segments[{id, startMs, endMs, text}]}`.
     The segments are sentences from the desktop, at most 25k. The job has its
     own caps, not the 120k publish cap.
  2. Map step:
     - Work in 10–15-minute windows that overlap by one window.
     - Strict output schema:
       `drops[{fromId, toId, kind: 'retake'|'false_start', confidence, reason}]`,
       with `beats[]` reserved for Phase 3.
     - The server rejects ids that were not in the request (the Orcle
       provenance rule) and merges overlaps.
  3. Job mechanics:
     - Checkpoint each window's result, with bounded parallelism.
     - Write one usage row per window.
     - Namespace `clientRequestId` as `cleancut:…`.
     - Return the result as `artifacts.cleanCut`.
  4. Model env `VIDEORC_AI_CLEAN_CUT_TEXT_MODEL` with fallbacks, plus timeout
     and max-token envs.
  5. Eval: the S0 tutorial transcript with the owner's marked retakes. Target
     precision of at least 0.8 at confidence 0.6 or higher. This is documented,
     not a CI gate.
- **Done when:**
  - Unit tests cover window math, provenance rejection, merging, checkpoint
    resume, idempotency and the per-kind limit.
  - The eval numbers are in the PR.

#### S11. Desktop: session media grants and a seekable player (fable-5)

- **Goal:** the renderer can play and seek a recording safely.
- **Depends on:** none.
- **Touches:**
  - Main process: `main/index.ts` (the new `session-media` host),
    `main/resource-capabilities.ts` (the grant registry), and a new
    `main/session-media.ts` with tests.
  - `preload/index.ts` and `shared/renderer-security-policy.ts`: the
    main-window-only IPC `media:grant-session`.
  - New renderer `components/media/session-player.tsx` (lazy) and its tests.
- **Steps:**
  1. Grants.
     - The IPC takes `{sessionId, which: 'source'|'derived'}` and resolves the
       path through `resource.admin.resolve_session_path`.
     - It only serves finalized `.mp4` regular files, and returns
       `{url, expiresAt}`.
     - A grant lasts 10 minutes, can be renewed, and is revoked when its window
       closes.
     - The Comments window cannot mint grants.
  2. Serving.
     - Parse a single `Range` header. Answer 206 with `Content-Range`,
       `Accept-Ranges: bytes` and `Content-Length`; 200 when there is no Range;
       416 when the range can't be satisfied.
     - Stream with `fs.createReadStream({start, end})` and
       `Content-Type: video/mp4`.
     - Re-check the file's identity (size and mtime) on every request.
  3. Player.
     - `<video>` with custom controls: play/pause, scrub, time, and the keys
       Space, ← and →.
     - No fullscreen; the permission stays denied.
     - A `skipRanges` prop jumps over removed ranges on `timeupdate` or
       `requestVideoFrameCallback`. This gives the virtual preview.
- **Done when:**
  - Main-process tests cover traversal, symlinks, unknown grants, expiry, the
    wrong window, and Range math including suffix ranges and 416.
  - Renderer tests pass.
  - The existing CSP test passes unchanged.
  - Manual check: a 2-hour recording seeks instantly.

#### S12a. Desktop backend: clean-cut jobs and transcription (fable-5)

- **Goal:** a durable job that gets a verbatim transcript for a recording.
- **Depends on:** S9 (or a fake service), and the S0 parameters.
- **Touches:**
  - New `clean_cut.rs`, split into `clean_cut/` submodules if it grows large.
  - `storage.rs`: the table and the chunk progress.
  - `main.rs`: RPCs and policy, startup requeue, shutdown interrupt, and
    mutation guards on delete, duplicate, remux and repair, as noise cleanup
    has.
  - `videorc_api.rs`: the chunk upload client.
  - `protocol.rs`, `shared/backend.ts`, `shared/backend-rpc-contract.ts` and
    fixtures.
- **Steps:**
  1. Create the table:

     ```sql
     clean_cut_jobs(
       id, source_session_id → sessions ON DELETE CASCADE,
       mode, state, step, progress, source_identity_json,
       transcript_path, analysis_json, edl_json, edl_revision,
       output_session_id, error_code, error_message,
       created_at, updated_at
     )
     ```

     A partial unique index allows one active job per source and mode.
  2. Add RPCs and an event:
     - `cleanCut.start {sessionId, mode, consentToUploadAudio}`
     - `cleanCut.get {sessionId}`
     - `cleanCut.list`
     - `cleanCut.cancel {jobId}`
     - `cleanCut.updateEdl {jobId, revision, removals[]}`
     - `cleanCut.render {jobId}`
     - Event `cleanCut.status`.

     Eligibility follows decision 11, adapted from `noise_cleanup.rs:788-848`.
     A job also needs the entitlement, `cleanCut.available` and consent.
  3. States:
     `queued → transcribing → analyzing → ready (cut list built) → rendering → validating → completed | failed | cancelled`.
     The heavy steps follow decision 18.
  4. Audio.
     - FFmpeg writes 16 kHz mono PCM WAV chunks of at most 120 s. Each chunk
       ends at the quietest point within the last 10 s of its window, and
       chunks overlap by 1 s.
     - Upload one chunk at a time, at most 2 in flight. Save each chunk's
       words, so the job resumes after a crash or quit.
     - Stitch by offsetting each chunk by `chunkStartMs` and dropping duplicates
       in the overlap by time.
     - Save `transcript.words.json` under the source session's app artifacts
       directory.
  5. Running out of minutes, the kill switch and being signed out each mark the
     job `failed`, with a reason code and a plain message. These jobs can be
     resumed.
- **Done when:**
  - Rust tests cover the state machine, eligibility, preemption, resuming from
    chunk N, stitching across the overlap, and mapping quota failures.
  - A fake transcript service in `scripts/lib/` has a Node test.

#### S12b. Desktop backend: the cut list (fable-5)

- **Goal:** turn words and audio into an exact, explainable cut list.
- **Depends on:** S12a, and S10 (or a fake).
- **Touches:** `clean_cut/edl.rs` (pure), `clean_cut/silence.rs` (a
  `silencedetect` runner and parser), `clean_cut/analysis.rs` (the web job
  client), and tests.
- **Steps:**
  1. Group words into sentences with ids, using punctuation and pauses. These
     are S10's input.
  2. Apply the local removals from decision 16: head and tail, silences,
     non-silent gaps, and fillers. Fillers are provider-tagged or come from a
     lexicon (English in v1).
  3. Map S10's drops from ids to times. Drops at confidence 0.6 or higher are
     on; lower ones become switched-off suggestions.
  4. Merge:
     - sort the removals and merge overlaps;
     - absorb kept slivers shorter than 250 ms;
     - snap every boundary to the source's frame grid, taken from ffprobe
       `r_frame_rate`, so audio and video segments have equal lengths.

     Every removal keeps its `kind`, `reason`, `confidence` and `enabled` state.
  5. Write `edl_json` v1:
     `{version, sourceIdentity, frameRate, durationMs, removals[], stats{byKind, keptMs}}`.
- **Done when:** table tests cover:
  - fillers at the edges, and back-to-back fillers;
  - overlapping drops;
  - frame snapping that keeps cumulative drift at 0 over 500 cuts;
  - music gaps left alone below the threshold;
  - an empty transcript, which trims only head and tail, by audio.

#### S13. Desktop backend: render and the derived session (fable-5)

- **Goal:** the cut list becomes a new MP4 next to the original, exact and in
  sync.
- **Depends on:** S12b.
- **Touches:**
  - `clean_cut/render.rs`.
  - `storage.rs`: `complete_clean_cut_derivative`, modelled on
    `complete_noise_cleanup_derivative`.
  - The file-operation journal, or a separate table (decision 12).
  - A capability probe, as noise cleanup does.
  - The package capability gates: `scripts/lib/repair-encoder-capabilities.mjs`,
    `scripts/lib/windows-ffmpeg-capabilities.mjs` and
    `scripts/lib/ffmpeg-linux-pin.mjs`, which must require the filters used.
  - The re-timed SRT, in `captions.rs` or `transcript.rs`.
- **Steps:**
  1. Render in one FFmpeg pass.
     - Use `trim`/`atrim` with `setpts`/`asetpts` and `concat`, or
       `select`/`aselect` when there are many ranges. Choose by S0's speed
       numbers.
     - `afade` at each join, at the S0 length; hard video cuts.
     - Encoder by platform, from the recording table:
       - macOS: VideoToolbox.
       - Windows: `h264_mf`, falling back to `libopenh264`.
       - Linux: `h264_vaapi` if the probe passes, else `libopenh264`.
     - Match the source's bitrate (from ffprobe). Keep the same size, fps and
       BT.709 tags, and add `+faststart`. Encode AAC at the source's rate.
     - ffprobe the track list first, and cut every audio track the same way.
  2. Report progress from `-progress pipe:1`, measured against the kept
     duration. Cancelling kills the owned child process. If a capture preempts
     the render, re-queue it.
  3. Validate before publishing: the ffprobe duration must equal the kept
     duration within 1 frame; audio and video durations must match within
     1 frame; stream counts must equal the source's. Otherwise fail and delete
     the partial file.
  4. Publish.
     - Write to a temp file, then rename it atomically to
       `"<stem> (Clean cut).mp4"`.
     - Insert the derived row with `complete_clean_cut_derivative`:
       `derived_from_session_id` set, **`processing_kind` NULL**.
     - Link it via `clean_cut_jobs.output_session_id`. `sessions.list` gains
       `cleanCutOfSessionId`, computed by a join. The new backend and renderer
       ship together, so the new field is safe.
     - A re-render replaces the same derived file and row.
  5. Journal: first prove what an older backend does at startup with an unknown
     `session_file_operations.kind` (`main.rs:473`, `storage.rs:4081`). If it
     errors, do not use the shared journal.
  6. Write a re-timed SRT, `"<stem> (Clean cut).srt"`, by mapping the source
     cues or words through the cut list.
  7. Check free space first. If there is less than 1.2 × the source size,
     refuse with a plain message.
- **Done when:**
  - Rust tests cover the filter-graph builder, the encoder fallback chain and
    the validation math.
  - A test proves downgrade safety for the journal choice.
  - A fixture render passes in `test:scripts` or the S16 smoke.

#### S14. Renderer: the Clean cut card and review (opus-4.8, UI/Product Design)

- **Goal:** users turn Clean cut on once, see their edited copies, and fix a
  cut in seconds.
- **Depends on:** S11, S13.
- **Touches:**
  - `components/tabs/orcle-tab.tsx`.
  - New `components/clean-cut/*` (card, review, transcript editor, chips), all
    lazy.
  - `lib/clean-cut-view.ts` and its tests.
  - `hooks/use-studio.tsx`: the RPCs and `cleanCut.status`.
  - `components/tabs/library-tab.tsx`: the "Clean cut" row menu item, plus a
    badge and "· cut from {source}" on the derived row.
  - The page description becomes "Live with you. Edits after.", and the Cloud
    AI copy adds Clean cut.
  - The web follow-up adds the Clean cut site copy (S5 pattern).
- **Steps:**
  1. The card.
     - Heading: "Clean cut · Stop recording, and the edited version is already
       there."
     - The switch "Make a clean cut of every recording": opt-in once, with the
       same consent, Premium and sign-in flow as S2.
     - The latest recording's status: Waiting until you stop streaming ·
       Transcribing 40% · Cutting · Ready: 42:10 → 31:05 · Failed, with Retry.
     - "Make a clean cut" for any eligible recording, through a session picker.
     - Minutes left this month.
  2. The review.
     - The S11 player on top, with a virtual preview that skips the enabled
       removals.
     - The transcript below, with removed spans struck through and coloured by
       kind using semantic tokens.
     - Chips per kind (Silences · Ums · Retakes · Start/end) with counts; a chip
       toggles its whole kind. Clicking a span restores or removes it.
     - Moments from the Orcle report appear as pins.
     - "Save changes" calls `cleanCut.updateEdl`, then `cleanCut.render`.
     - Keyboard-first: Space plays and pauses, ← and → seek, Enter toggles the
       selected span.
  3. A ready toast, once per job: "Your clean cut is ready (42:10 → 31:05)",
     with a "Review" action.
- **Done when:**
  - View-model tests cover stats, toggles, revision conflicts and status
    mapping.
  - Component tests pass.
  - By-eye screenshots in dark and light.
  - The transcript editor stays smooth with 30k words (virtualized list).
- **Out of scope:** Condensed (S19).

#### S15. Desktop: auto clean cut after Stop (gpt-5.5)

- **Goal:** with the switch on, every recording gets its clean cut without a
  click.
- **Depends on:** S14.
- **Touches:**
  - `hooks/use-studio.tsx`: on a `recording.finalization` event with state
    `finalized`, call `cleanCut.start` once per session, but only if auto is
    on and there is consent, Premium and the capability. Keep a ledger of
    attempted ids, like the old pack did.
  - `clean_cut.rs`: wait until the session's post-recording quality gate has
    finished before binding the source identity (`recording.rs:843`, `:10208`).
- **Done when:**
  - Tests cover:
    - one start per session;
    - no start without consent, Premium or the capability;
    - no start for stream-only or imported sessions;
    - gate sequencing, where a source repaired in place leads the job to bind
      the repaired file.
  - If the backend finalization code changed, `pnpm smoke:record-latency` and
    `pnpm smoke:recording-studio` pass.

#### S16. Fakes, smoke and docs for Clean cut (gpt-5.5)

- **Goal:** Clean cut is covered end to end without real providers.
- **Touches:**
  - `scripts/lib/fake-transcript-service.mjs`, which returns words and fillers
    from a script, and a fake analysis job.
  - A new `scripts/smoke-clean-cut-app.mjs`, wired up as `smoke:clean-cut` in
    `package.json`. It runs:
    1. record a short synthetic clip with scripted speech and silence, using
       the existing stimulus helpers;
    2. Stop, which triggers the auto job, then the render;
    3. check with ffprobe and the analyzer:
       - the duration matches the cut list;
       - audio and video are within 1 frame;
       - no frozen frames at the joins;
       - the SRT is re-timed.
  - Add the smoke to `smoke:local-gates` if it runs in 3 minutes or less.
  - `docs/clean-cut.md`.
- **Done when:** `pnpm smoke:clean-cut` and `pnpm test:scripts` are green on the
  dev app.

#### S17. Review and owner acceptance A2 (fable-5, Review route)

- **Review:**
  - the player protocol's security;
  - the consent and upload copy;
  - quotas;
  - serde and contract traps;
  - how the maintenance slot interacts with noise cleanup and repair;
  - downgrade safety (decision 12);
  - the Windows and Linux encoder paths. Use real Windows and Linux machines,
    or CI compile plus documented gaps.
- **Owner:** runs the three S0 recordings through the product and checks the
  A2 bar.

### Phase 3: Condensed

#### S18. Web: condensed selection (fable-5)

- **Map step:** per window, beats with a title, importance from 0 to 1, a
  standalone flag and hook/close flags. The provenance check applies.
- **Reduce step:** deterministic, to within ±10% of the target.
  - Always keep the hook and the close.
  - Keep the must-keep ids the desktop sends: marks with surrounding context,
    and chat peaks.
  - Prefer high-importance contiguous runs.
  - Avoid dangling references: keep the setup a payoff refers to.
- **Output:** kept ranges with titles.
- **Evals:** on the owner's 2-hour stream; the owner rates the result.

#### S19. Desktop and renderer: Condensed mode (fable-5 backend, opus-4.8 UI)

- A mode switch on the card, and "Condense" in Library.
- Target 10, 15, 20 or 30 minutes, default 15. Offered for recordings of at
  least 25 minutes.
- Keep hints come from the S1 moments.
- The cut list is the complement of the kept ranges, plus the Clean removals
  inside those ranges.
- The output is a separate derived session, `"<stem> (Condensed)"`.
- The review shows segment blocks with titles that can be toggled. Changing the
  target re-runs only the reduce step.

#### S20. Review and owner acceptance A3 (fable-5)

- Run the same review list as S17. The owner checks the A3 bar on a real
  2-hour stream.

## Edge cases

**Orcle report**

- Orcle turned off and on mid-stream, or a consent change: one report, merged
  (S1).
- Signing out mid-stream purges speech-derived promises (`cohost.rs:4069-4097`).
  The report then holds whatever remains at stop. This is documented, not a
  bug.
- App crash mid-stream: `stop_session` never runs, so there is no report in v1.
  The PR states this.
- A stream-only session has a session row, so it gets a report. It has no
  marks, because marks need a recording.
- The session row is missing: skip and log (S1).
- Deleting a session deletes its report through the cascade.
- Older app versions ignore the new tables.

**Clean cut**

- A capture starts during the render: the render is preempted and re-queued.
  Nothing uploads while live.
- The source file is moved or deleted: the job fails with "The recording file
  is missing".
- The quality gate repairs the source in place: S15 sequences the job after
  the gate.
- Out of minutes mid-transcription: the job pauses at chunk N and resumes later
  without redoing any chunk.
- A 4-hour recording is about 120 chunks. The job shows progress and can resume
  at any chunk.
- No speech at all: only head and tail are trimmed, by audio; otherwise the job
  ends with "No speech found, nothing to cut".
- Music, game sound or typing in the gaps: decision 16's rule for wordless
  gaps that aren't silent.
- Multiple audio tracks: all are cut the same way (S13 probes them).
- Imported or variable-frame-rate sources: not eligible in v1.
- Deleting the derived session leaves the source untouched, and the job records
  that its output is gone.
- Low disk space: refused up front (S13).
- No usable encoder on Windows or Linux: the job fails with the encoder named,
  and the PR records the gap.
- Downgrade: the derived row shows as a plain session in older apps. Journal
  safety is proven in S13.

**Publish removal**

- An older desktop calls the publish-pack routes: they keep working
  (decision 9).
- A remembered Settings tab of `orcle`: falls back to the default.
- Deep links or smokes using tab id `ai`: they open the Orcle tab.

## Out of scope

- Publish helpers of any kind: titles, descriptions, chapters, social posts,
  YouTube or VOD edits, announcements and uploads.
- Shorts or vertical clips, and file export of clip marks (⚑ decision 7).
- Thumbnails, smart zoom, B-roll and AI effects.
- New live Orcle powers, and any automatic moderation action.
- Live translation.
- Imported or variable-frame-rate videos and non-English filler lists. Both are
  later extensions.
- Any edit beyond removing ranges: no reordering, no transitions.
- Deleting the web's publish-pack routes. That is a follow-up after usage
  drains (decision 9).

## Verification gates

Run once at the end of each phase. Cheap typechecks mid-way are fine.

**Phase 1, desktop**

- TypeScript:
  - `pnpm typecheck`
  - `PATH=/opt/homebrew/bin:$PATH pnpm lint`
  - `pnpm format:check`
  - `PATH=/opt/homebrew/bin:$PATH pnpm --filter @videorc/desktop test`
  - `pnpm test:scripts`
- Rust:
  - `cargo fmt --check --all`
  - `cargo clippy -p videorc-backend -- -D warnings`
  - `env -u VIDEORC_PREMIUM_FEATURES cargo test -p videorc-backend <filter>`
    for `cohost`, `clip_marks`, `moments`, `storage`, `protocol`, `live_chat`,
    and the RPC inventory test in `main.rs`
  - `cargo build --release -p videorc-backend`
- Build and assets:
  - `PATH=/opt/homebrew/bin:$PATH pnpm build`
  - `pnpm check:renderer-assets`, compared by raw bytes against main
- Smokes and probes:
  - `pnpm smoke:cohost-fake`
  - `pnpm smoke:captions-contract`
  - `pnpm probe:comments-window`
  - `pnpm smoke:remote-control` (the `clipMark` intent)

**Phase 1, web:** `pnpm typecheck` and `pnpm test`.

**Phase 2, desktop:**

- Everything from Phase 1.
- Cargo filters `clean_cut` and `noise_cleanup`.
- `pnpm smoke:clean-cut`.
- `pnpm smoke:noise-cleanup`, because Clean cut shares its slot and journal
  patterns.
- If S15 touched backend finalization code: `pnpm smoke:record-latency` and
  `pnpm smoke:recording-studio`.
- The Windows and Linux encoder paths compile in CI. Behaviour checks happen on
  the named machines, or the gaps are written down.

**Phase 2, web:** `pnpm typecheck`, `pnpm test`, plus the eval numbers in the
PR.

**Phase 3:** the Phase 2 gates, plus evals.

**Release (each phase):** follow the videorc-release skill, including the fresh
D3 capture-decay acceptance. The release notes say "Publish is now Orcle"
(Phase 1) and introduce Clean cut (Phase 2). Changelog entries are written only
at release time.

## Owner actions

1. Provide the three S0 recordings, then watch the prototype outputs and give a
   GO or NO-GO.
2. Approve the Orcle Live copy and the site and privacy copy (S2, S5).
3. Do the A1 stream (S7) and label the questions.
4. Set the Clean cut monthly allowance, and add the verbatim transcription
   provider key to the Vercel env (S9).
5. Answer the ⚑ decisions: 7 (clip export), 9 (old clients), 11 (allowance) and
   S8 (carry-over).
6. Approve each phase release.

## Handoff (cold start)

- **Goal:** replace the Publish tab with **Orcle**, Videorc's AI tab, which
  sits directly under Studio. It launches with two features:
  - **Orcle Live:** the existing live AI producer, with one switch, consent and
    settings in the tab, and a report after every stream.
  - **Clean cut:** after Stop, an edited copy with silences, "um"s, false
    starts and retakes removed. Phase 3 adds a Condensed mode that turns a long
    stream into about 15 minutes.
- **Order:**
  - Phase 0 (S0) runs first and in parallel with Phase 1.
  - Phase 1: S1 and S2 can run in parallel, then S3 → S4 → S6 → S7. S5 is web
    copy and deploys after the desktop release.
  - Phase 2: S9 → S10 on the web, S11 in parallel on the desktop, then
    S12a → S12b → S13 → S14 → S15 → S16 → S17.
  - Phase 3: S18 → S19 → S20.
- **Start:**
  1. Run the drift check.
  2. Create a worktree from `origin/main`.
  3. Read `AGENTS.md`, `CLAUDE.md` and the design skill.
  4. Run S1 with the `fable-5` lane and S2 with the `opus-4.8` lane.
- **Research basis:** four read-only investigations on 2026-10-03 against
  desktop `6f9995eb` and web `5e429e03`, covering the Orcle engine and
  surfaces, Publish's blast radius, the Clean cut foundations and the web AI
  server. The measured facts are summarized under "What exists today" above.
