# Reduce microphone noise

To reduce background noise in a recording or stream, open **Sources**, select a
microphone, and turn on **Noise reduction**. The default is Off.
Adjust microphone gain first. Noise reduction receives that gained signal before
other microphone processing or the system-audio mix.

The control changes during capture without restarting the microphone. Off and
On share the same source timeline and use a short transition. Mute remains
a separate downstream control and silences the audio sent to the recording,
stream, captions and Buddy. System audio is not processed by noise reduction.

An idle microphone meter shows the input level with gain applied. During a
supported session the mic meter, captions and Buddy receive the processed
microphone contribution used in the recording. Noise reduction targets background
noise in speech. It does not provide acoustic echo cancellation or a configurable
strength parameter.

Microphone silence warnings use raw input received during the session, before
gain, noise reduction or mute. A quiet processed meter does not mean capture
has failed. Missing input and an input that delivers only silence still produce
capture warnings. Selecting another microphone starts a new capture-health window.

## Supported capture paths

Noise reduction runs on Videorc's timestamped session audio bus. That covers the
macOS native microphone and the capture-worker microphone on Windows and Linux.
A microphone that falls back to direct FFmpeg capture cannot use it: the Windows
DirectShow fallback, the Linux direct Pulse fallback, or
`VIDEORC_LINUX_MICROPHONE_DIRECT`. A session on such a route still starts,
without noise reduction. Session health records a warning, and the switch turns
Off with the message "Noise reduction is unavailable for this capture. It is
Off." Turning it on mid-session on such a route is refused the same way. The
app never shows noise reduction as On while it records untreated audio.

Removing a microphone keeps your noise reduction selection. A session with no
microphone starts with a silent bus and applies that selection when a supported
microphone is attached.

The implementation preserves Videorc's existing centered-mono microphone
policy. Stereo system audio stays stereo. Native device and packaging
acceptance must run on each target platform before claiming release support.

## Build and dependency

Cargo uses the pure Rust `rnnoise-rs` implementation from the
[TheOrcDev fork](https://github.com/TheOrcDev/rnnoise-rs) (branch `videorc`) at
revision `c915940e94e2ec1ca07a1af22c769a33c3fb1ce6`, with default features
disabled and the default float model. The fork is upstream
[lovelace-labs/rnnoise-rs](https://github.com/lovelace-labs/rnnoise-rs) revision
`74b46b1065630f68464ee60dd542e3ce175743db` plus one change: Cargo builds only the
Rust library, not the unused C static and dynamic libraries. It needs no C
RNNoise library, Python runtime or model download when the app runs. The package
is pinned from Git because it is not published on crates.io.

The embedded model has SHA-256
`eb8687d6ec4a461c971c60dc1f576d68e05bda2bfac8d9d356a330de14d28f71`.
It matches, byte for byte, the float weights regenerated from Xiph RNNoise
revision `70f1d256acd4b34a572f999a05c87bf00b67730d`. Binary packages include the
original [port license](../licenses/rnnoise-rs/LICENSE.txt),
[upstream DSP notices](../licenses/rnnoise-rs/UPSTREAM-NOTICES.txt) and
[source record](../licenses/rnnoise-rs/SOURCE.txt).

## Audio timing and controls

The processor consumes 480 mono samples at 48 kHz. Its measured delay is 960
samples, or 20 ms. The session bus prepares future input from its playout
buffer and assigns the result to its original source position. Sessions on
macOS and Windows get 20 ms more than the 50 ms deadline, On or Off, because
noise reduction can be turned on mid-session; the microphone keeps the same
budget for late audio either way. Linux already uses a longer deadline. This
changes when the bus writes, not what it writes. It does not add a user sync offset or move system audio
independently.

Each input block snapshots mic gain and advances the recurrent processor once.
Partial output writes reuse the prepared samples. Gain edits affect subsequent
processing blocks, including the bounded lookahead; they cannot rewrite a
block already processed. Safety mute is checked again while writing the
remaining samples. Source replacement or a discontinuity resets processor
history, so a new microphone cannot inherit the previous microphone's voice.

Turning noise reduction on, at session start or mid-session, first loads the
model off the audio thread: a few milliseconds, once per app run. A session that
stays Off never loads or runs it. After first enable, the processor keeps
running during bypass while a microphone is attached, so later switches retain
adaptive history. First
enable starts that history fresh. Once a removed microphone has drained, it stops
processing until another microphone is selected.
The steady Off path retains the existing output behavior. Pre-gain retains
floating-point headroom; the processor rejects nonfinite input or magnitude
above 64 before it can corrupt recurrent state. This is an invalid-signal
boundary, not an automatic gain control. Output protection still belongs to
the recording pipeline. Raising gain raises both speech and noise.

## Verification

Run `pnpm smoke:rnnoise` on a macOS development build to record a paced native
audio fixture, change gain/suppression/mute live, and inspect the decoded final
files. It is part of `pnpm smoke:local-gates`. It checks startup with RNNoise enabled without a corrective live update,
then startup with no microphone and remembered RNNoise followed by microphone
attachment in the same recording. The steady tone proves suppression wiring.
Its mute phase uses bypassed, audible audio.

The same run then does a speech pass to detect lost speech and verify RNNoise
mute and unmute on audible processed output. It synthesizes the speech with
macOS `say` and FFmpeg into a temporary 1 to 5 second, mono, 48 kHz,
little-endian float PCM file, and deletes it afterwards. To use your own
recording instead, supply a file in that format with finite samples within full
scale:

```sh
VIDEORC_RNNOISE_TEST_PCM_PATH=/absolute/path/speech.f32le pnpm smoke:rnnoise
```

On other platforms the smoke prints SKIPPED, like the other macOS-only smokes.

The debug native source normalizes this fixture to the requested peak and plays
it at the normal capture cadence. Missing, malformed, silent or oversized files
fail startup. The report records its path and SHA-256. Retention bounds reject
silent wet output, silent startup, lost attached-microphone audio and failed
unmute. These are signal-integrity checks, not intelligibility or listening
quality scores. Both passes are needed; speech energy alone cannot prove noise
suppression. The backend smoke blocks renderer processing updates
to prevent them repairing a broken startup setting. Normal UI toggle acceptance
is a separate check.

The wrapper checks real-model delay, partial final frames, reset, finite input,
headroom and noise suppression. The bus checks source positions, output retries,
transitions, mute and source lifecycle. UI tests cover stored defaults, pending
updates, acknowledgements and rollback.

If noise reduction refuses a microphone frame (non-finite, or past the +36 dBFS
headroom) or produces a non-finite output, Videorc writes silence for the
microphone over that stretch and resets the processor. The session goes on:
system audio, sounds and the live controls are not affected, and noise reduction
resumes as soon as the input is valid again. It never substitutes untreated
microphone audio while noise reduction is On. Session health records one
warning per episode, with a short toast; an episode ends after 1 second of clean
processing. A warning raised just before Stop is still reported.
