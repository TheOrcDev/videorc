import './lib/smoke-env.mjs'
import { linuxRenderNodeInvocation } from './lib/linux-render-node-isolation.mjs'

const cli = process.argv.slice(2)
if (cli[0] === '--') cli.shift()
const [command, ...args] = cli
try {
  const spec = linuxRenderNodeInvocation({ command, args })
  console.error(
    `[linux:render-node] ${spec.renderNode} and ${spec.cardNode}; all other /dev/dri nodes hidden for this command.`
  )
  // Replace this wrapper so the caller retains direct PID/signal ownership.
  // Node 24 is the repository's required runtime. A missing bwrap or denied
  // namespace fails here; never fall back to unrestricted GPU access.
  process.execve(spec.command, [spec.command, ...spec.args], spec.env)
} catch (error) {
  console.error(`Render-node isolation failed: ${error.message}`)
  process.exitCode = 1
}
