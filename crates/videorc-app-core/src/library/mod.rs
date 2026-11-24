//! The Library (plan 260 S1.6f, from `videorc-rust`'s plan 220 S3.7a):
//! every recording, as `use-studio.tsx` keeps the renderer's `sessions` state
//! and the Library tab acts on it. This part lands its words ([`copy`]) and
//! its pure logic ([`view`]); the page as one value, the Markers dialog and
//! the list's controller follow.

pub mod copy;
pub mod view;

#[cfg(test)]
mod tests;
