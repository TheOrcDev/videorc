// Holds a heavy local build (the macOS release backend) while Videorc streams live on this
// machine, so the build cannot take the CPU the stream needs. See waitWhileVideorcLive.
import { waitWhileVideorcLive } from './lib/host-lock.mjs'

await waitWhileVideorcLive()
