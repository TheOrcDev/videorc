# Plan 215: a streamer's list, 2026-11-02

> **Executor instructions**: This plan is seven workstreams (A to G), one
> PR each. Pick a workstream from "Order of work", follow its slices in
> order, and run every "Done when" check before moving on. If anything in
> "STOP conditions" happens, stop and report; do not improvise. When a
> workstream is done, update this plan's row in `plans/README.md` and fill
> in its "As built" line. Gates run once at the end of each workstream
> (owner rule): write and commit its slices first, then run its gate. A
> slice marked **red first** must be seen failing on the base before the
> fix starts.
>
> **Drift check (run first)**: `git diff --stat 57b0c457..origin/main --`
> plus the paths listed under your workstream. If an anchor quoted below has
> moved, re-find it by the symbol name. If a _behaviour_ changed (not just a
> line number), that is a STOP condition.

## Status

- **Status:** PLANNED 2026-11-03, ready to execute. Owner answers,
  2026-11-03: "d1: yes allow move, we definitely need that d2: go
  recommended d3: recommended d4: recommended d5: yes d6: awesome d7 yes.
  put all in plan". So D1 to D7 are all taken as recommended, and every
  workstream below is written to them.
- **Source:** a streamer's list from 2026-11-02, relayed by the owner on
  2026-11-03, plus a Stream Manager screenshot and a follow-up: "Yes, I was
  already signed in. Maybe it's because I signed in when I first used the
  app, and later updates changed the login or introduced a regression."
  The app version is probably 0.18.0 (main's version), **guess**.
- **Planned against:** `origin/main` `57b0c457`, in
  `~/projects/videorc-wt-215` (branch `plan-215-streamer-feedback-2`). The
  shared checkout is on a stale branch, so work in a fresh worktree from
  `origin/main`.
- **Owner route:** Orchestrator, fit 10, for the plan as a whole. Each
  workstream names its own route and model lane from `CLAUDE.md`.
- **How the facts were found:** four read-only investigations of
  `57b0c457`, then the load-bearing claims re-read by hand. Each fact is
  marked **verified** (read in the code) or **guess** (reasoned, not
  reproduced). Nothing was reproduced on the streamer's Mac. We have no
  support bundle or log from them.
- **In flight elsewhere:** plan 214 (Videorc Camera) is executing as one PR
  and also edits `command-palette.tsx`. Its UI branch measured the eager
  renderer bundle at about 468,052 of the 470,000-byte gzip ceiling
  (`scripts/check-renderer-asset-budget.mjs:112`). Whichever PR lands
  second rebases. New UI in this plan goes in lazy chunks.

## The feedback (verbatim, lightly trimmed)

1. "X chat is broken. As soon as the stream starts, it says X chat isn't
   working and asks me to sign in, even though I'm already signed in. The
   error message isn't clear."
   Screenshot (Stream Manager, live): "Sign in to your Videorc account to
   receive X comments." Pills "YouTube · Connected", "X · Failed". Rows:
   "YouTube: YouTube live chat connected. · Reading chat as Ram." and "X:
   Sign in to your Videorc account to receive X comments. · Reading chat as
   Ram."
2. "Allow rounded corners for displays."
3. "During a live stream, the Edit Scene option doesn't let you move your
   camera around. It seems to be locked in the latest version, probably a
   regression."
4. "Having an option to zoom further in screen (right now only 100%) as
   well as I can crop, enlarge more than the canvas. Right now the
   selectors and slider do not allow me to do that further."
5. "Add an option to show chat on stream for viewers, similar to
   highlights and captions."
6. "The Edit Scene button should be on the Scene page instead of the
   Studio page. (Or both. Also it would be cool to add Edit Scene in the
   ⌘K menu.)"
7. "Feature request: Allow the unified chat popup to be pinned on screen
   without being visible on the stream."

## What we found, in one table

| #   | What they hit                              | Cause (short)                                                                                                                                                                                                                                         | Workstream | Size |
| --- | ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- | ---- |
| 1   | X chat fails at start, says "sign in"      | Not X: the **Videorc account** session token was gone. A 401 on refresh signs the desktop out silently. The Go Live check calls X chat "ready" without looking at the account, and the toast sends you to Livestream, where X looks fine.             | A          | M    |
| 2   | No rounded corners for the screen          | The mask (circle, rounded) is wired per source on every render path, but only the camera gets one. The screen is hard-coded to no mask.                                                                                                              | F          | M    |
| 3   | Can't move the camera while live           | **Not a regression.** Moving, resizing and cropping on the Scene page has been locked during a session since 2026-07-03. The backend already accepts the commit live; the lock is UI only, except on the legacy FFmpeg path.                         | D          | M    |
| 4   | Can't zoom the screen past 100%            | "100%" is the W/H fields' cap. Behind it, every render path squashes a box that runs past the canvas edge instead of cutting it off. No zoom control for the screen.                                                                                 | E          | L    |
| 5   | Chat on stream                             | Doesn't exist. The comment highlight (renderer paints a PNG, the backend draws it on every output) is the template.                                                                                                                                   | G          | L    |
| 6   | Edit Scene is on the wrong page            | Studio's "Edit scene" just opens the Scene page. The Scene page has no edit button: editing starts only when you click a source on the canvas. ⌘K has "Open Scene", no "Edit scene".                                                                  | B          | S    |
| 7   | Chat window on top but not on stream       | Half ships: the Stream Manager has **Keep on top**. Hiding it is new: by the owner's call (2026-08-19) only Notes is hidden from capture, so the chat window is on stream whenever its display is captured.                                           | C          | M    |

## Send to the streamer now (the owner relays)

**Workarounds that work on today's build:**

- **X chat:** your X account is fine ("Reading chat as Ram" is X). What's
  missing is your **Videorc** sign-in: the account button at the bottom of
  the sidebar probably says "Sign in". Sign in there **before** you go
  live. Today chat doesn't reconnect by itself, so if you're already live,
  it needs the next stream.
- **Moving the camera while live:** set the positions up before you go
  live, save each one as a scene (Scene → Save / New scene…), and click
  between saved scenes while live. Scene and layout switches apply live.
- **Zoom into the screen:** in Freeform, select the screen and crop its
  sides (up to 95% per side). A smaller crop shown in a full-size box
  enlarges that part of the screen. **Fill** makes a landscape screen fill
  its box.
- **Edit scene:** ⌘3 opens the Scene page; click the camera or screen on
  the canvas to edit it.
- **Chat window:** the pin ("Keep on top") is in the Stream Manager's
  status bar. To keep it off the stream today, put it on a display you
  don't capture, or use an app scene (Scene → New scene…), which captures
  one app's window and never Videorc's own windows.

**Questions back (each one changes the work):**

1. X: what did the sidebar's account button say before you went live, your
   name or "Sign in"? About when did you last sign in to Videorc? Next
   time it happens, send a support bundle (Settings → About → Support
   bundle). A, A5 and A6 depend on this.
2. Zoom: do you want to show **part** of the screen bigger (zoom into a
   region), or the whole screen box larger than the frame? A screenshot of
   what you're trying to frame helps. E is written for both.
3. Moving the camera live: did it ever work for you (which version), or
   did you expect it to? The code says it has always been locked.

## Order of work

| Wave | Workstreams (one PR each)                                     | Why this order                                                                                                    | Runs in parallel?                                                                                                     |
| ---- | ------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| 1    | A X chat sign-in, B Edit scene entry points, C chat off stream | A is a broken promise to a live streamer: a 0.18.x hotfix candidate. B is small. C is self-contained.             | Yes. A is backend + Stream Manager; B is `command-palette.tsx` + Scene page; C is the capture filter + Stream Manager. |
| 2    | D move live, E bigger than the canvas                         | D is mostly renderer locks; E rewrites the source rect on all four render paths.                                  | Yes, but both touch `layout-tab.tsx` and the stage clamps. Land D first, rebase E.                                    |
| 3    | F rounded screen, G chat on stream                            | F's mask is drawn on the fitted rect that E changes, so F follows E. G is the largest and shares nothing with F. | Yes. Cap backend builds at two (`pnpm cargo:slot`) and at most three Rust delegates (11-02 kernel panic).             |

`use-studio.tsx` is touched by A, C and G. `layout-tab.tsx` by B, D, E, F
and G. Rebase the later PR; never merge in parallel blindly. A and C both
touch the Stream Manager's status bar.

## Decisions for the owner

Each has a recommendation. The plan is written to the recommendation.

- **D1. Moving things while recording or live.** _Recommended:_ allow move,
  resize, crop, the number fields and the arrow nudges on the Scene page
  during a session. While you drag, the canvas shows the outline; the
  stream and recording jump to the new place **when you let go** (drafts
  never reach an output, plan 058 decision 4 stands). Orientation stays
  locked. A session on the legacy FFmpeg path keeps the lock and says why.
  _Also possible:_ the stream follows the drag live (reverses plan 058
  decision 4; viewers see every in-between frame).
  **Owner answer (2026-11-03): yes**, "we definitely need that". As
  recommended: the outputs move on release, and plan 058 decision 4
  stands.
- **D2. How big.** _Recommended:_ a source can be up to 400% of the canvas
  and placed anywhere as long as at least 5% of it stays on the canvas.
  What runs past the edge is cut off, never squashed. Freeform gets a
  screen **Zoom** slider (100–400%) that scales the box around its centre.
  Zooming upscales, so text goes soft; crop stays the sharp way to show
  part of the screen, and the slider's hint says so.
  **Owner answer (2026-11-03): as recommended.**
- **D3. Rounded corners for the screen.** _Recommended:_ one **Corners**
  setting for the screen, beside the camera's, in every layout. It applies
  to display and window sources and is 0 (square) by default. The Screen
  ISO file stays square and uncropped (the raw source for editing).
  _Also possible:_ per source in Freeform only (a preset scene would have
  no place for it).
  **Owner answer (2026-11-03): as recommended.**
- **D4. Where Edit scene lives.** _Recommended:_ both. Studio keeps its
  button, the Scene page gets an **Edit scene** button beside Save and New,
  and ⌘K gets **Edit scene**. All three open the Scene page with the camera
  selected and the editor on.
  **Owner answer (2026-11-03): as recommended.**
- **D5. Chat on stream, first version.** _Recommended:_
  - the last 5 messages: name, platform icon, text and emotes;
  - no avatars and no fade yet;
  - **off by default**, because it shows every viewer's name;
  - placed on the Scene page and switched like Highlight and Captions
    (Show on stream / Show in recording), plus a switch in the Stream
    Manager, like the Buddy's;
  - a deleted or hidden message leaves the box on its next draw;
  - the vertical stream gets its own card.

  _Also possible:_ on by default, avatars, or a fade animation in the
  first version.
  **Owner answer (2026-11-03): yes, as recommended.**
- **D6. Hide the chat window from the stream.** _Recommended:_ a **Hide
  from stream** switch next to Keep on top, off by default (so the
  2026-08-19 rule stays the default), and remembered.
  - **macOS:** our own capture leaves the window out. The streamer's
    screenshots, QuickTime and Zoom still see it.
  - **Windows:** the only way hides it from every capture app (OBS, Zoom,
    screenshots), and the switch says so.
  - **Linux:** not possible. The switch is disabled and gives the reason.

  _Also possible:_ hidden by default whenever it's pinned.
  **Owner answer (2026-11-03): as recommended** ("awesome").
- **D7. An expired Videorc sign-in.** _Recommended:_
  - a toast, "Your Videorc sign-in expired. Sign in again.", when the
    desktop is signed out by the server;
  - a dot on the account button while chat or Buddy needs it;
  - the Go Live check names it before you go live;
  - chat attaches as soon as you sign in, without restarting the stream.

  _Also possible:_ the Go Live check only, no toast.
  **Owner answer (2026-11-03): yes, as recommended.**

---

## Workstream A: X chat tells the truth about your Videorc sign-in (D7)

**Route:** Diagnose, fit 9 (a user hit it live; backend account, chat, Go
Live check and UI). **Lane:** `fable-5.1`.

**Drift paths:** `crates/videorc-backend/src/account.rs crates/videorc-backend/src/secrets.rs crates/videorc-backend/src/x_chat.rs crates/videorc-backend/src/kick_chat.rs crates/videorc-backend/src/preflight.rs crates/videorc-backend/src/live_chat.rs crates/videorc-backend/src/support_bundle.rs apps/desktop/src/renderer/src/components/stream-manager/chat-sign-in-rows.tsx apps/desktop/src/renderer/src/components/account-menu.tsx apps/desktop/src/renderer/src/lib/studio-toasts.ts apps/desktop/src/renderer/src/hooks/use-studio.tsx`

**Why (verified unless marked):**

- **The message has one source.** It is
  `x_chat.rs:353-358`: `overrides.session_token.or_else(stored_session_token)`
  is None, so the error is `terminal(...)`. Nothing retries it.
- **X itself is fine.** "Reading chat as Ram" is the X account's label
  (`comments-destination-status.tsx:36`), so Sign in and Authorize X Live
  are done. This is not J's stream-key path: that row says "Needs Sign in",
  not Failed.
- **The backend was signed out when the stream started.**
  - The account UI and the connector read the same store: `account.get`
    reads `state.account_session`, seeded from `restore_persisted_account()`
    (`account.rs:257-268`), which needs the token.
  - The connector reads `stored_session_token()` (`account.rs:316-323`)
    from the same `STORE_CACHE` (`secrets.rs:348-355`).
  - Signed out, the sidebar's account button reads "Sign in" with a plain
    icon (`account-menu.tsx:104-108`). That is easy to miss.
- **How it signs out silently.**
  - A Videorc session lasts 30 days (`videorcweb/lib/auth.ts`,
    `session.expiresIn`; that local clone is from 2026-10-10).
  - On a 401, refresh calls `apply_unauthorized_session_refresh`
    (`account.rs:470-481`), which deletes the token and signs out. There is
    no toast and no event (no sign-out toast in `use-studio.tsx` or
    `studio-toasts.ts`).
  - Whether this is what hit the streamer is a **guess**. Also possible:
    an error swallowed into "no token" (`.ok().flatten()` on every read,
    `account.rs:258-267, 316-317`), or `let _ = persist_account` dropping a
    rotated token (`account.rs:464`).
  - There is no key rename or migration since 2026-06-25, so "an update
    changed the login" is unlikely.
- **Nothing warned before the stream.**
  - `x_destination_chat_preflight` (`preflight.rs:388-432`) checks the
    auth mode, the X account and X Live, never the Videorc account, and
    says "X chat is ready to read and send."
  - Pre-live `chat_capability(X)` is the same (`live_chat.rs:627-680`).
- **The toast points the wrong way.** It says "X chat isn't connected for
  {label}. Your stream is fine. Check X in Livestream." with Open
  Livestream (`studio-toasts.ts:189-193`). Livestream shows X as healthy.
- **Kick chat fails the same way.** `kick_chat.rs:797-802` is the same
  code. Buddy, captions and cloud AI gate on the same token call
  (`cohost.rs:10542`, `captions.rs:3670`, `clean_cut/mod.rs:791`).
- **Diagnostics.** The `x-live-chat-failed` health event and
  `backend.log` exist. The support bundle names only the store kind
  (`support_bundle.rs:906`), not whether a token is present.

**Repro (for A1):** packaged or dev build; X added with Sign in and
Authorize X Live; signed in to Videorc. Quit, delete
`account:videorc:session` from the app's `videorc-secrets.json`, launch, Go
Live. Today the Go Live check says Ready and the X row fails after publish.

**Slices:**

- **A1 (red first). One truthful state.** Add `account::session_state()`
  returning `SignedIn | SignedOut | Unreadable(error)`, and a read state
  `NeedsVideorcSignIn` (in `backend-rpc-contract.ts`, `shared/backend.ts`,
  the read-state labels and tones). `x_chat.rs` and `kick_chat.rs` map a
  missing token to it, with "Sign in to Videorc to read X chat." (Kick:
  "…Kick chat."). A read error becomes `last_error`, never "signed out".
  _Done when:_ a test in `x_chat.rs` asserts the new state (failing on the
  base), plus a Kick twin and the contract tests.
- **A2. The Go Live check names it.** `x_destination_chat_preflight` and
  `chat_capability(X)` (and Kick's) take the session state. Signed out
  shows "X chat needs your Videorc sign-in", with Sign in as the fix. A
  warning, not a block: the stream itself works.
  _Done when:_ the `preflight.rs` and `live_chat.rs` tests and
  `go-live-dialog.test.ts` cover signed out.
- **A3. The row and the toast name the account.**
  - Generalise `chat-sign-in-rows.tsx` to both "needs Sign in" states. The
    button reads **Sign in to Videorc**; reach it from the Chat window with
    a role-limited IPC, like `comments-window:open-destination`.
  - The toast reads "X chat needs your Videorc sign-in", with a Sign in
    action instead of Open Livestream.

  _Done when:_ `chat-sign-in-rows.test.ts`, `live-chat-view.test.ts`,
  `studio-toasts.test.ts` and `electron-ipc-contract.test.ts` pass.
- **A4. Chat attaches when you sign in.** On a successful sign-in
  (`main.rs` `account.complete_sign_in`, beside
  `resume_listen_after_sign_in`), re-spawn every connector in
  `NeedsVideorcSignIn` with its registered broadcast. The stream never
  restarts.
  _Done when:_ a `live_chat.rs` test goes no token, then sign in, then
  Connected against the mock relay.
- **A5. A sign-out you can see (D7).** An unauthorized refresh emits an
  account-changed event, then the toast "Your Videorc sign-in expired.
  Sign in again." The sidebar's account button gets a dot while chat or
  Buddy needs the sign-in. Stop swallowing errors: log and surface the
  `let _ =` and `.ok()` sites in `account.rs`.
  _Done when:_ a backend test asserts the event, and a `use-studio` test
  asserts the toast.
- **A6. The support bundle says it.** Add `account: { signedIn,
  tokenPresent, storeReadable }` and the chat provider rows.
  _Done when:_ the `support_bundle.rs` tests cover it.

**Gate:** targeted `cargo test` (account, x_chat, kick_chat, preflight,
live_chat, support_bundle), clippy, `pnpm typecheck`, `pnpm lint`,
desktop tests, the comments contract tests, and `pnpm smoke:studio-chat`.
Run the repro above by hand on the dev app. By eye in both themes.

---

## Workstream B: Edit scene on the Scene page and in ⌘K (D4)

**Route:** UI/Product Design, fit 9. **Lane:** `opus-5.5`. Read
`.claude/skills/videorc-design/SKILL.md` first.

**Drift paths:** `apps/desktop/src/renderer/src/components/command-palette.tsx apps/desktop/src/renderer/src/components/studio/scenes-gallery.tsx apps/desktop/src/renderer/src/components/scene/scene-list.tsx apps/desktop/src/renderer/src/components/tabs/layout-tab.tsx apps/desktop/src/renderer/src/components/app-shell.tsx`

**Why (verified):**

- The Studio page's Scenes gallery has "Edit scene"
  (`scenes-gallery.tsx:166-168`). It calls `openStudioPanel('layouts')`,
  which is only `setActive('layouts')` (`app-shell.tsx:348-353`), so it
  opens the Scene page (⌘3).
- The Scene page has no edit button. The fields and nudges wait for
  `sceneEditMode`, which is set only by clicking a source on the canvas
  (`layout-tab.tsx:844-846`). `SceneList` offers only Save and New
  (`scene-list.tsx:152-179`). **Guess:** the page looks like it isn't the
  editor.
- ⌘K has "Open Scene ⌘3" from `PAGES`, with keywords `layout, layouts,
  composition, background, takeover, presets` (`command-palette.tsx:80,
  319-333`). It has no "Edit scene" verb. Plan 214 also edits this file.

**Slices:**

- **B1. One "Edit scene" action.** Open the Scene page, select the camera
  (or the first editable source when there's no camera), and turn on
  `sceneEditMode`. Studio's button uses it too, so all three doors do the
  same thing.
  _Done when:_ a test proves the action selects the camera and turns on
  edit mode.
- **B2. The Scene page button.** **Edit scene** beside Save and New in
  `SceneList`, shown while the editor is off. While live, before D lands,
  it still opens the editor, and the locked fields say why.
  _Done when:_ `scene-list.test.ts` and `layout-tab.test.ts` cover it.
- **B3. ⌘K.** Add an **Edit scene** item after Open Scene, with keywords
  `edit, move camera, resize, freeform, position`. Add `edit scene` and
  `scene editor` to the Scene page's keywords.
  _Done when:_ `command-palette.test.ts` still passes "opens every page
  with one verb", and a new case finds the item by "move camera".

**Gate:** `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, desktop
tests, and the renderer asset budget (`pnpm build`). By eye in light and
dark.

---

## Workstream C: the chat window stays on top and off your stream (D6)

**Route:** Implementation, fit 8. **Lane:** `fable-5.1`, because C2
changes the live macOS capture filter (a capture-selection trigger in
`CLAUDE.md`).

**Drift paths:** `apps/desktop/src/main/window-capture-protection.ts apps/desktop/src/main/index.ts apps/desktop/src/renderer/src/components/stream-manager/stream-manager-status-bar.tsx apps/desktop/src/renderer/src/hooks/use-studio.tsx apps/desktop/src/renderer/src/lib/protected-overlay-windows.ts crates/videorc-backend/src/preview_screen.rs crates/videorc-backend/src/screen_capture.rs scripts/smoke-windows-stream-performance.mjs`

**Why (verified unless marked):**

- **"The unified chat popup" is the Stream Manager.** It is the
  `'comments'` window, opened with ⇧⌘J (`openCommentsWindow`,
  `main/index.ts:4040-4136`). There is no other chat window; Chat in
  Studio is part of the main window.
- **Keep on top already exists.** A `PinWindowButton` in its status bar
  (`stream-manager-status-bar.tsx:469`), plus an overflow-menu checkbox.
  It is remembered in `comments-window.json`. When on, the window floats on
  every Space and over full-screen apps on macOS
  (`applyNotesWindowAlwaysOnTop`, `main/index.ts:3060-3077`).
- **It's on stream by design today.**
  `videorcWindowRequiresCaptureProtection` returns `role === 'notes'`
  (`window-capture-protection.ts:42-47`). That is the owner's call of
  2026-08-19: "only notes should be invisible".
- **How each platform could hide it:**
  - **macOS:**
    - Our ScreenCaptureKit filter leaves out the "protected" window IDs
      (`preview_screen.rs:7226-7240`), and the renderer sends only Notes
      (`use-studio.tsx:2312-2319`).
    - An ID change while capture runs is stored but not applied until the
      next start (`preview_screen.rs:5428-5446`).
    - Several start paths send an empty list (`recording.rs:3855`,
      `live_layout.rs:2712`), so Notes' real guarantee is content
      protection.
    - The plan 210 in-place swap (`updateContentFilter`,
      `preview_screen.rs:~7621`) can apply a new filter live.
  - **Windows:** the monitor capture has no exclusion list.
    `WDA_EXCLUDEFROMCAPTURE`, through `setContentProtection`, is the only
    route, and it hides the window from every capture app. **Guess**,
    from Electron's docs: older Windows shows a black box.
  - **Linux:** not possible (`CAPTURE_PROTECTION_UNSUPPORTED_REASON`).
- **Window capture:** app scenes and Follow the app in front never pick
  Videorc's windows (`screen_capture.rs:105-116`,
  `follow-front-app.ts:177-182`). The manual window picker filters out
  only Notes (`screen_capture.rs:235`), so the Stream Manager can be
  picked there.
- **A stale smoke:** `scripts/smoke-windows-stream-performance.mjs:1731-1735`
  still lists `comments` as a protected role.

**Slices:**

- **C1. The rule follows a setting.** Add `hiddenFromStream` to the Stream
  Manager's saved state (with a version field, like the pin; old files load
  as off). The protection rule becomes "Notes, or the Stream Manager when
  `hiddenFromStream` is on". Add the IPC
  `comments-window:set-hidden-from-stream`. Any new status field goes in
  the IPC contract.
  _Done when:_ `window-capture-protection.test.ts`,
  `detached-window-close-prefs.test.ts` and the IPC contract test cover
  it.
- **C2. macOS: our capture leaves it out, live.**
  - Add the window's ID to the protected list while the switch is on.
  - In the backend, apply an ID change to a running capture with
    `updateContentFilter` instead of only storing it.
  - Every screen-capture start carries the list. Check the record+stream
    aux leg and the paths that send an empty list today.
  - Leave it out of the manual window picker.

  Don't use content protection on macOS: it would hide the window from the
  streamer's own tools too.
  _Done when:_ `protected-overlay-windows.test.ts`, and a cargo test proves
  an ID change applies with no capture restart.
- **C3. Windows: content protection on toggle.** Call
  `setContentProtection` live. The switch's hint says it also hides the
  window from other capture apps and screenshots.
  _Done when:_ a test pins the call, and the Windows marker harness shows
  the window's colour gone with the switch on and present with it off. Fix
  the stale role in the Windows smoke in the same commit.
- **C4. The switch.** **Hide from stream** next to Keep on top, in the
  status bar and the overflow menu, and in ⌘K. On Linux it is disabled,
  with the existing reason. When it's on, the footer says "Hidden from your
  stream", as Notes does. Nothing goes in the toolbar.
  _Done when:_ the `stream-manager-status-bar-*.test.ts` tests cover all
  three platforms. By eye in both themes and in Retro LCD.
- **C5. Smoke.** Clone `smoke:notes-window-invisible` into
  `smoke:stream-manager-invisible`: open the Stream Manager with a marker
  colour over the captured display, and record.
  _Done when:_ the marker pixels are ≤0.2% with the switch on, clearly
  above that with it off (proving the check can see the window), and still
  ≤0.2% after a toggle mid-recording.

**Gate:** typecheck, lint, desktop tests, targeted `cargo test`
(`preview_screen`), clippy, the new smoke,
`pnpm smoke:notes-window-invisible`, `pnpm probe:preview-lifecycle`, and
`pnpm smoke:recording-studio` (capture filter). Windows: CI plus the
marker harness on the Windows box, or a written waiver.

---

## Workstream D: move and resize while recording or live (D1)

**Route:** Implementation, fit 9 (recording behaviour). **Lane:**
`fable-5.1`.

**Drift paths:** `apps/desktop/src/renderer/src/components/tabs/layout-tab.tsx apps/desktop/src/renderer/src/components/scene/ crates/videorc-backend/src/live_layout.rs crates/videorc-backend/src/scene.rs crates/videorc-backend/src/compositor.rs crates/videorc-backend/src/recording.rs crates/videorc-backend/src/main.rs`

**Why (verified):**

- **Not a regression.** `dragEnabled={showOverlayControls && !isSessionActive}`
  came in with `cf0075df` (2026-07-03, "W2-SC3: drag the camera on the
  stage"). It was kept by #378 and plan 174 C-22 (#647), and plan 213 G
  (#1029) extended it to crop. `git log -L` finds no window without it.
  Plan 213 deferred live editing explicitly.
- **The lock is UI only:**
  - drag, resize and crop (`layout-tab.tsx:758-779`);
  - the fields, nudges and visibility (`:984-1116`, `:1335-1349`);
  - `SCENE_POSITION_LOCK_REASON` (`:114`).
- **The backend takes the commit live.**
  - `scene.source.transform.update` goes to `scene::update_source_transform`
    (`scene.rs:283-294`), then
    `live_layout::commit_scene_with_current_layout`
    (`live_layout.rs:2317-2335`). That commit only bails for idle-only
    reloads, and reports mode "hot" while recording.
  - Live preset swaps already ride this path
    (`smoke:live-layout-switch-recording`).
  - Overlays and banners are already editable live (`layout-tab.tsx:808`
    gates only on the websocket).
- **Every output picks it up.**
  - Metal and CPU read the installed scene every tick.
  - The macOS record+stream aux leg reads the primary scene. Only a
    vertical simulcast leg composes its own scene, so a horizontal edit
    leaves it alone, by design.
  - The camera never restarts ("the scene math absorbs the scale",
    `live_layout.rs:1934-1943`).
  - The ISO files record the raw source.
- **Exceptions:**
  - **The legacy FFmpeg graph** is static (`recording.rs:3100-3107`). The
    banner precedent is `session_accepts_banners`.
  - **Drafts**, the live ghost while dragging, are refused during a session
    on purpose (`editor_draft_refusal`, `compositor.rs:2428-2443`, plan 058
    decision 4).

**Slices:**

- **D1 (red first for the refusal). The backend says when it can.**
  Publish `acceptsLiveSceneEdits` beside the banner flag. Refuse
  `scene.source.transform.update`, `nudge` and `reset` with a named code
  while a session runs on the legacy graph. Add the field to
  `backend-rpc-contract.ts`.
  _Done when:_ a `live_layout` test commits a transform mid-session, and a
  legacy-path test gets the refusal.
- **D2. The Scene page unlocks.** Drop `!isSessionActive` from drag,
  resize, crop, the fields and the nudges when the flag is true.
  - `onDraft` stays off while live: the outline follows the drag, and the
    outputs move on release.
  - Orientation stays locked. Visibility stays locked; it is out of scope.
  - The live hint says "Changes apply to your stream when you let go."
  - When the flag is false, the lock reason says why.

  _Done when:_ `layout-tab.test.ts` gains a "live session" describe
  (enabled with the flag, the reason without it), and `scene-stage.test.ts`
  pins "no draft while live".
- **D3. Proof it lands in the files.** Extend `smoke:freeform-editor` to
  press Record, move the camera, and sample the recording before and after
  (`smoke:scene-switch-pixels` style). Also check a local RTMP sink.
  _Done when:_ the camera's box moves in the file and the stream, with no
  black or frozen frame at the commit.

**Gate:** typecheck, lint, desktop tests, targeted `cargo test`
(live_layout, scene, compositor), clippy,
`pnpm smoke:live-layout-switch-recording`, the extended
`smoke:freeform-editor`, a record+stream smoke for the aux leg, and
`pnpm smoke:recording-studio`. By eye in both themes.

---

## Workstream E: bigger than the canvas: cut off, never squashed (D2)

**Route:** Implementation, fit 9 (four render paths must agree).
**Lane:** `fable-5.1`.

**Drift paths:** `crates/videorc-backend/src/scene_geometry.rs crates/videorc-backend/src/scene.rs crates/videorc-backend/src/compositor.rs crates/videorc-backend/src/metal_compositor.rs crates/videorc-backend/src/recording.rs crates/videorc-backend/src/windows_d3d11_compositor.rs apps/desktop/src/renderer/src/components/scene/stage-transform.ts apps/desktop/src/renderer/src/components/scene/transform-fields-math.ts apps/desktop/src/renderer/src/components/tabs/layout-tab.tsx`

**Why (verified):**

- **"100%" is the W/H fields' cap.** `clampTransformField` keeps sizes in
  [min, 1] (`transform-fields-math.ts:56-61`). The canvas clamps keep the
  box on the canvas (`stage-transform.ts:414-432`).
- **The only Zoom slider today is the camera lens** (100–200%,
  `layout-tab.tsx:~1399`). Screen size is the background's Visibility, and
  it stops at the full canvas.
- **The backend accepts a bigger box but squashes it.**
  - It accepts w and h up to 2, and x and y in [-1, 2]
    (`sanitize_transform_unsnapped`, `scene.rs:789-797`).
  - But `scene_source_rect_pixels` (`scene_geometry.rs:135-157`) clamps x
    and y onto the canvas and shrinks w and h to what's left. A box past
    the edge is squashed, not cut off. The test
    `transform_and_crop_table_clips_at_canvas_edges` pins that squash.
  - Every path uses that rect:
    - Metal: `gpu_source_placement`.
    - CPU: `SourceFit` holds unsigned x and y.
    - FFmpeg graph: the overlay x and y are pre-clamped.
    - Windows D3D11: its twin (`windows_d3d11_compositor.rs:822-852`).
  - Only the Buddy sprite is drawn unclamped.
- **Crop** keeps at least 5% per axis (`scene.rs:800-810`).

**Slices:**

- **E1 (red first). One signed, uncut rect.** `scene_source_rect_pixels`
  returns the full rect with signed x and y. A helper intersects it with
  the canvas and shifts the source's start by the amount cut off.
  _Done when:_ the edge test becomes "cut, never squash" (failing on the
  base), with a negative-x case and a 400% case. A box fully on the canvas
  gives the same pixels as before.
- **E2. Every path uses it.**
  - Metal passes the uncut quad (the GPU clips, and masks keep their uv).
  - CPU and D3D11 draw the intersection.
  - FFmpeg uses negative overlay x and y.
  - The CPU mask tester uses the uncut fit.

  _Done when:_ there is a pixel test per path in the style of
  `screen_crop_fixture` (a box at x -0.25, w 1.5), plus the aux leg. The
  existing goldens are unchanged.
- **E3. The editor's limits.** Sizes up to 4 and positions in [-3, 4] in
  `sanitize_transform_unsnapped`, with the same limits in TS. "At least 5%
  stays on the canvas" in the canvas and field clamps. The W/H fields show
  up to 400%.
  _Done when:_ `transform-fields-math.test.ts` ("keeps sizes between the
  stage minimum and the canvas" becomes the new limit) and
  `stage-transform.test.ts` ("never leaves the canvas" becomes the 5%
  rule) pass, and the scene round-trips in the Rust and TS tests.
- **E4. A Zoom slider for the screen.** In Freeform, with the screen
  selected: **Zoom**, 100–400%, scaling the box around its centre. Its hint
  says: "Zooming softens text. Crop to show part of the screen sharply."
  _Done when:_ a test proves the slider's patch keeps the centre.

**Gate:** typecheck, lint, desktop tests, targeted `cargo test`
(scene_geometry, compositor, recording, windows modules through CI),
clippy, `pnpm smoke:freeform-editor`, `pnpm smoke:scene-switch-pixels`,
`pnpm smoke:separate-source-fixture` (ISO unchanged), a record+stream
smoke, and `pnpm smoke:recording-studio`. Windows CI for D3D11. By eye in
both themes.

---

## Workstream F: rounded corners for the screen (D3)

**Route:** Implementation, fit 8. **Lane:** `fable-5.1` for F1 and F2 (four
render paths); F3 (UI) can be `opus-5.5`.

**Drift paths:** `crates/videorc-backend/src/protocol.rs crates/videorc-backend/src/scene_geometry.rs crates/videorc-backend/src/compositor.rs crates/videorc-backend/src/metal_compositor.rs crates/videorc-backend/src/recording.rs crates/videorc-backend/src/windows_d3d11_session.rs apps/desktop/src/shared/backend-rpc-contract.ts apps/desktop/src/renderer/src/lib/capture.ts apps/desktop/src/renderer/src/components/scene/stage-transform.ts apps/desktop/src/renderer/src/components/tabs/layout-tab.tsx`

**Why (verified):**

- **The camera's setting.** `LayoutSettings.camera_corner_radius_pct`
  (`protocol.rs:499-504`, default 12) is resolved once by `camera_mask`
  (`scene_geometry.rs:259-278`) into `SceneMask::{None, Circle, Rounded}`.
- **Every path already takes a mask per source.** Only the camera gets
  one; the screen is hard-coded to none:
  - CPU: `compositor.rs:11362`.
  - Metal: `:8997`, plus the image and window branches.
  - FFmpeg: a shape only for `kind == Camera` (`recording.rs:23274-23283`).
  - D3D11: the session maps a mask for the camera only
    (`windows_d3d11_session.rs:3492-3497`).
  - Linux uses the CPU path, so there are four paths.
  - The aux leg re-uses the prepared sources, so the mask travels with
    them.
- **The mask is drawn on the fitted rect.** So it sits on the visible box
  after crop, Fill and the background's stage margin. It must follow E's
  uncut rect, which is why F comes after E.
- **The ISO reset site** is `source_iso_snapshot`
  (`compositor.rs:13446-13462`).
- **The canvas mirrors the camera's shape** (`stageSourceShape`,
  `stage-transform.ts:441-468`), from a status `shape` that the backend
  sends only for the camera (`compositor.rs:13205-13214`).
- **The parity template** is the screen-crop fixture trio:
  `scene_geometry::screen_crop_fixture`, `compositor.rs:15143-15281` (CPU,
  Metal, aux) and `recording.rs:42699` (FFmpeg).

**Slices:**

- **F1. Model and geometry.**
  - `screen_corner_radius_pct: u32` with `#[serde(default)]` (0), with a TS
    sibling in `backend-rpc-contract.ts` and `capture.ts`.
  - `screen_mask(layout)` next to `camera_mask`.
  - `source_iso_snapshot` resets it to 0.

  _Done when:_ an old layout JSON still parses to 0, and
  `source_iso_screen_leg_records_the_whole_uncropped_screen` is extended
  to a rounded screen.
- **F2. The four paths and the aux leg.** Wire the screen sites to
  `screen_mask`. The status sends the screen's shape.
  _Done when:_ a `rounded_screen_fixture` (corner pixel is the background,
  edge midpoint is the screen) passes on CPU, Metal, aux and FFmpeg
  legacy, and a D3D11 constants test passes, all within the camera mask's
  tolerance.
- **F3. The control.** **Corners** under the screen's framing row on the
  Scene page, the same control as the camera's. The canvas draws the
  rounded outline.
  _Done when:_ `layout-tab.test.ts` and `stage-transform.test.ts` cover
  it. By eye in both themes.

**Gate:** typecheck, lint, desktop tests, targeted `cargo test`
(scene_geometry, compositor, recording; windows through CI), clippy,
`pnpm smoke:separate-source-fixture`, a record+stream smoke, and
`pnpm smoke:recording-studio`. By eye: the Preview matches the recording.

---

## Workstream G: chat on stream (D5)

**Route:** Implementation, fit 9 (multi-system, every output). **Lane:**
`fable-5.1`.

**Drift paths:** `crates/videorc-backend/src/overlay_layout.rs crates/videorc-backend/src/comment_highlight.rs crates/videorc-backend/src/compositor.rs crates/videorc-backend/src/windows_d3d11_session.rs crates/videorc-backend/src/live_chat.rs crates/videorc-backend/src/main.rs apps/desktop/src/shared/backend-rpc-contract.ts apps/desktop/src/renderer/src/lib/comment-highlight.ts apps/desktop/src/renderer/src/lib/canvas-png.ts apps/desktop/src/renderer/src/lib/overlay-layout.ts apps/desktop/src/renderer/src/components/tabs/layout-tab.tsx apps/desktop/src/renderer/src/components/stream-manager/stream-manager.tsx apps/desktop/src/renderer/src/hooks/use-studio.tsx`

**Why (verified):**

- **The template is the comment highlight.**
  - The renderer paints the card on a canvas (`lib/comment-highlight.ts`,
    emotes included) and encodes a PNG in a worker (`canvas-png.ts`).
  - It sends `comments.highlight.set` with horizontal and vertical PNGs
    (`comment_highlight.rs:98-118`).
  - The backend holds it in a slot read every tick
    (`compositor.rs:9964-9971`), drawn by Metal, CPU, D3D11 and the aux
    and vertical legs (`overlay_leg_plan`, `overlay_layout.rs:449`).
  - The backend has no font crate, so text is never drawn in Rust.
  - The legacy FFmpeg graph carries no highlight
    (`comment_highlight.rs:956`); chat will be the same.
- **Overlay layout is strict.**
  - `OverlayLayout { highlight, captions, buddy }`
    (`overlay_layout.rs:102-115`) has no per-field serde default.
  - The TS schema has `allowUnknown: false` (`backend-rpc-contract.ts:3416-3447`).
  - `load_overlay_layout` falls back to **defaults** on a parse error
    (`overlay_layout.rs:726-738`). A careless new field resets everyone's
    placement.
- **Where the switches live.** Show on stream and Show in recording are on
  the Scene page's overlay inspector (`layout-tab.tsx:~1601-1621`). The
  Buddy also has one in the Stream Manager (`stream-manager.tsx:363`).
- **Chat data.** `LiveChatMessage` (`live_chat.rs:390-417`) has platform,
  name, badges, and text fragments with emote images. A delete or hide
  arrives on the same path with `is_deleted` and already clears the
  highlight (`live_chat.rs:3562`).
- No chat-overlay plan exists.

**Slices:**

- **G1. Backend.**
  - `OverlayItem::Chat`, with `chat` in `OverlayLayout` under
    `#[serde(default)]`.
  - A per-orientation rect, off on stream and in recording by default.
  - A `chat.overlay.set` / `chat.overlay.clear` RPC carrying horizontal and
    vertical PNGs, held in a slot like the highlight's and drawn per leg.
  - Update every `OverlayItem` match.

  _Done when:_ the `overlay_layout` and `compositor` tests and the contract
  tests pass, a saved `overlayLayout` row from `57b0c457` loads with its
  highlight, captions and Buddy placement intact, and a CPU/Metal blit
  parity test (copy `cpu_and_metal_blit_the_same_overlay_rect`) passes.
- **G2. The painter.**
  - The renderer keeps the last 5 eligible messages: not deleted, not
    hidden, not system rows.
  - It repaints on a new message or a delete, at most twice a second, and
    clears at the end of the session.
  - Each row is name, platform icon, text and emotes. A vertical card for
    the portrait leg.

  _Done when:_ desktop tests cover eligibility, coalescing and a delete
  leaving the box, and `pnpm smoke:comment-highlight-stream` gains a
  chat-box assertion on the RTMP sink.
- **G3. The controls.** A **Chat** item on the Scene page, placed like
  Highlight and Captions, with the same Show on stream / Show in recording
  switches. A **Chat on stream** switch in the Stream Manager, like the
  Buddy's. Both go in a lazy chunk.
  _Done when:_ `layout-tab.test.ts` and the stream-manager tests cover it,
  the asset budget holds, and it looks right by eye in both themes.
- **G4. Proof on every output.** `pnpm smoke:multistream:vertical` for the
  portrait card, `pnpm smoke:studio-chat`, and a record+stream smoke for
  the aux leg.

**Gate:** typecheck, lint, desktop tests, targeted `cargo test`
(overlay_layout, comment_highlight, compositor, live_chat), clippy, the
smokes in G2 and G4, and `pnpm smoke:recording-studio` once at the end.
Windows CI for D3D11.

---

## STOP conditions

- **A:** the token is present and readable on a repro, but the error still
  fires. The cause is something else; report it.
- **C:** applying a new exclusion list on macOS needs a capture restart (a
  visible hitch on stream). Report with numbers; don't restart silently.
- **D:** a live transform commit restarts any capture, or puts a black or
  frozen frame in the recording or stream.
- **E:** cutting instead of squashing changes the pixels of a box that is
  fully on the canvas (an existing golden changes).
- **F:** the screen mask disagrees between paths beyond the camera mask's
  tolerance.
- **G:** adding `chat` can't be done without resetting a saved overlay
  layout.
- Any new status, event or settings field that isn't in
  `backend-rpc-contract.ts`, or a Rust `Option` without
  `skip_serializing_if`.
- The renderer's eager gzip goes over 470,000 bytes. Move the new UI to a
  lazy chunk; never raise the ceiling without the owner.
- An anchor's behaviour changed since `57b0c457`.

## Not in this plan

- The stream following a drag live. Plan 058 decision 4 stands; D1 took
  move on release.
- Changing orientation or visibility while live.
- Chat on stream styles, avatars, fade, per-platform filters, or Buddy
  looking at the chat box. A later plan, if asked.
- Rounded corners per source for images or a second screen.
- Hiding the chat window on Linux (the platform can't).
- X chat without a Videorc account (the relay needs it).
- A screen zoom that follows the mouse.

## Owner acceptance

- **A:** sign out the dev app, Go Live with X added by Sign in. The Go
  Live check names the Videorc sign-in. Sign in mid-stream: X chat
  connects without a restart. A real X account is owed.
- **B:** all three Edit scene doors open the editor with the camera
  selected.
- **C:** pin the Stream Manager over a captured display and turn on Hide
  from stream. It's gone from the recording and still on your screen. On
  Windows, the tester or a waiver.
- **D:** move and resize the camera while recording and streaming. The
  file and the stream match the Preview after release.
- **E, F:** a 200% screen box, half off the canvas, with rounded corners
  matches between the Preview and the recording.
- **G:** chat on stream on a real YouTube and X test stream (live lab,
  only on the owner's go), both orientations. A deleted message leaves.
- **Feedback loop:** send the streamer the build with A, B and C first,
  and ask the three questions above.

## As built

_Empty until a workstream lands._
