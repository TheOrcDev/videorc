/**
 * Dev-only cargo profile for the backend. `pnpm dev` runs a DEBUG backend by
 * default, and its pacing numbers (CPU RGB->YUV conversion, encoder bridge
 * fps) are not evidence of the shipped binary. `VIDEORC_DEV_BACKEND_PROFILE=release`
 * runs the optimized backend so a Linux acceptance can measure the real
 * software path (Plan 0005). The smoke launcher's prebuild reads the same
 * variable.
 */
export function devBackendCargoProfile(env: NodeJS.ProcessEnv = process.env): 'debug' | 'release' {
  return env.VIDEORC_DEV_BACKEND_PROFILE === 'release' ? 'release' : 'debug'
}
