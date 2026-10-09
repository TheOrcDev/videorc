# YouTube API Services ToS Violations Report V.1: reply notes

These are working notes for the reply to Google's report. Plan 165 holds the
detail.

- **Report:** "YouTube API Services ToS Violations Report V.1", dated
  2026-10-08.
- **Project number:** 244529927041.
- **API client name:** Uros Miric.
- **Fix:** plan 165 ([plans/165](../../plans/165-youtube-tos-report-official-icon.md)).

The report asked three things: confirm the project numbers (III.D.1c),
confirm how often API data is refreshed or deleted (III.E.4a-g), and fix the
YouTube icon (III.F.2a, the only violation).

## III.D.1c: project numbers

**Answer:** Videorc uses one Google Cloud project for the YouTube API
Services: **244529927041**. No other project number is used by this API
client.

What the code shows (desktop app, `crates/videorc-backend/src/oauth.rs`):

- The desktop app has one OAuth client per build. Its client ID and secret
  are injected at build time from GitHub secrets
  (`VIDEORC_BUNDLED_YOUTUBE_CLIENT_ID` / `_SECRET`) by the macOS, Windows and
  Linux release workflows.
- No client ID appears in the source at HEAD.
- Two older client IDs appear in git history. Both belong to project
  244529927041 (commits 847ff2b2 and e7576750, the latter removed in
  2e622b44).
- The only scope requested is `https://www.googleapis.com/auth/youtube.force-ssl`.

**Owner to confirm in Cloud Console before sending:**

- [ ] Every OAuth client and API key in 244529927041 belongs to Videorc.
- [ ] No other Cloud project holds YouTube Data API credentials for Videorc
      (dev or old projects).
- [ ] Which project the videorc.com "Sign in with Google" uses. It does not
      call the YouTube API, but say so if it is a different project.

## III.E.4: how often API data is refreshed, updated or deleted

All YouTube API calls go directly from the user's computer to Google. No
Videorc server proxies them.

**Refresh while the user is live:**

| Data                              | Refresh                                                                                                               | Code                                     |
| --------------------------------- | --------------------------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| Live chat (liveChatMessages.list) | At Google's `pollingIntervalMillis`, never faster, with a 5 s minimum (10 s when chat is quiet, up to 30 s on errors) | `youtube_chat.rs` (`next_poll_delay_ms`) |
| Concurrent viewers (videos.list)  | Every 120 s                                                                                                           | `viewer_stats.rs`                        |
| Subscriber count (channels.list)  | Every 300 s                                                                                                           | `audience.rs`                            |
| Broadcast / stream status         | Every 60 s                                                                                                            | `platform_stream_watch.rs`               |
| Channel identity (channels.list)  | At app start, when Settings opens, on connect and at Go Live                                                          | `studio-bootstrap.ts`, `use-studio.tsx`  |
| OAuth access token                | Refreshed before it expires                                                                                           | `main.rs`                                |

**Deletion:**

- **Disconnect** in Videorc revokes the token with Google
  (`https://oauth2.googleapis.com/revoke`). It then deletes the stored tokens,
  the connected channel record and its stream key from the user's computer.
- **Chat messages and session statistics** kept for the user's own session
  history stay on the user's computer. They are deleted when the user deletes
  that session in the Library.

**Owner to know before wording the reply.** The following is true today and
is not changed by plan 165 (the owner's scope call):

- If access is revoked from Google's security settings page, the app marks
  the account "Needs reconnect" but does not delete stored data.
- Local chat history, scheduled-broadcast records and the cached avatar
  images have no 30-day expiry.
- The videorc.com privacy policy says YouTube data "is not retained after you
  disconnect" and is deleted when access is revoked in Google's settings.
  That does not match the behaviour above.

## III.F.2a: YouTube icon (fixed)

Every place the desktop app showed YouTube now shows **YouTube's official
icon file**, unmodified, with the visible mark **at least 20 px tall**.

- **Source:** the full-colour icon from https://brand.youtube/youtube-icon,
  converted losslessly from the official `.ai` file. Hashes and the
  conversion command are in
  `apps/desktop/src/renderer/src/assets/brand/youtube/README.md`.
- **Never tinted:** the icon is drawn through an `<image>`, so app colours
  and hover states cannot recolour it. YouTube Red `#FF0033` and the white
  triangle are YouTube's own.
- **Never smaller than 20 px:** any smaller request is clamped up to 20 px.
  Where a surface has no room (small status chips), the app writes "YouTube"
  as text instead of showing a small icon.

| Surface Google flagged / same defect                      | Before                                     | After                                                        |
| --------------------------------------------------------- | ------------------------------------------ | ------------------------------------------------------------ |
| Livestream → Destinations: YouTube, YouTube Vertical rows | 9.6 px redrawn glyph on a red-tinted tile  | Official icon, 20 px, on the row surface                     |
| Stream Manager chat rows (the "red dot")                  | 9.6 px redrawn glyph, red tint             | Official icon, 20 px, on the far right of the row            |
| Stream Manager chat platform filter                       | 9.6 px redrawn glyph                       | Official icon, 20 px                                         |
| Stream Manager activity pane filter                       | 9.6 px redrawn glyph                       | Official icon, 20 px                                         |
| Stream Manager activity rows                              | 8.3 px glyph laid over the viewer's avatar | Official icon, 20 px, on the far right (not over the avatar) |
| Stream Manager status bar, chat chips                     | 9.6 px redrawn glyph                       | Official icon, 20 px                                         |
| Chat status badges                                        | 8.3 px glyph (badge forces 12 px)          | The word "YouTube" (no icon)                                 |
| Upcoming streams, schedule dialog, Golem tab, menus       | 9.6 px redrawn glyph                       | Official icon, 20 px                                         |
| Highlight card shown on the stream                        | Hand-drawn red circle with a play triangle | Official icon, 20 px or more in output pixels, on the right  |
| Phone remote (LAN) chat rows                              | Letter "Y" on a red tile                   | Official icon, 20 px, on the far right                       |

The owner holds the before and after screenshots (every flagged surface, in
dark and light) for the reply. They are not in the repo.

**Not covered here:** the videorc.com website icon (the report's third
screenshot) is a separate website fix.
