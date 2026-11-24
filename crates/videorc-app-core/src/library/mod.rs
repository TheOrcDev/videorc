//! The Library (plan 260 S1.6f, from `videorc-rust`'s plan 220 S3.7a):
//! every recording, as `use-studio.tsx` keeps the renderer's `sessions` state
//! and the Library tab acts on it: its words ([`copy`]), its pure logic
//! ([`view`]), the page as one value ([`page`]) and the Markers dialog
//! ([`markers`]). The list's controller follows.

pub mod copy;
pub mod markers;
pub mod page;
pub mod view;

#[cfg(test)]
mod tests;
