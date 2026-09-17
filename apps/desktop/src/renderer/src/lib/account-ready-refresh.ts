// Account refresh on app ready (live feedback batch 3, B3).
//
// `account.get` hands the renderer the snapshot persisted at the last
// interactive sign-in. Until now it was only re-validated against the web on
// window focus and on a 5-minute timer, so a cold launch showed whatever the
// last sign-in stored — for Google-linked accounts, no avatar at all — until
// the user alt-tabbed away and back. This reducer decides when the renderer
// owes the web one `account.refresh` for the current backend connection:
// exactly once per connection, and only while signed in.

export interface AccountReadyRefreshState {
  /** The backend client this connection's refresh was already issued for. */
  readonly refreshedFor: object | null
}

export const INITIAL_ACCOUNT_READY_REFRESH_STATE: AccountReadyRefreshState = {
  refreshedFor: null
}

export type AccountReadyRefreshEvent =
  | { type: 'connected'; client: object; signedIn: boolean }
  | { type: 'disconnected' }

export interface AccountReadyRefreshResult {
  state: AccountReadyRefreshState
  /** Issue `account.refresh` now. */
  refresh: boolean
}

export function reduceAccountReadyRefresh(
  state: AccountReadyRefreshState,
  event: AccountReadyRefreshEvent
): AccountReadyRefreshResult {
  switch (event.type) {
    case 'disconnected':
      return {
        state: state.refreshedFor === null ? state : INITIAL_ACCOUNT_READY_REFRESH_STATE,
        refresh: false
      }
    case 'connected': {
      if (!event.signedIn) {
        // Signed-out snapshots have nothing to refresh; an interactive sign-in
        // later in this connection re-enters here as signedIn and refreshes.
        return { state, refresh: false }
      }
      if (state.refreshedFor === event.client) {
        return { state, refresh: false }
      }
      return { state: { refreshedFor: event.client }, refresh: true }
    }
  }
}
