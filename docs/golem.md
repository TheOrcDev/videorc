# Golem

The Golem is Videorc's AI companion while you're live (plan 119 as Orcle,
renamed and made yours in plan 164). The Golem tab sits right under Studio in
the sidebar (⌘9): its first tab is where you name your Golem, give it a
personality and its looks, and turn it on for your streams. Golem Live needs a
signed-in Videorc Premium account, and it stays marked Alpha until the owner's
live acceptance (A1) passes.

The code, wire and storage name is `cohost`. Everything a user reads says
Golem (or the name you gave it), never co-host and no longer Orcle.

## What Golem does while you're live

The Golem tab names three powers:

- **Never miss a question.** Questions from every platform, grouped, each with
  a drafted reply you approve. Answer out loud and Golem clears it.
- **Chat stays safe.** Spam, scams and abuse are flagged against your own
  rules. Golem never acts on its own.
- **The room, handled.** Golem greets first-timers, reminds you of your
  promises, nudges you in dead air, tells you when viewers say your audio
  broke, and can put the comment you're talking about on screen.

The Golem posts only in the modes you turn on. Everything is off by default
(plan 164, D4): today it removes a comment only when you tell it to, and a
reply goes out only when you send it. Automatic greetings and answers arrive
with plan 164's Phase D, each behind its own switch.
Voice commands (highlight, clear and remove a comment by asking) are covered
in [orcle-commands.md](orcle-commands.md).

## The one switch

"Golem joins my streams" turns Golem Live on and off.

- **On.** If Cloud AI is off, the "Turn on Golem Live?" dialog opens first,
  and nothing is saved until you allow it. Then one settings save turns on
  both Golem (`enabled`) and listening (`listen`), so Golem reads your chat
  and hears you.
- **Off.** Saves `enabled: false`. Nothing runs, and your other settings stay
  as they are.

Golem's chat producer starts with the stream's live chat and stops with it.
With Golem, Listen and Cloud AI consent enabled, addressed marker commands can
also run during a recording without chat. Stream Manager shows that listening
readiness separately. Say “Golem, make a marker here for [title]” or use the
free local `/marker [title]` command. Browse the saved points in Library; see
[Session markers](session-markers.md).

The status line under the switch says where the chat producer stands: Off;
On, joins your next stream; Live now; or Needs attention, with a plain reason
(sign in, Premium, Cloud AI off, or a pause or error from the Golem server).

The Stream Manager's own entry points (the status popover, the nudge and the
listen card) turn Golem on the same way.

**Customize**, collapsed under the report, holds the Cloud AI row and every
Golem setting: hearing you while you're live, reply tone, Golem notes, chat
rules, flag sensitivity, and showing comments on stream automatically.
Settings has no Golem tab any more; a remembered Golem settings tab opens the
default one.

## Consent: Cloud AI

Cloud AI has one home: the Cloud AI row under Customize in the Golem tab. It
is the only place to revoke it. The switch's consent dialog can grant it too,
and both write the same stored choice (`videorc.aiConsent`). There is no
second consent store. A change applies to a stream that is already live.

What Cloud AI covers while you're live:

- Golem reads your live chat.
- Golem hears you: your microphone audio goes to Videorc's cloud
  speech-to-text and comes back as text, even with live captions off.

What is kept, and where:

- Videorc servers don't keep your chat or your audio.
- When you record, the transcript is saved next to the recording
  (`<recording>.srt`) on this computer.
- A short report of each stream is saved on this computer.

## The stream report

**When.** Golem saves a report when its session ends: when the stream stops,
or when you turn Golem off. Turning Golem off and on again during the same
stream folds both parts into one report. If the app crashes mid-stream, that
stream has no report.

**What.** Counts and what became of things, never raw chat or drafts:

- questions caught, answered on air, replied, marked answered, dismissed,
  restored and shown on stream;
- the questions themselves, up to 200: wording, up to five askers, platforms,
  priority and outcome;
- flags raised and dismissed, by kind and severity;
- promises heard, kept, dismissed and reminded, plus up to 20 still open when
  the stream ended;
- first-timers seen and greeted, by voice, in chat or by hand;
- the alerts viewers raised, with the most viewers who said it at once;
- recaps offered, drafted and dismissed.

**Where.** In the local Videorc database (table `cohost_reports`, one row per
session). It is deleted with the recording, and it is never sent to Videorc.
It holds viewer names and question text, so it must never be added to the
support bundle or to any upload.

**Reading it.** The Golem tab's "Last stream" card shows the newest stream,
with a switcher for recent ones. In Library, a stream's row menu has "Golem
report", which opens the tab on that session. A stream Golem was off for
still shows its moments and chat totals.

## Clip that

Say "clip that" while Golem hears you (or live captions are on), or press
Mark clip: in the Stream Manager, from a Stream Deck or the phone remote, or
with the Mark clip shortcut from Settings → Shortcuts. The toast reads "Clip
marked at 12:34. It's in your stream report in Golem."

Marks are saved only while Videorc records to a file. With Record off, the
toast says the clip can't be saved.

The report shows them as **moments**: every mark, plus up to three chat peaks,
each snapped to the transcript with an excerpt. Moments are worked out when
the report is read and never stored. There is no clip file export.

## Where Golem works live

Live, Golem works in the Stream Manager, in the Comments window (⇧⌘J). The
Golem pane sits above the chat and is keyboard-first: ⌘J focuses it, ↑ and ↓
move, R replies, H shows the comment on stream, A marks it answered and ⌫
dismisses. While you're live, the Golem tab shows "Open Stream Manager".

## For developers

Settings and live state:

- `cohost.settings.get` and `cohost.settings.set`; the switch sends
  `{enabled: true, listen: true}` or `{enabled: false}`.
- The `cohost.state` event carries the live pane.

The persona and its images (plan 164, Phase A):

- `cohostSettings.persona` holds the name, personality, bubble style, state
  images (relative paths `<personaId>/<state>.<ext>`) and source; `autoChat`
  holds the mode and the three behaviours, all off by default. Both ride
  `cohost.settings.get/set` as whole objects; the backend refuses an
  out-of-bounds persona with `cohost-persona-invalid` and bad templates with
  `cohost-auto-chat-invalid`.
- Uploads go through main (`golem-assets:import-image`): sniffed PNG/WebP
  (JPEG for idle), 4 MB, copied to `userData/golem-assets/<personaId>/`,
  served as `videorc-asset://golem/<personaId>/<state>.<ext>`.
  `golem-assets:remove` deletes the folder for Start over.
- Generation is `cohost.avatar.generate {state, prompt, style}`: accepted at
  once, the outcome arrives as `cohost.avatar.generated {requestId, state,
  path?, opaque, error?}`. The backend posts to the web's
  `/api/ai/cohost/avatar` (95 s, 8 MB) and writes the PNG into the same
  managed folder, which main hands over as `VIDEORC_MANAGED_GOLEM_ROOTS`.
  Generate is on only when `/api/ai/capabilities` reports
  `cohost.avatar.enabled`; the daily cap is the web's.
- The bundled default pack (`assets/golem/default/`) is placeholder art the
  owner replaces; `persona.source: 'default'` means "use it".

The report:

- `cohost.report.get {sessionId}` returns
  `{sessionId, report, moments, chat: {messages, byPlatform}}`. `report` is
  `null` when Golem left none for that session.
- `cohost.report.latest` takes no params and returns the same payload for the
  newest session that has a report, else the newest streamed session, or
  `null` when there is neither.
- The `cohost.report.saved {sessionId}` event fires when a report is written
  or folded into the one already there.

The report format is `CohostSessionReport` with `version: 1`
(`crates/videorc-backend/src/protocol.rs`), mirrored in
`apps/desktop/src/shared/backend.ts` with closed validators in
`apps/desktop/src/shared/backend-rpc-contract.ts` and a fixture in
`protocol-fixtures/high-risk-contracts.json`. A stored report with another
version reads as no report, never as an error. Optional fields are omitted,
never null.

Code:

- Backend: `cohost.rs` builds the report in `stop_session` and saves it after
  the engine lock is released; `moments.rs` ranks moments; `transcript.rs`
  parses the `.srt`; `storage.rs` owns `cohost_reports`.
- Renderer: `components/tabs/orcle-tab.tsx` with `lib/orcle-tab-view.ts`, and
  `components/orcle-report-card.tsx` with `lib/orcle-report-view.ts` and
  `hooks/use-orcle-report.ts`, all under `apps/desktop/src/renderer/src/`.

Checks:

- `pnpm smoke:cohost-fake` runs Golem against a fake server and asserts the
  saved report's counts.
- `node scripts/capture-ui-pages.mjs` captures every page, opens the Golem tab
  by its id `ai`, and fails if the Golem Live switch is missing.
