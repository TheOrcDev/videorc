// Verdict for the vertical simulcast leg received by a local RTMP sink
// (smoke-multistream-app.mjs, VIDEORC_SMOKE_VERTICAL_LEG). Pure so the rules
// are unit-tested without an app run.
//
// Scope, stated honestly: the smoke's only source is the test pattern, which
// the compositor synthesises AT the canvas size — it has no 16:9 aspect to
// contain or crop. So this proves the dual-orientation PIPELINE (a vertical
// destination with its own key receives the portrait leg, not the horizontal
// program); the fit/fill pixel geometry is proven by the backend render test
// `vertical_fit_shows_the_whole_screen_above_a_covering_camera`, which feeds
// a real 16:9 frame.

/**
 * @param {{ canvas: { width: number, height: number },
 *           program: { width: number, height: number },
 *           received: { width: number, height: number } | null }} input
 * @returns {{ pass: boolean, failures: string[] }}
 */
export function assessVerticalLegStream({ canvas, program, received }) {
  const failures = []
  if (canvas.width >= canvas.height) {
    failures.push(`the vertical leg canvas ${canvas.width}x${canvas.height} is not portrait`)
  }
  if (!received) {
    failures.push('the vertical destination received no decodable video')
  } else if (received.width === program.width && received.height === program.height) {
    failures.push(
      `the vertical destination received the HORIZONTAL program (${received.width}x${received.height}), not the vertical leg`
    )
  } else if (received.width !== canvas.width || received.height !== canvas.height) {
    failures.push(
      `the vertical destination received ${received.width}x${received.height}, expected ${canvas.width}x${canvas.height}`
    )
  }
  return { pass: failures.length === 0, failures }
}
