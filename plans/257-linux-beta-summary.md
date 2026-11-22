# Plan 257 summary: Linux beta (for dispatch)

The full plan, with evidence for every row and every slice's steps, is
[257-linux-beta.md](257-linux-beta.md). This page is what a coordinator needs
to hand out fixer slices.

## Owner: physical steps on ogre first

These unblock slices that an agent can't do alone:

1. **Install v4l2loopback** (needs sudo, so the owner):
   `sudo pacman -S v4l2loopback-dkms` (ogre's kernel is `linux-t2`, and
   `linux-t2-headers` is already installed, so DKMS can build the module),
   then check with `modinfo v4l2loopback`. Unblocks S16 (Videorc Camera). If
   Secure Boot refuses the module, say so and the slice writes guidance
   instead.
2. **Plug in a USB webcam** and leave it connected. Unblocks S2's hotplug
   check and gives S1/S9 a camera with a real picture (the FaceTime camera
   sits in the closed lid and is black).
3. **Plug in a USB microphone** and leave it connected. Unblocks S1's
   real-mic takes and S9's mic swap.
4. **Unlock the session at the console** before any attended lab run (D12):
   ogre's lock screen covers the lab output, so a locked session streams the
   lock screen.
5. **Buy or borrow the second Linux box (D2, owner-owed):** Ubuntu 24.04 with
   an Intel or AMD GPU. Until it exists, S21's second-box half and S22 are
   blocked.

## Parity counts (55 features, ogre spot check 2026-11-21 + code)

| Status                                                        | Count |
| ------------------------------------------------------------- | ----- |
| Works, seen on ogre                                           | 11    |
| Works in code, not seen yet                                   | 12    |
| Degraded                                                      | 11    |
| Broken in the spot check (under heavy host load; S1 confirms) | 2     |
| Missing                                                       | 11    |
| OS-limited (Linux-native equivalent planned)                  | 5     |
| Neither platform has it                                       | 2     |
| Label only (release track)                                    | 1     |

## Top 10 gaps, by what a streamer feels

1. **Recordings lost the mic and hung at Stop** in 2/2 takes: tone for
   3.5–6 s, then silence; FFmpeg SIGKILLed; file saved by recovery. Box was
   heavily loaded, so S1 reproduces on a quiet box first.
2. **The preview is a CPU fallback.** Health says "Preview speed:
   Fallback"; the camera layer updated about once a second; camera plus
   preview cost about 3 cores at idle.
3. **Scene and global hotkeys don't fire on Wayland.**
4. **No desktop audio** (game, browser, alerts).
5. **No live captions on Linux.**
6. **No source changes while recording or live** (mic, camera, screen).
7. **The camera path is heavy and rigid**: asks 1080p from a 720p camera
   and scales on the CPU (~180 % CPU), no format choice, no hotplug.
8. **No self-update** (notice only; `latest-linux.yml` is 404).
9. **Hardware encoding isn't the default** (VAAPI evidence missing, AMD
   quarantined on ogre, no NVENC), so Clips are off and record and stream
   share one encode.
10. **Talk-show rooms from Linux can't share the screen or desktop audio.**

## Slices in order

Size: **S** one small PR, **M** a normal PR with tests and an ogre run,
**L** several days, a spike or many files. Lane names follow plan 250.
Every slice that touches the Linux recording arm runs the direct matrix
command on ogre (AGENTS.md). ogre limits: `cargo -j3`, `vitest
--maxWorkers=4`, one heavy job at a time, a quiet box for timing claims.

| #   | Slice                                                                | Route · lane · fit                            | Size | Depends on                                |
| --- | -------------------------------------------------------------------- | --------------------------------------------- | ---- | ----------------------------------------- |
| S0  | Lab detects a locked session and checks the picture                  | Implementation · `gpt-6.1-sol` · 8            | S    | —                                         |
| S1  | Mic dropout and FFmpeg hang at Stop: reproduce, fix                  | Diagnose → Implementation · `fable-5.1` · 9   | L    | USB mic (step 3) for the real-mic takes   |
| S2  | Camera: native format, device size, hotplug                          | Implementation · `fable-5.1` · 8              | M    | USB webcam (step 2) for hotplug           |
| S3  | Preview transport and watchdog (spike, then build)                   | Implementation · `fable-5.1` · 9              | L    | S2                                        |
| S4  | Linux docs tell the truth                                            | Docs · `gpt-6.1-sol` · 7                      | S    | —                                         |
| S5  | VAAPI by default, L1.5 evidence committed                            | Implementation · `gpt-6.1-sol` · 8            | M    | S1                                        |
| S6  | NVENC arm                                                            | Implementation · `gpt-6.1-sol` · 8            | M    | S5; NVIDIA box for its check (D7)         |
| S7  | Separate record and stream encodes on VAAPI                          | Implementation · `fable-5.1` · 8              | M    | S5                                        |
| S8  | Desktop audio through PipeWire                                       | Implementation · `fable-5.1` · 9              | L    | S1                                        |
| S9  | Change sources while recording or live; per-scene screens            | Implementation · `fable-5.1` · 9              | L    | S1, S2                                    |
| S10 | Live captions on Linux                                               | Implementation · `gpt-6.1-sol` · 8            | M    | S1                                        |
| S11 | Global shortcuts through the GlobalShortcuts portal                  | Implementation · `fable-5.1` · 9              | L    | —                                         |
| S12 | Wayland window behaviours: hide from capture, on top, screen tap     | UI/Product Design · `opus-5.5` · 8            | M    | —                                         |
| S13 | Talk-show rooms from Linux: screen share, desktop audio              | Implementation · `fable-5.1` · 8              | M    | S8                                        |
| S14 | Cloud shows and handoff on Linux, verified                           | Diagnose → Implementation · `gpt-6.1-sol` · 7 | M    | S13                                       |
| S15 | Separate source (ISO) recordings on Linux                            | Implementation · `fable-5.1` · 8              | M    | S7                                        |
| S16 | Videorc Camera proven and shown                                      | Implementation · `gpt-6.1-sol` · 8            | S    | v4l2loopback (step 1)                     |
| S17 | First-run onboarding for Linux                                       | UI/Product Design · `opus-5.5` · 8            | M    | S18                                       |
| S18 | Secret Service, groups and portal preflight                          | Implementation · `gpt-6.1-sol` · 8            | S    | —                                         |
| S19 | AppImage self-update and the Linux feed (publishing is a human gate) | Implementation · `fable-5.1` · 9              | L    | —                                         |
| S20 | Linux acceptance checklist, record schema, validator                 | Docs · `gpt-6.1-sol` · 8                      | M    | —                                         |
| S21 | Feature sweep on both boxes (no going live)                          | Review · `fable-5.1` · 9                      | M    | S1–S19; second-box half **blocked on D2** |
| S22 | Physical acceptance and the Beta flip                                | Release · human gate                          | —    | S20, S21; **blocked on D2**               |

**Start now, in parallel:** S0, S1, S2, S4, S11, S12, S18, S20. Then S8, S5,
S10 after S1; S3 after S2; S9 after S1 and S2. S19 can start any time (its
publish step waits for a release). S22 is the last step and needs the
second box.

## Owner decisions

D1 and D3–D12 are DECIDED (the recommended defaults, 2026-11-21). D2, the
second Linux machine, is OWNER-OWED. The full text is in the plan's "Owner
decisions" section.
