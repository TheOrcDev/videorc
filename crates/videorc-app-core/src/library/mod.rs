//! The Library (plan 260 S1.6f, from `videorc-rust`'s plan 220 S3.7a):
//! every recording, as `use-studio.tsx` keeps the renderer's `sessions` state
//! and the Library tab acts on it. This part lands its words ([`copy`]); the
//! page's view and the Markers dialog follow, then the list's controller.

pub mod copy;
