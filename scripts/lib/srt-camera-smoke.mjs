// Plan 255 S7: the pure parts of the SRT Camera smoke.
// The smoke runs on macOS only: its paths are POSIX paths on every host.
import { posix } from 'node:path'

/** Never the default SRT input port (9000) or 9100, which other local tools use. */
export const SRT_SMOKE_RESERVED_PORTS = [9000, 9100]

/** The libsrt copies a dev backend tries (srt_camera/libsrt.rs). */
export function libsrtCandidates(repoRoot) {
  return [
    posix.join(repoRoot, 'vendor', 'libsrt', 'current', 'lib', 'libsrt.dylib'),
    '/opt/homebrew/opt/srt/lib/libsrt.dylib',
    '/usr/local/opt/srt/lib/libsrt.dylib'
  ]
}

/**
 * A local IPv4 address other than loopback, so a caller reaches the camera
 * from a second address. Never a link-local (169.254) link.
 */
export function otherLocalAddress(interfaces) {
  for (const addresses of Object.values(interfaces)) {
    for (const entry of addresses ?? []) {
      const ipv4 = entry.family === 'IPv4' || entry.family === 4
      if (ipv4 && !entry.internal && !entry.address.startsWith('169.254.')) return entry.address
    }
  }
  return null
}

/** Lines of a `ps` or `lsof` listing, without its header line. */
export function countLines(listing) {
  const lines = listing.split('\n').filter((line) => line.trim() !== '')
  return Math.max(0, lines.length - 1)
}

/**
 * The camera frame as the smoke sees it: the waiting still is dark and grey
 * (a dark ground with light text); the fixture's test pattern is bright and
 * coloured.
 */
export function classifyCameraPicture({ meanLuma, chroma }) {
  if (meanLuma < 45 && chroma < 12) return 'still'
  if (meanLuma > 60 || chroma > 25) return 'picture'
  return 'unknown'
}

/**
 * A red-tinted picture against a neutral one: red well above the mean of
 * green and blue. The smoke alternates tints between senders.
 */
export function classifyTint({ meanR, meanG, meanB }) {
  return meanR - (meanG + meanB) / 2 > 45 ? 'red' : 'neutral'
}

/** A pairing check is in: a sender is connected and no frame has come. */
export function pairingAccepted(status) {
  return status.senderConnected === true && status.signal === 'waiting'
}

/** The pairing check is gone, and it left the camera waiting for the next. */
export function pairingLeft(status) {
  return status.senderConnected === false && status.signal === 'waiting'
}

/**
 * A clean feed: every status in the stretch is receiving, at a decoded rate
 * within `tolerance` of the source's. A damaged feed decodes only at key
 * frames, in bursts, and falls to holding between them.
 */
export function steadyFeed(statuses, sourceFps, tolerance = 2) {
  return (
    statuses.length > 0 &&
    statuses.every(
      (status) =>
        status.signal === 'receiving' &&
        typeof status.fps === 'number' &&
        Math.abs(status.fps - sourceFps) <= tolerance
    )
  )
}

/**
 * A new sender is on: a newer session than before it, receiving, with
 * frames of its own. A picture that only still looks live from the last
 * sender has the old session or no frames yet.
 */
export function newSenderDecoding(status, previousSession, minFrames = 3) {
  return (
    status.signal === 'receiving' &&
    status.senderSession > previousSession &&
    status.framesDecoded >= minFrames
  )
}

/**
 * A new sender's picture is back: the camera decodes that sender's frames
 * and the output shows a picture in that sender's tint, not the last one.
 */
export function senderPictureOnOutput(status, previousSession, sample, tint) {
  return (
    newSenderDecoding(status, previousSession) &&
    sample !== null &&
    classifyCameraPicture(sample) === 'picture' &&
    classifyTint(sample) === tint
  )
}

/** The same sender as `before` is decoding again: same session, more frames. */
export function sameSenderDecoding(status, before, minNewFrames = 3) {
  return (
    status.signal === 'receiving' &&
    status.senderSession === before.senderSession &&
    status.framesDecoded >= before.framesDecoded + minNewFrames
  )
}
