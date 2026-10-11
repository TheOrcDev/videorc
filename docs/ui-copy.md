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
  - Videorc, Premium, Buddy (or the name the streamer gave it), Buddy Live;
  - Go Live, as the action's name ("Go Live…", "Use for Go Live…"); the verb
    in a sentence is lowercase ("Go live", "when you go live");
  - pages and windows: Studio, Sources, Scene, Assets, Livestream, Captions,
    Output, Library, Settings, Health, Stream Manager, Preview, Notes,
    Captions reader;
  - platforms and products: YouTube, Twitch, Kick, X, TikTok, Custom RTMP,
    OBS, macOS, Windows.
- A status is a word, never a raw value: "Reconnecting", not "closed" or
  "device-missing".

## Ellipsis

- One character, "…", never three dots ("...").
- On a command that opens a further step asking for a choice or input:
  "Import…", "Rename…", "Choose thumbnail…", "Edit…", "Go Live…", "Pair a
  phone…", "Set up permissions…", "What's new…".
- Not on a command that acts at once, or one that only opens a page or a
  window: "Delete", "Open Output", "Open Stream Manager".
- On every pending label: "Saving…", "Importing…", "Exporting…",
  "Switching…", "Opening preview…".
- Search placeholders say what they search: "Search recordings…".

## Going live (D3)

One verb pair on every surface (plan 174 S2.2). The strings live in
`apps/desktop/src/renderer/src/lib/go-live-copy.ts`, and
`pnpm smoke:start-labels` pins them.

| Where                 | Copy                                                                            |
| --------------------- | ------------------------------------------------------------------------------- |
| Studio buttons        | "Record" (with ␣) and "Go Live…"                                                |
| Go Live dialog        | title "Go live"; primary "Go live" or "Go live on 3 destinations"               |
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
  "Livestream → Setup", "Settings → Shortcuts". Never point at a page, a tab
  or a button that does not exist.
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
| Streaming tab, Recording → Output           | "Livestream", "Output"                                       |
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
source change: the stage is the confirmation.

- Shape:
  - the title is the outcome, with no period: "MP4 ready", "Couldn't
    import the image";
  - the description is whole sentences, with periods;
  - at most one action, named by its verb: "Show in Finder", "Retry",
    "Open Livestream".
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
- Never a refusal as an error. "Takeovers are locked while you're recording
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
  - the words in [No internals](#no-internals) and "...", against a ratchet:
    `COPY_RULE_RATCHET` lists today's offenders as a count per file. Fixing
    one means lowering that file's count (the test says to what); a count
    may never rise, and a file not listed may have none.
- `pnpm lint` runs `scripts/check-em-dashes.mjs` (no em dash in app copy).
- `renderer-buddy-name-guard.test.ts` keeps "Orcle" and "Golem" out of
  copy.
