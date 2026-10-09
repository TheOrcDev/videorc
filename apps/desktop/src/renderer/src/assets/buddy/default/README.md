# Default Buddy pack

The owner's friendly stone golem (plan 164 D22; masters in
`assets/brand/buddy/`). `idle.webp` is the export of the original art;
`talk.webp`, `laugh.webp` and `think.webp` were generated from it as image
edits (Vercel AI Gateway, `openai/gpt-image-2.5-sunburst`, 2026-10-09) and
exported at the same scale, so the golem is the same height in all four and
stands on the same baseline. The renderer loads them into a canvas `Image`,
and they ride only the lazy Buddy chunks, never the eager renderer bundle.
The backend builds the Still pack from the same files (`buddy_pet.rs`,
`include_bytes!`). Keep any state file under 200 KB.
