# Plan 230: The Stream Manager Screen key

## Status

- **Status**: BUILT 2026-11-12, one desktop PR. The owner tried the first
  version on stream screens the same day and asked for this redesign
  (see Owner answers).
- **Priority**: P1 (owner request, 2026-11-12).
- **Effort**: S to M. One remote intent, one main-process move, one Stream
  Deck action. No capture, preview or encoder change.
- **Risk**: LOW. The key only moves a window; it never changes what the
  capture includes.

## The owner's ask (2026-11-12)

> "My streaming setup is 3 screens: macBook main screen, Dell U2723QE that
> is being presented, and a Dell U2311H in portrait orientation […] that I
> use to monitor the chat. […] I spend a lot of time on-stream swapping
> windows to put the chat on the U2723QE (for the audience to see the chat
> and interact) or on the U2311H so I can keep an eye on the chat while
> presenting something else. I'd like to setup the stream deck to do this
> with one key, that toggles the chat between those two screens."

> "Call those Presenting and Monitor screens."

## What a streamer gets

1. In the key's settings, the streamer picks a **Presenting screen** (the
   one viewers see) and a **Monitor screen** (where they read chat).
2. A press moves the Stream Manager to the other screen. The key's title
   says where it is: **Present** or **Monitor**.
3. Each screen keeps its own place: the window comes back to the frame it
   had last time on that screen, so the streamer places it once on each.
4. If Hide from stream is on while the window sits on the Presenting
   screen, the title reads **Hidden**: viewers see nothing.

## Owner answers (2026-11-12)

The first version also flipped Hide from stream, and with one screen it
only flipped that switch. A side chat raised that "Chat on stream" already
exists (plan 215 G: a burned-in box with the last 5 messages). The owner
went back to first principles:

- **Q1, the box is not the window.** "I switch the chat between monitor to
  keep a passive eye on it and presenting to address comments of the
  audience, so I need to see them and highlight them." The key moves the
  Stream Manager; the box stays a separate feature.
- **Q3–Q4, Hide from stream is orthogonal.** "If it's turned on, a streamer
  can accidentally forget […] and it won't be visible. I think Hide from
  stream should be decoupled from that, it's orthogonal to screen
  switching." The key only moves the window. No one-screen mode. Videorc
  still owns the move (A over a Hammerspoon or AppleScript recipe): no
  setup, no Accessibility permission, Windows too, and a key that shows
  where the window is.
- **Q5, the name.** "'Stream Manager Screen' is more explicit." Not
  "toggle": with one screen, a toggle reads as show and hide.
- **Q6–Q7, what the key shows.** One speech-bubble image for both states;
  the title shows the state (Present, Monitor, Hidden).
- **Q8, from anywhere else.** First answer: the Presenting screen. "This
  might be opinionated, let's make this easy to change." After trying it,
  the owner changed it: "when it's closed or away, pressing the key should
  put it on the Monitor screen first." It is one named value
  (`SCREEN_FROM_ELSEWHERE`) and a product decision in the PR.
- **Q10, the other titles.** Closed or minimized reads **Closed**, another
  screen reads **Away**. **Hidden** keeps its one meaning (on the
  Presenting screen with Hide from stream on), so one title never leads to
  two different presses.

- **Q11–Q12, a covered window.** "If the stream manager is not on the
  foreground (eg: another window covers it) […] the only way to get back
  to the chat was to flash it to the audience." Electron cannot tell that a
  window is covered, so the key does not guess: a **hold** (half a second)
  brings the Stream Manager to the front where it is, with the focus. "If
  it's already focused, can we hide it with long press? (close the
  window)": yes, a hold while it has the focus closes it. A Stream Deck
  press never takes the focus, so `isFocused` is exact. A tap now acts on
  release.
- **Q13, focus on the Presenting screen.** "When it lands on the Presenting
  screen it should become focused too […] I press the stream deck key to
  bring chat to the audience: it should capture focus then." A tap to the
  Presenting screen takes the focus; a tap to the Monitor screen leaves it.
  One named value (`FOCUS_ON_ARRIVAL`), the owner's call.
- **Q14, the focus comes back.** With Q13, a tap back to the Monitor screen
  left the focus on the Stream Manager, so slide keys went to the chat. The
  owner took A: a tap to the Monitor screen while the Stream Manager has
  the focus hands it to the app the streamer used last before Videorc. The
  front-app monitor of plan 210 keeps that app up to date from every
  activation, so it is never stale (a click in Chrome since) and also
  works after a hold gave the Stream Manager the focus. On macOS the native
  addon activates it by pid and bundle id (`activate_app`): never
  `open -b`, which sends a reopen event (a new Finder or browser window,
  maybe on stream) and launches an app that quit. On Windows `blur()`
  hands the focus to the window behind. Nothing on Linux.

## Decisions

- **D1. The key only moves the window.** It never sets Hide from stream,
  and it is not the Chat on stream box.
- **D2. Each press goes to the other screen.** From the Presenting screen
  to the Monitor screen, and back.
- **D3. From anywhere else, the Monitor screen.** Closed, minimized or on
  a third screen. Viewers never see the window appear by surprise. One
  named value, the owner's call (Q8).
- **D4. One frame per screen.** `comments-window.json` keeps
  `screenFrames: { [displayId]: frame }`. A screen without one gets the
  current size, fitted and centred in its work area. A window already on
  the target screen stays where it is, and a closed window opens straight
  on its screen. A tap takes the focus on the Presenting screen only (Q13),
  and the tap back gives it to the presented app again (Q14).
- **D5. What the remotes learn.** `remote.describe` gains `screens`
  (`{id, name}`, the monitor's name as the OS shows it, "DELL U2723QE",
  never a serial number; twins get their size, then a number).
  `remote.state` gains `streamManager` (`{screenId, visible,
hiddenFromStream}`). A paired phone sees the same: monitor names are no
  more private than the scene names it sees already.
- **D6. Screens by display id.** If either screen is gone (unplugged) the
  key refuses and asks the streamer to pick the screens again; it never
  guesses. Until both screens are picked, connected and different, the key
  reads **Pick screens**. A move that does not land on its screen is
  refused too ("The Stream Manager didn't move. Try again."). A frame the
  OS chose after a monitor change is never saved; saves resume once the
  streamer or the key places the window (a move or resize by hand is told
  apart by Electron's `will-move`/`will-resize`, which `setBounds` and the
  OS's own moves never fire).
- **D7. Tap and hold.** A tap (released within 500 ms) moves the window. A
  hold brings it to the front where it is, with the focus, or closes it
  when it already has the focus. The plugin times the press; main decides
  front or close.

## Wire

`streamManagerScreenSwap` with `presentingScreen` and `monitorScreen`
(display ids as strings, both required, different, at most 32 bytes). Its
own debounce bucket, `stream-manager-screen`.

`streamManagerFrontOrClose`, no fields: the hold. Same bucket, since a tap
and a hold are one key.

## Gates

- `cargo test -p videorc-backend remote_control`, clippy debug and release.
- Desktop unit tests for the move rules, the frame fit, the screen names,
  the executor, the IPC schema and the surface values.
- Stream Deck plugin tests for the key's title, state and intent.
- `pnpm smoke:remote-control`, with a step for this key: refusals, and a
  real move between two screens when the host has them.
- `pnpm smoke:remote-lan` (the phone sees the new fields).
- Owed: a move on Windows, where `setBounds` across screens with different
  scaling can size the window wrong; and a hold with another app in front,
  on macOS and Windows, which may refuse to give a background app the
  focus (the window then comes up without it); the same for a tap to the
  Presenting screen, and the focus coming back on the tap to the Monitor
  screen (on Windows also with Keep on top on, where `blur()` can pick
  another always-on-top window such as Notes).
