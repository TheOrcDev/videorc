# Desktop auth v2 rollout

Desktop auth v2 binds the browser hand-off to app-generated state and an S256
PKCE verifier. The companion web app exposes it at `/desktop/authorize/v2`;
desktop builds in this change refuse the legacy `/desktop/authorize` path and
raw `?token=` callbacks.

The rollout order is load-bearing:

1. Deploy the companion web PR first. It must serve both routes:
   `/desktop/authorize` for already-released clients and
   `/desktop/authorize/v2` for state + PKCE clients.
2. Verify the v2 route and `/api/desktop/session/verify`, then release the
   matching desktop build.
3. Keep the legacy route only for the documented migration window. Remove it
   after the minimum supported desktop version includes v2; do not reuse the v2
   component or action for legacy callbacks.

Deploying the desktop PR first makes sign-in fail closed because the current web
deployment does not have the v2 route. Deploying a web change that removes the
legacy route first locks out installed clients. Cross-link the two PRs and mark
the web deployment as the desktop PR's rollout prerequisite.

Security invariants for v2:

- only `https://www.videorc.com/desktop/authorize/v2` is accepted in packaged
  builds; unpackaged builds may explicitly use loopback;
- the OS deep-link carries `state`, an opaque encrypted code, and that code's
  authenticated `code_expires_at_ms` deadline, never a raw Better Auth one-time
  token or durable session token;
- the v2 route mints a v3 code whose clear expiry segment is authenticated both
  by AES-GCM additional data and the encrypted payload. The browser may open or
  re-open the link for 60 seconds; the code remains valid for another 120
  seconds so a callback delivered at the final allowed handoff still has the
  complete desktop retry reserve;
- desktop persists at most one callback per state. An exact callback is
  idempotent, a different code for the same state is rejected, and ACK retires
  the state. The persisted callback deadline is the earlier of its local
  120-second retry bound and the authenticated server-code expiry, and that
  exact deadline crosses the main-to-renderer contract;
- the code is S256-bound and may be retried idempotently only with the exact
  state and verifier; every retry revalidates that session authoritatively so
  revoked or expired sessions fail closed;
- the legacy route alone retains Better Auth's single-use one-time token bridge;
- the verify response is no-store and projected to the bounded desktop account
  DTO before it leaves the companion server.
