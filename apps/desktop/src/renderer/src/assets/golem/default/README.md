# Default Golem pack

The owner's friendly stone golem (plan 164 D22; master in
`assets/brand/golem/`). `idle.webp` is the 640 px tall export; `talk`,
`laugh` and `think` fall back to it until matching art exists (D16). The
renderer loads it into a canvas `Image`, and it rides only the lazy Golem
chunks, never the eager renderer bundle. Keep any state file under 200 KB.
