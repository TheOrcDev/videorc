# S0c: SRT in our FFmpeg (2026-10-18)

Plan 184, Phase 0, S0c. Throwaway: nothing here ships. The question is
whether the desktop can send its cloud feed over SRT (C1b) with the FFmpeg
we bundle, what that costs, and what SRT buys when the network drops.

Everything ran on one Mac. The dev app was not run. An FFmpeg CLI push
shaped like the desktop's stream leg stood in for it, and a reader with the
runner's decoder options stood in for the runner (Setup says how).

## Verdict

**Go for C1b, with four conditions.**

1. **The build is cheap and stays LGPL.** On macOS, libsrt 1.5.7 adds one
   configure flag, a 15-second static library build, 0.66 MB to `ffmpeg`
   and 0.68 MB to `ffprobe` (+2.5% each), and one system library
   (`/usr/lib/libc++.1.dylib`). FFmpeg's configure still says "LGPL version
   3 or later". The bundle needs two more license files.
2. **Windows and Linux already have libsrt, an old one.** The pinned BtbN
   LGPL builds (autobuild 2026-07-31) carry libsrt built from SRT master of
   2026-06-08 (it reports 1.5.5). That is before 1.5.6's KMREQ CVE fix and
   1.5.7's security release. No build change is needed there, only a re-pin
   to autobuild 2026-09-30, which carries 1.5.7, before C1b ships.
3. **The SRT stream id travels in the clear, even with a passphrase on.** The
   relay decoded it from every handshake. Today's ingest path,
   `live/<showId>-h.<ingestKey>`, would hand the ingest key to anyone on the
   same Wi-Fi, and that key also opens RTMPS. For SRT the passphrase is the
   secret; the stream id only names the feed.
4. **MediaMTX checks the passphrase per path, after the auth hook, and never
   shows it to the hook.** A passphrase per show means the node agent adds a
   MediaMTX path per feed through MediaMTX's API.

What SRT buys, measured here: a drop shorter than its latency window costs
nothing (2 s of blackhole at a 2 s latency lost no video in one run and 150 ms
in another; at the 120 ms default it lost 1.1 s); a drop under 5 s keeps the
connection, and a longer one reconnects through the desktop's fifo; the node sees
the feed ready 0.4 s after the publisher starts instead of RTMPS's 1.6 s; and
1% and 5% random loss lost no frames. What it costs: 3 points more upload than RTMPS
(+7.9% over the stream bitrate against +4.7%), and its latency setting is
added to the delay one for one (latency + 70 ms over RTMP).

## What was built (all in the spike's scratch directory)

| Piece | What it is |
| --- | --- |
| `build-ffmpeg-macos-srt.sh` | a copy of `scripts/build-ffmpeg-macos.sh` with the same flags, patch and checks, plus `WITH_SRT=1`: libsrt 1.5.7 built static against the same static OpenSSL, a hand-written `srt.pc`, `--enable-libsrt`, an `srt` protocol check and the SRT license file |
| `udp-relay.mjs` | a counting UDP relay for SRT: fixed delay each way, random loss, a blackhole that drops every datagram both ways, SRT packet classes (data, retransmission, ACK, NAK, handshake) and handshake decoding |
| `tcp-proxy.mjs` | the same for RTMP and RTMPS; a TCP proxy can only stall (stop reading both sides, hold new connections, deliver a close at restore) or cut (close everything, refuse new connections) |
| `run-case.mjs`, `run-dual.mjs`, `analyze.mjs` | MediaMTX with a logging auth hook, the relay or proxy, the publisher, a runner-shaped reader loop and an API poller; then the summary |
| `auth-tests.mjs` | eleven short publishes: stream id forms, passphrase on, off, wrong, missing, set through the API, and a hook that denies; three more runs checked the passphrase as a protocol option, AES-256, an RTMPS key in the query, and deleting a path under a live publisher |
| `drop-batch.sh`, `table.mjs` | the drop runs and their table |
| `proposed-build-ffmpeg-macos-srt.patch` | the change to `scripts/build-ffmpeg-macos.sh` that C1b can apply, tested end to end on a copy of the repo's layout |

## Setup

- Apple M4 (10 cores), 32 GB, macOS 26.5. Other agents were compiling Rust
  through most runs: load average 6 to 50 (over 100 for a while late on),
  one `rustc` at 570 to 760% CPU, 6 of 7 GB of swap in use. Byte counts
  don't care; timings jitter by tens of milliseconds, and the latency runs
  show a few transient half-second hiccups.
- From 22:29 on the Mac kept idle-sleeping between tool calls (its sleep
  timer is 1 minute), freezing every process for about 15 minutes at a time.
  Every run was checked for a gap in its 250 ms API poll. Five runs that a
  sleep cut through were thrown away and run again; two of the reruns were
  cut again, but only after their drop window, so their numbers stand. A
  time-limited `caffeinate` held the Mac awake for the last runs and was
  stopped afterwards.
- MediaMTX v1.21.2 (Homebrew) with the node's template
  (`videorc-cloud/dev/mediamtx.yml.tpl`), SRT turned on, and every port moved
  off the defaults onto 127.0.0.1: RTMP 21935, RTMPS 21936, RTSP 28554, SRT
  28890/udp, API 29997. The auth hook was a logging stand-in for the node
  agent's. `readTimeout` stayed at the template's 10 s.
- **The publisher (for the dev app):** the FFmpeg built here. H.264 1080p60
  at 6 Mbps from VideoToolbox with the app's encoder posture (`-realtime 1
  -bf 0 -g 120 -profile:v high`), AAC 160 kbps. Overhead and drop runs sent a
  75 s clip encoded once that way, `-re`, video copied, because the desktop's
  leg also copies H.264 from its bridge's MPEG-TS FIFO; drop runs encoded the
  audio in the leg, as the desktop does. The output is the desktop's leg:
  `-f fifo -fifo_format mpegts|flv -queue_size 512 -drop_pkts_on_overflow 1
  -attempt_recovery 1 -recover_any_error 1 -restart_with_keyframe 1
  -recovery_wait_time 2` (`fifo_flv_output_args`), RTMPS with C1c's
  `tls_verify=1` and a CA file. "Bare" means the plain output, no fifo. SRT
  went as `srt://…?streamid=publish:<path>&latency=<µs>&pkt_size=1316`.
- **The network:** the relay or proxy in front of MediaMTX added 20 ms each
  way (40 ms RTT, a home in the EU to a Hetzner box). A "Wi-Fi drop" is a
  blackhole: the UDP relay drops everything both ways; the TCP proxy stalls,
  which is kinder to TCP than a real drop (below).
- **The reader (for the runner):** FFmpeg reading the path over RTSP/TCP from
  MediaMTX with the runner's decoder options (`-timeout 5000000 -fflags
  nobuffer -flags low_delay`), retrying every 250 ms, logging each packet's
  arrival, pts and checksum. MediaMTX serves an SRT-fed path over RTSP with
  the same tracks as an RTMPS-fed one (H264, MPEG-4 Audio), so the runner
  itself needs no change and was not run.

## 1. The macOS build

### Configure changes

One flag, plus the library it finds:

```
CONFIGURE_FLAGS+=( "--enable-libsrt" )
export PKG_CONFIG_PATH="<build>/srt-pkgconfig${PKG_CONFIG_PATH:+:$PKG_CONFIG_PATH}"
```

Everything else is unchanged (`--disable-gpl --disable-nonfree
--enable-version3 --enable-openssl`, the static OpenSSL directory, the
Homebrew pins, the AVFoundation clock patch). Configure's external
libraries go from `appkit avfoundation bzlib coreimage iconv openssl zlib`
to the same plus `libsrt`.

FFmpeg's configure links its libsrt test from `pkg-config --libs srt` alone.
libsrt's own `srt.pc` lists its C++ runtime under `Libs.private` and its
crypto as `Requires.private: openssl libcrypto`, which would pull in
Homebrew's `openssl.pc` and its dylibs. So the script writes its own:

```
Libs: -L${libdir} -lsrt -L<build>/openssl-static -lcrypto -lc++
Cflags: -I${includedir} -I${includedir}/srt
```

### libsrt build

From the release tarball (SHA-256 below), in the build directory, before
FFmpeg's configure:

```
cmake -S srt-1.5.7 -B srt-build -DCMAKE_BUILD_TYPE=Release \
  -DCMAKE_INSTALL_PREFIX=<build>/srt-prefix -DCMAKE_INSTALL_LIBDIR=lib \
  -DCMAKE_OSX_ARCHITECTURES=arm64 \
  -DENABLE_SHARED=OFF -DENABLE_STATIC=ON -DENABLE_APPS=OFF \
  -DENABLE_BONDING=OFF -DENABLE_UNITTESTS=OFF -DENABLE_STDCXX_SYNC=ON \
  -DENABLE_ENCRYPTION=ON -DUSE_ENCLIB=openssl-evp -DUSE_OPENSSL_PC=OFF \
  -DOPENSSL_INCLUDE_DIR=$(brew --prefix openssl@3)/include \
  -DOPENSSL_CRYPTO_LIBRARY=<build>/openssl-static/libcrypto.a \
  -DOPENSSL_SSL_LIBRARY=<build>/openssl-static/libssl.a
cmake --build srt-build -j N && cmake --install srt-build
```

- Source: `https://github.com/Haivision/srt/archive/refs/tags/v1.5.7.tar.gz`,
  SHA-256 `017cd1e437ef2073a4dd10ddf7b55e86bc3d6ebac0393d13bd22f6a57055d32b`.
- Static only, so no dylib sits next to the archive for the linker to
  prefer. Encryption through OpenSSL's EVP API, found as the staged static
  archives, never through `openssl.pc`.
- `ENABLE_STDCXX_SYNC=ON`: macOS has no `pthread_condattr_setclock`, so the
  pthreads build waits on the wall clock (CMake warns, and SRT's docs say the
  library "can get stuck" that way). The C++11 build uses the steady clock.
  It is 12 KB smaller, too.
- Bonding off: MediaMTX takes no bonded groups.
- This Mac's `cmake` is 3.15.5 for x86_64 (it runs under Rosetta), so the
  architecture has to be named; `lipo` confirms `libsrt.a` is arm64. Nothing
  was installed for this spike.
- Time: 11 to 15 s for libsrt, 86 to 147 s for FFmpeg with 5 to 8 jobs under
  the load above.

### Checks the script should add (fail closed, like the OpenSSL ones)

- the configuration line has `--enable-libsrt`;
- `ffmpeg -protocols` lists `srt` under Output;
- `otool -L` still shows no Homebrew path (it now lists `/usr/lib/libc++.1.dylib`,
  a system library on every Mac);
- `scripts/preflight-macos-package.mjs` probes `srt` next to rtmp, rtmps and
  tls.

The capture clock check (`scripts/ffmpeg-capture-clock.mjs`) passes on both
builds; `minos` stays 26.0 as today.

### Size

Both built here from the same source, flags and toolchain; only `--enable-libsrt`
differs. The installed binaries are already stripped.

| file | today's flags | with libsrt | delta |
| --- | ---: | ---: | ---: |
| `bin/ffmpeg` | 26,786,632 | 27,447,800 | +661,168 (+2.47%) |
| `bin/ffprobe` | 26,595,160 | 27,272,824 | +677,664 (+2.55%) |
| `bin/ffmpeg`, gzip -9 | 12,799,876 | 13,110,798 | +310,922 |
| `bin/ffprobe`, gzip -9 | 12,707,868 | 13,014,438 | +306,570 |

The bundle grows by 1.34 MB, about 0.6 MB compressed. `ffprobe` grows too
because it links libavformat statically; it never opens `srt://`, and the
growth is the price of one shared build. (`libsrt.a` itself is 1.3 MB.)

### License check

- **FFmpeg's view.** libsrt is in configure's plain external library list,
  not in the GPL, nonfree or version 3 lists. With it, configure prints
  "License: LGPL version 3 or later", as today, and the script's GPL and
  nonfree gate passes.
- **What libsrt is.** Haivision's files (all of `srtcore/` and `haicrypt/`)
  are MPL-2.0. Fifteen of the compiled `srtcore` files also carry the
  original UDT notice, BSD-3-Clause, "Copyright (c) 2001 - 2011, The Board of
  Trustees of the University of Illinois". `md5.cpp` is under Aladdin
  Enterprises' zlib-style license.
- **MPL-2.0 with LGPL v3.** MPL-2.0 §3.3 lets an MPL file go into a larger
  work under a "Secondary License" (GPL 2.0, LGPL 2.1 or AGPL 3.0, or any
  later version) unless the file carries the "Incompatible With Secondary
  Licenses" notice.
  No libsrt file does (only the license text mentions the notice). MPL is
  per file: libsrt's files stay MPL, FFmpeg's stay LGPL v3.
- **MPL-2.0 with Apache-2.0 (OpenSSL 3).** No conflict: MPL's copyleft stops
  at libsrt's own files, and both are compatible with (L)GPL v3, which is
  why the bundle is v3 in the first place.
- **What the bundle must add.**
  1. `licenses/SRT-LICENSE-MPL-2.0.txt`: `srt-1.5.7/LICENSE`.
  2. `licenses/SRT-UDT-BSD-3-Clause.txt`: the University of Illinois notice
     from the head of `srtcore/core.cpp`. BSD-3-Clause asks for it in the
     documentation of a binary.
  3. `SOURCE.txt`: the libsrt tarball URL and SHA-256. MPL §3.2(a) asks us to
     say where the source is; put the tarball beside the public downloads,
     where `SOURCE.txt` already says FFmpeg's source goes.
  4. `NOTICE.txt`: one paragraph, "This bundle statically links libsrt
     (https://github.com/Haivision/srt), licensed under the Mozilla Public
     License 2.0, with portions under the BSD 3-Clause license."
  `md5.cpp`'s license asks nothing of binaries.
- **Not new, found on the way.** Today's macOS bundle ships no OpenSSL
  license text, which Apache-2.0 §4(a) asks for. The Windows and Linux
  bundles ship only BtbN's `LICENSE.txt`, which is FFmpeg's LGPL v3 text
  byte for byte, though those builds statically link about 60 libraries,
  libsrt (MPL-2.0) and libzmq (MPL-2.0) among them. Worth a separate fix.

## 2. SRT into MediaMTX

### Stream id, passphrase and the auth hook

What MediaMTX v1.21.2 posts to its auth hook for an SRT publish (read in
`internal/servers/srt/conn.go` and `internal/auth/manager.go`, then seen in
the hook's log):

```json
{ "ip": "127.0.0.1", "user": "", "password": "", "token": "", "action": "publish",
  "path": "live/sh_…-h", "protocol": "srt", "id": "<uuid>", "query": "", "userAgent": "" }
```

An RTMPS publish posts `"protocol": "rtmp"` and a `userAgent` of `FMLE/3.0
(compatible; Lavf62.12.101)`. The stream id forms MediaMTX takes, as the hook
saw them:

| stream id | hook `path` | `user` / `password` | `query` |
| --- | --- | --- | --- |
| `publish:live/sh_…-h` | `live/sh_…-h` | empty | empty |
| `publish:live/sh_…-h:<user>:<pass>` | `live/sh_…-h` | user, pass | empty |
| `publish:live/sh_…-h:key=…&v=1` | `live/sh_…-h` | empty | `key=…&v=1` |
| `#!::r=live/sh_…-h,m=publish,u=<user>,s=<pass>` | `live/sh_…-h` | user, pass | empty |
| `publish:live/sh_…-h.<ingestKey>` (today's path) | the whole path, key included | empty | empty |

The last form works, but MediaMTX then logs the key twice per publish
("is publishing to path 'live/…-h.<key>'"), as it does for RTMPS today.

The passphrase, in order of what happens to a connection:

1. MediaMTX parses the stream id and calls the hook first. The hook never
   sees the passphrase.
2. If the hook allows, MediaMTX takes the path's `srtPublishPassphrase` from
   its config and checks the caller's key exchange against it.
3. Then it accepts.

| case | result |
| --- | --- |
| path passphrase set, caller's matches | publishing; AES-128 (or what `pbkeylen` asks) |
| path passphrase set, caller's wrong | hook called and allowed, then "closed: invalid passphrase" |
| path passphrase set, caller has none | hook allowed, then "closed: passphrase not provided by client" |
| no path passphrase, caller has one | refused: "passphrase is missing" (rejection code 1010, bad secret) |
| path added at runtime with `POST /v3/config/paths/add/<path>` `{"srtPublishPassphrase": "…"}` | 200, and publishing with that passphrase works |
| hook answers 401 | "failed to authenticate: server replied with code 401" |

Every refusal reaches FFmpeg as the same "Input/output error"; MediaMTX
rejects with the peer code, and FFmpeg's libsrt doesn't print the reason. A
wrong passphrase failed in 1.1 s; a denying hook took 4.1 s, because
MediaMTX waits a random 0 to 4 s before answering an auth failure.

On the wire (decoded by the relay from every handshake): the stream id
travels in the conclusion handshake both ways in plain text, stored as
byte-swapped 32-bit words, so a plain `grep` misses it but any SRT parser
reads it. That stays true with a passphrase on; the key exchange (extension
3) travels next to it. The passphrase itself never appeared on the wire, in
MediaMTX's log or in the hook's body.

**FFmpeg prints the whole SRT URL.** With the passphrase in the query,
`Output #0, mpegts, to 'srt://…&passphrase=…'` appears at info level on
every start, and every failed connect prints `Connection to srt://…&passphrase=…
failed`. The desktop's `redact_stream_urls` masks only `rtmp://` and
`rtmps://`. Passing the passphrase as a protocol option instead keeps it out
of every line, and works: `-format_opts passphrase=…:pbkeylen=16` on the
fifo, or `-passphrase … -pbkeylen 16` before a plain output. It still sits in
FFmpeg's argument list, like an RTMPS stream key today.

### Upload overhead

How: the relay and the proxy count every datagram and every byte, each way,
per second. A steady 30 s window (10 to 40 s after start) of the same
copied clip. The stream bitrate is the clip's: 6.008 Mbps of H.264 and 0.160
Mbps of AAC, 6.168 Mbps. For UDP the wire figure adds 28 bytes of IPv4 and
UDP header per datagram, counted. For TCP the proxy sees only the byte
stream, so the wire figure is a model: 1448-byte segments with 52 bytes of
IPv4 and TCP (timestamps) header each, and one 52-byte ACK back per two
segments. `nettop` wasn't needed: the relay and the proxy see every datagram
and byte of the one flow.

| feed, 1080p60 | upload on the wire | over the stream | download | packets up |
| --- | ---: | ---: | ---: | ---: |
| **SRT**, MPEG-TS, 1316-byte payloads | **6.656 Mbps** | **+7.9%** | 14 kbps (24 ACKs/s) | 664/s |
| SRT with an AES-128 passphrase | 6.649 Mbps | +7.8% | 14 kbps | 664/s |
| **RTMPS** (FLV, TLS 1.3) | **6.460 Mbps** (model) | **+4.7%** | 112 kbps (model) | 539/s |
| RTMP (FLV) | 6.421 Mbps (model) | +4.1% | 112 kbps (model) | 536/s |

Where SRT's 7.9% goes:

| layer | SRT | RTMPS |
| --- | ---: | ---: |
| container | MPEG-TS +4.1% (6.421 Mbps) | FLV and RTMP chunks +0.5% (6.198) |
| transport framing | SRT header and ACKACKs +1.4% | TLS records +0.6% (6.236) |
| IP | UDP/IPv4 +2.4% | TCP/IPv4 +3.6% |

- Both directions together: SRT +8.1%, RTMPS +6.6%. SRT's ACKs from
  MediaMTX are few (24 a second); TCP acknowledges every other segment.
- At 6 Mbps the difference on the upload is about 0.2 Mbps.
- AES costs no bytes: SRT encrypts in counter mode, with no padding.
- MPEG-TS is the price: 4 bytes in every 188, PES headers and padding at the
  end of every frame, PAT and PMT. `pkt_size=1316` (seven TS packets) is the
  largest that fits SRT's 1456-byte payload.

**Under random loss** (the relay drops each datagram with this probability,
both ways; 40 ms RTT; RTMPS can't be tested this way, because a proxy above
TCP can't drop TCP segments):

| SRT latency | loss each way | retransmitted | NAKs back | video lost at the reader |
| --- | ---: | ---: | ---: | ---: |
| 120 ms | 1% | 72 kbps (+1.1%) | 13/s | none |
| 1000 ms | 1% | 77 kbps (+1.2%) | 13/s | none |
| 1000 ms | 5% | 394 kbps (+6.4%) | 47/s | none |

MediaMTX counted no frame in error in any of them.

### First frame and latency

From the publisher's start, same machine and clip:

| feed | handshake answered | MediaMTX path ready | reader's first frame |
| --- | ---: | ---: | ---: |
| SRT, latency 120 ms | 0.14 s | **0.36 s** | 1.83 s |
| SRT, AES-128 | 0.18 s | 0.42 s | 1.99 s |
| SRT, latency 1000 ms (the 1% loss run) | 0.15 s | 1.26 s | 2.72 s |
| RTMPS | (TCP open 0.05 s) | **1.61 s** | 3.65 s |
| RTMP | (TCP open 0.04 s) | 1.60 s | 3.65 s |

- SRT's handshake is two round trips. MediaMTX then reads the MPEG-TS
  tables and the first frames, which wait out the latency window.
- RTMP(S) waits for MediaMTX's RTMP reader, which analyses 2 s of media
  before it calls the path ready (`analyzePeriod = 2 * time.Second` in
  gortmplib v1.0.4; FFmpeg's `-re` sends the first 0.5 s at once, hence
  1.6 s). That is MediaMTX, not RTMP, but it is what our node does, on every
  connect and every reconnect.
- The reader's first frame waits for a keyframe (every 2 s), so it moves in
  2 s steps; here SRT got the earlier one.

What the latency setting costs. One encoder and one tee: an MPEG-TS leg over
SRT through the relay and an FLV leg over RTMP through the proxy, the same
20 ms each way, into two paths; two readers; the same frames matched by
checksum (1,395 to 1,568 per run, 30 s each):

| SRT `latency` | SRT arrives later than RTMP, median (10th to 90th percentile) |
| ---: | ---: |
| 120 ms (SRT's default) | 190 ms (170 to 210) |
| 500 ms | 570 ms (549 to 589) |
| 1000 ms | 1067 ms (1048 to 1085) |
| 2000 ms | 2071 ms (2051 to 2092) |
| 3000 ms | 3071 ms (3055 to 3091) |

- SRT adds its latency, plus a constant 70 ms that doesn't depend on it.
- The receiver uses the larger of the two sides' values, and MediaMTX's own
  is 120 ms (gosrt's default; MediaMTX doesn't set it), so the desktop's
  `latency` decides. MediaMTX's API reports it as `msReceiveTsbPdDelay`.
- FFmpeg's `latency` is in microseconds.

## 3. Reconnect after a Wi-Fi drop

How: the drop starts 15 s into a run. For SRT the relay drops every datagram
both ways; for RTMPS the proxy stalls (Setup), and one run cuts instead, the
way `smoke:cloud-solo` pulls the network. The publisher is the desktop's
fifo leg unless the row says "bare", with the audio encoded in the leg.
After the restore:

- **next attempt**: the first new SRT socket or TCP connection;
- **path ready**: MediaMTX logs "is publishing" again;
- **reader flowing**: the first frame of a steady run at the runner-shaped
  reader. The runner's own 1 s steady window (S0a) comes on top.

| feed | drop | the connection | video lost | next attempt | path ready | reader flowing |
| --- | --- | --- | ---: | ---: | ---: | ---: |
| SRT, latency 120 ms | 2 s | kept | 1.13 s (1.17 s in a 2nd run) | – | – | 0.14 s |
| SRT, latency 120 ms | 4 s | kept | 3.03 s | – | – | 0.15 s |
| SRT, latency 120 ms | 6 s | broke at 5 s; the new one replaced the stale session at restore + 1 s | new session | 0.16 s | 1.00 s | 2.92 s |
| SRT, latency 120 ms | 10 s | broke at 5 s; MediaMTX dropped it at 10 s; 1 failed attempt | new session | 2.24 s (2.25 s) | 3.02 s (3.01 s) | 4.93 s (4.92 s) |
| SRT, latency 120 ms | 30 s | the same; 4 failed attempts | new session | 0.34 s | 0.95 s | 2.87 s |
| SRT, latency 2000 ms | 2 s | kept | 0 (150 ms in a 2nd run) | – | – | no gap |
| SRT, latency 2000 ms | 10 s | broke at 5 s | new session | 2.21 s | 4.89 s | 6.74 s |
| SRT, `connect_timeout=1500`, `recovery_wait_time 1` | 30 s | broke at 5 s; 7 failed attempts | new session | 1.05 s | 1.35 s | 2.86 s |
| SRT bare | 2 s | kept | 1.08 s | – | – | 0.11 s |
| SRT bare | 10 s | **FFmpeg exited** 6.2 s into the drop | – | – | – | – |
| RTMPS | 2 s stall | kept | none | – | – | 0.05 s |
| RTMPS | 10 s stall | MediaMTX dropped it at 10 s (i/o timeout); the desktop saw "Broken pipe" at restore | new session | 0.64 s (0.62 s) | 2.70 s (0.86 s) | 4.66 s (2.68 s) |
| RTMPS | 30 s stall | the same | new session | 0.63 s | 0.87 s | 2.67 s |
| RTMPS bare | 10 s stall | FFmpeg **blocked** in its write for the whole stall, exited at restore | – | – | – | – |
| RTMPS, cut | 10 s | gone at once; the fifo retried every 2 s, refused | new session | 0.02 s | 0.27 s | 2.76 s |

Numbers in brackets are a second run of the same case.

**What the times are made of.**

- **SRT keeps its connection until libsrt's peer-idle timeout: 5 s** of
  silence from MediaMTX. FFmpeg has no option to change it
  (`SRTO_PEERIDLETIMEO` isn't among libsrt's FFmpeg options). Under 5 s
  nothing restarts: the fifo never notices, MediaMTX keeps the publisher,
  the reader keeps its session.
- **SRT recovers what it still holds.** Inside a kept connection the lost
  video was 1.1 s of 2 s and 3.0 s of 4 s at the 120 ms default; at 2000 ms a
  2 s drop lost nothing in one run and 150 ms in the other. Roughly: lossless
  while the drop is shorter than the latency minus a few round trips. MediaMTX
  counted no frame in error; the loss shows as a pts gap.
- **The break is silent.** libsrt writes no line when the link dies. In the
  6 s case the only line in FFmpeg's log was `[fifo] Recovery successful`;
  otherwise the first line came 9.2 s into the drop (7.7 s with the shorter
  timeout), from the first failed reconnect.
- **The fifo's retry cycle.** The first attempt comes 1.05 s after the break.
  Each failed attempt then takes `connect_timeout` (3 s by default) + about
  1 s + `recovery_wait_time` (2 s): **6.05 s**, measured over four cycles.
  With `connect_timeout=1500` and `recovery_wait_time 1`, **3.55 s** (seven
  cycles). After the network returns, the next attempt comes within one
  cycle; where in the cycle depends on how long the drop was, which is why
  the 10 s and 30 s rows differ.
- **Then MediaMTX and a keyframe.** An SRT path is ready about 0.6 s plus
  the latency after the connect. The reader then waits for the next keyframe
  (the fifo restarts on one, but the reader joins after it), up to the 2 s
  GOP.
- **MediaMTX keeps a silent publisher for `readTimeout`, 10 s, for both
  protocols.** With `overridePublisher` on (its default), a publisher that
  comes back sooner replaces the stale one: the 6 s row.
- **RTMPS.** TCP holds the bytes, so a stall under 10 s loses nothing here
  (a real drop adds TCP's backoff, see "Not measured"). The fifo's queue (512
  packets, about 4.8 s at 1080p60 with audio) fills 5.6 s into the stall
  ("FIFO queue full"); later packets are dropped. Past 10 s MediaMTX closes
  the connection, and the desktop hears it only when the network returns. The
  reconnect (TCP, TLS, RTMP) takes 0.6 s, then MediaMTX's 2 s RTMP analysis
  is met at once or up to 2 s later, depending on how much backlog the fifo
  sends first.
- **Bare outputs.** FFmpeg's SRT output dies with the peer-idle timeout
  ("Error submitting a packet to the muxer: Input/output error", exit 251).
  A bare RTMPS output blocks in its write (no `rw_timeout`) until the network
  returns. Both need the fifo, which the desktop already uses.

**What each protocol needs from the desktop's restart logic.**

- **SRT:** nothing for drops under 5 s. Beyond that, the fifo's
  `recover_any_error`, as today; shorten its cycle to 3.55 s with
  `connect_timeout=1500` and `recovery_wait_time 1`. Leg health can't wait
  for libsrt's log: read the fifo's lines, and better, the runner's
  `state.feeds[].connected`.
- **RTMPS:** the fifo as today. It is fine that a stalled leg errors only
  when the network returns: that is when the server's close arrives.
- **The "3 s fallback" can't live in the restart logic.** During a drop SRT
  can't connect within 3 s either, and switching protocol then would flap.
  Decide once, at Go Live (section 5).

**Found on the way: never copy ADTS audio into a fifo-wrapped FLV leg.** The
first RTMPS drop runs copied the clip's AAC. After the first reconnect FFmpeg
reused the FLV muxer's automatic `aac_adtstoasc` filter after its end of
stream ("A non-NULL packet sent after an EOF"), and the leg reconnected every
2 s for the rest of the run, never delivering a frame. The desktop encodes the
leg's audio, so it isn't hit; keep it that way. Those runs were thrown away
and run again with the audio encoded.

## 4. Windows and Linux

Both use BtbN's LGPL builds, pinned in `vendor/ffmpeg/windows-pin.json` and
`linux-pin.json` (autobuild 2026-07-31-14-10, FFmpeg n8.1.2-34). Both archives
were downloaded here and matched their pins' SHA-256.

- **libsrt is already in both.** Each binary's configuration line has
  `--enable-libsrt`. BtbN builds it in every variant
  (`scripts.d/50-srt.sh`: static, `ENABLE_ENCRYPTION=ON`, from SRT's git
  master), with OpenSSL 3.6.3's libcrypto inside both binaries; Windows uses
  Schannel for TLS (`--enable-schannel`) and Linux OpenSSL (`--enable-openssl`),
  which C1c already relies on.
- **It is an old libsrt.** The July build took SRT master at `c39196c9a5`
  (2026-06-08) and reports version 1.5.5. v1.5.7 is that commit plus six:
  "[core] Fix kmreq CVE (#3345)" (tagged v1.5.6), "Added checks to prevent
  rogue CMD MSG to sneak thru (#3323)" and "Security improvements and
  enhancements (#3359)", which the 1.5.7 release notes describe as fixes for
  KMREQ length checks, an encryption downgrade, forged ACKs and malformed
  DROPREQ ranges.
- **The fix is a re-pin.** BtbN moved SRT to `ff8ab25c57` (1.5.7 plus eight
  commits) on 2026-09-23. The month-end build after that,
  `autobuild-2026-09-30-13-08` (FFmpeg n8.1.3-9), reports libsrt 1.5.7 and
  OpenSSL 3.6.4 in its Windows binary (checked; its `win64-lgpl-8.1.zip` has
  SHA-256 `4a7642b2264c03e8a0ce8a3825b933ee5580656f45695a086fe7e294045ffc0a`).
  Its Linux asset comes from the same scripts; read its configuration before
  pinning. Month-end builds are the ones BtbN keeps
  (`scripts/lib/ffmpeg-windows-pin.mjs`). The Windows `ffmpeg.exe` grows from
  113.5 MB to 134.1 MB between the two builds, none of it SRT.
- **What else changes.**
  - `scripts/lib/ffmpeg-linux-pin.mjs`: add `--enable-libsrt` to
    `REQUIRED_LINUX_FFMPEG_CONFIGURATION`, and `srt` to the capability check.
  - `scripts/fetch-ffmpeg-windows.mjs`: the same check on the Windows
    runner, where the binary can run.
  - Both bundles: ship the MPL-2.0 text and the UDT notice next to
    `LICENSE.txt`, and name the SRT commit in `SOURCE.txt` (BtbN's tag gives
    it, through `scripts.d/50-srt.sh` at that date).
  - The Windows capture worker (`ffmpeg-capture.exe`) is built with
    `--disable-network`, so nothing changes there.
- **The node** needs no SRT in its FFmpeg: MediaMTX terminates SRT itself
  (gosrt v0.12.0, pure Go) and the runner reads RTSP.

## 5. What C1b should build

### The shape of an SRT feed

- **One MediaMTX path per feed for both protocols: `live/<showId>-<h|v>`,
  with no key in the name.** SRT names it in the stream id,
  `publish:live/<showId>-h`, which is public. RTMPS carries the ingest key
  in the stream name's query, `live/<showId>-h?key=<ingestKey>`, inside TLS.
  Checked: the hook gets `path: live/sh_…-h` and `query: key=…`, MediaMTX's
  log shows the path without the key, and a reader of `live/sh_…-h` gets the
  feed. The runner reads `live/<showId>-<h|v>` whatever the ingest,
  and a switch from one protocol to the other is one publisher replacing
  another (`overridePublisher`, on by default).
- **The passphrase is the SRT secret.** 32 random base62 characters per feed
  (SRT takes 10 to 79). A passive observer of one handshake gets the stream
  id and the wrapped key, and can test passphrase guesses offline, so it must
  be long and random; 32 base62 characters is about 190 bits.
- **AES-128** (`pbkeylen=16`) is enough and costs no bytes; `pbkeylen=32`
  (AES-256) also works with MediaMTX, if wanted.
- **Latency 1000 ms by default, set by the web.** Measured: no frame lost at
  1% and 5% random loss; it absorbs a stall of up to about 0.8 s (a 2 s stall
  at 2000 ms lost 0 and 150 ms in two runs); it costs 1.07 s of delay and 1 s
  more on every
  reconnect before the node sees the feed. SRT's rule of thumb is 4 × RTT, so
  1000 ms covers RTTs to 250 ms. For the phone (Phase 3), 2000 to 2500 ms.
  The web sends it, so it can change without a desktop release.

### Desktop (`videorc`)

1. **FFmpeg on macOS.** The script change in section 1, ready as a patch
   (`proposed-build-ffmpeg-macos-srt.patch`, kept with the spike's scratch
   files; C1b applies it): the libsrt pin and build, `srt.pc`,
   `--enable-libsrt`, the two checks, the license files, `NOTICE.txt` and
   `SOURCE.txt`, and the reuse check that rebuilds a bundle without `srt`.
   It ran end to end here on a copy of the repo's layout:
   the same binary sizes as section 1, both license files, the `NOTICE.txt`
   and `SOURCE.txt` lines, `srt` present, and a second run reused the bundle.
   Add `srt` to `scripts/preflight-macos-package.mjs`.
2. **FFmpeg on Windows and Linux.** The re-pin and checks in section 4.
3. **The cloud target carries its transport.** Either RTMPS as today, or SRT:
   host (a DNS name in release builds, as C1c requires for RTMPS), port,
   stream id, passphrase, latency. `validate_stream_publish_url` takes
   `srt://` for the cloud feed only: a port, no user info, no `passphrase`
   in the query.
4. **The MPEG-TS leg**, next to `fifo_flv_output_args`:

   ```
   -f fifo -fifo_format mpegts -queue_size 512 -drop_pkts_on_overflow 1
   -attempt_recovery 1 -recover_any_error 1 -restart_with_keyframe 1
   -recovery_wait_time 1 -format_opts passphrase=<p>:pbkeylen=16
   srt://<host>:<port>?streamid=publish%3Alive%2F<showId>-h&latency=1000000&pkt_size=1316&connect_timeout=1500
   ```

   - No `-tag:v 7`: that is FLV's tag. The bridge's MPEG-TS tag is already
     MPEG-TS's.
   - The passphrase goes in `-format_opts`, never in the URL, because FFmpeg
     prints the URL.
   - `connect_timeout=1500` and `recovery_wait_time 1` shorten the dead
     leg's retry cycle from 6.05 s to 3.55 s (section 3).
   - The raw path's tee takes the same as a slave:
     `[f=mpegts:onfail=ignore:passphrase=…:pbkeylen=16]srt://…`.
5. **The 3 s fallback to RTMPS happens before the leg exists.** FFmpeg says
   nothing when an SRT connect succeeds, and the leg can share its FFmpeg
   with the recording, so the choice can't wait for FFmpeg. Probe from Rust:
   send SRT's induction handshake (one 64-byte UDP datagram; the listener
   answers without auth, in one round trip, 42 ms here at a 40 ms RTT) every
   250 ms; no answer in 3 s means UDP is blocked, and the session uses RTMPS. Mid-session a dead
   SRT leg keeps retrying SRT; a later slice can rebuild it as RTMPS if SRT
   keeps failing while the control socket stays up.
6. **Redaction.** `redact_stream_urls` learns `srt://` and masks the whole
   query, as a second line behind keeping the passphrase out of the URL.
7. **Leg health.** libsrt writes nothing when a link dies. The first line
   came 9.2 s into a drop (the failed reconnect's "Connection to … failed").
   Read the fifo's lines (`Error opening srt://`, `Recovery failed`,
   `Recovery successful`, `FIFO queue full`), and prefer the runner's
   `state.feeds[].connected` and `kbps`, which see the feed directly.
8. **Smokes.** `smoke:cloud-solo` gains an SRT pass through a UDP relay: a
   2 s blackhole (no reconnect, at most partial loss), a 10 s blackhole
   (reconnect, resume), and a log check that no passphrase or stream id is in
   the renderer events or the app log. `smoke:recording-matrix` doesn't move.

### Node (`videorc-cloud`)

1. **MediaMTX:** `srt: yes`, `srtAddress: :<srtPort>`. One UDP port carries
   every show (I1's firewall needs that port, not a range). Keep
   `readTimeout: 10s`: it is also MediaMTX's SRT peer-idle timeout, and with
   `overridePublisher` on, a publisher that comes back inside it replaces its
   stale session (measured: after a 6 s drop the new connection took over and
   MediaMTX closed the old one as "terminated").
2. **A path per feed with its passphrase.** At show create the agent calls
   MediaMTX's loopback API, `POST /v3/config/paths/add/live/<showId>-<h|v>`
   with `{"srtPublishPassphrase": "<passphrase>"}`; at show end
   `DELETE /v3/config/paths/delete/…`. Measured: the delete closes a live SRT
   publisher at once ("terminated"), and its reconnect is refused ("passphrase
   is missing": the feed falls to `all_others`, which has none); the hook
   refuses it too, because the show has ended. The `all_others` path can't
   hold a passphrase per show. Paths added through the API live only in
   MediaMTX's memory (the API doesn't write the config file), so after a
   MediaMTX restart the agent adds them again for every live show.
3. **The hook (`decide`).** For `protocol: "srt"`, `action: "publish"`: the
   path must be a feed of a live show; refuse a stream id with a user,
   password or query, to keep the shape tight. The hook can't see the
   passphrase; MediaMTX checks it right after. For `protocol: "rtmp"`: the
   same path, plus `key=<ingestKey>` in `query`.
4. **`ingest.get`** returns the SRT block too, so a relaunched desktop
   resumes over SRT.
5. **The runner** doesn't change: it reads RTSP from MediaMTX.

### Web (`videorc-web`)

1. **Mint per feed:** `srtPassphrase`, 32 base62 characters, never stored,
   like the ingest key. It goes to the node in `POST /v1/shows` and to the
   desktop in the create response.
2. **The stream id isn't a secret.** The node derives
   `publish:live/<showId>-<h|v>`.
3. **The ingest item grows an SRT block:**

   ```json
   { "orientation": "horizontal",
     "serverUrl": "rtmps://eu-hel-1.live.videorc.com:1936/live",
     "streamKey": "sh_…-h?key=<ingestKey>",
     "srt": { "url": "srt://eu-hel-1.live.videorc.com:8890", "streamId": "publish:live/sh_…-h",
              "passphrase": "<32 base62>", "latencyMs": 1000 } }
   ```

   and each `VIDEORC_CLOUD_NODES` entry gains `srtPort`.
4. **`docs/cloud.md`:** the SRT port, the passphrase rule, the latency
   setting, and that SRT stream ids are public.
5. **The plan's wire shape changes first** ("Ingest on the node" and the
   create response), then all three repos, as the plan says.

## Not measured, and why

- **The dev app.** It wasn't run. The CLI publisher copies the leg's shape,
  not the app's bridge FIFO, its stream health monitor or its restart code.
  C1b's smoke runs the app.
- **The runner in the loop.** A reader with its decoder options stood in.
  MediaMTX serves the same RTSP tracks whatever the ingest, so the runner's
  hold and resume timings from S0a apply on top of the "reader flowing
  again" times here.
- **RTMPS under packet loss and a real TCP drop.** A user-space proxy can't
  drop TCP segments or make the publisher's TCP back off. A real drop adds
  TCP's retransmission backoff after the network returns (it doubles per
  retry, so after a 10 s outage the next retry can be seconds away), and a
  lossy path costs TCP throughput that SRT doesn't pay. Doing this needs
  root (`dnctl`/`pfctl`) or the Linux lab box with `tc netem`.
- **A real Wi-Fi.** A roam that changes the laptop's address was not tried.
  SRT has no connection migration, so expect it to end like the longer drops
  here: a break and a reconnect. Cellular and hotel networks that block UDP
  were not tried either; that is what the fallback is for.
- **The SRT probe** in section 5 wasn't built; its answer time comes from the
  relay's handshake log.
- **Windows and Linux at run time.** Their binaries were read, not run.
- **Real RTTs above 40 ms**, and SRT to a node across the internet.
