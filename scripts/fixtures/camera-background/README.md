# Camera background fixture (plan 258 S2)

`fixture.json` describes the dev-only fixture camera that
`pnpm smoke:camera-background` runs with (`VIDEORC_FIXTURE_CAMERA=<this folder>`,
debug builds only; packaged builds refuse it):

- **The room** (the secret background): a code of square magenta and cyan
  cells, `cellsPerHeight` of them across the frame's height, picked by `seed`.
  Nothing else in Videorc draws saturated magenta and cyan alternating in both
  directions, so `scripts/lib/camera-background-leak.mjs` can find it in any
  output, scaled, cropped, H.264 encoded or 4:2:0 subsampled.
- **The figure**: head, hair, neck and an orange shirt, centred at `centreX`
  and swaying `sway` (a fraction of the height) every `swayPeriodSeconds`. The
  detector counts the shirt colour to prove an output shows the fixture camera.

The backend draws both (`crates/videorc-backend/src/camera_fixture.rs`); the
folder holds no image, so there is nothing to license. The figure is drawn,
not photographed: a person segmenter (Apple Vision in S3, tasks-vision in S8)
may not see it as a person. With no person found, a correct effect blurs or
replaces the whole frame, which the detector still judges correctly (no room
anywhere). If a slice needs a figure the segmenter keeps, add a
licence-clean person cutout here and have the fixture paint it in place of the
drawn one.

The detector reads the shirt colour from this file, and its magenta and cyan
classes (`classifyPixel`) assume the room's fully saturated colours: change the
room's colours and the classifier together, and rerun its Node tests.
