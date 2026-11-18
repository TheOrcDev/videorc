import type { StartSessionParams } from './backend'

/**
 * A last check a Go Live hands the Studio's start (plan 250 D15): it
 * runs on the exact `session.start` parameters, after every await before
 * the RPC, and keeps the refusal it gave. Small and
 * eager on purpose: the Studio's start imports it, the headless Go Live
 * module stays lazy.
 */
export interface GoLiveStartGate {
  /** A refusal to give the caller, or null to start. */
  check: (params: StartSessionParams) => string | null
  /** What `check` refused with, once it has. */
  refusal: string | null
}

/**
 * Thrown by the start when its gate refuses. The start cleans up what it
 * prepared as for any failure, and raises no failure toast: the caller
 * answers with the refusal.
 */
export class GoLiveStartRefused extends Error {}
