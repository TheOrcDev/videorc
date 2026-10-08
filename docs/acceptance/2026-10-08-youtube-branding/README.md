# YouTube icon: before and after (plan 165)

These screenshots go with the reply to Google's "YouTube API Services ToS
Violations Report V.1" (2026-10-08, project 244529927041, policy III.F.2a).

- `before/` is `origin/main` at `3fcc17e4`.
- `after/` is the plan 165 branch.

Every surface is captured in dark and light themes.

| File                                    | Surface                                                                                                |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `01-livestream-destinations-*`          | Livestream → Setup: the Destinations list with the **YouTube** and **YouTube Vertical** rows (flagged) |
| `01b-livestream-destinations-closeup-*` | The same list, cropped                                                                                 |
| `02-livestream-upcoming-*`              | Livestream → Upcoming: the YouTube section                                                             |
| `05-stream-manager-1280x820-*`          | Stream Manager: chat filter, chat rows, activity filter and rows, status bar (all flagged)             |
| `05-stream-manager-420x760-*`           | Stream Manager at a narrow width                                                                       |
| `06-stream-highlight-card-*`            | The highlight card burned into the stream, at its real output size (720p, 1080p, 1080x1920)            |
| `07-phone-remote-chat-*`                | The phone remote's chat rows (LAN page, real stylesheet, mobile width, 2x)                             |

**After the fix:**

- Every YouTube mark is YouTube's official full-colour icon file
  (`apps/desktop/src/renderer/src/assets/brand/youtube/`), unmodified.
- The visible mark is at least 20 px tall and never tinted.
- No YouTube mark sits on top of a photo or avatar.
- In the Stream Manager, every chat and activity row ends with its platform
  mark on the far right.
- Avatars and the other platforms' icons were enlarged to match, so the rows
  stay balanced.

## How the shots were taken

The app ran in dev from each tree with an isolated profile and sample chat
from YouTube, Twitch, Kick and X (`liveChat.start` fakes with activity
events).

- **Main window:** captured over CDP.
- **Stream Manager:** captured with `comments-window-capture-page`.
- **Highlight cards:** rendered by the app's own card painter
  (`renderCommentHighlightCards`).
- **Window colours:** Display P3. YouTube Red `#FF0033` reads as about
  `#EA333E` in these PNGs. The card PNGs are sRGB.
