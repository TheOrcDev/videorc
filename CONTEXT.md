# Videorc language

The words Videorc uses, in the app and when we talk about it. The recording
timeline terms come first; the UI glossary after them is the canonical
vocabulary for copy (plan 174, D3 and D4). How to write with these words is
in [`docs/ui-copy.md`](docs/ui-copy.md).

## Language

These terms distinguish points on a recording or livestream timeline from
moments proposed for clipping.

**Marker**:
A point on a recording or livestream timeline, with an optional title, that
its owner wants to find again. It identifies where that subject starts.
_Avoid_: Chapter, clip, chat message

**Clip mark**:
A hint from the owner that the moment leading up to a point in a recording is worth clipping. A Clip press while recording keeps one beside the saved clip.
_Avoid_: Marker, exported clip

**Moment**:
A suggested time range worth reviewing, drawn from clip marks or activity during a stream.
_Avoid_: Marker, finished clip

## UI glossary

One word per thing on every surface: buttons, toasts, ⌘K, menus, the phone
remote and the docs. Code names may differ (`session`, `cohost`, `target`);
copy never shows them. Capitalized terms are names and keep their capitals
mid-sentence; everything else is sentence case.

### Going live and recording

**Go Live**:
The action that starts a livestream. The Studio button reads "Go Live…"
because it opens a dialog; the dialog's title and its primary button read
"Go live"; ⌘K reads "Go live…".
_Avoid_: Stream (as a button), Start streaming, Confirm Go Live

**End livestream**:
Stopping a livestream. The recording of that session stops too, and the
confirmation says so: "Your recording stops too."
_Avoid_: Stop all, End stream, Stop streaming

**On air**:
The state while a livestream runs, and only then.
_Avoid_: Live (for a recording, a source or any running session), Streaming (as a state)

**Livestream**:
The page where destinations and stream details are set up. As a noun it is
lowercase: the broadcast itself. "Stream" is its short form in running text
("Your stream stopped").
_Avoid_: broadcast (except a platform's own object, like an X broadcast), live session

**Recording**:
What Videorc writes to a file, and each item in Library.
_Avoid_: session (in copy), take, capture

**Clips**:
The Output section and its one switch, "Keep the last seconds" (plan 181,
the owner's redesign): whenever Videorc is open it keeps the last minute of
the program ready (plan 199), writing nothing permanent. The status bar
reads "Clip · 1:00"; the ring is never "Recording" or "On air".
_Avoid_: Replay buffer, instant replay, replay cache, buffer (alone)

**Clip** (the action):
The one action that saves the last seconds as a clip, at one of two lengths
(plan 199): the last 30 seconds (the Stream Manager's "Clip 30 s", the Save
a 30-second clip key, ⌘K "Save a 30-second clip", a deck key, `/clip`, the
spoken "clip that") or the last minute ("1 min", the Save a 1-minute clip
key, ⌘K "Save a 1-minute clip", `/clip 60`, the spoken "clip the last
minute" or "long clip"). While a recording runs the moment is also kept as a
mark in the recording and its report, spanning the length asked for.
_Avoid_: Mark clip, Save replay, Capture replay

**Clip** (the file):
The saved video ("Clip 2026-10-12 18-30-05.mp4" in the Clips folder, a row
in Library titled Clip).
_Avoid_: replay, highlight (for the file)

**On stream**:
Shown in what viewers see: a chat message, a takeover, Buddy. The actions
are "Show on stream" and "Take off stream".
_Avoid_: On air (for an item), live (for an item)

**Receiving**:
A source that is producing frames.
_Avoid_: Live, Active, On air

**Vertical stream**:
The 9:16 twin of a livestream that goes out beside the horizontal one.
_Avoid_: vertical leg, simulcast leg

### Scenes and sources

**Scene**:
Anything the streamer switches to on stream, built in or saved.
_Avoid_: layout (for the thing you switch to), preset, view

**Layout**:
The arrangement inside a scene: where the screen and the camera sit.
_Avoid_: scene (for the arrangement), composition

**Preset**:
A quality preset only: resolution, frame rate and bitrate together.
_Avoid_: preset for a scene or a layout ("Layout preset")

**Source**:
A capture input: a screen or window, a camera, a microphone, system audio.
_Avoid_: input, feed

**Takeover**:
A full-frame image the streamer puts on stream over everything else.
Assets → Takeovers manages them; Studio's Takeover section puts one on
stream.
_Avoid_: screen, takeover screen

**Banner**:
An image the streamer places anywhere on the picture: a sponsor, their
socials, a logo, a frame. Assets → Banners imports and manages them; the
Scene page places them and shows or hides them ("Show", "Hide"). A banner
stays over a takeover and under captions, Buddy and the highlight card.
_Avoid_: overlay (in copy), image source, sticker, sponsor (as the feature's
name)

**Live background**:
An animated background behind the screen and camera: Silk, Side Rays, Plasma
Wave, Liquid Chrome or Line Waves, from React Bits (plan 190). Assets →
Backgrounds → Live puts one on the scene, and a click on its tile takes it
off. A scene has one background, live or an image. Where it can't move, it
shows a still frame of its look, and its Adjust style says why.
_Avoid_: animated background, shader, video background, motion background

**Look**:
One of a live background's three curated color sets ("Silk · Satin"), chosen
in its Adjust style. Each live background remembers its own look, Motion
(Calm or Normal), Visibility and Dim.
_Avoid_: preset (a preset is quality only), theme, variant, style

**Sound**:
A short audio file (up to 30 seconds) the streamer plays into the recording
and every stream from the Soundboard: an airhorn, applause, a laugh.
Assets → Sounds imports and manages them; Sources → Sounds sets their level
and whether the streamer hears them.
_Avoid_: clip (a clip is a stretch of a recording), sample, SFX, sound effect
(as the feature's name), jingle

**Soundboard**:
Studio's grid of pads, one per sound, under Scenes. A click or the sound's
key (1–9) plays it; the Stream Manager, `/sound`, ⌘K, the Stream Deck and
the phone play the same sounds.
_Avoid_: sound pad (in copy; it is the component's name), sampler

**Off**:
A source or a feature the streamer turned off ("Camera: Off"). When there
is nothing to pick, say so: "No camera found"; while looking, "Finding
devices…".
_Avoid_: None, Disabled (for something turned off)

**Gain**:
The fader that raises or lowers a source's volume, in dB.
_Avoid_: Level (for the fader), volume (for a source)

**Level**:
How loud a source is right now, on its meter.
_Avoid_: Gain (for the meter), Monitoring

**Microphone**:
The microphone, spelled out.
_Avoid_: mic

**Camera**:
The camera, spelled out.
_Avoid_: cam, webcam

### Destinations and accounts

**Destination**:
Where a livestream goes: a YouTube channel, a Twitch account, a Custom RTMP
server.
_Avoid_: target, provider, output, platform (for the destination itself)

**Account**:
The platform sign-in behind a destination. A destination connects with
"Sign in" or with a "Stream key".
_Avoid_: OAuth, auth mode, credentials

**Channel**:
The platform's own channel a destination streams to.
_Avoid_: target

**Stream key**:
The secret a platform gives for RTMP.
_Avoid_: Manual RTMP, RTMP credentials

**X**:
The platform.
_Avoid_: X / Twitter, Twitter

**Custom RTMP**:
A destination that is any RTMP server.
_Avoid_: Manual RTMP, Custom (alone)

**Stream details**:
A livestream's title, description, privacy and category.
_Avoid_: Broadcast info, metadata, Metadata draft

**Read-only**:
A chat Videorc can read but not post to.
_Avoid_: receive-only

**Reconnect**:
What a destination or a chat needs after its connection dropped, and the
action that fixes it ("Twitch: reconnect to send").
_Avoid_: re-auth, re-authorize

**Discord announcement**:
The one message Videorc posts to each of the streamer's Discord channels when
they go live, through the webhooks they pasted in Livestream → Setup → Discord
(one per server). It links each live destination and becomes "Was live" at
the stop (plan 187).
_Avoid_: notification, alert, ping (a ping is only the @here or @everyone it
carries)

**Webhook**:
The Discord URL that lets Videorc post to one channel. It is a secret:
Videorc shows only its last four characters.
_Avoid_: hook, integration, bot

### Windows and pages

**First-run setup**:
The welcome steps shown once on a fresh install, starting with permissions.
Liquid Chrome fills the main window behind one card titled "Welcome to
Videorc". Settings → General → Setup and ⌘K offer "Run setup again…";
replaying returns to the page it opened from and preserves the first-run
record. Existing installs skip setup on update.
_Avoid_: onboarding (in copy), Setup alone (also a sidebar group and a
Livestream tab)

**Stream Manager**:
The live dashboard window: chat, activity, Buddy and the stats bar.
_Avoid_: Chat window, Comments window, comments (for chat)

**Chat**:
The viewers' messages, in Stream Manager and, while on air with Chat in
Studio on, in the Studio's Chat section (plan 204).
_Avoid_: comments

**Captions reader**:
The window that shows live captions as text for the streamer.
_Avoid_: Captions window, caption viewer

**Preview**, **Notes**:
The two other windows, by these names.
_Avoid_: Teleprompter, Preview window (as a title)

**Chrome ground**:
The still of Liquid Chrome under every Videorc window (plan 208): black
metal with soft silver streaks in dark, and the same turned around,
porcelain with graphite streaks, in light. It never moves, and the desktop
never shows through it. The Preview has none, because it frames video.
_Avoid_: wallpaper, background (a scene has one), live background (it never
moves), glass

**Chrome controls**:
The polished controls you touch: the chrome primary button (Go Live…,
Continue, Save), the beads on switches and sliders, the plate on what is
selected, and the red Record LED that lights while a recording or
livestream runs. Panels, menus, dialogs and text stay flat.
_Avoid_: metallic, shiny, glass buttons

**Keep on top**:
The pin that keeps a window over other apps, the same name in every window.
_Avoid_: Pin, Always on top, Float

**Health**:
The page with Videorc's verdicts, warnings and the support bundle.
_Avoid_: diagnostics, Diagnostics tab

**Support bundle**:
The redacted file a streamer exports from Health to send to support.
_Avoid_: diagnostics, logs (as the thing to send)

**Import…**:
Bringing a local file into Videorc: an image, a recording, an OBS setup.
_Avoid_: Upload (for a local file), Add file

### Buddy and Premium

**Buddy**:
Videorc's AI companion on stream, with no article ("Buddy reads chat"), or the name
the streamer gave it when the character speaks or acts ("Grum: 5 people
asking…"). "Buddies" for more than one. "Golem" names only the stone golem
creature, never the feature.
_Avoid_: the Buddy, co-host, Orcle, pet, sidekick

**Buddy Live**:
The switch that lets Buddy join a livestream.
_Avoid_: Joins my streams, chat mode (for the on switch)

**Chat posting**:
What Buddy may post to your chats as you: Off, Suggest or Auto. It never
turns Buddy on or off; Buddy Live does.
_Avoid_: chat mode, auto chat

**Profile**:
The Buddy page's first tab: Buddy Live and its status, My Buddies, the look,
the personality and Cloud AI. The page is Buddy; its tabs are Profile, Chat,
Voice, Reports and Clean cut.
_Avoid_: the Buddy tab (for the first tab)

**Premium**:
The paid plan. A locked feature says "{Feature} is part of Videorc Premium."
with one "View Premium" action.
_Avoid_: Premium required, Upgrade to unlock, Pro, entitlement

### Taking things away

**Delete**:
Destroy something the streamer made: a recording, a scene, a marker. A
recording goes to the Trash (the Recycle Bin on Windows), and the copy names
the bin.
_Avoid_: Remove (for a destroy)

**Remove**:
Take something out of a list or off the stream without destroying it: a
destination, a source, a chat message, a background.
_Avoid_: Delete (when nothing is destroyed)

**Discard**:
Throw away unsaved changes.
_Avoid_: Revert, Cancel changes

**Clear**:
Empty a field, a filter or a view.
_Avoid_: Reset (unless it restores a default), Delete
