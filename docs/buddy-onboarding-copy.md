# Avatar onboarding and library copy (plan 170 D14, plan 239)

The one source for every string in the avatar onboarding and library, on
videorc.com (`lib/buddy-onboarding-copy.ts`) and in the app
(`apps/desktop/src/renderer/src/lib/buddy-onboarding-copy.ts`). Both copy
modules use these strings word for word, and a test on each side pins the
four step titles. Change a string here first, then in both modules.

Since plan 239 the character on the stream is the **avatar** (a lower-case
common noun in a sentence) and **Sidekick** is the helper that reads chat.
The file names keep `buddy` (plan 236 D1).

`{name}`, `{remaining}`, `{limit}` and `{count}` are filled in at runtime.
The official characters' names, taglines and personalities live in
`protocol-fixtures/buddy-official-catalog.json`.

## Step titles (pinned by tests)

1. Meet your avatar
2. Describe it
3. Give it a personality
4. Create your avatar

Progress label: `Step {n} of 4`. Buttons: `Back`, `Next`, `Skip for now`
(step 3 only, when Name is filled).

## Step 1: Meet your avatar

- Lead: "Create your own Golem, Orc, Goblin, Pirate, Robot, or anything you
  can describe, and put it in your live stream."
- Demo heading: "How it looks on stream"
- Demo bubbles, in order (follower named Mira, viewer named coders_x):
  1. "Welcome to the horde, Mira!" (talk pose)
  2. "We go live every Tuesday at 8, coders_x." (talk pose)
  3. "Ha! Good one." (laugh pose)
     Between bubbles the idle pose; a "New follower: Mira" chip appears just
     before bubble 1. With reduced motion, one still frame showing bubble 1.
- "What it does" heading, then five lines:
  - "Greets followers, subs and raids by name"
  - "With Sidekick, answers viewers' questions from what you tell it"
  - "Talks in a comic speech bubble, no voice needed"
  - "Shows on your stream, in your recordings, or both"
  - "Comes alive with Make it Alive"
- Gallery heading: "Start from one of ours"
- Gallery note: "Free for everyone."
- Card action: "Use this one"
- Primary action: "Create my own"
- Premium note under it: "Creating your own is part of Videorc Premium."

## Step 2: Describe it

- Field label: "What does it look like?"
- Placeholder: "A grumpy stone golem with a mossy back and a lantern"
- Example chips: "A tiny dragon in a hoodie", "A knight made of pizza",
  "A wise old owl with glasses"
- Picture label: "Add a picture for inspiration (optional)"
- Picture help: "A pet, a logo, a sketch or a selfie. It becomes a new
  character drawn in the Videorc style. The picture is used once and not
  kept."
- Picture actions: "Choose a picture", "Remove"
- Picture errors: "Use a PNG, JPEG or WebP picture." / "That picture could
  not be read. Try another one."
- Next disabled hint: "Describe it or add a picture to continue."
- Limit counter: `{count}/600`

## Step 3: Give it a personality

- Name label: "Name"; placeholder "Flint"; help "1 to 24 characters."
- Personality label: "Personality"; placeholder "Grumpy but kind. Calls
  viewers pebbles."; chips "Cheerful and loud", "Dry and sarcastic",
  "Calm and wise"; counter `{count}/1200`
- About you label: "About you (optional)"; placeholder "I stream indie
  games on Tuesdays and Fridays at 8 pm. My shop is at example.com/shop.";
  help "Sidekick answers viewers' questions from this."; counter
  `{count}/4000`

## Step 4: Create your avatar

- Summary rows: "Look", "Name", "Personality", "About you"; an empty optional
  row reads "Not set".
- Allowance: "Uses 4 of your {remaining} images left today."
- Primary: "Create my avatar"
- Working: "Drawing the pictures. This takes one to three minutes."
- Pose labels: "Idle", "Talk", "Laugh", "Think"
- Done: "Saved to your library."
- Actions: "Use as my avatar", "Redo" (talk, laugh and think only), web only
  "Open in Videorc" and "Download Videorc"
- App only, a secondary action after "Use as my avatar": "Make it Alive" (it
  uses the avatar, then opens the Alive creator with it; plan 172 D12)
- A pose that failed: "This pose did not come out. Redo it."

Gates and errors (step 4 and the library):

- Signed out (web): "Sign in to create an avatar." Action "Sign in"
- Free account: "Creating your own avatar is part of Videorc Premium."
  Actions "View Premium" and "Start from one of ours"
- Allowance used up: "You've used today's images. You get more tomorrow."
- Library full: "Your library is full ({limit} avatars). Delete one to make
  room."
- Failed: "Couldn't draw the pictures. Nothing was used from your allowance.
  Try again."
- App, Cloud AI off: "Allow cloud AI to create an avatar." Action "Allow cloud
  AI" (the app's existing consent label)

## Library

- Section title: "My avatars"
- Groups: "Official", "Made by you"
- Active badge: "Active"
- Actions: "Use", "Rename", "Edit personality", "Delete", "Make it Alive",
  "New avatar…" (it opens the onboarding)
- Empty "Made by you": "Avatars you create show up here, on videorc.com and in
  the app."
- Rename and Edit personality dialogs: action "Save"
- A library change that failed without a message from the server: "Something
  went wrong. Try again."
- Delete confirm: title "Delete {name}?"; body "Its pictures are removed
  from your Videorc account."; actions "Delete" and "Cancel"
- Signed out (app): "Sign in to see the avatars you made on videorc.com."
- Chosen elsewhere (app, when sync will not overwrite an avatar made only on
  this computer): "{name} was picked on videorc.com." Action "Use"
- First-launch invitation (app, default avatar untouched): "Make this avatar
  your own, or pick another." Action "Start"

Alive avatars (app, plan 172 D10, D12):

- A card whose avatar moves shows the tag "Alive": every official avatar with
  a pack (it ships with the app or downloads the first time it is used),
  and yours that have one. Yours without one keep "Make it Alive".
- An avatar made only on this computer (signed in): "{name} is only on this
  computer." Action "Save to my library"
- While a pack or an avatar is on its way: "Downloading {name}'s moves.",
  "Saving {name}'s moves to your library.", "Saving {name} to your library."
