// How a stored Electron accelerator reads, per platform (plan 062; plan 174
// S1.2). Split from accelerator.ts so the renderer's eager shell (status bar,
// sidebar, ⌘K) can print shortcuts without the recorder and validation code.
//
// The implementation is the @videorc registry's lib/accelerator
// (renderer/src/lib/accelerator.ts, installed by `pnpm ui:sync` and never
// edited here), which ShortcutKeys and lib/platform read. This module keeps
// the shared path for the main process and shared/accelerator.ts, so every
// process prints and parses an accelerator with the same code. Pure: no DOM,
// no React.
export * from '../renderer/src/lib/accelerator'
