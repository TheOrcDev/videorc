---
name: videorc-design
description: Videorc's UI design language — a Raycast-style dark glass command-palette aesthetic, built exclusively from shadcn/ui components. Use whenever building, styling, reviewing, or planning ANY Videorc UI (new components, screens, dialogs, lists, toolbars), when the user mentions "our design", "the design skill", "Raycast style", or asks how something should look.
---

# Videorc Design Language

The single source of truth for how Videorc looks and feels. Every UI task follows this skill. The reference is the Videorc logo: a glossy BLACK-GLASS orb with chrome/silver detail and one LED-red accent — expressed as a Raycast-style command surface: floating translucent black-glass panels, crisp chrome typography, muted gray metadata, hairline structure, vivid rounded-square icons, and keyboard-first affordances. Light mode is the porcelain-white twin of the same structure.

**Status: shipped.** The renderer was migrated to this language 2026-06-24 (17 slices) and retuned to the black-glass palette 2026-07-02 (`styles.css` is the implementation of the token table below; main-side data-URL windows mirror it via `src/main/window-palette.ts`). Do not restyle screens ad hoc — fix tokens, not components.

## Hard rules

1. **shadcn/ui only.** Every interface element is a shadcn/ui component (or a composition of them), installed and customized per the `shadcn` skill (`.agents/skills/shadcn/`, with reference docs in `~/.claude/skills/shadcn/`). No other component libraries, no hand-rolled widgets when a shadcn primitive exists. Tailwind utilities + shadcn CSS variables carry the theming.
2. **Dark glass first, light glass supported.** Dark is the default and the reference expression of this language. Light mode STAYS as a first-class twin: identical structure, patterns, spacing, and rules, with the light token column below — never a separately-designed theme. Both themes remain reachable via the existing theme toggle.
3. **Keyboard-first.** Every primary action has a visible shortcut, rendered as key chips (see Patterns). Footers advertise the current context's actions.
4. **Color is information.** The chrome is monochrome (blacks, grays, white). Saturated color appears ONLY in app/source icons and small status accents (e.g. live/connected green, destructive red). Never tint panels, rows, or text decoratively.

## Tokens

Implemented as shadcn CSS variables in `apps/desktop/src/renderer/src/styles.css` (oklch; that file is the live source of truth). Main-process data-URL windows (Notes/Comments/Preview — dark-always, they frame video) mirror the solid values in `src/main/window-palette.ts`; change them together.

Surfaces (dark = black glass · light = porcelain)
- Window/panel base, translucent over the wallpaper frost: dark `oklch(0.13 0.003 286 / 68%)` (solid `#0D0D0F`) · light `oklch(0.985 0.001 286 / 62%)` (solid `#FAFAFB`). Never pure #000 — it kills the glass depth. Card/popover float at 92%: dark `oklch(0.16)` (`#141417`) · light `#FFFFFF`.
- Electron implementation note (bisected with scripts/ui-glass-bisect-probe.mjs): real backdrop blur is unreachable — NSVisualEffectView materials paint fully opaque through Electron on current macOS, and CSS `backdrop-filter` cannot see behind the window (putting it on the root also kills alpha pass-through). The frost is therefore the `GlassWallpaperUnderlay`: main fetches the actual wallpaper (System Events), the renderer draws it blurred (70px, saturate 1.4) as the app's bottom layer, geometry-tracked to the window, under the theme's translucent `--background` coat. The window stays `transparent: true` + `backgroundColor: '#00000000'` so the underlay's absence (Automation denied) degrades to plain translucent glass. Exactly ONE element paints `--background` (the body) plus the underlay's tint layer — never add further coats.
- Panels float: rounded corners `16–20px` (panel), layered shadow (`0 16px 70px rgba(0,0,0,0.55)` dark · `rgba(0,0,0,0.25)` light) + a tight `0 0 0 1px` hairline ring.
- Hairlines and borders: dark white-10% (`rgba(255,255,255,0.10)`) — the polished edge of the black glass · light black-8% (`rgba(0,0,0,0.08)`); never solid gray borders.

Text (three tiers, nothing else; dark · light)
- Primary (chrome · ink): `#F4F4F5` · `#1C1C1E`, weight 500 for titles/labels.
- Secondary: `#A1A1AA` · `#6E6E73`, weight 400 — inline context after a title, right-aligned metadata, placeholders.
- Tertiary: `#71717A` · `#98989D` — section headers, footer hints, disabled.

Selection & interaction (dark · light)
- Selected/hovered row: white-8% · black-6% overlay, radius `8–10px`, full-row block; no outlines, no color fills.
- Pressed: white-12% · black-10%. Focus-visible: 2px ring (dark white-28% · light black-25%, keyboard only).

Brand red (the logo's LED-glow eyes)
- ONE saturated accent, semantic only — record, LIVE, destructive: dark `oklch(0.60-0.62 0.23-0.24 27)` · light `oklch(0.55 0.24 27)` (`--destructive`/`--live`). Never chrome, never decorative: the logo has two red eyes, not a red face.

Geometry & rhythm
- Radii: panel 16–20, rows/cards 8–10, key chips & small controls 6.
- Row height: 44–48px; list rows are single-line.
- Horizontal padding: 16–20px panel gutter; 12px between icon and title; 8px between title and inline context.
- Section headers get 16px top spacing, 8px bottom.

Type
- System font stack (SF Pro on macOS). Sizes: search/title input 18–20, row title 14–15, metadata/section headers 12–13, key chips 11–12.

Icons
- App/source icons: 24px rounded-square (radius ~6), vivid, full-color — they are the only large color on screen.
- Inline/status icons: 16px, Phosphor (already in the app), tinted secondary gray unless conveying status.

Motion
- Fast and subtle: 100–150ms ease-out. Panels fade+scale from 0.98; rows highlight instantly (no transition on selection). Nothing bounces.

## Toast discipline

Toasts are for NEWS the interface does not already show — never for
confirming a routine interaction the user just watched succeed.

- **Never toast success for scene/layout/source changes.** The stage/preview
  IS the confirmation (owner call, 2026-07-16 — "no green popups on every
  small thing"). This includes live layout applies, preset clicks, and
  source device switches.
- Success toasts are reserved for: async work finishing out of view
  (recording saved, import complete, publish pack generated), destructive
  confirmations (deleted), and account-level side effects (connected,
  authorized).
- Warnings/errors always surface — silence is only for the expected outcome.
- When in doubt, don't toast. A user mid-flow reads every popup as an
  interruption.

## Core patterns

**Glass panel** — the universal container (windows, dialogs, palettes): translucent blurred black glass, hairline ring, big radius, floating shadow. Content sits directly on it; no nested cards-on-cards.

**Search header** — borderless input on the panel itself: leading 24px icon, large placeholder in secondary gray, trailing hint (tertiary text + key chip). No input box outline; the panel IS the input surface. Use shadcn `Command` (cmdk) — this pattern is its native shape.

**Sectioned list** — tertiary-gray section label ("Development", "Suggestions"), then rows. Row anatomy, left to right:
1. 24px rounded-square icon
2. Primary title
3. Inline context in secondary gray on the same line (e.g. the owning app/platform)
4. Optional alias key chip (e.g. `st`)
5. Spring space
6. Right-aligned: optional small status icons, then the kind/metadata label in secondary gray ("Command", "Quicklink")

**Key chips (kbd)** — small rounded rect (radius 6), white 10% background, hairline border, secondary-gray glyph (`⌘`, `K`, `↵`, aliases). Build once as a `Kbd` composition of shadcn `Badge`/styled span and reuse everywhere.

**Footer action bar** — hairline-separated strip at panel bottom: leading app glyph button (ghost), trailing primary action label + its key chip, hairline vertical divider, secondary action ("Actions ⌘K"). All shadcn `Button variant="ghost"` + Kbd chips + `Separator`.

**Empty/hint states** — tertiary gray, centered, short; no illustrations.

## shadcn component mapping

| Need | Use |
|---|---|
| Palette / searchable list | `Command` (+ `CommandDialog`) |
| Modals & confirmations | `Dialog` themed as glass panel |
| Lists / destination rows | `Command` rows or composed row primitive (one shared component) |
| Buttons | `Button` ghost/outline; primary actions stay text+kbd, not big filled CTAs |
| Shortcut hints | `Kbd` composition (Badge-based), shared |
| Section/row dividers | `Separator` at white 8% |
| Badges/status | `Badge` with monochrome variants; color only for live/error |
| Scroll regions | `ScrollArea` |
| Menus/popovers | `DropdownMenu`/`Popover` on the solid-fallback surface |
| Toasts | sonner styled to the same glass tokens |

Missing a primitive? Install it via the shadcn CLI (see the shadcn skill) — do not hand-roll.

## Do / Don't

- DO keep chrome monochrome; let source icons and preview content provide the color.
- DO show shortcuts next to actions; the UI should read like a command surface.
- DO use one shared row component for every icon+title+meta list (destinations, sources, devices, recordings).
- DON'T use solid opaque cards, colored section backgrounds, or borders heavier than 1px white/8%.
- DON'T mix radii arbitrarily — panel/row/chip tiers only.
- DON'T introduce new fonts, icon sets, or component libraries.
- DON'T restyle existing screens outside the migration plan.
