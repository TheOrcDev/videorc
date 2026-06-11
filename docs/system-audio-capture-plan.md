# System Audio Capture Plan

Status: follow-up feature plan.

Created: 2026-06-11.

This plan tracks the system-audio item from the June 2026 fix audit. It is not a
small bug fix: `DeviceKind::SystemAudio` exists, but the product does not yet have a
system-audio source, mixer, recording graph, or UI control. The current placeholder
must stay unavailable until the native adapter and mixer are wired end to end.

## Current State

- `DeviceKind::SystemAudio` exists in Rust and TypeScript protocol mirrors.
- `devices.rs` always appends `system_audio_placeholder()` with status
  `Unavailable`.
- `SourceSelection` has screen, window, camera, microphone, and test-pattern fields,
  but no system-audio selection.
- `AudioTrackSource` supports only `Microphone` and `TestTone`.
- `CaptureInputs` has one optional `MicrophoneInput`. Recording audio setup assumes
  either one microphone FIFO/avfoundation input or a test tone.
- `audio.rs` has a reusable 48 kHz stereo `AudioFrame` and native FIFO writer, but
  the capture source is CoreAudio microphone-only.
- The Sources tab filters only microphone devices into the mixer. System audio can
  appear only in Diagnostics as an unavailable row.

## Product Target

Users can record and stream desktop/game audio without installing a virtual audio
device. The first implementation is macOS-only and uses native system capture.

Acceptance target:

- System audio appears as selectable only when the native adapter is available.
- A session can record or stream with system audio only, microphone only, or both.
- Mixed audio is 48 kHz stereo and reaches the same local recording and stream legs.
- Permission or platform failure is surfaced as an unavailable or permission-required
  device, plus a health event when a selected source cannot start.
- The fallback test tone is used only when no real audio source is selected and the
  current session mode still needs an audio track for diagnostics.
- Packaged and dev builds behave the same.

## Architecture Direction

Do not bolt system audio into the existing microphone-only path as a special case.
Promote audio capture to a small native-audio graph:

- Native sources emit `AudioFrame { sample_rate: 48000, channels: 2, samples }`.
- A mixer owns one or more sources and writes a single f32le FIFO to FFmpeg.
- Per-source gain/mute is applied before mixing.
- The mixer clamps mixed samples to `[-1.0, 1.0]` and records per-source frame/drop
  counters for Diagnostics.
- Recording status reports all active `AudioTrack`s, not just the one FIFO.

This keeps FFmpeg downstream-first and avoids a growing filter-graph branch for every
audio-source combination.

## Slices

### SA1 - Protocol and Stored Selection

Goal: represent system audio without making it selectable yet.

- Add `systemAudioId` and `systemAudioName` to `SourceSelection` in Rust and
  TypeScript mirrors.
- Add `AudioTrackSource::SystemAudio` and the TypeScript mirror.
- Add persisted audio settings for system gain/mute only if the UI slice needs them;
  otherwise keep gain/mute local to the mixer defaults.
- Normalize old capture configs to `undefined` system audio fields.
- Tests: protocol serde round trips, TS capture config normalization, and a status
  payload containing microphone plus system audio tracks.

### SA2 - Native Audio Graph

Goal: split "one microphone FIFO" from "native mixed audio".

- Introduce `NativeAudioInput` with variants for microphone and system audio.
- Introduce a `NativeAudioMixer` that can attach one or more `NativeAudioSource`
  receivers and write one f32le FIFO.
- Keep the existing video-epoch trimming behavior at the mixer boundary so all audio
  sources align to the first encoded video frame together.
- Keep microphone-only behavior byte-compatible where possible.
- Tests: deterministic mixing, clipping, mute/gain, pre-roll trimming, and track list
  generation for mic-only/system-only/mixed/test-tone cases.

### SA3 - ScreenCaptureKit System Audio Adapter

Goal: turn macOS system audio into `AudioFrame`s.

- Add a `system_audio_capture.rs` module for native macOS system-audio capture.
- Discover availability separately from screen/window discovery so a missing display
  permission does not imply system audio is available.
- Convert platform sample buffers into 48 kHz stereo `AudioFrame`s.
- Surface permission/API failures through `DeviceStatus`.
- Tests: pure conversion helpers and error mapping. Real capture requires manual
  macOS acceptance.

### SA4 - Recording Integration

Goal: feed selected system audio into record/stream sessions.

- Extend `resolve_capture_inputs` to include selected system audio.
- Replace `prepare_native_audio_source` with preparation for the native audio graph.
- Emit health events when a selected native audio source cannot start.
- Feed the mixed FIFO into bridge and legacy recording paths.
- Preserve the test-tone fallback only for no-real-audio sessions.
- Tests: FFmpeg input args, track list, fallback behavior, session health event paths,
  and existing microphone sync offset coverage.

### SA5 - Sources UI

Goal: expose the feature with honest status.

- Add a System Audio row to the Sources tab mixer using existing device rows and
  controls.
- Keep live switching disabled until the native audio graph has a source-switch path.
- Show Available, Permission needed, or Unavailable directly from backend device
  status.
- Tests: desktop unit/typecheck/build. Manual browser check for layout and disabled
  states.

### SA6 - Acceptance and Diagnostics

Goal: prove the feature on real hardware.

- Add a manual checklist under `docs/acceptance/` for system-audio capture.
- Include dev and packaged builds.
- Cover system-only, mic-only, mixed mic+system, record-only, stream-only, and
  record+stream sessions.
- Verify audio/video sync, no obvious clipping, no echo/feedback, and useful
  diagnostics if the source is unavailable.
- Add diagnostics counters for system audio captured frames, dropped frames, and mixer
  clipping events.

## Risks

- ScreenCaptureKit audio availability and permissions differ by macOS version.
- System audio and microphone clocks may drift; the first slice should measure drift
  before adding long-session acceptance.
- Mixing in Rust keeps the FFmpeg graph simple, but it makes clipping, source loss,
  and timing diagnostics our responsibility.
- Live device switching for audio should be a later warm-swap feature, not part of the
  first capture implementation.
- Capturing app/system audio may include browser playback or monitoring output; the UI
  should avoid implying echo cancellation or monitor routing until those exist.

## Done Definition

This feature is done only when the placeholder device is replaced by a real
availability check and a selected system-audio source reaches both local recording and
stream output in dev and packaged builds. Until then, `system-audio:native-adapter-pending`
must remain unavailable.
