# Videorc Changelog — source of truth

One file per release. This directory is the **single source** for the public
changelog: it compiles to `changelog.json` (via `pnpm changelog:build`), which
is uploaded to R2 next to the update feed and consumed by videorc-web
(`/changelog`, `/releases/<version>`), the newsletter render, and the desktop
"What's new" panel.

Everything here is **public by design**. Never include commit hashes, internal
gate/script names, acceptance checklists, or anything else that can't be on the
website — that material belongs in `docs/releases/<version>.md`, the internal
engineering record.

## File format

Filename is the full releaseId: `0.9.2-beta.1.md` (matches the R2 release path
and the update feed — never the bare `0.9.2`).

```markdown
---
version: 0.9.2-beta.1
date: 2026-07-01
channel: beta
platforms:
  - macos
title: Camera and microphone fixed in the installed app
summary: One sentence used by the changelog index, newsletter subject, and in-app banner.
highlights:
  - 2-5 short user-facing bullets.
  - This is the cut shown in-app and in the newsletter.
---

User-facing markdown body. Plain product voice — what changed and why you
care. Screenshots via public URLs only.
```

`channel` is one of `alpha`, `beta`, or `stable` and must match the releaseId:
`0.10.0-alpha.1` uses `alpha`, `0.10.0-beta.1` uses `beta`, and a final
`0.10.0` release uses `stable`.

`platforms` is a non-empty, duplicate-free block list containing `macos`,
`windows`, or both. Every new entry must declare it explicitly. Entries written
before platform metadata was added omit the field and are interpreted as
`platforms: [macos]`, so the existing macOS history remains valid. A Windows
Alpha entry starts like this:

```markdown
---
version: 0.10.0-alpha.1
date: 2026-07-18
channel: alpha
platforms:
  - windows
title: A signed Windows test build
summary: One sentence that states only the capabilities this accepted build proves.
highlights:
  - A verified Windows-facing change.
---

User-facing Windows Alpha notes, including relevant limitations.
```

Frontmatter is a strict subset of YAML: scalar `key: value` lines plus the
`platforms:` and `highlights:` block lists. Unknown keys, malformed
dates/versions, invalid platform identifiers, empty highlights, or an empty
body **fail validation** (`pnpm changelog:check`), and from the release gate
onward a release cannot ship without a valid entry for its releaseId.

## Voice rules

- Write for users, not engineers: lead with what they can now do (or what
  stopped being broken), not how it was implemented.
- `summary` must stand alone — it is the only text some surfaces show.
- `highlights` are scannable fragments, one change each, no trailing filler.
- Link to `videorc.com` pages when pointing anywhere; never to the repo.
