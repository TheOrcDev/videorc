# 2026-11-20 Windows stream scenarios on an Intel UHD 620 laptop (#156)

## Why

The 2026-07-26 PARTIAL record for #156
(`2026-07-26-windows-encoded-media-pipeline.md`) left five things open behind
the landscape ceiling: portrait, record-plus-RTMP, split-profile,
unavailable-target and clean-stop. It also asked for a second physical host.
#1610 (`2026-11-20-windows-d3d11-1440p-4k.md`) has since cleared the
landscape ceiling (1440p60 and 4K30 on the D3D11 path) on two hosts, and the
portrait twins with it. This record runs the stream scenarios on that second
host.

## Host and build

HP laptop, Intel Core i5-8365U, Intel UHD 620 (driver 31.0.101.2135),
Windows 11 Pro 10.0.26300, on AC. Dev app from main `3035a0b0` with the release
backend (`VIDEORC_DEV_BACKEND_PROFILE=release`), bundled FFmpeg from
`vendor/ffmpeg/windows-x64`. Every session used the Intel Quick Sync H.264
Encoder MFT through Media Foundation.

The protected `smoke:windows-stream-performance` gate did not run: it accepts
only an NSIS-installed candidate built from the checked-out commit, with its
release, installer and payload identity. The maintained dev-app stream smokes
cover the same scenarios against local `ffmpeg -listen 1` RTMP receivers.

## Results

| Scenario (#156)                      | Smoke                                             | Result                                    |
| ------------------------------------ | ------------------------------------------------- | ----------------------------------------- |
| Record plus RTMP, at the cap         | `smoke:multistream`, `VIDEORC_SMOKE_TARGETS=5`    | PASS                                      |
| Record plus RTMP, unavailable target | `smoke:multistream` (3 targets + an offline Kick) | PASS                                      |
| Split profile (vertical leg)         | `smoke:multistream:vertical`                      | PASS                                      |
| Clean stop with a leg mid-retry      | `smoke:stream-leg-eof`                            | FAIL, 3 of 3 (fixed by #1626, see Update) |

- **At the cap:** one record+stream encode reached all five receivers
  (562,056 bytes each), every leg passed the stream artifact gates, and the
  local recording finalized and passed pacing, PTS and duration. The
  compositor heartbeat dipped once to 14.4 fps during the take and recovered
  to 27.4 fps.
- **Unavailable target:** the three healthy receivers each got 606,725 bytes
  and passed, the recording passed, and the offline leg reported
  `reconnecting` while the others kept streaming.
- **Vertical leg:** the three horizontal receivers passed, the vertical
  receiver got the 360x640 fit leg (not the horizontal program), the
  recording passed and the offline leg was isolated.
- **Leg EOF:** the closed leg reports `reconnecting` after about 5.5 s, the
  other leg stays live, the leg resumes about 2.1 s after its ingest returns
  and the reconnected stream starts on a keyframe. With the ingest closed
  again 3 s before Stop, FFmpeg does not exit inside the 8 s streaming quit
  grace. The backend escalates to TERM, the session ends as failed ("FFmpeg
  did not finish after Stop … kept as recovery media"), and the recording is
  rebuilt from the MKV (about 34 s). Stop returned in 8,060 to 8,088 ms in
  all three runs.

## The leg EOF failure

A refused loopback connect costs about 2 s on Windows (the stack retries the
SYN after the RST); on macOS it fails at once. The fifo leg keeps its
recovery loop running after `q`: it waits `recovery_wait_time` (2 s), makes
one more connect attempt, and only then writes its trailer. The bundled
FFmpeg alone, with the app's fifo options and the same close, reopen and
close of a local receiver before `q`, took 6.3 s from `q` to exit (exit 0).
Against a port that never listened it took 2.8 s. The app's session (a
recording plus two fifo legs in one tee) crosses 8 s.

## Update, 2026-11-22: clean stop fixed (#1623, #1626)

#1626 (merge `6062a10a4`) fixed #1623. The stderr monitor now tracks which
FFmpeg outputs have written their trailers. A streaming Stop ends FFmpeg as
soon as every output still open is a leg that is reconnecting. If FFmpeg has
to be forced after the recording has closed, the session finalizes normally
instead of keeping recovery media.

The evidence in #1626 comes from this host (same laptop, Quick Sync MFT, dev
app on the release backend):

- `smoke:stream-leg-eof`: PASS. Stop took 8.37 s, logged
  `Capture session finalized after stop signal`, and kept no recovery media.
  The healthy leg sits behind the dead one, so this Stop still uses the 8 s
  grace.
- `smoke:multistream` (offline Kick leg): PASS. FFmpeg exited 0.60 s after
  Stop and the session finalized. Before the fix every Stop was forced into
  recovery media, but that smoke does not check how Stop ends, so it still
  passed.

The leg-EOF row above keeps its original result from `3035a0b0`. This record
did not re-run the smoke on a build with the fix.

## Not covered here

- Natural OpenH264 fallback: this host's Media Foundation probe accepts
  Quick Sync, so the probe never rejects it here.
- The protected `smoke:windows-stream-performance` matrix (installed
  candidate only).
