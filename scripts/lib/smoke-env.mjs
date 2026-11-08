// Agents run smokes from shells inside T3 Code, which leaks two variables into every child.
// Import this module for its side effect before spawning anything.
//
// - T3CODE_THREAD_ID: T3 probes each localhost listener of a process carrying it (an HTTP
//   GET, then a TLS hello). A one-shot `ffmpeg -listen 1` RTMP sink takes the probe as its
//   only client and exits ("RTMP protocol version mismatch") before the app connects.
// - ELECTRON_RUN_AS_NODE: T3 is an Electron app. With it set, the dev app starts as plain
//   Node and dies before the handshake (electron-updater's getVersion).
delete process.env.T3CODE_THREAD_ID
delete process.env.ELECTRON_RUN_AS_NODE
