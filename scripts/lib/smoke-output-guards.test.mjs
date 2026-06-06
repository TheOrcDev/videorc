import assert from 'node:assert/strict'
import test from 'node:test'

import { createPreviewSurfaceOutputGuard } from './smoke-output-guards.mjs'

test('preview surface output guard ignores unrelated shutdown noise', () => {
  const guard = createPreviewSurfaceOutputGuard()
  guard.inspectLine('[123:ERROR:content/browser/gpu/gpu_process_host.cc] GPU process exited unexpectedly')
  guard.inspectLine('[backend:warn] WebSocket receive error: Connection reset by peer')
  assert.doesNotThrow(() => guard.assertClean())
})

test('preview surface output guard fails on ipc handler errors', () => {
  const guard = createPreviewSurfaceOutputGuard()
  guard.inspectLine("Error occurred in handler for 'preview-surface:apply-host-commands': TypeError: Object has been destroyed")

  assert.throws(
    () => guard.assertClean(),
    /Preview surface host emitted handler error\(s\).*preview-surface:apply-host-commands/
  )
})
