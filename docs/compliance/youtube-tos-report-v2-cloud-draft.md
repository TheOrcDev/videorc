# YouTube API Services: Videorc Cloud update (DRAFT for the owner)

**Status: DRAFT, not sent.** The owner reviews, edits and sends it. Plan 222
Y1 asked for it; plan 184 D13 and D15 hold the rules behind it. This file is
in the public repo, so it holds no secrets.

- **Follows:** "YouTube API Services ToS Violations Report V.1" (2026-10-08)
  and our reply notes in
  [`youtube-tos-report-v1-reply.md`](youtube-tos-report-v1-reply.md).
- **Project number:** 244529927041 (unchanged).
- **Send before:** anyone but the owner goes live through Videorc Cloud with
  YouTube as a destination (plan 184 D15). Plan 221's answer: send it once
  the port passes plan 222 A1, so the beta cohort does not wait on it.
- **When sent:** record the date in plan 185 Progress (plan 222 Y1, "Done
  when").

## What changes, in one paragraph

Videorc is adding an optional relay for paying users, Videorc Cloud. With it
on, the user's computer sends one copy of the live video to a Videorc media
server, and that server sends it on to the platforms the user picked,
YouTube among them. This changes one thing for YouTube API data, and only for
users who use Videorc Cloud: the YouTube stream key travels to our server
for the length of the show. Every YouTube API call still goes from the
user's computer, and no Videorc server calls the YouTube API.

## The promise we made, and the sentence that replaces it

Our reply to report V.1 says, under III.E.4
([`youtube-tos-report-v1-reply.md:44-45`](youtube-tos-report-v1-reply.md)):

> All YouTube API calls go directly from the user's computer to Google. No
> Videorc server proxies them.

That stays true. What it does not cover is that the stream key, which the
user's computer reads from the API, can now leave the computer. Proposed
replacement:

> All YouTube API calls go directly from the user's computer to Google. No
> Videorc server calls the YouTube API or proxies those calls. When a user
> streams through Videorc Cloud, the YouTube stream key that their computer
> read from the API (`liveStreams` ingestion info) is sent over an encrypted
> connection to the Videorc media server that carries that one show. The
> server holds it in memory only, uses it only to send that show's video to
> YouTube's ingest, never writes it to disk or to a log, and drops it when
> the show ends. Users who do not use Videorc Cloud are unchanged: their
> stream key never leaves their computer.

## The facts behind it

Each line is what the code does today (desktop branch
`plan-184-videorc-cloud`, runner repo `videorc-cloud` `phase-1-runner`).
The owner can quote any of them.

**What passes through our servers, for a Videorc Cloud show only**

| Data | From → to | Kept |
| --- | --- | --- |
| The live video and sound | The user's computer → the media server (RTMPS, TLS) → YouTube's ingest | Not stored. Passes through memory while live. |
| The YouTube stream key (the ingest URL with its key) | The user's computer → the media server, over the show's control socket (WSS, TLS) | Memory only, for that show. Dropped at show end. |
| A show record: start, end, which server, why it ended, minutes live and on hold | Our web service (videorc.com) | Kept, to meter cloud hours. Holds no video, sound, chat or keys. |

- **The key never reaches videorc.com.** The desktop asks videorc.com to
  create a show and gets back the media server's address; the stream key
  then goes straight from the desktop's backend to that media server, never
  through the web service and never through the app's own UI process (plan
  184 C3 and D15; `cloud_show.rs`, the `destinations.set` hand-over).
- **Memory only on the media server.** The process that pushes the video
  holds the key in memory. The node's agent also keeps the last destination
  list in memory, so a crashed relay process can be given it back without
  the user (runner `docs/wire-notes.md`, "Signals and crashes"). Neither
  writes it to disk: the relay's crash-recovery state file holds no
  destinations, and a restarted relay waits to be handed them again.
- **Never in a log or a process list.** The relay passes keys to its video
  process through a local proxy, never on its command line (runner
  `502d37b`), and an ended show leaves no key behind on the node (runner
  `333ca0f`). The desktop's own logs mask the URL (`HandoverDestination`'s
  debug form prints `••••`), and `smoke:cloud-solo` scans the app's logs
  and events for a marked key on every run.
- **Dropped at the end.** When the show ends, the relay process exits and
  the agent forgets the show's destinations. A show lasts at most 12 hours,
  and a show whose computer is gone ends after its hold limit (30 minutes by
  default, 60 at most), so no key outlives its show by more than that.
- **Where:** the media servers are in the EU (Hetzner; the first node is
  planned for Germany, plan 222 D8). A server outside the EU would need this
  answer and the privacy page updated first.

**What does not change**

- **Every YouTube API call is made from the user's computer**, as listed in
  the V.1 reply's table: broadcast creation and transitions, live chat,
  viewer and subscriber counts, stream status, channel identity, token
  refresh. The media server only pushes video to YouTube's RTMP(S) ingest,
  the same thing any encoder does.
- **No Videorc server calls the YouTube API.** The relay has no YouTube
  OAuth token and no API key; it is never handed one.
- **Chat is not relayed.** YouTube chat is read and sent from the user's
  computer only. Nothing about chat passes through Videorc Cloud (plan 184
  D17; forwarding chat waits for a separate update to this answer).
- **The broadcast ends the same way.** Broadcasts are created with
  `enableAutoStop: true`. When the user stops, the computer moves the
  broadcast to `complete` with the API, as today. If the computer is gone,
  the relay stops sending video at the hold limit and YouTube ends the
  broadcast by itself about a minute later; no server calls the API to do
  it.
- **Disconnect** in Videorc still revokes the token with Google and deletes
  the stored tokens and stream key from the user's computer. Nothing about
  YouTube is stored on our servers to delete.

## For context: relays on YouTube

Restream, StreamYard and other cloud relays are on YouTube's list of
verified encoders ([help](https://support.google.com/youtube/answer/2907883)),
so pushing a user's own stream to YouTube's ingest from a server is an
ordinary shape. Videorc Cloud does the same for the user's own stream, with
the user's own key.

## The privacy policy sentence that goes with it

The videorc.com privacy page gains a Videorc Cloud section when the cloud is
public (plan 222 Y2, web `lib/legal/cloud-copy.ts`, behind
`VIDEORC_CLOUD_PUBLIC`). Its two sentences about keys and YouTube, which this
answer must match:

> Your stream keys go from your computer to that server over an encrypted
> connection when the show starts. The server holds them in memory for that
> show only and drops them when it ends. We never store your stream keys or
> write them to a log.

> Every call to YouTube's API still comes from your computer, as without the
> cloud. No Videorc server calls the YouTube API, and your chat doesn't pass
> through Videorc Cloud.

## Owner checklist before sending

- [ ] The proposed replacement sentence reads right to you, and nothing in
      the facts above is wrong for the build you will ship.
- [ ] The V.1 reply's open item still stands and is separate: if access is
      revoked from Google's security page the app marks the account "Needs
      reconnect" but keeps local data (V.1 reply, "Owner to know").
- [ ] Videorc Cloud is still dormant for everyone but you (the cohort,
      `VIDEORC_CLOUD_USERS`, is empty) until this is sent.
- [ ] After sending: the date goes into plan 185 Progress, and plan 222 O2
      step 3 (the cohort) may start.
