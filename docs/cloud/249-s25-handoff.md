# Plan 249 S25: count and report cloud activity correctly

Status: implemented at source level, **not qualified**. Only light checks
ran. The Rust here has never been compiled, and the `reporting` acceptance
case is maintained but has not run. No real email, Discord message, provider
call or broadcast was made.

## Trees and bases

- Desktop: `/Users/orcdev/projects/videorc-wt-249-s25`, branch
  `feat/249-s25-cloud-parity` (local, unpublished).
- Web: `/Users/orcdev/projects/videorcweb-wt-249-s25`, same branch name.
- Each tree is the published S24 tip with the published total-view reports
  merged in, staged and uncommitted (no conflict). S25 is the unstaged and
  untracked diff on top. Commit the staged merge first, then S25.

| Repo    | HEAD (S24)          | MERGE_HEAD (total views) |
| ------- | ------------------- | ------------------------ |
| Desktop | `7c2e0ed51` (#1461) | `d80b77792` (#1458)      |
| Web     | `db7ce88e` (#142)   | `97ad1518` (#139)        |

## What one stream is

One stream is one **live interval** of a cloud show, as the server owns it
(S16 `liveInterval`):

- It starts when the first platform leg went live (`liveSince`).
- It ends only when the server confirms its output stopped (`endedAt`).

So the time a room is open but off air is never counted. End livestream then
Go Live in the same show is a second interval.

A solo resume starts a new local capture session, but the stream goes on: the
interval reports it, and the local session's own report and usage are
suppressed (`cloud_output_session::local_session_bound`).

A node show, which has no interval, keeps its local behaviour.

## Desktop

`cloud_output_session.rs` folds `cloud.state` into one `Live` and one `Ended`
event per interval, and each observer acts on those events:

- **Reports and history.** One queued report per show and interval
  (`cloud_interval_report_emails`).
  - Its id is derived from the show and interval (SHA-256 into an RFC 9562
    version 8 UUID). The web's existing unique `(user, reportId)` keeps one,
    whichever computer sends it.
  - The report is timed by the server's interval.
  - Viewer and view reads are kept only inside the interval. Views and
    concurrent viewers stay separate, and each platform keeps its own total
    views (the total-view reports are reconciled here).
  - A solo interval reads every local session that fed it
    (`cloud_interval_sessions`).
  - Chat, audience and community totals are kept for a whole session. They are
    used only when they describe this interval alone.
  - "Since your last stream" is left out for an interval.
  - The email and history preferences are read from the web, unchanged.
- **Usage stats.** One `stream_start` and one `stream_stop` per interval,
  with derived event ids. The web keeps one of each id. Duration is the
  interval's. The sharing setting is unchanged.
- **Discord.** A talk show is announced per interval, using S18's saved
  destinations.
  - Legs confirm from the cloud's own legs, and `endedAt` marks the post as
    "was live".
  - The web's interval claim (`POST /api/cloud/shows/:id/effects`) keeps the
    first claim, so a resume, a relaunch or another computer never posts
    twice. If the claim can't be made (offline, an older web), nothing is
    posted.
  - A solo show keeps its local session announcement.
- **/live status.** A talk show beats from its interval: session id = the
  interval id, the cloud's legs, the server's start.
  - Every beat about a cloud show carries `showId` and this computer's
    controller epoch (S24).
- **Who acts.** Only the computer that may act for the show produces effects
  (`cloud_controller::ownership_allows`). A successor continues the same
  interval with the same ids.
- **Ending an interval early.** It ends before its `endedAt` only on positive
  evidence: the same show reports another interval, or the show was cleared
  with an end reason. The end is then the last time it was seen live (a lower
  bound). A status that merely lacks the show ends nothing.

## Web

- **Migration 0044** (`cloud_show_interval_effects`, additive): one claim per
  show, interval and effect. The current effect is `discord-announce`.
  - Numbers: S24 0041, S22 0042, S19 0043 (asked of S19).
- **`POST /api/cloud/shows/:id/effects`.**
  - The caller must own the show.
  - It is an S24 controller command: a stale epoch, or a missing header on an
    adopted show, gets 409.
  - The interval must be the show's, current or past, and must have gone live.
- **`state_json.pastIntervals`**: the show's ended intervals, at most 20, so
  an ended interval stays provably the show's.
- **Live status.** The beat accepts optional `showId` and `controllerEpoch`.
  - `/live` combines the show's real legs with the desktop's alerts, title and
    recording only for a beat from the show's current controller.
  - A beat from a computer that lost the show is ignored for that show.
  - An older beat without `showId` is treated as before.
- **No new history or email path.** The derived report id makes the existing
  dedupe hold across computers. Platform enums still exclude any "Videorc
  Cloud" destination.

## Acceptance case (maintained, not executed)

Run `VIDEORC_PARITY_WEB_ROOT=… node scripts/smoke-cloud-parity-app.mjs --case reporting`.

1. It first runs:
   - the judge and fake-web tests;
   - the web interval tests;
   - the Rust filters in `REPORTING_RUST_FILTERS`.
2. Interval 1 (opted in):
   - room Go Live, kill and relaunch, Resume, End livestream after five
     minutes;
   - then it waits for one report and one usage start and stop.
3. Interval 2 (opted out of reports, usage and Discord): Go Live again in the
   same show, End livestream.
4. `assertReportingOnce` then requires:
   - for interval 1: one report, one usage start and stop, one claim and one
     Discord post, all timed by the server;
   - for interval 2: nothing;
   - no id belonging to no interval;
   - every beat naming its show.

The fake web keeps reports, usage, beats and claims by the web's rules, and
now applies the web's interval rule. It has a loopback Discord sink
(`VIDEORC_DISCORD_API_BASE_URL`, refused in packaged builds).

## Remaining before PR readiness

- **Rust is uncompiled.** Run `cargo test -p videorc-backend` with the
  filters above, then `cargo clippy -p videorc-backend -- -D warnings`. Run
  them on main with #1457.
- **The case has not run.** The Discord post needs a linkable destination. If
  the fake YouTube broadcast reads as private, the announcer posts nothing for
  it and the case's Discord assertion fails. That is a fixture fix, not a
  product one.
- **The migration has not run against Postgres.**
- **Known limits, not waived:**
  - The interval-to-session links live on the computer that recorded them. A
    successor computer's solo report reads only the sessions it saw.
  - An interval whose `endedAt` never reaches any controller and whose show is
    cleared without an end reason is never reported. It is under-reported, not
    invented.
  - Solo Discord announcements still follow the local session (a resume after
    15 minutes posts again). Moving solo onto interval claims needs its
    destinations persisted the way S18 does for rooms.
