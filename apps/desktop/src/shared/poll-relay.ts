import type { PollStartParams } from './backend'

// Plan 188 S2: the Stream Manager never calls the backend. A poll action goes
// window → Electron main → Studio (which runs the `polls.*` RPC), the same
// broker as the banner relay.

/** One poll action from the Stream Manager (button, popover, `/poll`). */
export type PollRelayAction =
  | { action: 'start'; params: PollStartParams }
  | { action: 'end' | 'cancel' | 'reshow'; pollId: string }

/** Stream Manager → main → Studio: one poll action with main's request id. */
export type PollRelayCommand = PollRelayAction & { requestId: string }
