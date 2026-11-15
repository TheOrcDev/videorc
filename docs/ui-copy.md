# Writing Videorc's UI copy

How every word a streamer reads in Videorc is written: buttons, labels,
toasts, errors, menus, ⌘K, tooltips, the phone remote and the release notes
that quote them. The words themselves (one name per thing) are the glossary
in [`CONTEXT.md`](../CONTEXT.md). The look of the surfaces that carry copy
(toasts, alerts, empty states) is the design skill,
`.claude/skills/videorc-design/SKILL.md`.

Plan 174 S2.1 wrote these rules down; S2.2 to S2.5 apply them across the
app. Two checks hold them (see [Guards](#guards)).

## Voice

- Plain, short and specific. Say what happened, then what to do.
- Talk to the streamer ("you"). When Videorc acts, Videorc is the subject:
  "Videorc is reconnecting."
- Use contractions: can't, don't, isn't, you're, couldn't. Not "cannot" or
  "could not".
- American English: color, canceled, behavior, center, gray.
- No em dashes. Reword with a period, a comma or a colon. `pnpm lint` runs
  `scripts/check-em-dashes.mjs`, which fails on one in app copy.

## Casing

- Sentence case on every button, menu item, tab, title, label, toast and
  status word: "Save local recording", "Needs reconnect".
- Capitalize only names:
  - Videorc, Premium, Sidekick, Sidekick Live. Sidekick, with no article,
    means the helper only: Sidekick Live, reading chat, drafts, flags,
    removals, voice commands, reports, "Sidekick, …" (plan 239 D1);
  - the avatar, the character on the stream, is a lower-case common noun in
    a sentence ("your avatar", "My avatars", "New avatar…", "Use as my
    avatar"); "Avatar" capitalized names the page and the Stream Manager
    block. The character goes by its own name wherever one is at hand
    ("{name} on stream", "{name} talks", "Say something as {name}"). The
    test for a sentence: about the look, the bubble, reactions, motion, the
    picture, the library, creating one or being on the stream, it is the
    avatar; about reading chat, hearing, writing lines, flagging, removing,
    commands, reports or Premium, it is Sidekick. Sidekick writes, the
    avatar says;
  - Go Live, as the action's name ("Go Live", "Use for Go Live…"); the verb
    in a sentence is lowercase ("Go live", "when you go live");
  - pages, sidebar groups and windows: Studio, Sources, Scene, Assets,
    Captions, Avatar, Output, Destinations, Sidekick, Library, Settings,
    Health, Setup, Livestream (the group), Stream Manager, Preview, Notes,
    Captions reader;
  - Scenes, Studio's section that is the home of scenes ("Open Scenes",
    plan 231 D8); a scene in a sentence stays lowercase;
  - platforms and products: YouTube, Twitch, Kick, X, TikTok, Custom RTMP,
    OBS, macOS, Windows.
- A status is a word, never a raw value: "Reconnecting", not "closed" or
  "device-missing".

## Ellipsis

- One character, "…", never three dots ("...").
- On a command that opens a further step asking for a choice or input:
  "Import…", "Rename…", "Choose thumbnail…", "Edit…", "Go live…" (⌘K), "Pair a
  phone…", "Run setup again…", "What's new…", "Add scene…", "Change screen…",
  "Set key…", "Sign in…" and "Authorize X Live…" (both open an account flow in
  the browser).
- Not on a command that acts at once, or one that only opens a page, a
  section or a window: "Delete", "Duplicate", "Open Output", "Open Stream
  Manager", "Open Destinations", "Open Scenes". A dialog's own button acts, so
  Add scene…'s reads "Add scene" or "Add 3 scenes". "Set level for me"
  changes Gain at once, so it has no ellipsis either.
- On every pending label: "Saving…", "Importing…", "Exporting…",
  "Applying…", "Opening preview…".
- A pending label never replaces the name of what was clicked. A scene or
  layout being applied keeps its name with a spinner and "Applying…"
  (issue #1275); a switch still running after a moment adds one status line
  under the list naming what it waits for ("Side by side · Waiting for the
  camera's first frame…"), and a click that takes a switch over says so
  ("Replaces the switch to Screen + camera.").
- Search placeholders say what they search: "Search recordings…".

## Going live (D3)

One verb pair on every surface (plan 174 S2.2). The strings live in
`apps/desktop/src/renderer/src/lib/go-live-copy.ts`, and
`pnpm smoke:start-labels` pins them.

| Where                 | Copy                                                                            |
| --------------------- | ------------------------------------------------------------------------------- |
| Studio buttons        | "Record" (with ␣) and "Go Live": no "…", the owner's exception (plan 235 D2)    |
| Go Live dialog        | title "Go live"; primary "Go live" or "Go live on 3 destinations"               |
| Not public on YouTube | "Go live unlisted?" with "Go live unlisted" and "Change privacy" (or Private)   |
| Stopping while on air | "End livestream", with "Your recording stops too."                              |
| The state             | "On air"                                                                        |
| ⌘K                    | "Start recording", "Go live…"; while running "Stop recording", "End livestream" |
| Shortcut labels       | "Record / stop recording", "Go Live / end livestream"                           |
| An Upcoming event     | "Use for Go Live…"                                                              |

## Words to use

- One name per thing: the glossary in `CONTEXT.md`. Recording, not
  session; destination, not target or provider; Stream key, not Manual
  RTMP; X, not X / Twitter; Health and support bundle, not diagnostics.
- "Choose", not "Select", for picking something.
- Delete destroys, Remove takes out of a list or off stream, Discard drops
  unsaved changes, Clear empties a field, a filter or a view.
- Quote a control or a page exactly as it reads today, with "→" for a path:
  "Destinations → Setup", "Settings → Shortcuts". Never point at a page, a tab
  or a button that does not exist.
- Scenes (plans 210 and 231) read the same everywhere. The words are in the
  glossary (Scene, Layout, Default scene, Scene key, Add scene…, Change
  screen…); the strings:
  - Studio's Scenes section and the Scene page say "Each scene shows its own
    screen. ⌃⌥1 to ⌃⌥9 switch them from any app." (the platform's keys), or
    "A scene's key switches to it from any app." once the streamer changed
    them.
  - "Add scene…" makes scenes; its picker's button reads "Add scene" or "Add 3
    scenes", and "Choose at least one." with nothing chosen.
  - "Change screen…" changes what one scene shows: an app, "A specific
    window", a display, or "No screen". A scene for an app says "{App} ·
    front window" ("Front window" on its own card), and a scene whose layout
    draws no screen says "No screen".
  - The scene on stream's fields start "On stream: Figma"; Sources → Screen
    says whose screen it is: "Shown by “Figma”, the scene on stream. Each
    scene keeps its own screen.", or "“Camera only”, the scene on stream,
    shows no screen. Each scene keeps its own screen.", with "Open Scenes".
  - Settings → Shortcuts names a position by the scene in it: "Scene 1 ·
    Figma", and "Scene 9 · no scene" while it's empty. A key another app
    holds says "Another app uses ⌃⌥3". The key HUD's switch (plan 231 D20)
    reads "Show the scene's name when a key switches it".
  - The refusals, as warnings: "Keep at least one scene." (the last one),
    "Switch to another scene first." (deleting the scene on stream while
    recording or live), "No scene uses Side by side" (a remote's old layout
    request), "Figma isn't open", "“Figma” already shows this.", and "Update
    Videorc to change your scenes." (a library from a newer Videorc).
  - "Follow the app in front" is the switch, in Studio's Scenes section, and
    "Follows" a row's mark ("Stop following" and "Follow the app" in its ⋯
    menu).
  - Never "saved scene", "Unsaved scene", "New scene…", "Save scene…",
    "Change app…", or a layout as something to switch to.
- Hide screen (plan 210) reads the same everywhere: the control is "Hide
  screen" and then "Show screen", on the scene's Screen row in Studio's Scenes
  section, and the chip while it holds is "Screen hidden". Never "blur",
  "privacy mode" or "censor".
- Videorc Camera (plan 214) is the camera other apps see, one name
  everywhere: "Videorc Camera", never "virtual cam", "vcam" or "webcam".
  Its home is Output → Camera for other apps; ⌘K reads "Turn Videorc
  Camera on" and "Turn Videorc Camera off". The words live in
  `lib/virtual-camera-view.ts`, and its test pins every state's line.
  macOS asks for approval in a place that moved, so the line names the path
  for the Mac's version, quoted exactly as System Settings reads it, with
  one "Open System Settings" button:
  - macOS 13 and 14: "Allow Videorc Camera in System Settings → Privacy &
    Security."
  - macOS 15 and later: "Allow Videorc Camera in System Settings → General
    → Login Items & Extensions → Camera Extensions."
- Community (plan 225) reads the same everywhere. The tab is **Community**,
  in Sidekick after Chat. A viewer is a **person** with **accounts**; the
  chip on the first row of their stream is "Regular · 14", "Back · 3 wk"
  (weeks under 8, then "Back · 3 mo") or the milestone label ("10th
  stream", "5 in a row", "One year"); "First chat" stays as it was. Say
  "in a row", never "streak" (Twitch's word), and "regular", never "VIP" or
  "loyal". The card is "About {name}", with "Same person as…", "Not the
  same" ("Split off"), "Mark as bot" / "Not a bot", "Forget {name}…" and
  the note's line "Only you see this. Sidekick never changes it." Links the
  streamer settles are "Links that need you", with "Same person" and "Not
  the same"; a suggestion reads "Might be the same as {name} on
  {platform}"; a cancelled or hijacked word reads "A !link with {name} on
  {platform} needs you". The settings are "Remember my community",
  "Regular after", "Welcome regulars on stream", "Show milestone cards
  automatically", "Sidekick remembers" and "Community sync"; the data actions
  are "Export…", "Import…" and "Forget everyone…" (the confirm "Forget
  everyone?"). The YouTube line is exactly "YouTube viewers are remembered
  for 30 days after they chat (YouTube's rules)." The avatar's bubble lines
  for the viewers' commands are "Done, {name}. I've forgotten you.", "Welcome
  back to the list, {name}.", "Unlinked, {name}." and "Linked: {name} on
  {platform} and {name} on {platform}." (one name when both match); the
  wave says "Hey {name}!". Never promise chat: nothing in Community posts.
- Premium, always the same sentence and action: "{Feature} is part of
  Videorc Premium." with one "View Premium" button.
- Platform-true words come from the platform helpers, never a literal:
  `revealInFileManagerLabel()` ("Show in Finder" or "Show in folder"),
  `trashName()` (Trash or Recycle Bin) and `osSettingsName()` in
  `lib/platform.ts`, and the computer noun and default paths in
  `lib/platform-copy.ts` (plan 174 S1.4). Shortcut keys come from the
  shortcut helpers (S1.2), never a typed "⌘" or "Cmd+".

## No internals

Copy never names how Videorc is built. The copy guard fails on these words
in readable strings:

| Never                                       | Say instead                                                  |
| ------------------------------------------- | ------------------------------------------------------------ |
| backend, socket, WebSocket, RPC             | "Videorc": "Videorc is reconnecting. Try again in a moment." |
| OAuth, callback                             | "Sign in", "Connect", "Finish connecting {Platform}"         |
| provider                                    | the platform's name, or "destination"                        |
| revision, compositor                        | what the streamer sees: "the scene", "the preview"           |
| entitlement                                 | the Premium sentence                                         |
| `VIDEORC_*`, Electron                       | nothing: developer strings go to the console                 |
| diagnostics                                 | "Health", "support bundle"                                   |
| Manual RTMP                                 | "Stream key"                                                 |
| X / Twitter                                 | "X"                                                          |
| Streaming tab, Recording → Output           | "Destinations", "Output"                                     |
| Open Live, Open Recording, Customize        | the control's real label                                     |
| Command Palette                             | "Search" (⌘K)                                                |
| receive-only                                | "read-only"                                                  |
| "..."                                       | "…"                                                          |
| an icon's component name, like `DeleteIcon` | the word: "Trash"                                            |

Raw error text never reaches a toast or a line. Map it to copy
(`userErrorMessage`, plan 174 S2.4); the raw text goes to the console and
the support bundle.

## Toasts

A toast is for news the interface does not already show (the design
skill's "Toast discipline"). Never a success toast for a scene, layout or
source change: the stage is the confirmation. The one exception is the key
HUD (plan 231 D20), and it is not a toast: when a key, the Stream Deck or the
phone switches the scene while no Videorc window is in front, a chip off
stream shows the scene's name and key for a moment ("T3 Code ⌃⌥2"), or the
refusal ("Figma isn't open").

- Shape:
  - the title is the outcome, with no period: "MP4 ready", "Couldn't
    import the image";
  - the description is whole sentences, with periods;
  - at most one action, named by its verb: "Show in Finder", "Retry",
    "Open Destinations".
- Type by meaning; the type colors the icon only, never the toast:
  - error: it failed and needs you;
  - warning: it can't happen now, or it is degraded;
  - info: neutral news, or a step to take ("Approve the connection in your
    browser");
  - success: something finished out of view (a recording saved, an import
    done, an account connected).
- Duration:
  - about 4 s for a one-line toast;
  - 8 s or more with a description;
  - persistent with an action, or while it mirrors a state still true:
    "Streaming to {X} stopped" stays until "{X} is back" replaces it.
- One id per kind of toast, so a newer one replaces the older and the same
  news never stacks twice.
- Never a refusal as an error. "Renaming takeovers is locked while you're recording
  or live" is a warning.

## Errors

- Shape: "Couldn't {verb} {object}", then why when Videorc knows it, then
  one fix.
  - "Couldn't import the image" · "It isn't a PNG or a JPEG. Choose another
    image."
  - "Couldn't start recording" · "The microphone is in use by another app."
    · Retry
- Unknown cause: "Couldn't {verb} {object}." and "Try again. If it keeps
  happening, export a support bundle from Health."
- Videorc offline: "Videorc is reconnecting. Try again in a moment."
- A field's own error sits under the field (`FieldError`), in monochrome
  text with the error icon.

## Disabled and locked

- A disabled control always says why, in one of these:
  - a line under it (`SegmentedControl`'s `disabledReason`, PowerSlider);
  - the `DisabledReason` tooltip (plan 174 S1.1);
  - one Alert that leads the tab, when everything in it is locked.
- Locked while recording or live: "Locked while you're recording or live.
  Changes apply the next time you record or go live." (the lock Alert of
  plan 174 S1.5; "session" stays out of copy).
- Locked by the plan: the Premium sentence and "View Premium".

Takeover imports remain available while recording or live. Only rename,
reorder and delete use the session lock; explain that scope beside them.

## Numbers, time and missing values

- One spelling per fact, from the formatters (plan 174 S1.4): "1080p ·
  30 fps · 6 Mbps", "1920 × 1080", "2:05" and "1:02:05".
- Plurals are real words: "1 viewer", "12 viewers". Never "viewer(s)".
- A value Videorc can't read shows "–" with the reason on hover. Never an
  unmeasured zero.

## Guards

- `apps/desktop/src/renderer/src/renderer-copy-guards.test.ts` reads every
  JSX text and every string that reads as prose in the renderer (a toast, an
  error message, a label, a placeholder) and fails on:
  - an icon component's name (`DeleteIcon`), with no exceptions;
  - the words in [No internals](#no-internals) and "...", with no
    exceptions (plan 174 S2.5 brought the last offenders to zero, so there
    is no allowlist);
  - a Title Case command label: the text of a `Button`, a menu item, a tab
    or a dialog action may capitalize a word after its first only when it
    is a name from [Casing](#casing) (`CAPITALIZED_NAMES` in the test).
    "Import From OBS" fails; "Open Stream Manager" passes.
- `pnpm lint` runs `scripts/check-em-dashes.mjs` (no em dash in app copy).
- `renderer-buddy-name-guard.test.ts` keeps the companion's retired names
  out of copy (plans 170 and 171, and "Buddy" since plan 236). The Buddy
  check reads only what a person reads (JSX text and string literals): code
  names stay `buddy`. The backend's words have the same check,
  `the_backend_copy_says_sidekick_not_buddy` in `buddy_act.rs`.
