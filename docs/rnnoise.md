# Reduce microphone noise

To reduce background noise in a recording or stream, open **Sources**, select a
microphone, and set **Noise reduction** to **On**. The default is **Off**.
Adjust microphone gain first. Noise reduction receives that gained signal before
other microphone processing or the system-audio mix.

The control changes during capture without restarting the microphone. Off and
On share the same source timeline and use a short transition. Mute remains
a separate downstream control and silences the audio sent to the recording,
stream, captions and Orcle. System audio is not processed by noise reduction.

An idle microphone meter shows the input level with gain applied. During a
supported session the mic meter, captions and Orcle receive the processed
microphone contribution used in the recording. Noise reduction targets background
noise in speech. It does not provide acoustic echo cancellation or a configurable
strength parameter.

Microphone silence warnings use raw input received during the session, before
gain, noise reduction or mute. A quiet processed meter does not mean capture
has failed. Missing input and an input that delivers only silence still produce
capture warnings. Selecting another microphone starts a new capture-health window.

## Supported capture paths

Noise reduction requires Videorc's timestamped native microphone bus. This includes
the macOS native microphone path and the Windows capture-worker path. Direct FFmpeg
capture fallbacks, including the current Linux Pulse microphone path, cannot
apply this processor. An enabled request on such a path is rejected with an
explanation. Turn noise reduction Off or select a supported microphone; the app
must never show noise reduction as active while recording untreated audio.

Removing a microphone keeps your noise reduction selection. A session with no
microphone starts with a silent bus and applies that selection when a supported
microphone is attached.

The implementation preserves Videorc's existing centered-mono microphone
policy. Stereo system audio stays stereo. Native device and packaging
acceptance must run on each target platform before claiming release support.

## Build and dependency

Cargo uses the pure Rust `rnnoise-rs` implementation at revision
`74b46b1065630f68464ee60dd542e3ce175743db`, with default features disabled and
the default float model. It needs no C RNNoise library, Python runtime or model
download when the app runs. The package is pinned from Git because it was not
published on crates.io at integration time.

The embedded model has SHA-256
`eb8687d6ec4a461c971c60dc1f576d68e05bda2bfac8d9d356a330de14d28f71`.
It matches the float weights regenerated from the RNNoise model auditioned in
the sandbox. [Research and comparison results](rnnoise-rust-research.md) record
the upstream source, model archive and checks. Binary packages include the
original [port license](../licenses/rnnoise-rs/LICENSE.txt),
[upstream DSP notices](../licenses/rnnoise-rs/UPSTREAM-NOTICES.txt) and
[source record](../licenses/rnnoise-rs/SOURCE.txt).

## Audio timing and controls

The processor consumes 480 mono samples at 48 kHz. Its measured delay is 960
samples, or 20 ms. The session bus prepares future input using its existing
playout buffer and assigns the result to its original source position. It does
not add a hidden user sync offset or move system audio independently.

Each input block snapshots mic gain and advances the recurrent processor once.
Partial output writes reuse the prepared samples. Gain edits affect subsequent
processing blocks, including the bounded lookahead; they cannot rewrite a
block already processed. Safety mute is checked again while writing the
remaining samples. Source replacement or a discontinuity resets processor
history, so a new microphone cannot inherit the previous microphone's voice.

The processor starts on first enable. Until then, Off performs no model
inference. After first enable, it keeps running during bypass while a
microphone is attached, so later switches retain adaptive history. First
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
files. It checks startup with RNNoise enabled without a corrective live update,
then startup with no microphone and remembered RNNoise followed by microphone
attachment in the same recording. The steady tone proves suppression wiring.
Its mute phase uses bypassed, audible audio.

Also run the speech fixture pass to detect lost speech and verify RNNoise mute
and unmute on audible processed output. Supply a local 1 to 5 second, mono,
48 kHz, little-endian float PCM file with finite samples within full scale:

```sh
VIDEORC_RNNOISE_TEST_PCM_PATH=/absolute/path/speech.f32le pnpm smoke:rnnoise
```

The debug native source normalizes this fixture to the requested peak and plays
it at the normal capture cadence. Missing, malformed, silent or oversized files
fail startup. The report records its path and SHA-256. Retention bounds reject
silent wet output, silent startup, lost attached-microphone audio and failed
unmute. These are signal-integrity checks, not intelligibility or listening
quality scores. Run both the tone and speech passes; speech energy alone cannot
prove noise suppression. The backend smoke blocks renderer processing updates
to prevent them repairing a broken startup setting. Normal UI toggle acceptance
is a separate check.

The wrapper checks real-model delay, partial final frames, reset, finite input,
headroom and noise suppression. The bus checks source positions, output retries,
transitions, mute and source lifecycle. UI tests cover stored defaults, pending
updates, acknowledgements and rollback. Final validation results and remaining
platform limits are recorded in
[the implementation acceptance record](acceptance/2026-10-04-rnnoise.md).

If noise reduction fails, the shared audio transport stops both microphone and system
audio. Videorc reports an error in session health and asks you to stop and restart
the session. It never substitutes untreated microphone audio while noise reduction is
On. Video may continue until you stop it. The error is retained if the
output process exits before the health sampler runs.
