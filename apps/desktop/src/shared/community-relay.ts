import type { BackendRpcParams, BackendRpcResult } from './backend-rpc-contract'
import type { CommentsCommandResolution } from './backend'

/**
 * Know your viewers from the Stream Manager (plan 225 C2, C3): the person
 * card's calls. The window has no backend socket; main relays each call to
 * the MAIN renderer, which owns it, like `/sound` and `/buddy`. Only these
 * methods may ride the relay: reading a person, the card's actions, and the
 * "Same person as…" search. Nothing here posts to chat.
 */
export const COMMUNITY_RELAY_METHODS = [
  'cohost.community.person',
  'cohost.community.list',
  'cohost.community.update',
  'cohost.community.link',
  'cohost.community.unlink',
  'cohost.community.suggestion.accept',
  'cohost.community.suggestion.dismiss',
  'cohost.community.forget',
  'cohost.community.wave'
] as const

export type CommunityRelayMethod = (typeof COMMUNITY_RELAY_METHODS)[number]

export function isCommunityRelayMethod(value: unknown): value is CommunityRelayMethod {
  return (COMMUNITY_RELAY_METHODS as readonly unknown[]).includes(value)
}

export interface CommunityRelayCommand {
  requestId: string
  method: CommunityRelayMethod
  /** The method's params; the MAIN renderer's client validates them. */
  params: unknown
}

/** How long the window waits for the MAIN renderer's answer. */
export const COMMUNITY_RELAY_TIMEOUT_MS = 15_000

/** One typed call through the relay, for the window's code. */
export type CommunityRelayCall = <M extends CommunityRelayMethod>(
  method: M,
  params: BackendRpcParams<M>
) => Promise<BackendRpcResult<M>>

declare module './backend' {
  interface VideorcApi {
    /** A `cohost.community.*` call from the Stream Manager (plan 225 C2). */
    communityFromCommentsWindow: (command: CommunityRelayCommand) => Promise<unknown>
    onCommunityRequest: (callback: (command: CommunityRelayCommand) => void) => () => void
    pushCommunityResult: (resolution: CommentsCommandResolution<unknown>) => Promise<boolean>
  }
}
