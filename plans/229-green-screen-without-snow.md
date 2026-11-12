# Plan 229: The green screen without snow

The owner's stream on 0.22.0 (2026-11-11, session `8ff749f5`, record and
stream, 21:42–21:57 local), which already has plan 227's keyer: with Key out
background on and the defaults (`#00FF00`, Similarity 40, Smoothness 8, Spill
removal 10, no Hide edges), "snow" shows around the subject in the clip
`Clip 2026-11-11 21-56-24.mp4` (session `e2341214`, the replay buffer's last
30 s, 21:55:56–21:56:26).

## Status and scope

- **Status: IMPLEMENTED 2026-11-11** on branch
  `plan-229-green-screen-snow` (base `origin/main` `269b4c82f`, worktree
  `~/projects/videorc-wt-229`). No decision was needed: the fix is the
  keyer's default behaviour, with no new setting. Owed: the owner's own take
  with the green screen.
- **Evidence:** `~/videorc-test-2026-11-11-green-screen/snow/` (frames,
  crops, alpha maps, the noise simulation) and its scripts in
  `~/videorc-test-2026-11-11-green-screen/scripts/` (`specks.py`,
  `hue_margin.py`, `clip_specks.py`, `sim.py`; stdlib Python, run with
  `python3 -I`). It is the owner's camera footage, so it stays out of the
  repo.

## What the clip shows

- The snow is specks of green screen, one to three pixels across, teal or
  dark green, on the keyed background next to the head, the shoulders, the
  mic and the mic arm. They sit somewhere else in every frame: in a 200×150
  region beside the head, 0 to 43 speck pixels a frame over 60 frames. A
  speck that moves every frame is camera noise, not something in the room.
- The session's raw camera file (the ISO `-camera.mp4`, seconds 790–820)
  puts the lit screen 16–20° from `#00FF00`. Standard chroma-key green
  (`#00B140`) sits about 20° away. The default cone is 24° plus a 4.8°
  band, so the screen keys with only 4–8° to spare on the blue side. Specks
  sampled from the frame are 24.8–26.8° away, and teal because they are the
  bluer ones.
- In shadow (the right side, beside the mic and the arm), the screen's
  chroma is 9–20, near plan 227's luma floor of 5 and its ramp. Noise there
  crosses the floor as well as the cone.
- The ISO is H.264 at about 6 Mbit/s, which smooths the noise: the same
  keyer on it leaves no specks beside the head. The live frames the
  compositor keyed are noisier. The camera's chroma is 4:2:0, one sample per
  2×2 pixels, so one noisy sample is a 2×2 speck.
- FFmpeg's `chromakey` (the FFmpeg leg, bundled 8.1.1) judges each pixel by
  its 3×3 neighbourhood: one off-key pixel in a green field turns a 3×3
  block opaque. The CPU, Metal and D3D11 keyer judged each pixel alone, and
  that is the gap the noise gets through.

## Simulation

Per-pixel luma noise and per-2×2 chroma noise added to the raw frame
(`sim.py`), keyed with the shipped model, comparing the colour the key
judges: the pixel alone (0.22.0), a 3×3 tent, a 3×3 box, a 5×5 binomial.
Visible specks (alpha > 40) in pure screen:

| Chroma noise σ | Region     | Alone  | 3×3 tent | 3×3 box | 5×5 binomial |
| -------------- | ---------- | ------ | -------- | ------- | ------------ |
| 1.5            | lit screen | 0.71 % | 0.06 %   | 0.03 %  | 0.01 %       |
| 1.5            | mid shadow | 4.6 %  | 0.81 %   | 0.55 %  | 0.38 %       |
| 2              | lit screen | 1.97 % | 0.29 %   | 0.16 %  | 0.09 %       |
| 2              | mid shadow | 8.8 %  | 2.1 %    | 1.3 %   | 0.82 %       |

Without noise the deep shadow keeps about 1 % on every kernel (the ISO's
own residue). The cost at edges, measured on the clean frame: the subject
loses 0.08–0.30 px of outline on average with any kernel. The teal logo on
the t-shirt stays fully opaque on the clean frame with every kernel; with
noise (σ 3) the 5×5 leaves 0.13 % of its pixels less than opaque, against
1.11 % judged alone.

## The fix

- **Model** (`scene_geometry::chroma_key_neighbourhood_rgb`, plan 229): the
  key judges the colour smoothed over a 5×5 binomial, `[1 4 6 4 1]² / 256`,
  around the sampled texel (texels past the frame's edge repeat the edge).
  The pixel keeps its own colour, and despill still runs on it. The angle,
  the luma floor and Hide edges are unchanged.
- **Effects:** a speck of one or two chroma samples keys with the screen
  around it. A lone texel of the black t-shirt that noise turns green, which
  used to key alone (a hole), stays. A dark subject against a bright screen
  can lose the one column touching the screen, which is the column the 4:2:0
  chroma already bleeds green into.
- **Paths:**
  - The CPU blits build the judged colour of every texel once per blit,
    separably (`[1 4 6 4 1]` across, then down, integer sums), and the luma
    and chroma passes share it. A test pins it to the reference at every
    texel. The bilinear blit reads it with the sample's own taps. On one
    thread at 1080p (a standalone replica, best of eight runs), the old
    keyer took 14.5 ms, judging each pixel's 25 texels directly 62 ms
    (4.3×), and the plane 17 ms to build and key (1.2×).
  - The Metal shader: nine bilinear taps at 0 and ±1.2 source texels,
    weighing 6/16 and 5/16 per axis, through a clamp-to-edge linear sampler.
    On a texel centre that is the same kernel. The constants are mirrored
    (the preview helper has no `scene_geometry`) and pinned equal by a test.
  - The D3D11 shader: the same nine taps (`SampleLevel`, level 0). The
    constant buffer gains one float4 (15 × 16 bytes), pinned by the Windows
    shader test.
  - The FFmpeg leg is unchanged: `chromakey` already judges a 3×3
    neighbourhood.

## Not done

- The owner's own take with the green screen on this build: no snow around
  the head, the shoulders and the mic arm, in the Preview and in the file.
  No automated check can do it: the dev app has no camera grant, and the
  ISO is too smooth to show the noise.
- A WARP render test of the D3D11 keyer (still owed from plan 227).
