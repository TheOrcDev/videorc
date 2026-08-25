# The Videorc icon set

How icons are named, how many the app may ship, and what has to happen before
the set can be swapped for a licensed one.

## Where icons live

Every renderer module imports from `apps/desktop/src/renderer/src/components/icons.tsx`.
Nothing imports an icon package directly — `no-restricted-imports` makes that
an ESLint error outside the registry itself.

The registry names icons by **meaning**, not by shape: call sites ask for
`SourcesIcon`, `AlertIcon`, `RecordIcon`. Two consequences:

- Swapping icon sets is a change to one file. Every slot is annotated
  `AppIcon`, and `AppIcon` is declared structurally in that file rather than
  re-exported from the icon package, so the compiler checks a replacement set
  really does accept the app's prop surface.
- The set is countable and reviewable. Before the registry the app had grown
  to **100 distinct icon imports across 52 files**, including three warning
  variants, two pins, two locks and two spinners — nobody could have answered
  "which icons does Videorc use?" without a grep.

Today: **90 semantic slots over 85 glyphs**. Five slots share a glyph
(`StudioIcon`/`CameraIcon`, `SourcesIcon`/`DisplayIcon`, `AssetsIcon`/`ImageIcon`,
`OutputIcon`/`RecordIcon`, `PublishIcon`/`SparkleIcon`) — those are exactly the
places the audit below expects to diverge.

### Adding an icon

Check whether a slot already means what you need and reuse it. Add a slot only
for a genuinely new meaning, and never add a second variant of an existing one
— that is how the set reached 100.

## Licence: the 100-icon ceiling

Nucleo's licence permits open-source use with two conditions
(nucleoapp.com/license, read 2026-08-25):

> "If you're using the Nucleo icons in templates, themes, plugins, or open
> source projects, you can use a maximum of 100 Nucleo icons and you should
> include the copyright notice."

and

> "You can't sublicense, resell, share, or redistribute the icons or modified
> versions."

Two things follow, and **both need an owner decision before any Nucleo icon
lands**:

1. **Count.** 100 is the hard ceiling. `pnpm icons:build` refuses to build a
   larger export rather than leaving the count to whoever last added a glyph.
   At 85 glyphs the app has ~15 of headroom; the audit's divergences would
   spend about 4 of it.

2. **Where the SVGs may live.** Videorc's repository is public and AGPL, which
   grants everyone downstream the right to redistribute and modify everything
   in it. That collides with "can't share or redistribute the icons". The
   open-source clause plainly contemplates _using_ the icons in a project like
   this one; whether committing the SVG sources to a public repo counts as
   redistribution is the open question. Two workable answers:

   - **In-repo** — commit the export under `vendor/icons/` with the copyright
     notice. Simplest; take this route only if the owner is satisfied the
     licence allows it.
   - **Out-of-repo** — keep `vendor/icons/` untracked (or in a private
     package) and commit only the generated components, or keep the generated
     module out of the public repo too and let community builds fall back to
     the current set. `scripts/build-icons.mjs` reads its source folder from
     `--source`, so nothing else in the tree cares which choice is made.

   Neither the app nor the build depends on the answer, so the code below is
   ready either way.

## Build pipeline

```bash
pnpm icons:build                      # vendor/icons/*.svg -> icons.generated.tsx
pnpm icons:build --source path/to/export --out path/to/module.tsx
```

Export one SVG per icon, named after the component (`alert-circle.svg` →
`AlertCircle`), **one stroke weight for the whole set**. The build:

- requires a `viewBox` and strips fixed `width`/`height`, so one export serves
  both the 16px inline and 24px nav sizes;
- rewrites hard-coded `fill`/`stroke` to `currentColor` (preserving structural
  `fill="none"`), so icons tint with their text as the design language
  requires;
- strips ids, classes, titles and vendor metadata — ids collide the moment two
  icons are inlined on one page;
- **fails** if an export still carries colours in a `style` attribute, rather
  than shipping an icon that ignores the theme;
- refuses to exceed the licence ceiling.

It has no dependencies: this repo is public, and refreshing a licensed icon set
should not put an SVG toolchain in everyone's install.

### The `weight` prop

~113 call sites pass `weight="fill" | "duotone" | "bold"`, inherited from the
current set. Generated components accept `weight` and ignore it, so a
single-weight export does not require editing every call site. Two things
follow for the export:

- Icons that today render **filled** (`weight="fill"`, the active-nav and
  status treatment) will read lighter as outlines. Export a **solid variant**
  for the slots listed as filled in the audit, or accept the flattening
  deliberately.
- Once a set is in place, the dead prop should be removed in a follow-up sweep
  — a codemod, not hand edits.

## Semantic audit

The registry preserved today's glyph for every slot: the migration was
deliberately behaviour-free. These are the slots where the inherited glyph is
**wrong or weak**, to settle before or during the export.

| Slot                                         | Glyph today               | Verdict                                                                                                                                                                                        |
| -------------------------------------------- | ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SourcesIcon`                                | Monitor                   | **Change.** The Sources page owns screen, window, camera _and_ microphone; a monitor names one of four. Prefer a plug/input or layered-devices glyph.                                          |
| `OutputIcon`                                 | Record (dot)              | **Change.** The Output page configures destinations and encoding; the record dot is the Record _action_ and must not be diluted. Prefer export/arrow-out or sliders. Splits from `RecordIcon`. |
| `PublishIcon`                                | Sparkle                   | **Change.** "AI sparkle" says nothing about publishing. Prefer send/share/rocket, and keep sparkle for explicitly-AI actions. Splits from `SparkleIcon`.                                       |
| `SourcesIcon`/`DisplayIcon`                  | Monitor (shared)          | **Split** once Sources gets its own glyph; `DisplayIcon` keeps the monitor.                                                                                                                    |
| `AssetsIcon`/`ImageIcon`                     | ImageSquare (shared)      | **Consider splitting.** Assets is a library of media, not one image — a stack/collection glyph would separate them.                                                                            |
| `StudioIcon`/`CameraIcon`                    | VideoCamera (shared)      | **Keep shared** unless the export offers a distinct "studio/stage" glyph worth the extra count.                                                                                                |
| `ClapperboardIcon` vs `LibraryIcon`          | FilmSlate / FilmReel      | **Review together.** Two film metaphors for "recordings" and "library"; one may be redundant.                                                                                                  |
| `SaveIcon`                                   | FloppyDisk                | **Owner call.** Dated metaphor, universally understood. Keep unless the export has a better save affordance.                                                                                   |
| `AlertIcon` vs `WarningIcon`                 | WarningCircle / Warning   | **Keep both, enforce the split**: triangle warns, circle alerts. This pairing already absorbed three previous variants.                                                                        |
| `HealthIcon` / `HeartbeatIcon` / `GaugeIcon` | Pulse / Heartbeat / Gauge | **Review.** Three vitals metaphors across Health and streaming; probably two are enough.                                                                                                       |

Everything not listed keeps its meaning as-is; the export just needs a
like-for-like glyph.

### Export shopping list

The 90 slots are the authoritative list — read them straight out of
`components/icons.tsx`, where each is grouped and documented. Export one SVG
per slot name in kebab-case (`sources-icon.svg` → `SourcesIcon`), plus solid
variants for the filled slots noted above.

Three slots are **not** part of any icon-set migration: `TwitchIcon`,
`XPlatformIcon` and `YoutubeIcon` are third-party brand marks with their own
trademark rules, and the design language keeps app/source marks as the only
full-colour icons on screen.
