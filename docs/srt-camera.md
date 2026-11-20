# SRT Camera

The SRT Camera turns an SRT stream from another app or device into a camera
(plan 255). It is a Beta on macOS.

## Set it up

1. Settings → General → **SRT input**: turn it on. The camera list in
   Sources gains **SRT Camera (port 9000)**.
2. In Sources → Video → Camera, pick **SRT Camera (port 9000)**. Its row
   shows the camera's settings.
3. Give the sender three things:
   - this computer's IP address (System Settings → Network, on the link the
     sender uses) and the row's **Port** (9000 by default);
   - the **Passphrase** (Copy). Videorc refuses a sender without it, and
     the stream is encrypted;
   - the latency, through **Connection**: Cable or this computer 0 ms, Wi-Fi
     120 ms, Internet 500 ms. SRT uses the larger of the two ends' values.
4. Use the camera in a scene, like any camera.

The sender is the SRT caller; Videorc is the listener. Videorc never starts,
stops or sets up a sender.

## What it does

- The port is open only while the setting is on and a scene in use holds
  the camera. It listens on every interface, so a sender on a USB network
  link works too. The passphrase is the guard.
- Until frames arrive the camera shows "Waiting for SRT stream on port N".
- The sender picks the size and frame rate. Videorc fits the picture to the
  canvas; a 25 fps stream on a 30 or 60 fps canvas repeats frames.
- When the sender's frame rate is the canvas rate or twice it (30 or 60 fps
  on a 30 fps canvas), the canvas follows the sender: a new frame starts
  the next canvas frame at once instead of waiting for the canvas's own
  timer. At the canvas rate that is each frame; at twice it, every second
  frame. At any other rate (24, 25 or 50 fps on 30) the canvas keeps its own
  timer.
- If the stream stops, the last frame holds for 2 s, then the still comes
  back. The picture returns by itself when frames arrive again.
- One sender at a time. A second sender from another address is refused
  while the first sends; a sender that connects and leaves without sending
  anything frees the camera at once, and one that has sent nothing for 2 s
  gives way to the next.
- It heals by itself. A sender that drops and redials from the same address
  gets in at once, even before Videorc has noticed the old connection died.
  If the port can't open, Videorc tries again every 2 s at most while the
  camera is in use, and says so in the camera's state. A decoder error or a
  change of size or rate mid-stream restarts decoding at the next key frame.
  The recording or livestream keeps running throughout.
- It decodes H.264 and HEVC (Main 10 included) with VideoToolbox. Any other
  codec shows "This SRT stream uses a codec Videorc can't show".
- Sources → Camera shows its state: "Waiting", "Receiving · 3840 × 2160 ·
  25 fps · HEVC", "Sender refused: wrong passphrase", "Second sender
  refused". A refusal shows only while no feed arrives: a sender that keeps
  dialling as a pairing check never hides a stream that is coming in.
- When something blocks the camera, the state says what: "Can't open the
  port. Trying again.", "The SRT library didn't load. Trying again.", "The
  passphrase didn't load. Turn SRT input off and on in Settings → General
  to try again.", "The SRT listener stopped. Trying again.",
  "Receiving, but no picture yet" and "Receiving, but the picture doesn't
  decode".
- Go Live asks first when the SRT Camera is in the scene with no signal.
  Recording does not ask.

## What a sender can expect

Videorc is the SRT listener. Any caller that follows these rules works:

- **Mode:** SRT 1.3 or newer (the v5 handshake; SRT disconnects an older
  caller, which can't read a reject reason), live mode, MPEG-TS
  carrying H.264 or HEVC. The passphrase is required; a caller without one,
  or with the wrong one, is refused by SRT itself with reject reason
  `SRT_REJ_BADSECRET` (10), or `SRT_REJ_UNSECURE` (11) without one.
- **Busy:** while the sender at another address is live (it connected or
  sent data in the last 2 s), a caller is refused with reject reason
  `SRT_REJX_OVERLOAD` (1402). When two callers connect at once, the first
  one through wins and Videorc closes the other. A refused caller can retry:
  the camera frees 2 s after its sender goes quiet, or at once when that
  sender closes.
- **Redial:** after a drop, call again from the same address. A call with
  the right passphrase replaces the old connection at once, even if Videorc
  has not yet seen the old one die. A call with the wrong passphrase changes
  nothing.
- **Pictures:** each PES packet carries one whole picture, as most senders do.
  A sender that splits a picture across PES packets is not supported.
- **Latency:** Videorc asks for the receive latency of its Connection setting
  (0, 120 or 500 ms). SRT uses the larger of the two ends' values.
- **Port:** the camera listens only while a scene uses it (D16). Keep
  redialing; the call goes through once the camera is in use again.

## Sound and lip sync

The SRT Camera is video only: Videorc drops the stream's audio. A follow-up
can take the audio for senders that need it.

The camera arrives late. Set the microphone sync offset in the audio mixer to
match.

## For developers

- Backend: `crates/videorc-backend/src/srt_camera/`. Everything is shared
  code except `apple_decode.rs`, the one place that turns an access unit
  into a frame in the camera frame store (D9).
- libsrt 1.5.7 (MPL-2.0) is loaded at run time. `pnpm libsrt:build:macos`
  stages it at `vendor/libsrt/current/`, with OpenSSL linked statically;
  the packaged app ships it in `Contents/Resources/libsrt/` and main names
  it in `VIDEORC_BUNDLED_LIBSRT_PATH`. A dev backend also tries Homebrew's
  copy (`brew install srt`).
- `pnpm smoke:srt-camera` proves it end to end with FFmpeg-made streams and a
  small test sender (`scripts/fixtures/srt-test-sender.c`, built with `cc` on
  the libsrt Videorc ships), on a random free port. It checks the feed
  arrives clean before it trusts anything else.

### Latency work (development builds only)

A release build (`cargo build --release`) leaves this code out entirely; only
development builds read the variables.

- `VIDEORC_SRT_FRAME_TAP=<dir>`: for every decoded frame, a line in
  `<dir>/frames.csv`: `decoded_ms,pts,width,height,sender_session,arrived_ms`.
  `decoded_ms` is the wall clock (`SystemTime`, ms with three decimals) when
  the decode returned the frame; `pts` is the frame's own PTS (90 kHz);
  `arrived_ms` is when the access unit whose decode returned it finished
  arriving. Buffered, flushed each second, appended across runs.
- Every Nth frame (`VIDEORC_SRT_FRAME_TAP_EVERY`, default 3), a grayscale
  sample `<dir>/<decoded_ms>.pgm` (binary PGM), named by the same text as its
  CSV line. `VIDEORC_SRT_FRAME_TAP_CROP=x,y,w,h` (0 to 1, the whole frame by
  default) picks the region; it is read every Nth pixel so it is at most
  `VIDEORC_SRT_FRAME_TAP_WIDTH` (default 640) wide. The files are written on a
  thread of their own; when it falls behind, lines and samples are dropped
  (and logged), never waited for.
- The receive latency is the Connection setting (0, 120 or 500 ms). Both
  ends offer one, and SRT uses the larger; the backend log says the value
  each time the listener starts (`[srt-camera] receive latency N ms`).

### Log lines

The backend log names each sender by libsrt's socket number, N. A soak or a
support read can rely on these lines; their format stays as written here.

- `[srt-camera] sender N accepted`: libsrt let the sender in.
- `[srt-camera] sender N first frame after T ms`: once per sender, the time
  from that accept to its first decoded frame handed to the camera's output,
  decoding included. T is whole milliseconds.
  Most of it is the wait for the sender's next key frame: a sender that
  keeps encoding through a reconnect sends none on connect. A sender that leaves
  before a frame (a pairing check) logs no such line, and no line is ever
  logged per frame.
- `[srt-camera] sender N replaced by M`: a redial or a new sender took over.
- `[srt-camera] sender N refused: the camera is busy`: another address
  reached `accept` while the camera was taken (refused, or closed).
- `[srt-camera] sender N left: …` and `[srt-camera] sender N released: …`:
  the sender went away, or its socket broke.
- `[srt-camera] sender N left before it was set up: …`: libsrt let the
  sender in, but it closed before Videorc could set its options.
