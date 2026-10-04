# Orcle Live

Orcle is Videorc's AI producer while you're live (plan 119). Orcle Live is one
switch in the Orcle tab, right under Studio in the sidebar (⌘9). It needs a
signed-in Videorc Premium account, and it stays marked Alpha until the owner's
live acceptance (A1) passes.

The code, wire and storage name is `cohost`. Everything a user reads says
Orcle, never co-host.

## What Orcle does while you're live

The Orcle tab names three powers:

- **Never miss a question.** Questions from every platform, grouped, each with
  a drafted reply you approve. Answer out loud and Orcle clears it.
- **Chat stays safe.** Spam, scams and abuse are flagged against your own
  rules. Orcle never acts on its own.
- **The room, handled.** Orcle greets first-timers, reminds you of your
  promises, nudges you in dead air, tells you when viewers say your audio
  broke, and can put the comment you're talking about on screen.

Orcle never posts, replies or moderates by itself. A reply goes out only when
you send it.

## The one switch

"Orcle joins my streams" turns Orcle Live on and off.

- **On.** If Cloud AI is off, the "Turn on Orcle Live?" dialog opens first,
  and nothing is saved until you allow it. Then one settings save turns on
  both Orcle (`enabled`) and listening (`listen`), so Orcle reads your chat
  and hears you.
- **Off.** Saves `enabled: false`. Nothing runs, and your other settings stay
  as they are.

Orcle only runs during a stream: it starts with the stream's live chat and
stops with it. The status line under the switch says where it stands: Off;
On, joins your next stream; Live now; or Needs attention, with a plain reason
(sign in, Premium, Cloud AI off, or a pause or error from the Orcle server).

The Stream Manager's own entry points (the status popover, the nudge and the
listen card) turn Orcle on the same way.

**Customize**, collapsed under the report, holds the Cloud AI row and every
Orcle setting: hearing you while you're live, reply tone, Orcle notes, chat
rules, flag sensitivity, and showing comments on stream automatically.
Settings has no Orcle tab any more; a remembered Orcle settings tab opens the
default one.

## Consent: Cloud AI

Cloud AI has one home: the Cloud AI row under Customize in the Orcle tab. It
is the only place to revoke it. The switch's consent dialog can grant it too,
and both write the same stored choice (`videorc.aiConsent`). There is no
second consent store. A change applies to a stream that is already live.

What Cloud AI covers while you're live:

- Orcle reads your live chat.
- Orcle hears you: your microphone audio goes to Videorc's cloud
  speech-to-text and comes back as text, even with live captions off.

What is kept, and where:

- Videorc servers don't keep your chat or your audio.
- When you record, the transcript is saved next to the recording
  (`<recording>.srt`) on this computer.
- A short report of each stream is saved on this computer.

## The stream report

**When.** Orcle saves a report when its session ends: when the stream stops,
or when you turn Orcle off. Turning Orcle off and on again during the same
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

**Reading it.** The Orcle tab's "Last stream" card shows the newest stream,
with a switcher for recent ones. In Library, a stream's row menu has "Orcle
report", which opens the tab on that session. A stream Orcle was off for
still shows its moments and chat totals.

## Clip that

Say "clip that" while Orcle hears you (or live captions are on), or press
Mark clip: in the Stream Manager, from a Stream Deck or the phone remote, or
with the Mark clip shortcut from Settings → Shortcuts. The toast reads "Clip
marked at 12:34. It's in your stream report in Orcle."

Marks are saved only while Videorc records to a file. With Record off, the
toast says the clip can't be saved.

The report shows them as **moments**: every mark, plus up to three chat peaks,
each snapped to the transcript with an excerpt. Moments are worked out when
the report is read and never stored. There is no clip file export.

## Where Orcle works live

Live, Orcle works in the Stream Manager, in the Comments window (⇧⌘J). The
Orcle pane sits above the chat and is keyboard-first: ⌘J focuses it, ↑ and ↓
move, R replies, H shows the comment on stream, A marks it answered and ⌫
dismisses. While you're live, the Orcle tab shows "Open Stream Manager".

## For developers

Settings and live state:

- `cohost.settings.get` and `cohost.settings.set`; the switch sends
  `{enabled: true, listen: true}` or `{enabled: false}`.
- The `cohost.state` event carries the live pane.

The report:

- `cohost.report.get {sessionId}` returns
  `{sessionId, report, moments, chat: {messages, byPlatform}}`. `report` is
  `null` when Orcle left none for that session.
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

- `pnpm smoke:cohost-fake` runs Orcle against a fake server and asserts the
  saved report's counts.
- `node scripts/capture-ui-pages.mjs` captures every page, opens the Orcle tab
  by its id `ai`, and fails if the Orcle Live switch is missing.
