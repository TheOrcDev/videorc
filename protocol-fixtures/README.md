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
