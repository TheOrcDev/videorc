# Plan 191: Performance pass: leaks, wasted work and measured wins

> **Executor instructions**: This plan has two halves. **Part A** lists the
> fixes, one PR each, all merged on 2026-10-24. **Part B** holds the decisions only the owner
> can make and the follow-up slices that need a quiet host, a Windows box, or
> a measurement first. Work Part B one slice at a time: read the slice's
> evidence, run its "Done when" checks, and stop and report on any STOP
> condition instead of improvising. When a slice or PR lands, update its row
> here and in `plans/README.md`.
>
> **Drift check (run first, every slice)**:
> `git log --oneline 0db1e5bc..origin/main -- <the slice's files>`
> Line numbers were read at `63f9bb6e`/`0db1e5bc`. If an anchor moved, re-find
> it by symbol. If the *behaviour* changed (not just a line number), that is a
> STOP condition for that item.

## Status

- **Priority**: P1. Every Part A fix is measured or mechanically certain, low
  risk, and invisible to users. Part B's owner decisions carry the largest
  remaining idle cost.
- **Effort**: Part A was 16 findings of S–M each, worked overnight: 13 merged
  PRs, 2 closed after measurement (A5, A7), 1 stopped and moved to Part B
  (A15), plus the CI fix #777. Part B is M–L in total.
- **Risk**: LOW for Part A (behaviour-preserving by construction, each with
  its own gate list). MEDIUM for the Part B items that touch real-time audio,
  the preview window, or Chromium process flags.
- **Depends on**: none. No Part A PR depends on another.
- **Category**: perf
- **Planned at**: audited at `63f9bb6e` (desktop 0.9.148); PRs branch from
  `0db1e5bc` (origin/main, 2026-10-24).
- **Route**: Orchestrator owns it (fit 10); Diagnose (fit 9) for the
  measurements. Each PR was written by one executor subagent in its own
  worktree off `origin/main`, then reviewed by the orchestrator before it was
  marked ready. Per `CLAUDE.md`, the Part B slices that touch audio, the
  preview, or Chromium flags are `fable-5` work; the rest are `gpt-5.5`.

## How the audit was done

1. **Seven read-only audits in parallel**, one per subsystem, each working from
   the improve skill's performance playbook: the main-window renderer, the
   Electron main process and secondary windows, the compositor and native
   preview, recording/encoding/audio, the backend server/storage/network
   services, build/bundle/perf tooling, and the Windows and Linux paths. A
   process restart cut off the compositor and tooling audits; the
   orchestrator covered their highest-value questions by hand (sections
   N2, N10).
2. **Every finding was re-read at its `file:line` by the orchestrator** before
   it became a PR or a slice. Several agent claims were corrected or rejected;
   see "Considered and rejected".
3. **Measurements on this Mac, always on copies**, never on the live files or
   the running app: a census of the owner's real profile, `EXPLAIN QUERY PLAN`
   and timings of the real Library query against a copy of the real 90 MB
   database, WAL-vs-rollback insert cost, the cost of one `ps` sample, and the
   Windows preview resize in an offline release benchmark built with the same
   `image 0.25.10`.
4. **Not measured**: live idle CPU/RSS of the running app. The machine sat at
   load average 40–100 from other sessions' builds all night, so any number
   would have been noise. That is slice N1.

## What we measured

| Fact | Where | Number |
|---|---|---|
| Chromium HTTP disk cache | `~/Library/Application Support/Videorc/Cache` | **~2 GB**, 472,796 files. 471k of them are `404 Not Found` (empty body, no `Cache-Control`) for `http://127.0.0.1:<port>/preview/{camera,screen}/live.png?…&t=…`, written June–July 2026. Each takes a 4 KB block; Chromium never evicts them because their logical size stays under its cap. The rest are Vite dev modules from `pnpm dev` runs of many worktrees plus a few avatars. |
| App database | `videorc.sqlite3` | 90 MB, `journal_mode=delete`, `auto_vacuum=0`; 3,865 sessions, `sessions.diagnostics_json` averages 10.9 KB/row (~42 MB), 58,680 `session_logs`, 35,286 `health_events`, 3,538 `repair_jobs`, oldest rows 2026-05-31 |
| Library page query | `storage.rs` `list_session_items_page` | **111–144 ms** median per page (95 ms best) on the real data; a page deep in the list 133 ms. `EXPLAIN QUERY PLAN`: full scans of the health/log/artifact/chat indexes and of `repair_jobs`, for a 51-row page. With the page pinned as the outer loop plus two indexes: **6.1 ms** median (1.6 ms best); deep page **2.8 ms**; identical rows. |
| Database writes | 300 autocommit `health_events` inserts | rollback journal: **2.1–2.6 ms/insert**; WAL at the same `synchronous=FULL`: **0.08–0.75 ms/insert** |
| `ps -axo pid=,ppid=,rss=,comm=` | backend resource sampler, once per second for the backend's lifetime | **~32 ms system CPU per sample** (278 ms wall under load) → about 3% of a core, all day, whenever the app is open |
| Windows preview resize | `preview_bmp.rs` `image::imageops::resize(Triangle)` per changed frame | 1080p→800: **9.5 ms**; 1080p→1280: **17 ms**; 1440p→1120: **25 ms**; 4K→1920: **56 ms** CPU per frame (Apple Silicon; weak Intel iGPU laptops are slower). The proof surface polls at up to 25 Hz. |
| Logs, posters, avatar cache | app data | fine: backend log rotates at 2 MB × 2; 2,231 posters (21 MB); 276 avatars (7 MB) |

## What is already good (keep it)

Verified by the audits (spot-checked by the orchestrator) and worth copying:

- WebSocket fan-out serializes once per connection, high-rate events go
  through a latest-wins coalescing lane with per-connection filters, and
  `preview.frameReady` is muted while main pumps (`main.rs` ~5017–5124).
- Telemetry reaches React at most 1/s (`TELEMETRY_UI_COMMIT_INTERVAL_MS`),
  20 Hz audio levels never touch React state (`lib/backend-audio-levels.ts`
  store + CSS custom properties in `level-meter.tsx`), and present reports are
  throttled to 250 ms.
- Compositor → bridge → FFmpeg is zero-copy (`frame_store.rs` pooled,
  `Arc`-pinned frames; VideoToolbox encodes the retained IOSurface).
- Every long buffer is bounded: chat 2,000 view / 200 rendered (virtualized),
  logs 80, health events 40, caption lines 50, FFmpeg stderr tail and line
  length, metrics/FFmpeg log dirs (200 MB caps), backend log 2 MB × 2.
- Live chat persistence is batched off the async runtime (`spawn_blocking`,
  one transaction per burst); every chat/viewer connector task is aborted on
  stop; reconnects back off (0.5–30 s).
- Listener/timer/observer hygiene in the renderer is clean (every
  `addEventListener` has its removal, observers disconnect, object URLs are
  revoked, AudioContexts close, mic tracks stop).
- The Windows proof surface skips unchanged frames with a 204 before any copy,
  right-sizes `maxWidth` to the drawable, and stops polling when suspended.

## Part A: fixes shipped as PRs (one problem each)

Each PR was opened as a draft by its executor and reviewed by the
orchestrator (diff read in full, gates re-run, scope checked), then marked
ready. On 2026-10-24, at the owner's request, all 13 plus #777 were
squash-merged onto `aa4eee4f`, #777 first. Main after the last merge
(`b9ae4d8b`) has exactly the tree that was checked as one combined merge (see
Combined verification).

| # | PR | Problem | Evidence | Fix | Measured / expected | Status |
|---|---|---|---|---|---|---|
| A1 | [#764](https://github.com/TheOrcDev/videorc/pull/764) perf/191-http-cache | ~2 GB of stale cached 404s; backend errors carry no `Cache-Control`, so any polled route refills the cache | Cache census above; `main.rs` 401/404 paths (`live_camera_frame_handler`, `preview_handler`, `session_poster_handler`) return bare `StatusCode` | Router-wide `no-store` default unless a handler set its own; one-time `session.defaultSession.clearCache()` per profile (marker `http-cache-cleanup.json`), 15 s after start | ~2 GB reclaimed on affected profiles; nothing new accumulates | **merged** `663ea85b` |
| A2 | [#773](https://github.com/TheOrcDev/videorc/pull/773) perf/191-library-query | Library page reads every row of five tables per page | Plan output above | `CROSS JOIN` pins the page as the outer loop for all six history joins; indexes `repair_jobs(file_path, status)`, `clean_cut_jobs(output_session_id, updated_at DESC, id DESC)` | 111–144 ms → 6 ms (identical rows); the plan test demands stored-index searches for every history table and fails on the old SQL; storage 130/130, session 352/352 | **merged** `75176c78` |
| A3 | [#770](https://github.com/TheOrcDev/videorc/pull/770) perf/191-sqlite-wal | Rollback journal: a journal file created, written, fsynced and deleted per write, under the one connection mutex | No `journal_mode` PRAGMA anywhere; owner DB `journal_mode=delete` | `enable_write_ahead_log` on the production and test opens (a refusal only warns); `synchronous` stays FULL (bundled SQLite 3.50.2 defaults FULL for WAL too; a test asserts it); copy/backup audit clean | 2.1–2.6 → ~0.1–0.75 ms per write; 131/131 storage tests now run in WAL | **merged** `8955dcf9` |
| A4 | [#760](https://github.com/TheOrcDev/videorc/pull/760) perf/191-comments-push | Every chat message's push to the Stream Manager returns the whole ≤2,000-message view, deep-validated and cloned back to a caller that discards it | `index.ts` `comments-window:push-delta`/`push-snapshot` handlers; renderer API typed `Promise<void>` | Handlers resolve `undefined`; the IPC contract declares a void result, so a future value fails loudly | One ~0.5–1 MB walk + clone less per chat message | **merged** `5661c5f1` |
| A5 | [#759](https://github.com/TheOrcDev/videorc/pull/759) perf/191-startup-spawn | Every macOS launch was thought to wait for a GPU-process round trip before spawning the backend | `primeScreenCapturePermission` awaits `runtimeInfo()` (→ `app.getGPUInfo('basic')`) before reading the permission | Read the permission first | **Measured: 0.16–1.04 ms** on Electron 39.8.10 (`getGPUInfo('basic')` settles from main-process data, 5 of 5 probe runs), so it saves under 1 ms per launch | **closed, not worth it** |
| A6 | [#763](https://github.com/TheOrcDev/videorc/pull/763) perf/191-core-context | Caption partials, Buddy bubbles and other sessions' health lines republish the core Studio context (73 consumers) | `use-studio.tsx` core memo holds `captionLines` (2 readers) and `buddyOverlay` (0 readers); `openCaptionsWindow` listed `captionLines` in its deps (core + shell churn); `setSessions` maps to a new array even when no row matches | `StudioCaptionsContext` inside the render-testable provider boundary; `buddyOverlay` out of core; `openCaptionsWindow` reads the existing ref; identity-preserving `sessions` updates | Core and shell stop republishing per caption partial and per bubble (3 red-then-green boundary tests); +228 eager gzip bytes | **merged** `c4d80d91` |
| A7 | [#762](https://github.com/TheOrcDev/videorc/pull/762) perf/191-chat-flush | Each main-window chat flush copies and re-sorts the whole 2,000-message buffer (up to ~60 flushes/s in bursts) | `lib/live-chat-view.ts` `applyLiveChatMessages` | In-order append fast path, exact fallback; equivalence-tested (400 seeded scenarios) | **Measured: only 1.0–1.24× per flush** (V8's TimSort already finds the sorted run: ~2,004 comparisons, not tens of thousands) for **+287 eager gzip bytes**; the real cost is `admitChatDelivery` (N13) | **closed, not worth it** |
| A8 | [#761](https://github.com/TheOrcDev/videorc/pull/761) perf/191-stream-manager-chat | The Stream Manager applies, reconciles and renders one delta per chat message and re-sorts 2,000 messages each time | `comments/main.tsx` `onCommentsDelta` → `applyView` → `reconcileBrokerCommentsSnapshot`; `stream-manager.tsx` sort and unmemoized `communityGifts` | `CommentsDeltaBatcher`: deltas fold once per frame (rAF or 16 ms) and reconcile once; skip the sort when already sorted; memoize gifts | Per delta on a full buffer: apply ~5 ms + **reconcile ~22 ms** + sort ~1.5 ms, now once per frame (equivalence-tested) | **merged** `a509c31d` |
| A9 | [#772](https://github.com/TheOrcDev/videorc/pull/772) perf/191-ps-sampler | The backend forks `ps -axo` every second for its whole life | `diagnostics.rs` `RuntimeResourceSampler` (read by `DiagnosticStats` and three perf gates, so it must stay) | libproc on macOS (`proc_pidinfo` RSS, BFS over `proc_listchildpids`, `proc_name`) feeding the unchanged aggregation; `ps` kept as the per-sample fallback and on Linux/Windows | **Measured: ~42 ms → ~35 µs CPU per sample (~1,100×)**, i.e. ~4% of a core → ~0.004%; identical snapshots back to back; 39/39 diagnostics tests | **merged** `2b3bb456` |
| A10 | [#771](https://github.com/TheOrcDev/videorc/pull/771) perf/191-deadline-lag | `deadline_lag_times_ms` is the one encoder-bridge window vector never cleared: it grows for the whole session and is copied and sorted every 2 s on the frame-paced writer thread | `encoder_bridge.rs` both window resets omit it; `p95_ms` copies and sorts | One `clear_window_samples!` macro clears all eleven at both resets (the at-risk verdict cannot change: the session max feeds the same budget) | Writer stalls that grew with session age are gone; 115/115 encoder_bridge + 37/37 diagnostics tests. **Visible**: the Diagnostics tab's "Deadline lag" p95 now shows the current 2 s window, like every other bridge p95 (display-only readers, none gates) | **merged** `5e86b8c2` |
| A11 | [#767](https://github.com/TheOrcDev/videorc/pull/767) perf/191-videorc-api-client | Every Videorc API call builds a new `reqwest::Client` (no connection reuse): Buddy's tick pays a TCP + TLS handshake every 8–20 s | `videorc_api.rs` `VideorcApiClient::new`; `cohost.rs` tick sites | One process-wide client (`OnceLock`); base URL still resolved per call; a failed build is not cached | A test proves a second client's request rides the first one's TCP connection; 28/28 videorc_api tests | **merged** `5dc05920` |
| A12 | [#776](https://github.com/TheOrcDev/videorc/pull/776) perf/191-bmp-resize | Windows preview resizes each changed frame with a generic f32 resampler | `preview_bmp.rs` `bounded_bgra_pixels` | Fixed-point tent downscaler (image's exact kernel, 15-bit weights, u16 intermediate, padded tap counts) written straight after the BMP header | **Measured encode per frame (M4): 1080p→800 9.3→2.4 ms, 1080p→1280 25.7→3.9 ms, 1440p→1120 26.5→4.4 ms, 4K→1920 48.0→10.3 ms (3.8–6.6×)**; max diff ≤1 vs image in 24 cases (12 exact); clippy and `pnpm check:windows` clean | **merged** `075d564c` |
| A13 | [#774](https://github.com/TheOrcDev/videorc/pull/774) perf/191-d3d11-upload | The Windows D3D11 session clones every new capture/camera frame before upload | `windows_d3d11_session.rs` `Arc::new(frame.bytes.clone())` ×2 | `WindowsD3d11UploadPixels` shares the frame handle (immutable; pooled buffers return only on the last drop) | 8.3 MB (1080p capture) / 3.7 MB (720p camera) less memcpy per new frame; `pnpm check:windows` passes; `smoke:windows-d3d11-media` on the Windows box before release | **merged** `f1cae054` |
| A14 | [#775](https://github.com/TheOrcDev/videorc/pull/775) perf/191-cpu-compositor | The CPU compositor (every Linux frame) computes three YUV channels to keep one, rebuilds mask geometry per pixel, and zero-fills a canvas it overwrites | `compositor.rs` luma/chroma passes, `source_mask_allows`, `checkout_buffer` + `fill_yuv420p` | Per-channel `#[inline]` helpers, `SceneMaskTester` built once per blit, overwrite checkout at both sites (`checkout_buffer` now test-only) | Byte-identical: exhaustive 256³ colour test, mask tester at every pixel, dirty-vs-zeroed render, CPU/Metal parity (279 + 53 tests); objdump confirms the chroma Y' and the per-pixel mask call are gone (luma U/V was already optimized out); clippy and `pnpm check:windows` clean | **merged** `ca3188e0` |
| A15 | (none) perf/191-proof-decode | The Windows/Linux proof surface's per-frame blank check decodes the whole frame on its main thread | `native-preview-proof-poller-runtime.ts` `proofImageIsBlank` (`drawImage(image, 0, 0, 8, 8)` + `getImageData`) | Planned `await image.decode()` + one hoisted canvas | **Measured: the planned fix does not work** (the executor's Electron 39.8.10 probe: `decode()` fills a different cache, so the canvas still decodes 13–21 ms on the main thread). Moved to Part B, slice N12. | **stopped, see N12** |
| A16 | [#768](https://github.com/TheOrcDev/videorc/pull/768) perf/191-pipewire-copy | Linux portal capture copies every PipeWire frame twice (buffer → scratch → frame store) | `linux_pipewire_stream.rs` scratch + `preview_screen.rs` `linux::publish_bgra_frame` (`extend_from_slice` under the shared mutex) | Publish the converted buffer itself and swap a checked-out store buffer in as the next conversion target (`mem::replace`): same single critical section, conversion still outside the lock; `copy_to_bgra` resizes and overwrites every byte, so stale contents never leak | One full-frame memcpy less per frame, out of the lock (8.3 MB at 1080p, 33 MB at 4K) | **merged** `b9ae4d8b` |

### Combined verification (all Part A PRs merged together)

Machine-load rules for the night meant every dev-app smoke ran once, on a
scratch worktree with nine PR branches (A1, A3, A4, A6, A8, A9, A10, A11,
A16) merged into `origin/main` `5660ad11` (never pushed). The other four were
verified on their own (see their rows): A2 by its query-plan test and the
storage and session suites; A12–A14 change Windows-only or CPU-compositor
code that no Mac smoke runs, so they got clippy, `pnpm check:windows` and
their own equivalence tests.

| Check on the merged tree | PRs covered | Result |
|---|---|---|
| `pnpm typecheck`, `pnpm build`, `pnpm check:renderer-assets` | A1 A4 A6 A8 | pass; eager JS **394,279 / 395,000** gzip (721 B headroom) |
| `cargo test -p videorc-backend -- storage:: videorc_api cohost default_no_store` | A1 A3 A11 | **423 passed, 0 failed** |
| `cargo clippy -p videorc-backend -- -D warnings` | A1 A3 A9 A10 A11 | pass |
| `cargo clippy -p videorc-backend -- -D warnings` and `cargo fmt --check --all` on the post-merge tree itself (`d83cadfd`: all 13 PRs plus #777) | all | pass |
| `pnpm smoke:dev` (boot + recording, artifact analysis) | all merged (9 PRs) | **pass** (60 frames, A/V skew 38 ms; asset background, poster) |
| `pnpm probe:comments-window` (Stream Manager rows, highlights, unread) | A4 A6 A8 | **pass** |
| `pnpm smoke:session-decay:gate` | A3 A9 A10 | **pass**: on a quiet host (load 6–19), 2/2 runs of 3/3 sessions at 30.00 fps, 0.0% degraded, identical to the base build in alternating A/B runs. Under two parallel compiles (load 27–36) it failed 3/3 on the base AND 3/3 on the merged tree, so the gate is host-load sensitive and those misses were not a regression |

**CI on these PRs**: every PR shows the same three red checks as main and as
the owner's own recent merges (#754, #755, #758). (1) "Rust (test + clippy +
fmt)" stops at its first step, `cargo audit`, on RUSTSEC-2026-0386 (tokio
1.52.3 "unsound"; dated 2026-10-13, in the advisory database since
2026-10-23), so CI has run no Rust tests or clippy on any PR since; the fix is [#777](https://github.com/TheOrcDev/videorc/pull/777) (tokio 1.53.3, two lock-file lines, `pnpm audit:rust` passes; merged `0d1d0735`). Its own run passed the audit, fmt and clippy, then timed out in the test build (N14). #769 (another contributor's Windows fix) bumps tokio to 1.54.1 and now conflicts with main on those two `Cargo.lock` lines; its rebase should keep 1.54.1.
(2) "Windows startup incident diagnostics" and (3) "gates / Windows release
source gates" are red on main too. A16's Linux job compiled the PipeWire
change and ran 3,617 tests; its one failure,
`buddy_pet_create::tests::buddy_pet_creation_cancel_leaves_no_partial_pack`,
is a timing test the change cannot reach.

## Part B: owner decisions

These change behaviour or carry real regression risk, so they wait for the owner.

- **D1. Clips (the replay buffer) is on by default, so an idle Studio runs a
  full recording pipeline all the time.** `lib/capture.ts:1432`
  (`replayBuffer: { … enabled: true, explicit: false }`) plus the idle
  reconciler in `use-studio.tsx` (`replayBufferReconcileAction` → `'start'`)
  start a buffer-only session whenever Studio is idle on a hardware encoder:
  compositor at target fps, a VideoToolbox session, an FFmpeg segment muxer,
  the mic bus, 20 Hz levels and a 1 Hz prune task. Disk and memory are bounded
  (~26 MB at the 30 s default). The cost is CPU, GPU and battery whenever the
  app is open. Options: (a) keep as is; (b) off by default for new installs;
  (c) arm only while a screen or game source is live; (d) pause after the
  window has been hidden for N minutes. **Recommendation**: measure first (N1,
  Clips on vs off, on a MacBook on battery), then choose; (c) or (d) keep the
  feature's promise for gamers.
- **D2. Process-wide un-throttling on macOS.** `index.ts:1191`
  appends `disable-backgrounding-occluded-windows` and
  `disable-renderer-backgrounding` for every renderer. The documented reason
  is the detached preview freezing while occluded. Today's production
  presenter is the in-process CAMetalLayer, but the switches also keep an
  occluded main window and Stream Manager at full rAF/timer cadence. Narrowing
  them is HIGH risk (it was the "preview froze until clicked" bug).
  **Recommendation**: measure renderer CPU with the main window occluded (N1)
  and decide only with `pnpm probe:preview-lifecycle`'s occlusion case plus a
  by-eye check.
- **D3. `pnpm dev` runs on the real profile.** Without
  `VIDEORC_USER_DATA_DIR`, every worktree's dev app shares
  `~/Library/Application Support/Videorc` (Chromium cache, window-state files,
  owned-process ledgers). Option: default dev runs to a `Videorc-dev`
  userData unless the variable is set. Developer-only, owner preference.
- **D4. Retention for write-only diagnostic rows.** `health_events` rows
  with `session_id IS NULL` and `repair_jobs` whose `file_path` matches no
  session are read by nothing (`storage.rs` readers all key on a live session).
  Pruning them after 30 days is cheap, but it is a data-retention change.
  **Recommendation**: count them on a copy of a real profile first.

## Part B: follow-up slices

### N1: quiet-host baseline, before and after Part A
- **Why**: no live idle CPU/RSS number exists for 0.9.148; tonight's host was
  too loaded.
- **Do**: on an idle Mac (no other agent builds; check `uptime` < 5), run on
  `main` and again after Part A merges: `pnpm smoke:preview-performance`
  (`scripts/perf-idle-probe.mjs --gate`), `pnpm smoke:process-memory`,
  `pnpm smoke:recording-performance`. Add variants for Clips on/off (D1) and
  the main window occluded (D2).
- **Done when**: `docs/acceptance/2026-10-XX-performance-pass.md` holds
  before/after CPU% and RSS per process for each variant.

### N2: switch on the packaged performance budget
- **Why**: the budget machinery exists (`scripts/performance-scenario-runner.mjs`,
  `scripts/aggregate-performance-calibration.mjs`,
  `scripts/performance-budget-preflight.mjs`, the release workflow's
  `perf:budget:preflight` step), but `config/performance-budgets/v1/active/`
  holds only a README: "No v1 budget data is active". The idle-CPU probe
  (`smoke:preview-performance`) is in neither CI nor `smoke:local-gates`; CI
  runs only the 8 s `smoke:process-memory:sentinel` and the bundle budget. A
  regression like the `ps` sampler or D1's idle pipeline is caught nowhere.
- **Do**: the three-run packaged calibration the README describes, review the
  variance, activate the short-sentinel profile, and add
  `pnpm smoke:preview-performance` to `smoke:local-gates` once it is
  calibrated with Clips in its shipped state.
- **Done when**: the release workflow enforces an active profile and
  `smoke:local-gates` fails on an idle-CPU regression.

### N3: database calls off the async workers
- **Why**: `Database` is one `std::sync::Mutex<Connection>` (`storage.rs`
  `lock()`), and 82 `state.database.` call sites in `main.rs` run inline on
  tokio workers (only image/sound imports use `spawn_blocking`;
  `live_chat_persistence.rs` already does it right). A2 and A3 shrink each
  hold a lot; this removes the rest.
- **Do**: an `AppState::db(|db| …)` helper on `spawn_blocking`; migrate the
  Library page, session detail reads and `emit_health_event` first, then the
  rest mechanically. Keep multi-call handlers in one closure.
- **Done when**: a stress test (20 concurrent `sessions.list` plus a fake
  stderr health emitter) keeps `health.ping` p95 under 5 ms.
- **Risk**: LOW–MED.

### N4: real-time audio without allocation
- **Why**: the CoreAudio input callback allocates a `Vec` per callback and
  frees one when the ring is full (`audio.rs:887`, `:1310–1316`). The session
  bus allocates 5–12 `Vec`s per 10 ms chunk and re-renders on every FIFO retry
  (`session_audio.rs:293–294`, `:5808`, `:5838`, `:5857–5860`;
  `source_audio_tap.rs:156`, `:334`). The warm microphone never drains its
  1,024-packet ring, so every callback takes the full-ring path
  (`audio.rs:33`, `warm_microphone.rs`).
- **Do**: a fixed buffer pool recycled through a second lock-free channel;
  a `ChunkScratch` owned by the bus loop; drain or shrink the warm ring.
- **Done when**: a counting-allocator test shows 0 allocations per callback
  and per chunk; `pnpm smoke:soundboard-fixture` keeps byte-identical PCM; the
  recording-studio audio gates pass.
- **Risk**: MEDIUM (capture path); `fable-5` lane.

### N5: the main process stops recomputing preview bounds every frame
- **Why**: `presentNativePreviewSurfaceCompositor` →
  `reconcileNativePreviewSurfaceForPreviewWindow` → `previewWindowState()`
  calls `getBounds`, `getContentBounds`, `screen.getDisplayMatching`,
  `getPrimaryDisplay`, visibility getters and `getMediaSourceId` twice per
  frame (`index.ts` ~4095–4360, ~6815–6860): ~1,400 synchronous native calls a
  second at 60 fps, for values that change only on events main already
  handles.
- **Do**: cache `PreviewWindowState` and invalidate it from the existing
  move/resize/show/hide/display handlers, with a cheap `getBounds()` equality
  guard.
- **Done when**: `pnpm probe:preview-lifecycle` and `pnpm probe:preview-window`
  pass, and the main present p95 does not rise.
- **Risk**: MEDIUM (stale placement); `fable-5` lane.

### N6: main-process IPC and I/O hygiene (small items, one PR)
- `backend:log` goes to every window though only the main renderer listens
  (`index.ts` `logBackend` → `sendToWindows`).
- One synchronous `appendFileSync` per backend log line
  (`backend-log-file.ts`).
- `pruneAvatarCache` stats up to 1,000 files synchronously every ≤5 s
  during chat (`index.ts` ~14322).
- Window-state emits on every move/resize/focus event without coalescing.
- `requestBackendAdmin` opens a new WebSocket per request (`index.ts`
  ~9690); History open fires 3–4 in parallel.
- **Done when**: per-channel send tallies (`sendToWindowsCounts`) show
  `backend:log` × 1 window, and `pnpm probe:comments-window` passes.

### N7: Windows encoder and capture (needs a Windows box)
- Media Foundation creates an output sample and buffer per `ProcessOutput`
  and a full I420 input buffer per frame on the CPU route
  (`windows_media_foundation_encoder.rs` ~1256, ~2839, ~3617).
- WGC readback maps the staging texture right after `CopyResource` with a
  blocking `Map` (`windows_graphics_capture.rs` ~473–482); use two staging
  textures ping-pong.
- **Done when**: `smoke:windows-mf-probe` / `smoke:windows-native-screen`
  show lower capture and encode times on the Intel UHD tester.

### N8: renderer, measure first
- StudioProvider self time per commit (17k lines, ~250-dep core memo): React
  Profiler during a chat burst.
- `status-dot.tsx` `motion-safe:animate-ping` runs for the whole session.
- Highlight-card `ImageBitmap`s are never `close()`d (`lib/caption-overlay.ts`
  ~589).
- LevelMeter/Buddy preview gate on IntersectionObserver/visibility, which do
  not fire when the window is merely covered (see D2).
- `getPreviewWindowState` is polled every 4 s although a push subscription
  exists (`use-studio.tsx` ~10542).

### N9: Rust release profile
- `Cargo.toml` has no `[profile.release]`: `lto=false`, `codegen-units=16`.
  Measure `lto="thin"` with `codegen-units=1` on the CPU paths (audio bus, CPU
  compositor, BMP) against the release build time before changing it.

### N10: does the compositor stop when nothing reads it?
- The compositor ticks at its consumer's `target_fps` (`compositor.rs` ~5350).
  Whether closing or minimizing the preview while idle (and with Clips off)
  stops the run is decided in the preview-surface reconcile. Measure with a
  perf-idle-probe variant (preview window closed vs open).

### N12: the proof surface's blank check (Windows production presenter)
- **Measured** (executor probe on the repo's Electron 39.8.10 / Chrome
  142 with the proof surface's exact webPreferences and real 1920×1080 BMP
  frames, built byte-for-byte like `preview_bmp.rs`; p50 main-thread ms for
  the check): today **16–21 ms per frame**; with `await image.decode()` first
  13.5–18 ms (`decode()` fills a different cache than the canvas, so it adds a
  second decode); one reused canvas changes only allocation churn; an 8×8
  `createImageBitmap(blob, { resizeWidth: 8, resizeHeight: 8 })` check
  **0.1 ms**, but it waits 21–30 ms off-thread before each present. At 25 Hz
  × 2 sources the check can take most of the proof window's main thread. In
  a hidden renderer a single check took 51–208 ms.
- **Options**: (b) the 8×8 `createImageBitmap` check (a rejected bitmap takes
  the `onerror` path; the downsample differs slightly from `drawImage`); (a)
  canvas reuse alone (small GC win, same time); (d) read the alpha straight
  from the BMP bytes (must match Chromium's BI_RGB alpha handling, which is
  unverified).
- **Done when**: on the Windows tester, `smoke:windows-stream-performance` (or
  `__videorcNativePreviewMetrics()`) shows the chosen option keeps per-source
  `proofTransportDecodedFramesPerSecond` and lowers the proof renderer's
  main-thread time. The night's probe (an Electron page timing the check
  against real BMP blobs) lives only in that session's scratchpad. If N12 is
  picked up, rebuild it as a maintained `scripts/` probe with a package
  script; never commit its Electron userData.
- **Risk**: MEDIUM (production presenter, no Windows run tonight).

### N13: chat delivery re-validates its whole journal on every flush
- **Measured** (executor benchmark, process CPU, 2,000-row buffer with a full
  2,000-entry delivery journal): `admitChatDelivery` costs **~0.9 ms median
  per flush** (0.57 ms best). It now dominates a main-window chat flush.
  `validateChatDelivery` re-validates all 2,000 journal entries, allocating per
  entry, and the function rebuilds its own 2,000-row id `Map`, both on every
  flush. The Stream Manager reaches it through `applyCommentsSnapshotDelta`
  (once per frame after A8).
- **Do**: first find whether the journal ever crosses a trust boundary
  between flushes. If it is produced in-process, validate only the incoming
  entries and keep an id index alongside the journal; if it arrives over IPC,
  validate once at the boundary, not per flush.
- **Done when**: the existing chat-delivery tests pass unchanged, and a
  benchmark shows per-flush cost proportional to the batch, not the journal.
- **Bundle note**: `shared/chat-delivery.ts` ships in the eager bundle
  (about 1,000 gzip bytes of headroom): the fix must not add bytes, so measure
  with `pnpm check:renderer-assets`.

### N14: CI's Rust job no longer fits its time limit
- **Measured** (GitHub Actions history, 2026-10-24): the last green "Rust
  (test + clippy + fmt)" run on main was 2026-10-22 23:17, with a 54 min Test
  step. On 2026-10-23, before the tokio advisory broke the audit step, two
  main runs were cancelled after 72–73 min inside the test build. #777's own
  run passed the audit, fmt and clippy, then hit the 75 min job limit still
  compiling the test binary (65 min without output). A cancelled run skips
  the cache save, so after a `Cargo.lock` change every run starts cold and
  can time out again.
- **Do**: time the test build with lighter debug info first
  (`CARGO_PROFILE_TEST_DEBUG=line-tables-only`, the same for `dev`), then
  consider building and running tests in separate steps or nextest
  partitions. Raising `timeout-minutes` costs more macOS runner minutes.
- **Done when**: the Rust job finishes on main within its limit from a cold
  cache.

### N11: correctness lead found on the way (not perf)
- `video_toolbox_encoder.rs` ~899 turns `VTEncodeInfoFlags::FrameDropped` into
  an error that may end a recording leg (`encoder_bridge.rs` ~7563 →
  `pipeline_error`). Diagnose with a test double before deciding anything.

## Considered and rejected

- **Owned-process ledger costs ~18 sync `ps` per launch** (Electron-main
  audit): 15 of the 16 ledger files are empty per-worktree `[]` files and one
  holds a single June record, so a launch probes at most one pid. Not worth it.
- **The `ps` sampler has no reader** (recording audit): wrong. It feeds
  `DiagnosticStats` (`backendRssBytes`, `activeFfmpegProcesses`) and three perf
  gates. A9 makes it cheap instead of lazy.
- **One transaction for a health event plus its session log**: after A3 each
  commit costs ~0.1–0.3 ms; not worth the extra code path.
- **Replay buffer memory**: bounded and on disk (~26 MB at 30 s, ≤470 MB at
  the 600 s maximum). Its cost is CPU and battery, which is D1.
- **WAL with `synchronous=NORMAL`**: barely faster than WAL+FULL here and
  would let a power cut lose the last finished take's row; rejected in favour
  of WAL+FULL.
- **Windows idle wakeups (100 Hz capture owner, ≥62 Hz media thread)**:
  battery-only; revisit if laptop idle power becomes a target.
- **Streaming the BMP header and pixels as two chunks** to skip the no-resize
  memcpy: ~0.5–1.5 ms per frame; A12 removes the copy on the resize path,
  which is where the cost is.
- **A WebSocket push transport for the proof surface**: would change the
  documented poll-based identity of the Windows presenter (AGENTS.md); out of
  scope without an owner call.
- **Starting the backend before `runtimeInfo()`** (A5, PR #759, closed): on
  Electron 39.8.10 `app.getGPUInfo('basic')` settles in 0.16–1.04 ms from
  main-process data, so the reorder saves under 1 ms per launch.

## Found on the way (not performance)

- `src/renderer/src/components/buddy-library-section.test.ts` "opens the
  onboarding when another surface asks for it (plan 174 G-4)" fails in 4 of 5
  runs on an unmodified `0db1e5bc`. It gives a lazily imported
  `BuddyOnboarding` only `vi.waitFor`'s 1 s default to appear. A flaky test on
  main; give it an explicit timeout.
- Under load (load average 50–100) the full desktop suite times out in
  `studio-provider.integration.test.ts`, `library-desktop-list.test.ts` and
  `comments-snapshot-delta.test.ts` (5 s defaults). The same files pass
  serially with `--maxWorkers=1 --testTimeout=60000`.
- `apps/desktop/electron.vite.config.1787864947110.mjs` (an electron-vite temp
  file) is committed on main.
- `use-studio.tsx` ~10164 reads `status.state` straight from
  `client.request('preview.camera.start', …)`. When that resolves to nothing
  (seen as an unhandled rejection in several full desktop-suite runs, in "creates
  one preview surface then updates bounds without renderer admin RPCs"), it
  throws. Guard it, or fix the test's mock.
- About 250 ms after connect, the provider's scene reload re-applies an
  identical scene as a new object, which publishes the core context once more
  (found by the A6 executor). Cheap to check with an equality guard.
- **Eager bundle headroom**: the untouched `0db1e5bc` build measures 393,990 gzip
  against the 395,000 ceiling. A6 (+228) and A8 (+57) leave ~720 bytes; the
  next eager feature will need an owner for its bytes.

## STOP conditions (Part B)

- A slice's anchors changed behaviour since `0db1e5bc`.
- A measurement contradicts the slice's premise (e.g. N1 shows Clips costs
  nothing measurable): record it here and drop the slice.
- Any audio, preview or recording gate from `AGENTS.md` fails twice after a
  fix attempt.

## Maintenance notes

- A1's default `no-store` layer makes "forgot the header on an error path"
  harmless; a future route that SHOULD be cacheable must set its own
  `Cache-Control`.
- A2's `CROSS JOIN`s are load-bearing: rewriting them back to plain `JOIN`
  reintroduces full scans. The plan test in `storage.rs` guards it.
- A3: anything that copies the database file must checkpoint first or copy
  `-wal`/`-shm` with it.
- A10: new encoder-bridge window vectors must join both reset lists.
