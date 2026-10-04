# Plan 146: Bound legacy PCM recording synchronization

## Status

P1. Attributed during final acceptance on main `b3771763`. Source repair merged in PR 600 (`c88f3ad4`, main `2310b6fd`); the real-command regression is RED before the fix and GREEN after it. Focused app and full source verification pass; aggregate verification remains in progress; no aggregate acceptance claimed.

## Reproduction and attribution

The unchanged complete local bundle finishes its recording matrix at **16/18**. The 4K60 session remains Recording for 6.371 seconds and stops normally, but its MP4 contains only 20 frames / 0.333 seconds. The strict minimum duration and keyframe evidence gates correctly reject it. A fresh isolated repetition retains the original MKV through an open read-only descriptor: both original MKV and exported MP4 contain 25 video frames / approximately 0.426 seconds. Export trimming and prior-profile state are therefore not the cause.

The exact legacy command combines real-time 3840×2160/60 test video, the live session PCM FIFO, `aresample=async=1:first_pts=0,apad`, PCM encoding, `-shortest`, and the existing JPEG preview output. The default synchronization window is ten seconds. An exec-preserving observation shim captures only this local command outside Git. Changing one output option, `-shortest_buf_duration 0.25`, makes the same maintained 4K60 smoke pass all unchanged artifact checks; its A/V tail difference is 7 ms. The shim is removed before source verification.

Evidence is retained outside Git under `/Users/orcdev/projects/videorc-qa-evidence-20261004/`: `local-main-b377`, `4k60-isolated`, `4k60-command`, and `4k60-bounded`. Raw app logs may contain ephemeral credentials and must not be published.

## Repair and verification

Use the production argument builder and the real live PCM bus in a macOS FFmpeg regression. Require output progress before Stop, bounded cleanup of the exact child, and enough finished video frames; draining the preview pipe is part of the real command shape. Observe RED before changing production policy.

Bound only legacy padded-PCM recording synchronization, preserving the existing Linux Pulse bound and bridge/AAC policies. Keep audio padding and video-owned EOF, encoder selection, the 4K60 experimental profile, duration/keyframe requirements, and all quality gates unchanged. Run the microphone-EOF control, recording unit tests, strict Clippy/format, the unmodified 4K60 app smoke, the complete profile matrix, recording-studio/device gates, and the final local bundle. A focused pass cannot substitute for those aggregates.

The independent shared record/stream pressure stop failure remains in [Plan 147](147-diagnose-shared-record-stream-stop.md).


## Source regression results

The production-command/live-bus regression fails before the fix: video stalls at five frames / 0.066667 seconds for its complete eight-second progress deadline, then the exact FFmpeg child is stopped and reaped. After the source change, all three real-FFmpeg cases pass: live legacy PCM progress plus finished frame-count/clean-stop checks, the original microphone-EOF video-clock control, and staged MP4 export ownership. Logs: `legacy-pcm-red.log` and `legacy-pcm-green.log` under the private evidence root. Added pure policy controls retain existing AAC and bridge behavior. Full Rust passes 3,080 cases / 13 ignored; full desktop passes 3,097 / one existing skip; all 1,935 Node cases pass. Strict Clippy, Rust formatting, global formatting/text checks, and the fresh backend build pass. The unmodified source-app 4K60 smoke passes: 6.233 seconds, 374 observed/expected/distinct frames, 60 fps, four keyframes, maximum keyframe interval two seconds, BT.709/video-range tags, High level 5.2, 13 ms A/V tail difference. Source backend SHA-256 `f29cf7383be43f7b8e17ffa0d09aefbddb5483fe197de3e50c67249b87bb8e12`. No wrapper is present for this run. The complete matrix/studio/local bundle remains pending.


These QA follow-ups use Plan146/147 because open Orcle PR599 already reserves Plan140. The local private evidence filenames retain their original `fix140` names. Shadscan baseline/floor/pre-commit:37/37/37. The source fix is merged through the normal protected PR workflow; no release is published.
