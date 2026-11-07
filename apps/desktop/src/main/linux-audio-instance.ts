// Marks Videorc's own playback for Linux system audio (plan 212).
//
// The backend captures system audio by linking every PipeWire playback stream
// into its own capture stream, so it must leave out the streams Videorc plays
// itself (Library playback, Buddy's voice, the soundboard monitor), or a
// recording hears them twice. Chromium plays renderer audio from its audio
// service through libpulse, and libpulse copies PULSE_PROP into the client and
// stream properties PipeWire publishes. Set before the audio service starts, it
// carries this process's pid to every Videorc stream:
//
//   videorc.app-instance=<Electron main pid>
//
// The backend decides by the stream's process first: a process it can verify
// (its executable or name matches the binary the stream reports) is left out
// when it descends from VIDEORC_ELECTRON_MAIN_PID and captured when it does
// not, so a marker leaked into a foreign app's environment never hides it.
// The marker decides only for a stream with no verifiable process. Probed on
// Electron 39 with pipewire-pulse 1.6: the property is on both the node and
// its client.

export const LINUX_AUDIO_INSTANCE_PROP = 'videorc.app-instance'

const INSTANCE_ENTRY = /(^|\s)videorc\.app-instance=("[^"]*"|'[^']*'|\S*)/g

/**
 * The PULSE_PROP value Videorc's main process should run with, or undefined
 * off Linux. Keeps whatever a user or harness already set and replaces a
 * marker inherited from another Videorc process, such as the one a relaunch
 * starts from.
 */
export function linuxPulseProp(
  platform: NodeJS.Platform,
  existing: string | undefined,
  pid: number
): string | undefined {
  if (platform !== 'linux') return undefined
  const kept = (existing ?? '').replace(INSTANCE_ENTRY, ' ').trim().replace(/\s+/g, ' ')
  const marker = `${LINUX_AUDIO_INSTANCE_PROP}=${pid}`
  return kept ? `${kept} ${marker}` : marker
}
