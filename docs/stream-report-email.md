# Stream report email

Plan 237. About a minute after each live stream of 5 minutes or more, the
signed-in account gets one email with the stream's numbers: how many people
were watching at the peak and on average, how many chatted, and the same per
platform, with new followers, support, plan 225's community counts and the
change since the last stream.

The web side (route, email, unsubscribe, privacy copy) is videorc-web's
`docs/stream-report-email.md`, which also holds the wire contract.

## Where it lives

| Piece                                                                  | File                                                                                 |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| The numbers, from the session's own rows (pure builder + SQLite reads) | `crates/videorc-backend/src/stream_report.rs`                                        |
| The queue, the sender, the RPCs                                        | `crates/videorc-backend/src/stream_report_email.rs`                                  |
| The pending reports (`stream_report_emails`)                           | `crates/videorc-backend/src/storage.rs`                                              |
| Livestream → After the stream                                          | `apps/desktop/src/renderer/src/components/streaming/stream-report-email-section.tsx` |

## What is sent, and when

1. An observer reads `recording.status` and `stream.targets` from the event
   bus. A session that went live and ran 5 minutes or more, while an account
   is signed in, becomes a row in `stream_report_emails`: the session id, a
   report id, the destinations' platforms, the account's email, due 60 s
   after the end. The row holds no numbers, and deleting the session deletes
   it.
2. The sender takes due rows one at a time. It drops a row whose account is
   no longer the signed-in one (a sign-out drops every queued row at once),
   and a row older than 3 days.
3. It asks `GET /api/account/stream-report-email` first. An account that
   turned reports off sends nothing.
4. It builds the report from the session's rows (`stream_report::load_report`)
   and posts it to `POST /api/desktop/stream-report` with the Bearer session.
5. 2xx: done. 401, 400, 413, 415, 429: dropped. 404 (an older videorc.com):
   dropped, and the sender stays quiet for the rest of the run. 408, 5xx or no
   answer: retried at 1, 2, 4… up to 30 minutes, 10 tries.

Peak and average follow the Stream Manager's history
(`stream-manager-stats.ts`, `viewersItem`): the largest combined count of
one saved sample and the rounded mean of the totals, so the email and the app
agree. The chart is at most 48 bars: one per sample, or the largest total in
each 48th of the stream, empty where nothing was measured.

Never sent: chat messages, viewer names, links, stream keys, the account's
address (the web uses the session's own).

## YouTube (D3)

YouTube's numbers are in the report like every other platform's (owner,
2026-11-14): concurrent viewers, chat counts, the subscriber change, and the
YouTube part of tips, supporters and community counts. There is no switch.

This changes what the v1 compliance reply told Google: it said session
statistics stay on the user's computer
(`docs/compliance/youtube-tos-report-v1-reply.md`). With the stream report
email they pass through videorc.com, which renders the email, sends it
through Resend and keeps none of the numbers. The privacy policy says so, and
**the next YouTube compliance report must tell Google** (plan 237, "YouTube
compliance").

## Switches

- **The account's choice** is on videorc.com: on by default (D2). Livestream →
  After the stream reads and writes it (`streamReport.email.get` / `.set`),
  and so does the email's one-click unsubscribe.
- **Send the last one** (`streamReport.email.sendLast`) sends the latest live
  session that has ended (a stream still running is skipped) now, with a fresh
  report id and no 5-minute floor: the way to see the email without streaming
  again. It asks the account's choice first, like an automatic report, so an
  "off" account sends no numbers.
- **Each of the three RPCs gives up after 8 s.** `.set` and `.sendLast` are
  mutations, and the backend restarts a mutation that runs past 10 s, even
  mid-stream, so a slow videorc.com must never hold one that long.
- **`VIDEORC_STREAM_REPORT_EMAIL=0`** turns it off for a run. Every smoke
  launcher (`scripts/lib/app-launcher.mjs`) and the live lab set it, so no
  test ever emails a real inbox. The launcher ignores a value left exported in
  the shell: only a run's own env can turn it on.
