// Plan 207: the look's helpers live in the setup chunk, so the Studio reaches
// them through a dynamic import. Once loaded they are kept: a look choice is
// then applied inside its own press, React draws it before the next press,
// and a second choice (the background right after the layout) never builds
// on a look that is one frame old.

type FirstRunLookHelpers = typeof import('@/lib/first-run-look')

let helpers: FirstRunLookHelpers | null = null
let loading: Promise<FirstRunLookHelpers> | null = null

function load(): Promise<FirstRunLookHelpers> {
  loading ??= import('@/lib/first-run-look').then(
    (loaded) => {
      helpers = loaded
      return loaded
    },
    (error: unknown) => {
      // The next call tries again.
      loading = null
      throw error
    }
  )
  return loading
}

/**
 * Runs `run` with the look's helpers: at once when they are loaded, otherwise
 * as soon as they are. Calls keep their order.
 */
export function withFirstRunLook(run: (helpers: FirstRunLookHelpers) => void): void {
  if (helpers) {
    run(helpers)
    return
  }
  void load().then(run)
}

/** Setup opened: load the helpers before the look step needs them. */
export function warmFirstRunLook(): void {
  void load().catch(() => {})
}
