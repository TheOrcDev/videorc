# Plan 062: Set a shortcut by pressing it, not by typing it

> Executor: implement the ordered slices below in an isolated worktree of
> current main. Read `AGENTS.md` and `.claude/skills/videorc-design/SKILL.md`
> first. Planning authorizes no merge or release.

## Status and decisions

- Status: PLANNED 2026-09-25.
- Priority: P2. Effort: S to M (about 1 to 1.5 days). Risk: low to medium.
  The only risky part is the main-process key capture in S2, because a bug
  there can leave global shortcuts switched off.
- Planned against origin/main `b2dba422`. The working tree on
  `feat/windows-owner-waiver` is behind main, so every reference below is
  from origin/main.
- Owner route: UI/Product Design (fit 8). S2 is Implementation (fit 8).
  Model lanes: S1 and S2 use `gpt-5.5`, S3 and S4 use `opus-4.8`.
- Branch `feat/shortcut-recorder`, commit prefix `feat(shortcuts):`.
- Owner direction (2026-09-25): "in settings we want that to not be writing
  down commands … if we click then we just do Command-M or Command-Shift-M
  and it makes the command, not for us to have to type it in."

### What is wrong today

In Settings → **Global shortcuts**, every row is a plain text `Input`: the
five action rows (record, stream, mic, next and previous layout) and every
layout row under **Horizontal layouts** and **Vertical layouts**. You have
to type Electron accelerator syntax such as `Cmd+Shift+R` by hand
(`settings-tab.tsx` about lines 443–520 on main). That causes three problems:

1. It is hard to use. You have to know the key names (`Option` or `Alt`?
   `Return` or `Enter`?), and a typo fails silently until a toast appears.
2. Every keystroke is saved and re-registered with the OS. The studio calls
   `GlobalShortcutsRegistrar.sync` on each render, so typing `Cmd+Shift+M`
   one character at a time registers `C`, `Cm`, `Cmd`, `Cmd+` and so on.
   Each partial value fails to register and can fire the "could not be
   registered" toast.
3. On Windows the placeholders and chips say `Ctrl`, because
   `displayAccelerator` changes `Cmd` to `Ctrl` for display only. The stored
   string still registers as `Cmd`. Electron documents that Command has no
   effect on Windows and Linux, so a Windows user who types what the
   placeholder shows gets a binding that never fires. Confirm this on the
   Windows CI box in S4.

### The target experience

Each row gets a **shortcut recorder** field that works like the ones in
macOS System Settings and Raycast:

- **At rest:** the field shows the binding as key chips (`⌘ ⇧ M`), or
  _Unassigned_ in muted text. When a binding is set, a small clear button
  appears at the end of the field.
- **Click (or press Enter or Space on the focused field):** the field arms
  and shows _Press shortcut…_ with the focus ring. While you hold modifiers,
  they appear live as chips (`⌘ ⇧ …`).
- **Press a full combination:** the recorder checks it, saves it once,
  registers it once and disarms.
- **Esc** cancels and keeps the old binding. **Delete or Backspace** with no
  modifiers clears the binding. Clicking away or leaving the window cancels.
- **An invalid combination:** the field stays armed and one line of helper
  text under the row explains why, for example _Add ⌘, ⌃ or ⌥ so the key
  still types in other apps._

### Decisions (the owner can change these; each maps to one function)

1. **A modifier is required.** A combination must include Cmd, Ctrl,
   Option/Alt or Super. The exception is a bare function key from F1 to F24,
   because Stream Deck hotkeys usually send F13–F24. Shift plus a letter is
   rejected, because a global binding on it would take capital letters away
   from every app.
2. **A small set of system combinations is blocked.** On macOS: ⌘Q, ⌘W, ⌘H,
   ⌘M, ⌘Tab, ⌘Space, and ⌘C/V/X/Z/A. The Windows list is the equivalent
   Ctrl set plus Alt+F4 and Alt+Tab. A global binding takes the key away
   from every app on the machine, so **plain ⌘M is blocked (it is Minimize
   everywhere). ⌘⇧M is fine.** The helper text says why.
3. **Duplicates inside Videorc are refused, not moved.** The message names
   the row that already has it: _Already used by Screen + Cam._ Main already
   rejects duplicates at registration (`replaceGlobalShortcutBindings`);
   this surfaces the same rule before saving.
4. **The binding is saved in the platform's Electron names.** macOS saves
   `Cmd`, `Ctrl`, `Alt` and `Shift`. Windows and Linux save `Ctrl`, `Alt`,
   `Shift` and `Super`. Existing `Cmd+Shift+R` values keep working on macOS.
5. **Scope is the global shortcuts only.** That means the five action rows
   and all layout rows. The read-only **Shortcuts** reference table (in-app
   keys from `lib/shortcuts.ts`) stays read-only.

### Why the recorder cannot be a plain renderer `keydown` listener

Four things would take the key before a renderer listener sees it:

- **Registered global shortcuts.** The OS delivers a registered combination
  to `globalShortcut`, not to the page. Recording `⌘⇧R` while it is already
  bound would **start a recording** and never reach the field.
- **Main's `before-input-event`** swallows ⌘1–⌘9 and ⌘, for workspace
  navigation (`main/index.ts` about line 1693), so the field would navigate
  away instead.
- **Menu accelerators**, such as the default Electron role menu's ⌘Q, ⌘W
  and ⌘M.
- **The studio `keydown` handler** starts or stops the session on Space and
  refreshes on P (`use-studio.tsx` about line 13391).

So while the recorder is armed, **main owns key capture**. It suspends
Videorc's own global registrations. In `before-input-event` it calls
`preventDefault()` on every key event in the main window and forwards
`{ type, code, key, meta, control, alt, shift }` to the renderer. Per the
Electron docs, `preventDefault` there blocks both the page's key events and
menu shortcuts. When the recorder disarms, main re-registers the last config.

## Slices

### S1: Pure accelerator logic and tests (`gpt-5.5`)

New `apps/desktop/src/shared/accelerator.ts`. It is shared because main
needs `normalize` for the Windows fix in S4.

- `acceleratorFromKeyInput(input, platform)` returns
  `{ kind: 'modifiers-only', keys } | { kind: 'combo', accelerator } | { kind: 'cancel' } | { kind: 'clear' }`.
  - It maps the key from **`code`, not `key`**. On macOS, ⌥M produces
    `key === 'µ'`. The mappings are: `KeyA`–`KeyZ` to `A`–`Z`, `Digit0`–`9`,
    `F1`–`F24`, arrows to `Up/Down/Left/Right`, `Space`, `Enter`, `Tab`,
    `Backspace`, `Delete`, `Home/End/PageUp/PageDown`, punctuation
    (`Minus` to `-`, `Equal` to `=`, `BracketLeft` to `[` …), and numpad
    to `num0`–`num9`, `numadd` and so on.
  - Modifier order in the saved string is fixed: `Cmd`, `Ctrl`, `Alt`,
    `Shift`, then `Super` on Windows and Linux.
- `validateAccelerator(accelerator, platform)` returns
  `{ ok: true } | { ok: false, reason: 'needs-modifier' | 'system-reserved' }`
  (decisions 1 and 2).
- `normalizeAccelerator(value, platform)` handles comparison: case, alias
  (`Command`/`Cmd`/`CommandOrControl`, `Option`/`Alt`) and modifier order.
  On non-darwin it rewrites `Cmd` to `Ctrl`.
- `findAcceleratorOwner(config, accelerator, exceptAction)` returns the
  action that already has it (decision 3), using `globalShortcutEntries`.
- `acceleratorDisplayKeys(accelerator, platform)` returns chip glyphs
  (`['⌘','⇧','M']` on macOS, `['Ctrl','Shift','M']` elsewhere). It reuses
  `displayKeyGlyph` for the non-mac mapping, and macOS uses the ⌃⌥⇧⌘ order.

**Done when:** `shared/accelerator.test.ts` covers ⌘⇧M and ⌥M (via `code`),
Ctrl+Shift+M on win32, bare F13 allowed, bare M rejected, Shift+M rejected,
⌘Q and ⌘M blocked, ⌘⇧M allowed, `cmd+shift+m` equal to `Shift+Cmd+M`,
duplicate detection across action rows and layout rows, and Esc, Backspace
and modifiers-only results.
`pnpm --filter @videorc/desktop test -- accelerator` is green.

### S2: Main-process capture mode and global suspend (`gpt-5.5`)

- **IPC contract** (`shared/electron-ipc-contract.ts` and preload):
  - invoke `shortcut-recorder:set-armed` (`boolean`) returns `{ armed: boolean }`.
  - event `shortcut-recorder:key` sends `{ type: 'keyDown' | 'keyUp', code, key, meta, control, alt, shift }`.
  - event `shortcut-recorder:disarmed` fires when main disarms on its own.
  - Add them to `VideorcApi` in `shared/backend.ts` as optional members,
    like `setGlobalShortcuts`.
- **`main/global-shortcut-lifecycle.ts`**: add a small `ShortcutRecorderGate`
  (pure, testable against the fake registry in the existing test file).
  - `arm()` unregisters every owned accelerator and keeps the last
    requested config.
  - `disarm()` re-runs `replaceGlobalShortcutBindings` with that config.
  - While armed, `setGlobalShortcuts` only stores the config. It applies on
    disarm, so saving a binding cannot re-register mid-capture.
  - `arm` and `disarm` are idempotent.
- **`main/index.ts` `before-input-event`:** when the gate is armed, call
  `event.preventDefault()` on every key event and forward it as
  `shortcut-recorder:key`. Return before the ⌘1–9 navigation branch. Keep
  the `publishShortcutModifier` call as the first line.
- **Fail-safes.** Main disarms and emits `shortcut-recorder:disarmed` on
  main-window `blur`, `webContents` `did-start-navigation` (reload),
  `render-process-gone`, and a 30 s idle timer that resets on each key.
  Global shortcuts must never stay dead because a renderer forgot to disarm.

**Done when:** lifecycle tests prove these cases. Arm unregisters owned keys
and leaves other apps' keys alone. Disarm restores exactly the last config.
A `setGlobalShortcuts` call while armed is deferred and then applied. A
double arm or double disarm is a no-op. The IPC contract test covers the
new channel. `pnpm typecheck` and `pnpm --filter @videorc/desktop test` are
green.

### S3: `ShortcutRecorder` component and Settings wiring (`opus-4.8`)

- New `renderer/src/components/shortcut-recorder.tsx`, built only from
  shadcn parts:
  - An outline `Button`, `w-44`, the same height as the inputs it replaces.
  - `KbdGroup` and `Kbd` chips for the value, or muted _Unassigned_.
  - A trailing ghost icon button to clear, shown only when a value is set.
    Use a meaning-named icon from the registry, not a new one.
  - Armed state: _Press shortcut…_ with the ring, and live modifier chips.
  - Error line: `FieldDescription` or `FieldError` text under the row.
    Muted for guidance, destructive only for a failed registration.
  - Props: `value`, `onChange(next: string | '')`,
    `validate(accel) => string | null` (the parent supplies the duplicate
    check), `platform`, `id`, `aria-label`.
- **Behaviour:**
  - Clicking arms the recorder: `setShortcutRecorderArmed(true)`, then
    listen to `onShortcutRecorderKey`.
  - Each event goes through `acceleratorFromKeyInput`, then
    `validateAccelerator`, then `validate`. Exactly one `onChange` fires per
    committed combination.
  - Disarm on commit, cancel, clear, blur, unmount, or
    `shortcut-recorder:disarmed`.
  - Fallback when there is no bridge (vitest or browser dev): a capture-phase
    `keydown` on the button that calls `preventDefault` and
    `stopPropagation`, fed through the same function.
  - Follow the repo's useEffect-elimination direction: subscribe in the arm
    handler and unsubscribe in disarm, not in a mount effect.
- **`settings-tab.tsx`:**
  - Replace both `Input` blocks (the five action rows and the per-layout
    rows) with `ShortcutRecorder`.
  - Section description: _Work system-wide, even when Videorc is in the
    background. Click a field and press the keys. Stream Deck hotkeys and
    F13–F24 work too._ Drop the "Electron accelerator syntax" sentence.
  - Replace the footnote with _Esc cancels · Delete clears._ using Kbd
    chips, or drop it if the clear button makes it redundant.

**Done when:**

- Component tests (vitest and Testing Library, fallback path) cover:
  - Clicking arms and shows _Press shortcut…_.
  - ⌘⇧M commits `Cmd+Shift+M` once.
  - Esc keeps the old value.
  - Backspace clears.
  - Bare M shows the modifier hint and stays armed.
  - A duplicate shows _Already used by …_.
- By eye in `pnpm dev`, in the Settings screenshot area:
  - Record ⌘⇧M on "Screen + Cam".
  - Re-record over an already-bound ⌘⇧R; recording must **not** start.
  - Press ⌘1; the app must not navigate.
  - Press Space; the session must not start.
  - Press ⌘M; it is refused with a reason.
  - ⌘-Tab away; the recorder disarms and globals work again from another
    app.
- `pnpm typecheck`, `pnpm lint`, `pnpm format:check` and the desktop tests
  are green.

### S4: Truthful status, chips everywhere, Windows `Cmd` fix (`opus-4.8`)

- **Per-row registration status.** `GlobalShortcutsRegistrar` already gets
  `registered: Record<action, boolean>` back. Expose the latest result
  (a tiny store read with `useSyncExternalStore`) and show an inline
  destructive line on a row that failed: _Taken by another app. Pick
  another._ Keep the toast only for the IPC-failure path.
- **Scenes gallery** (`components/studio/scenes-gallery.tsx` about line 163):
  render the layout's binding with `acceleratorDisplayKeys`, the same way
  as Settings, instead of the raw `displayAccelerator` string.
- **Windows and Linux fix.** In `setGlobalShortcuts` (main), pass every
  entry through `normalizeAccelerator(value, process.platform)`, so stored
  `Cmd+…` values register as `Ctrl+…` off macOS and match what the UI has
  always shown. First verify the Electron behaviour on the Windows CI build
  or the docs. If `Cmd` really does register as Ctrl there, drop this
  bullet.

**Done when:** a forced conflict (bind a combination another app already
owns, such as a Raycast hotkey) shows the inline line on that row only. The
gallery chips match Settings. A unit test covers
`normalizeAccelerator('Cmd+Shift+R', 'win32') === 'Ctrl+Shift+R'`. `pnpm build`
is green, and the renderer budget check is green (Settings is the only new
importer; keep the recorder out of the eager shared chunk).

## Out of scope

- Making the in-app **Shortcuts** reference table editable.
- Chords or sequences (such as ⌘K then R), and mouse-button bindings.
- Stream Deck plugin changes. Its Hotkey action already sends whatever combo
  is recorded here.

## Verification summary

`pnpm typecheck` · `pnpm lint` · `pnpm format:check` ·
`pnpm --filter @videorc/desktop test` · `pnpm build`, plus the S3 by-eye
checklist in the dev app. Recording and native-preview gates are not needed
(no capture, compositor or preview code changes). Global shortcut dispatch
itself is unchanged.
