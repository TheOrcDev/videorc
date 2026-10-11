# Bundled Buddy pet packs

Read-only pet packs shipped with the app (plan 168 D3): each `<name>/` folder
here is the pack `bundled:<name>` (`manifest.json`, its sheets, `buddy.json`),
packaged as `buddy-assets/bundled` and passed to the backend as the second
`VIDEORC_MANAGED_BUDDY_ROOTS` entry. Only our own art goes here, never a
third-party pack.

## `buddy/`: Buddy the Golem, alive (plan 172)

The pack `bundled:buddy`: page-pet manifest v1, 40 frames of 640 px (25 gaze
cells, 12 reactions, `talk-a`, `talk-b`, `wave`) in one 3200 × 5120
`mascot.webp`, plus `buddy.json`, `build-report.json` and `provenance.json`.
It was made on 2026-10-09 by `pnpm buddy:alive --slug golem`
(`scripts/buddy-alive-generate.mjs`), which runs the in-app creator's
pipeline headless: identity notes from `assets/brand/buddy/golem-master.png`
(trimmed onto a transparent 1024 px canvas, the reference of every call), a
pilot, then eight sheets as image edits of that reference with the creator's
prompts (`openai/gpt-image-2.5-sunburst` through the Vercel AI Gateway),
cut, registered and packed by the app's own builder
(`cargo run -p videorc-backend --features buddy-pack-example --example buddy_pack`), which also loads the
result with the app's pack loader. `assets/brand/buddy/README.md` has the
whole recipe.

- **Sources** (the reference, every pilot and sheet version) live outside the
  repo in `~/videorc-assets/buddy-alive/golem/sources/` and are never
  committed; `provenance.json` records the SHA-256 of the reference and of
  each sheet the pack was built from.
- **Size** (plan 172 D3): the builder's lossless atlas was 7.12 MB, over the
  6 MB line, so this copy re-encodes `mascot.webp` with lossy colour at
  quality 92 and lossless alpha
  (`cwebp -q 92 -m 6 -alpha_q 100 -alpha_filter best`): 1.62 MB, the same
  manifest and cells. Side by side at
  on-stream size (the character about 240 px tall) and at twice that on the
  face, it looks the same as the lossless atlas; 512 px cells were not
  needed. The other files are the builder's bytes.
- **Byte-exact**: the official catalog pins every file's size and SHA-256, so
  `.prettierignore` skips these folders. Rebuild, never hand-edit.
- **Review**: plan 172 D6 needs the owner's approval of every gaze row and
  reaction sheet before this ships.
