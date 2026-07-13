# Linux Slice 1 Shared Settings and Capability Protocol

> **For agentic workers:** REQUIRED SUB-SKILL: use `compose:tdd` for every behavior change.

**Goal:** add mirrored Linux media settings and protocol types without changing existing runtime behavior, with explicit fallback reporting and fixture-backed normalization.

**Architecture:** introduce a new `crates/videorc-backend/src/media_policy/*` module for settings/selection/fallback decisions and mirror the same fields into TS protocol types, fixtures, and backend RPC contract.

**Tech Stack:** Rust 2024, serde, TypeScript.

Execution context:

- Follow TDD: write the failing test before implementation.
- The local machine is constrained; when local Node is unavailable, run the Node-focused verification on GitHub after this workflow file is on the default branch or via a PR that includes it.

---

### Task 1: Rust contracts and fixtures scaffold

**Covers:** S5, S10, S11, S12, S14

**Files:**
- Create: `crates/videorc-backend/src/media_policy/mod.rs`
- Create: `crates/videorc-backend/src/media_policy/settings.rs`
- Create: `crates/videorc-backend/src/media_policy/selection.rs`
- Create: `crates/videorc-backend/src/media_policy/fallback.rs`
- Modify: `crates/videorc-backend/src/protocol.rs`
- Modify: `protocol-fixtures/high-risk-contracts.json`

- [ ] **Step 1: add a failing protocol fixture test for new fields**

Create/extend fixtures with one Linux-only profile that includes:

- preset intent (`automatic`, `performance`, `balanced`, `quality`, `compatibility`, `custom`)
- capture/audio/compositor/preview/encoder IDs
- fallback mode and capability verdict
- observed runtime path and hardware fingerprint
- benchmark recommendation

In test, parse fixture and expect unknown fields to fail and missing known fields to fail.

- [ ] **Step 2: run failing tests**

```bash
pnpm --filter @videorc/desktop test -- src/shared/protocol-contract-fixtures.test.ts src/shared/backend-rpc-contract.test.ts
cargo test -p videorc-backend protocol
```

Expected: fail due missing Linux contract fields.

If local `node` is unavailable, capture this failure from the `Linux` workflow logs on branch/PR.

---

### Task 2: Rust policy types and normalizing selection

**Covers:** S5, S10, S11, S12, S14

**Files:**
- Create: `crates/videorc-backend/src/media_policy/settings.rs`
- Create: `crates/videorc-backend/src/media_policy/selection.rs`
- Create: `crates/videorc-backend/src/media_policy/fallback.rs`
- Modify: `crates/videorc-backend/src/lib.rs`
- Modify: `crates/videorc-backend/src/protocol.rs`

- [ ] **Step 1: add minimal strict Rust structs/enums**

Implement:

- media policy intent enums
- bounded numeric/device path validation
- unknown enum fallback to `automatic` with diagnostic reason
- deterministic selection output

- [ ] **Step 2: wire fixtures into protocol surface**

Add shared Rust protocol fields consumed by desktop clients with no OS-specific behavior changes.

- [ ] **Step 3: run focused verification**

```bash
cargo test -p videorc-backend media_policy protocol
```

---

### Task 3: desktop shared protocol mirrors and behavior tests

**Covers:** S5, S10, S11, S12, S14

**Files:**
- Modify: `apps/desktop/src/shared/backend.ts`
- Modify: `apps/desktop/src/shared/backend-rpc-contract.ts`
- Modify: `apps/desktop/src/shared/backend-rpc-contract.test.ts`
- Modify: `apps/desktop/src/shared/protocol-contract-fixtures.test.ts`

- [ ] **Step 1: add mirror types and request/response schemas**

Mirror new Rust policy fields exactly:

- requested/selected media policy
- fallback mode
- observed runtime path
- capability verdict and benchmark recommendation

- [ ] **Step 2: add failing behavior tests for schema drift and intent preservation**

- required intent should be preserved
- unknown enums should map to fallback state with diagnostic payload
- rejected unsupported device/fps/rate values should fail with explicit error text

- [ ] **Step 3: run focused verification**

```bash
pnpm --filter @videorc/desktop test -- src/shared/backend-rpc-contract.test.ts src/shared/protocol-contract-fixtures.test.ts
```

If local `node` is unavailable, run this slice on a workflow run that includes `linux.yml` and read the same command output from CI logs.

---

### Task 4: slice gate and docs status

**Covers:** S3, S10

**Files:**
- `crates/videorc-backend/src/protocol.rs`
- `docs/linux-port-tasks.md`

- [ ] **Step 1: complete Slice 1 task gate**

```bash
cargo test -p videorc-backend media_policy protocol
pnpm --filter @videorc/desktop test -- src/shared/backend-rpc-contract.test.ts src/shared/protocol-contract-fixtures.test.ts
pnpm typecheck
```

- [ ] **Step 2: mark Slice 1 items as done in `docs/linux-port-tasks.md` once gates pass.**
