// Live captions can't run on some platforms at all (Linux today: no native
// microphone path to transcribe). The Studio decides that in one place,
// `captionsPlatformUnavailableReason(runtimeInfo.platform)` in
// apps/desktop/src/renderer/src/lib/captions-preflight.ts: every session
// starts without captions there, and the Live captions switch and the agent
// `set_captions` tool refuse with that copy (what smoke:agent-mcp skips on).
//
// Caption smokes ask the running renderer the same question, through the same
// module and the app's own runtime info, so a skip follows the product's own
// truth and never a bare `process.platform` check. A probe that can't answer
// fails the smoke: a skip is never silent and never a guess.

/** Renderer JS for the smoke command server's `eval-js` (dev app only). */
export const CAPTIONS_PLATFORM_PROBE_JS = `
  const info = await window.videorc.getRuntimeInfo()
  const preflight = await import('/src/lib/captions-preflight.ts')
  return {
    platform: info?.platform ?? null,
    reason: preflight.captionsPlatformUnavailableReason(info?.platform)
  }
`

/**
 * The product's reason captions can't run on this platform, or null when
 * they can. Throws on an answer that isn't one of those two.
 */
export function captionsPlatformReasonFromProbe(answer) {
  if (!answer || typeof answer !== 'object') {
    throw new Error(`The captions platform probe returned no answer: ${JSON.stringify(answer)}`)
  }
  if (typeof answer.platform !== 'string' || answer.platform.length === 0) {
    throw new Error(
      `The captions platform probe could not read the app's platform: ${JSON.stringify(answer)}`
    )
  }
  if (answer.reason === null) return null
  if (typeof answer.reason !== 'string' || answer.reason.trim().length === 0) {
    throw new Error(
      `The captions platform probe returned an unnamed reason on ${answer.platform}: ${JSON.stringify(answer)}`
    )
  }
  return answer.reason
}

/**
 * Ask the running renderer. `evalJs(code)` runs `code` through the smoke
 * command server's `eval-js` and resolves to the code's return value.
 */
export async function captionsPlatformUnavailableReason(evalJs) {
  return captionsPlatformReasonFromProbe(await evalJs(CAPTIONS_PLATFORM_PROBE_JS))
}

/** The one SKIP line a caption smoke prints for the part it didn't run. */
export function captionsSkipLine(smoke, part, reason) {
  if (!reason) throw new Error('A captions SKIP needs the product reason.')
  return `${smoke} SKIP ${part}: ${reason}`
}
