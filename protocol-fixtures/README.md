# Shared protocol fixtures

`high-risk-contracts.json` is the platform-neutral wire-contract fixture shared by
the Rust backend and TypeScript desktop tests. It covers the protocol shapes most
likely to cause silent cross-process failures: native preview placement, scene and
layout data, recording/compositor status nullability, desktop account authorization
(including its main-owned retry deadline),
and Library comment pagination/deletion (including the terminal page shape).

The JSON is the authoritative example. A wire-shape change must update the fixture
and keep both test suites green:

- Rust: `cargo test -p videorc-backend shared_high_risk_contract_fixture`
- TypeScript: `pnpm --filter @videorc/desktop test -- protocol-contract-fixtures.test.ts`

Fixture paths are relative opaque strings and do not assume Windows or POSIX path
syntax. Never put machine-specific paths, tokens, recordings, or account data here.

## `buddy-motion.json`

The Buddy's motion envelopes (plan 168, D6): for every page-pet reaction pose,
the default pose, a raw nudge, a gaze turn, a talk-bob train and breathing, the
transform every 1/60 s for 2 s at Motion 0.45 and 1.0, drawn at 180 px and
360 px, plus the GSAP easing formulas at 101 points. It is generated FROM the
Rust model; both models must reproduce it within `tolerance` (1e-4):

- Regenerate after a deliberate motion change:
  `cargo test -p videorc-backend buddy_motion::tests::write_shared_fixture -- --ignored`
- Rust: `cargo test -p videorc-backend buddy_motion`
- TypeScript: `pnpm --filter @videorc/desktop test -- buddy-motion.test.ts`

## `buddy-official-catalog.json`

Videorc's official Buddy library (plan 170, D10 and D11), edited by hand. The
desktop catalog (`apps/desktop/src/shared/buddy-library.ts`), the backend table
(`crates/videorc-backend/src/cohost_library.rs`) and the web catalog
(videorc-web `lib/buddy/official.ts`) must equal it:

- Rust: `cargo test -p videorc-backend buddy_official_catalog`
- TypeScript: `pnpm --filter @videorc/desktop test -- buddy-library.test.ts`

The library RPC shapes (`cohost.library.*`) ride `high-risk-contracts.json`
under `buddyLibrary`, with the rest of the shared wire fixtures.
