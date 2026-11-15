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
The action that starts a livestream. The Studio button reads "Go Live"
(and its Retro LCD key), with no "…" although it opens a dialog: the owner's
exception (plan 235 D2). The dialog's title and its primary button read
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
The broadcast itself; as a noun it is lowercase. "Stream" is its short form in
running text ("Your stream stopped"). Capitalized, it names the sidebar group
that holds Destinations and Sidekick (plan 235 D6), and the Studio's Session row
("Livestream · 4 destinations").
_Avoid_: broadcast (except a platform's own object, like an X broadcast), live session

**Stream report**:
The email Videorc sends after a live stream (plan 237): watching at the
peak and on average, and how many people chatted, platform by platform.
Sidekick's in-app summary stays the "Sidekick report" (Sidekick → Reports).
_Avoid_: viewers reached, unique viewers, audience size, recap email

**Watching**:
A platform's count of people watching at the same moment.
_Avoid_: viewers (for that count), subscribers, reach

**Recording**:
What Videorc writes to a file, and each item in Library.
_Avoid_: session (in copy), take, capture

**Program**:
What goes out: every layer at least one running output carries, and while
nothing runs, every layer with a switch on. The Preview shows the program;
Clips keeps what a recording would (each item's Show in recording).

**Clips**:
The Output section and its one switch, "Keep the last seconds" (plan 181,
the owner's redesign): whenever Videorc is open it keeps the last minute
ready (plan 199), using each item's Show in recording switch and writing
nothing permanent. The status bar shows nothing for it (the "Clip · 1:00"
chip was removed 2026-11-13); the ring is never "Recording" or "On air".
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
Shown in what viewers see: a chat message, a takeover, your avatar. The actions
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

**Scene for an app**:
A saved scene New scene… makes from an app you show (plan 210): it shows the
app's front window, whichever window that is, and keeps working after the app
quits and comes back. Its row reads "Figma · front window".
_Avoid_: app scene (in copy), window scene, app capture

**Follow the app in front**:
When the streamer brings an app to the front, the stream switches to that
app's scene. Each scene for an app follows; its ⋯ menu's "Stop following"
turns that off, and its row says "Follows" while it does. macOS only.
_Avoid_: auto-switch, smart switching

**Swap in place**:
How a scene switch changes the screen or window on stream (plan 210 D5): the
one running capture changes its target instead of stopping and starting, and
the program keeps the outgoing picture (the **held frame**) until the new
window's first frame, then cuts. No black frame, no frame of the new window
under the old scene's layout. Budget: 150 ms p95 from the click.
_Avoid_: crossfade (there is none), warm capture, restart

**Hide screen**:
Covers the screen on every output (the recording, every stream, Clips and the
Screen file) with a frosted still of it, while the camera and microphone stay
on; "Show screen" brings it back. While it holds, the Studio and the Stream
Manager say "Screen hidden". Its key is Control-Option-H (Ctrl+Alt+H on
Windows and Linux) until changed in Settings → Shortcuts, and on macOS a
password manager in front hides the screen too. Plan 210.
_Avoid_: blur (it isn't live), privacy mode, BRB (that's a takeover), censor

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
stays over a takeover and under captions, the avatar and the highlight card.
_Avoid_: overlay (in copy), image source, sticker, sponsor (as the feature's
name)

**HTML banner**:
A banner whose picture is a web page with a transparent background, so it
can move: an animated badge, a ticker, a lower third (plan 232). Assets →
Banners → "Import HTML…" takes an `.html` file or a folder with
`index.html`. It is a banner in every other way. Code and wire names say
`html overlay`; copy never does.
_Avoid_: HTML overlay (in copy), browser source, web source, widget

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
Not the avatar's look (its pictures, Still or Alive, on Avatar → Profile).
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

**Videorc Camera**:
The camera other apps see: Videorc's program, as the Preview shows it, offered
as a camera that Meet, Zoom, Teams, Discord or FaceTime can choose. No sound.
Output → Camera for other apps is its one home (a switch, off by default);
⌘K and agents mirror it, and Health removes it on macOS. Windows adds
" Windows Virtual Camera" to the name on its own. Plan 214.
_Avoid_: virtual cam, vcam, webcam, virtual camera (in copy)

### Destinations and accounts

**Destinations** (the page):
Where destinations and stream details are set up, in the sidebar's Livestream
group: Setup, Upcoming and Guests. It was the Livestream page until plan 235
(2026-11-14); its id is still `live`, and ⌘K still finds it by "livestream" and
"stream key". Quote its tabs as "Destinations → Setup".
_Avoid_: Livestream (for the page), Connections, Channels, Streaming tab

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
they go live, through the webhooks they pasted in Destinations → Setup → Discord
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
The welcome steps shown once on a fresh install: Permissions ("Welcome to
Videorc"), What are you making?, Your look, Sound check, and Where you
stream. Where you stream shows only for Livestreams or Both; Recordings
has four steps. Liquid Chrome fills the main window behind one card; Your
look's scene picture plays the chosen live background inside it. Settings
→ General → Setup and ⌘K offer "Run setup again…"; replaying returns to the
page it opened from and preserves the first-run record. Existing installs
skip setup on update.
_Avoid_: onboarding (in copy), Setup alone (also a sidebar group and a
Destinations tab)

**Stream Manager**:
The live dashboard window: chat, activity, the Sidekick pane (with your
avatar's block at its foot) and the stats bar.
_Avoid_: Chat window, Comments window, comments (for chat)

**Chat**:
The viewers' messages, in Stream Manager and, while on air with Chat in
Studio on, in the Studio's Chat section (plan 204).
_Avoid_: comments

**Presenting screen**, **Monitor screen**:
The two screens of the Stream Deck's Stream Manager Screen key (plan 230).
The Presenting screen is the one viewers see; the Monitor screen is where
the streamer reads chat. A tap moves the Stream Manager from one to the
other; from anywhere else it goes to the Monitor screen. On the key:
Present and Monitor.
_Avoid_: main screen, second screen, shared screen, chat screen

**Chat command**:
A `!name` a viewer types as the first word in chat (`!go`). Videorc answers
as you with the reply you saved, starting with `@their name`, only in the
chat they asked in; `!commands` lists them (plan 226). Edited in
Destinations → Setup → Chat commands. Not the composer's `/` commands (`/marker`,
`/clip`), which never reach chat.
_Avoid_: bot command, slash command (for these), auto reply

**Captions reader**:
The window that shows live captions as text for the streamer.
_Avoid_: Captions window, caption viewer

**Preview**, **Notes**:
The two other windows, by these names.
_Avoid_: Teleprompter, Preview window (as a title)

**Chrome ground**:
The still of Liquid Chrome that plan 208 put under every Videorc window. The
owner removed it on 2026-10-29: windows are now the plain solid (chrome
black in dark, porcelain in light), and only the phone remote still shows
the still.
_Avoid_: wallpaper, background (a scene has one), live background (it never
moves), glass

**Chrome controls**:
The polished controls you touch: the chrome primary button (Go Live,
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

### Agents

**Agents**:
AI apps on this computer (Claude, Cursor, Codex, VS Code and others) that
run Videorc through Videorc MCP: Settings → Remote → Agents, "Let AI agents
control Videorc". Each connected app is "an agent" with the name the
streamer gave it ("Claude Desktop"); Stop disconnects every agent. Plan 209.
_Avoid_: bots, AI assistants, integrations, MCP clients (in copy)

**Videorc MCP**:
What docs and the website call the way agents connect. In agent apps the
server is named `videorc`.
_Avoid_: Videorc API, MCP server (in the app's own copy)

### Avatar, Sidekick and Premium

Two products since plan 239, joined by one rule: Sidekick writes, the avatar
says.

**Avatar**:
The character on the stream: the name, personality and look the streamer
gave it, its comic bubble, reactions and greeting lines. Viewers see it. In
a sentence it is a lower-case common noun ("your avatar", "My avatars",
"New avatar…", "Create your avatar"); capitalized, "Avatar" names the page
(Setup, ⌘6) and the Stream Manager block. Where its own name is at hand the
character goes by it ("Flint on stream", "Say something as Flint"). The
default avatar is Flint the Golem, the official stone character (plan 239
D2; it was named Sidekick until then); "Golem" names only that creature
(kind "Golem", slug `golem`), never a product. Free, except a look made
with AI and creating an Alive avatar. Names a program reads keep `buddy`
and `cohost` (`overlayLayout.buddy`, `cohost.buddy*`, `buddy_say`,
`videorc://buddy`, saved values).
_Avoid_: Sidekick (for the character), the Sidekick, mascot, pet (an Alive
avatar's pack is a "pet pack" in docs and code; copy says "moves"), Avatars
(capitalized mid-sentence), Buddy

**Sidekick**:
The helper only the streamer sees, with no article ("Sidekick reads
chat"): it reads chat, hears the streamer, catches questions, drafts
replies, flags spam, removes comments when asked, takes voice commands and
writes the stream's report. Premium with Cloud AI. It was the name of both
the helper and the character until plan 239, which gave the character its
own word, the avatar. "Sidekick" is the word that wakes it ("Sidekick, clip
that"); speech to text also writes "side kick" or "side-kick", and all
three wake it. The avatar's own name still wakes it too, but copy teaches
"Sidekick" alone. It was called Buddy until plan 236, because speech to
text heard "Buddy" as "body". The hidden "buddy" and "bodhi" wake aliases
expired after 0.26.1; a deliberately chosen avatar name "Buddy" still works. Names a program reads keep `buddy` (`/api/buddy/*`,
`cohost.buddy*`, `set_buddy`, the page id `ai`, saved values).
_Avoid_: Buddy, buddy, co-host (in copy), the Sidekick, Orcle, Sidekick for
the character on stream, "your Sidekick", "Sidekicks"

**Sidekick Live**:
The switch that lets Sidekick join a livestream.
_Avoid_: Buddy Live, Joins my streams, chat mode (for the on switch)

**{name} talks**:
How the avatar talks on its own, named after it ("Flint talks"): Off,
Bubble (in its bubble on stream, never in chat) or Suggest (a card; one
click posts it to chat as you). It is the avatar talking: its greeting lines
and the lines Sidekick writes for it (Answers, Banter, greetings written
with AI). It lives in the Stream Manager's Avatar block. Nothing is ever
posted in chat on its own. It never turns Sidekick on or off; Sidekick Live
does. Plans 211 and 239.
_Avoid_: Chat posting, chat mode, auto chat, Auto (gone since plan 211),
Sidekick talks

**`/sidekick`**:
The Stream Manager composer's command that asks Sidekick to do something
("/sidekick switch to BRB"). `/buddy` still works, unlisted, for two
releases.
_Avoid_: /buddy (in copy)

**Profile**:
The Avatar page's first tab: where the avatar shows, My avatars, Name and
personality with About you, the look (Still or Alive), Reactions and Motion.
Its second tab is Greetings. The page is Avatar; its tabs are Profile and
Greetings.
_Avoid_: the Avatar tab (for the first tab)

**Overview**:
The Sidekick page's first tab (id `live`; it was Profile until plan 239):
Sidekick Live and its status, listening, What Sidekick does and Cloud AI.
The page is Sidekick; its tabs are Overview, Chat, Community, Voice,
Reports and Clean cut.
_Avoid_: Profile, the Sidekick tab (for the first tab)

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
