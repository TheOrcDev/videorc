# Real glass: probe calibration (plan 050, S1–S2)

Date: 2026-09-23 · macOS 26.5.1 (Apple M4, built-in Retina display) · Electron
39.8.10 · `probe:ui-glass` (`scripts/ui-glass-probe.mjs`).

The probe region-captures every window (`screencapture -R`) over stand-in
backdrops and measures a text-free sample rect per window. The thresholds in
`GLASS_THRESHOLDS` sit between the populations below, with at least 2x
separation on each gated metric.

## Populations

`transmission` is the colour distance between the red- and blue-backdrop
shots. `sharpness` is the Laplacian variance over a dense black-on-white text
backdrop. Contrast is `--foreground` / `--muted-foreground` against the coat
measured over white and black backdrops (worst case). The primary column is
omitted: every row passes 7:1 comfortably except the light fake frost's
content pane (9.9:1, still a pass).

### A. Today's fake frost (wallpaper underlay at 0.92/0.94, 68%/62% coat)

| theme | window · sample           | transmission | sharpness | secondary |
| ----- | ------------------------- | -----------: | --------: | --------: |
| dark  | main · content toolbar    |         3.86 |      3.41 |      7.10 |
| dark  | main · sidebar foot       |            0 |      0.02 |      6.75 |
| dark  | chat · list foot          |            0 |      0.14 |      7.62 |
| dark  | captions · body           |            0 |      1.56 |      7.13 |
| dark  | notes · textarea (opaque) |            0 |         0 |      7.58 |
| light | main · content toolbar    |         2.83 |      2.67 |    2.94\* |
| light | main · sidebar foot       |            0 |      0.07 |    2.67\* |

\* Light secondary contrast in population A was scored with the old
`#6E6E73` token mirror; the probe now uses the real `--muted-foreground`
(`#5B5B5E`).

### B. Transparent window without a material (the July leak)

The underlay was hidden through CDP on windows that are transparent but carry
no vibrancy (Chat and Captions before S3). Text behind the window reads
through: dark captions sharpness **12.04**, light captions **11.76**, light
chat **83.68**.

### C. Real vibrancy (`under-window`) with the S2 coats

Dark coats are `--glass-window` 42% and `--glass-content` 34%; light coats are
60% and 30%. The sidebar sits on the window coat alone.

| theme | window · sample        | transmission | sharpness | primary | secondary |
| ----- | ---------------------- | -----------: | --------: | ------: | --------: |
| dark  | main · content toolbar |        24.04 |         0 |   14.23 |      6.03 |
| dark  | main · sidebar foot    |        36.77 |      0.02 |   11.46 |      4.86 |
| light | main · content toolbar |         9.90 |         0 |   16.09 |      5.73 |
| light | main · sidebar foot    |        13.45 |         0 |   15.34 |      5.46 |

## Thresholds

| Metric             | Threshold | Separation                                                                  |
| ------------------ | --------- | --------------------------------------------------------------------------- |
| transmission       | ≥ 8       | A ≤ 3.86 vs C ≥ 9.90: 2.1x below, 1.2x above, 2.6x between the populations  |
| sharpness          | ≤ 4       | C ≤ 0.3 vs B ≥ 11.76: more than 13x below, 2.9x above                       |
| primary contrast   | ≥ 7       | WCAG AAA for body text                                                      |
| secondary contrast | ≥ 4.5     | WCAG AA                                                                     |
| pinned luminance   | ≤ 0.12    | Dark glass over white measures 0.02–0.04. A light material measures 0.8–0.9 |

## Why these coats

Over pure white, the dark `under-window` material measures `#4A4B49`
(luminance 0.069). Secondary text needs 0.040 or less, so a coat of about 30%
of `--glass-solid` is the floor. An earlier sidebar with a white 5% fill
measured 4.36:1 and failed. The sidebar now sits on the window coat alone.

Light glass needs a heavier coat: the light material turns gray over dark
content, and dark text needs a bright background. At 60% + 30%, light
secondary text holds 5.5–5.7:1 over a black desktop.

## WindowServer

WindowServer CPU is sampled read-only with `top` after a 20 s settle, with the
preview presenting. S2 (main window on glass): 24.2%. The glass-on versus
`VIDEORC_GLASS=0` comparison with every window on glass is recorded in the S7
acceptance notes.
