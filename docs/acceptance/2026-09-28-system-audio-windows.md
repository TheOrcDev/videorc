# System audio on Windows (plan 069 S8), 2026-09-28

Scope: slice S8 of `plans/069-system-audio-on-off.md`, the Windows PR
(`feat/069-windows-system-audio`). S8a added the WASAPI process-loopback
producer (`crates/videorc-backend/src/system_audio_capture_windows.rs`); S8b
wires it into sessions. Everything below was built and cross-checked from macOS
(`cargo xwin`); **nothing here has run on Windows yet**. This file is the
on-box checklist that makes S8 done.

## What S8b changed

- `devices.rs`: `WINDOWS_SYSTEM_AUDIO_SESSIONS_WIRED = true`. The System audio
  row is Available on build 20348 and later (every Windows 11) and hidden
  before. `windows_system_audio_supported()` caches the build probe, and
  sessions use the same answer, so the row shows exactly where a session can
  mix system audio. Setting the constant back to `false` withdraws the whole
  feature on Windows (row hidden, switch ignored by sessions).
- `system_audio_session.rs`: `system_audio_capable()` is true on those Windows
  builds; `platform_opener()` opens `SystemAudioCapture` (WASAPI) through the
  same `SystemAudioOpen` seam macOS uses. Every Windows session whose audio
  goes through the session audio bus (capture-worker microphone, or paced
  silence when no microphone is selected) now runs the bus at the 150 ms
  system-audio playout delay with the decision 8 offset split, whether or not
  the switch is on, exactly as macOS has since S4.
- Microphone bypass: when the capture worker cannot open the microphone and
  the session falls back to the direct DirectShow input
  (`microphone-capture-worker-fallback`), or the bundle has no
  `ffmpeg-capture.exe`, FFmpeg opens the device itself and the bus is
  bypassed. Such a session gets no System audio switch. If System audio is On
  at start, or turned On during the session, the backend emits
  `system-audio-mic-fallback-bypass` (Warn, with the session id): "System
  audio is off for this session because the microphone is on a fallback
  input." The session stays microphone-only and `recording.status` reports
  `mixSources: ["microphone"]` for its track. The renderer shows the same
  sentence on the switch row (the Studio inputs row says "Off for this
  session").
- A System audio toggle on a bypassed session carries the unchanged mic
  values, so the FFmpeg-stdin live mic control sends FFmpeg nothing and the
  reply is `applied: true` (unit-tested).
- Renderer: "Open Settings" next to "System audio could not start." shows only
  on macOS, where the Screen Recording grant can fix it. Loopback needs no
  grant on Windows, so "Needs Screen Recording permission" and the Mac volume
  line never appear there.

## System audio sync offset (o_sys) on Windows

`SYSTEM_AUDIO_SYNC_OFFSET_MS` is 0 on both platforms. The macOS value comes
from the S0 measurement; **the Windows value is unmeasured**. The Windows box
must measure it (see step 5) and, if it differs from 0 by more than 15 ms,
report the number so a platform-specific constant can be added before the
Windows alpha ships this feature.

## On-box checklist (Windows 11 x64, PowerShell 7)

Record the machine, build number, output device and commit for every step.

1. **Build and unit gates.**

   ```powershell
   cargo fmt --check --all
   cargo clippy -p videorc-backend -- -D warnings -A dead_code -A unused_imports -A unused_variables -A unused_mut
   pnpm typecheck; pnpm lint; pnpm --filter @videorc/desktop test
   ```

2. **Live producer tests** (plays a 1 kHz tone through the default output):

   ```powershell
   $env:VIDEORC_SYSTEM_AUDIO_SPIKE=1
   cargo test -p videorc-backend system_audio_capture_windows_live -- --ignored --nocapture --test-threads=1
   ```

   Both `system_audio_capture_windows_live_tone` and
   `system_audio_capture_windows_live_excludes_the_root_tree` must pass.

3. **AGENTS.md Windows stability gates.** The session and producer tests spawn
   tasks and threads, so each affected filter runs 25 times and the full suite
   three times, from PowerShell 7:

   ```powershell
   foreach ($filter in 'system_audio', 'session_audio', 'recording::tests::system_audio_session_tests', 'devices', 'live_audio') {
     1..25 | ForEach-Object { cargo test -p videorc-backend $filter; if ($LASTEXITCODE) { throw "$filter run $_ failed" } }
   }
   1..3 | ForEach-Object { cargo test -p videorc-backend; if ($LASTEXITCODE) { throw "full suite run $_ failed" } }
   ```

4. **Tone smoke (Windows twin of `smoke:system-audio`).** S7's
   `scripts/smoke-system-audio-app.mjs` was not on the macOS branch when S8b
   was written, so the twin is manual until that script gains a `--windows`
   path:
   1. Start the packaged app (or `pnpm dev`), turn System audio On in the
      Studio mixer, and start a local recording.
   2. In a second PowerShell, play a known tone through the default output:

      ```powershell
      $player = New-Object System.Media.SoundPlayer 'C:\Windows\Media\Windows Notify System Generic.wav'
      $player.PlaySync()
      ```

      (Any WAV works; a generated 1 kHz sine makes the check objective.)

   3. Stop, open the file from the Library and confirm the tone is audible and
      the mic is still present. `ffprobe` must show one audio track.
   4. Repeat with System audio Off: the tone must be absent.
   5. Play something in Videorc itself (Library playback) with System audio
      On: it must not be recorded (own-app exclusion rooted at
      `VIDEORC_ELECTRON_MAIN_PID`). Check the backend log for
      `System audio capture started` with `pid_excluded = true`.

5. **o_sys measurement.** Record with System audio On while a clap or click
   plays through the speakers and appears on screen (or use
   `pnpm measure:av-sync --make-fixture` played in a browser window that is
   captured), then run `pnpm measure:av-sync <recording> --json`. Report the
   system-audio offset against video. Keep `SYSTEM_AUDIO_SYNC_OFFSET_MS = 0`
   unless it is off by more than 15 ms.

6. **Record-latency and live-audio gates.** Every bus session on Windows now
   runs at the 150 ms playout delay. Confirm nothing moved:

   ```powershell
   pnpm smoke:record-latency:gate
   node scripts/smoke-record-latency-app.mjs --enforce --system-audio
   pnpm smoke:windows-live-audio-controls
   ```

   If `smoke:record-latency` does not run on Windows, record that and time
   five Record starts by hand with System audio On and Off.

7. **Output-device change mid-session.** Start a recording with System audio
   On and music playing, then switch the default output (speakers to a USB or
   Bluetooth headset) in the Windows sound settings. Process loopback is not
   tied to an endpoint, so audio should keep flowing. If WASAPI reports
   `AUDCLNT_E_DEVICE_INVALIDATED` instead, the session must show
   `system-audio-lost` ("System audio stopped. The session keeps going."),
   keep recording the mic, and turning System audio off and on again must
   restore it. Write down which of the two happened.

8. **DirectShow fallback bypass.** Force the bypass by renaming
   `ffmpeg-capture.exe` next to the bundled `ffmpeg.exe` (or pick a
   microphone the worker cannot open), then:
   1. With System audio On, start a recording. Expect the
      `microphone-capture-worker-fallback` health event, then
      `system-audio-mic-fallback-bypass` with the sentence above, the row
      showing it, and a recording with mic audio only.
   2. Turn System audio Off and On during the session: one more bypass event
      on each On, and microphone gain and mute changes still apply (the FFmpeg
      live control).
   3. Restore `ffmpeg-capture.exe` and confirm a normal session mixes system
      audio again.

9. **Windows 10 (build below 20348), if a machine is available.** The System
   audio row is hidden, and a session started with the setting On (for
   example after an OBS import on another machine) shows no system-audio
   health event.

10. **OBS import.** Import a scene collection with Desktop Audio enabled: the
    report's Desktop audio line says "Turns System audio on." and the switch
    is On.

11. **Iris Xe tester acceptance.** On the Iris Xe tester machine, a 10 minute
    recording and a 10 minute stream with System audio On, a game or video
    playing, and the mic in use: no crackle, no drift against the picture, the
    tone from step 4 present, and CPU within the usual envelope. The tester
    signs off here.

## Results

| Step | Result  | Notes        |
| ---- | ------- | ------------ |
| 1    | pending |              |
| 2    | pending |              |
| 3    | pending |              |
| 4    | pending |              |
| 5    | pending | o_sys = ? ms |
| 6    | pending |              |
| 7    | pending |              |
| 8    | pending |              |
| 9    | pending |              |
| 10   | pending |              |
| 11   | pending |              |
