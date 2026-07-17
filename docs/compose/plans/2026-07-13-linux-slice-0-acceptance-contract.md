# Linux Slice 0 Acceptance Contract Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use compose:tdd for every behavior change.

**Goal:** implement a complete Linux acceptance validator and evidence template so every Linux artifact run has machine- and feature-level proof.

**Architecture:** pure schema validation in a small Node module (`scripts/lib/linux-acceptance-gate.mjs`) with a Node test (`scripts/lib/linux-acceptance-gate.test.mjs`) and a fixed manifest template used by both CI and on-device runs.

**Tech Stack:** Node script runner (`node --test`), deterministic line-based assertions, acceptance artifact manifests.

Execution context:

- This slice must follow TDD: failing test first.
- On this machine, avoid local heavy operations and run this slice through GitHub Actions when possible.
- If local `node` tooling is unavailable, treat the RED check as a CI-only check and verify with workflow logs.

---

### Task 1: implement red-phase manifest validator test

**Covers:** S1, S2, S12, S18

**Files:**
- Create: `scripts/lib/linux-acceptance-gate.test.mjs`
- Test command in this slice: `node --test scripts/lib/linux-acceptance-gate.test.mjs`

- [ ] **Step 1: Write the failing test**

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateLinuxAcceptanceManifest } from './linux-acceptance-gate.mjs';

test('acceptance gate reports all required sections in empty manifest', () => {
  const errors = validateLinuxAcceptanceManifest({});

  assert.ok(Array.isArray(errors));
  assert.ok(errors.includes('required: gnome-wayland'));
  assert.ok(errors.includes('required: portal'));
  assert.ok(errors.includes('required: pipewire'));
  assert.ok(errors.includes('required: screen-capture'));
  assert.ok(errors.includes('required: preview'));
  assert.ok(errors.includes('required: encoder'));
  assert.ok(errors.includes('required: final-artifact'));
  assert.ok(errors.includes('required: av-sync'));
  assert.ok(errors.includes('required: process-cleanup'));
  assert.ok(errors.includes('required: redaction'));
});
```

- [ ] **Step 2: Run test and verify it fails**

Preferred local run:

```bash
node --test scripts/lib/linux-acceptance-gate.test.mjs
```

Expected: fail if the module is missing or contract is incomplete.

Fallback when local Node tooling is unavailable:

```bash
git push origin HEAD:feat/linux-support-work  # create/update remote branch first
gh workflow run linux.yml --repo oladapodev/videorc --ref feat/linux-support-work
```

CI evidence expected: Linux workflow logs must show this test with explicit `fail` output before implementation.

---

### Task 2: implement acceptance validator

**Covers:** S1, S2, S12, S17

**Files:**
- Create: `scripts/lib/linux-acceptance-gate.mjs`
- Modify: `scripts/lib/linux-acceptance-gate.test.mjs`
- Modify: `package.json`
- Modify: `.gitignore`

- [ ] **Step 1: Add minimal pure validator implementation**

- [ ] **Step 2: Add missing manifest command in `package.json`**

```json
"acceptance:linux:verify": "node scripts/lib/linux-acceptance-gate.mjs"
```

- [ ] **Step 3: Ignore Linux acceptance evidence directory explicitly**

Append in `.gitignore`:

```text
docs/acceptance/artifacts/linux/
```

- [ ] **Step 4: Extend test coverage for incomplete evidence and success path**

- [ ] **Step 5: Run focused validation**

Local:

```bash
node --test scripts/lib/linux-acceptance-gate.test.mjs
pnpm acceptance:linux:verify -- /tmp/videorc-linux-acceptance/manifest.json
pnpm check:text-files
```

CI-only equivalent:

```bash
git push origin HEAD:feat/linux-support-work
gh workflow run linux.yml --repo oladapodev/videorc --ref feat/linux-support-work
```

---

### Task 3: add Linux acceptance template and artifact contract

**Covers:** S1, S17, S18

**Files:**
- Create: `docs/acceptance/linux-app-acceptance-template.md`

- [ ] **Step 1: create template with explicit commands and rollback fields**

Include:
- start state, command set, artifact capture path, rollback notes,
- explicit gates (GNOME/portal/PipeWire/capture/preview/encoder/artifact/AV/smoke/process),
- evidence paths under `docs/acceptance/artifacts/linux/<date>/`.

- [ ] **Step 2: verify slice gate (lightweight)**

```bash
node --test scripts/lib/linux-acceptance-gate.test.mjs
pnpm check:text-files
```

---

### Task 4: completion and docs marker update

**Covers:** S1, S2, S18

**Files:**
- `docs/linux-port-tasks.md`

- [ ] **Step 1: mark Slice 0 evidence as complete only after gated checks pass**
- [ ] **Step 2: commit only files for this slice**
