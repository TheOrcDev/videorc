import { symlinkSync } from 'node:fs'

import type { TestContext } from 'vitest'

/**
 * Makes a symlink for a test, or skips that test where the host cannot:
 * Windows refuses symlinks without Developer Mode or an elevated token
 * (EPERM). Any other error still fails the test. A test that skips the
 * whole platform instead never runs where Developer Mode is on (a dev box,
 * an elevated CI runner).
 */
export function symlinkOrSkip(ctx: TestContext, target: string, path: string): void {
  try {
    symlinkSync(target, path)
  } catch (error) {
    if ((error as { code?: string }).code !== 'EPERM') throw error
    ctx.skip('this host cannot create symlinks (EPERM)')
  }
}
