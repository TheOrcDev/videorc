//! The app-wide recording poster cache (plan 260 L3): Electron's one
//! `SessionPoster`, which the Library's rows and Clean cut's recording list
//! both draw (`components/session-poster.tsx`).
//!
//! - **Keys** are the session and its backend version (the duration, as
//!   `sessionPosterUrl`'s `v=`), so a repair or an export that replaces the
//!   file reads its new poster.
//! - **The cache** ([`PosterCache`]) holds a picture per key, `None` while
//!   its read is on its way or when there is none. Each page that wants a
//!   key is its user; a page lets go of the sessions it no longer lists
//!   ([`PosterCache::keep`]), and a key goes when no page wants it. It is
//!   bounded per page: past [`POSTER_CACHE_LIMIT`] of a page's keys, that
//!   page's next new want starts its own keys again, so one page's long
//!   list never clears another's.
//! - **The read** ([`Library::load_posters`]) is the loopback server's
//!   poster, else one `sessions.poster` backfill and a second read, off the
//!   main thread on the core's runtime.
//!
//! The picture type is the caller's (the GPUI app keeps an image handle),
//! so this stays free of any window toolkit.

use std::collections::{BTreeMap, BTreeSet};

use super::{Library, LibraryBackend, LibraryFiles};

/// A poster: the session and its backend version (the duration).
pub type PosterKey = (String, Option<i64>);

/// The most keys one page holds before its next new want starts its keys
/// again.
pub const POSTER_CACHE_LIMIT: usize = 200;

#[derive(Debug, Clone)]
struct Entry<T> {
    /// `None` while its read is on its way, or when there is no poster.
    picture: Option<T>,
    /// The pages that want this poster.
    users: BTreeSet<&'static str>,
}

/// The posters every page shares, by [`PosterKey`].
#[derive(Debug, Clone)]
pub struct PosterCache<T> {
    entries: BTreeMap<PosterKey, Entry<T>>,
}

impl<T> Default for PosterCache<T> {
    fn default() -> Self {
        Self {
            entries: BTreeMap::new(),
        }
    }
}

impl<T> PosterCache<T> {
    pub fn len(&self) -> usize {
        self.entries.len()
    }

    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    /// The key was asked for: read, on its way, or known to have none.
    pub fn contains(&self, key: &PosterKey) -> bool {
        self.entries.contains_key(key)
    }

    /// The poster, once it is read; `None` while on its way or when there is
    /// none (the page draws the file glyph).
    pub fn get(&self, session_id: &str, version: Option<i64>) -> Option<&T> {
        self.entries
            .get(&(session_id.to_string(), version))
            .and_then(|entry| entry.picture.as_ref())
    }

    /// `user` wants these posters. Returns the keys nobody asked for yet, in
    /// order and once each: the caller reads them and [`fill`](Self::fill)s
    /// them. They wait as `None` meanwhile, so a second want doesn't read
    /// them again. Past [`POSTER_CACHE_LIMIT`] of `user`'s keys (counting
    /// answers no page holds, which any restart drops), `user` lets go of
    /// all of them before the new ones go in; another page's keys stay.
    pub fn want(
        &mut self,
        user: &'static str,
        keys: impl IntoIterator<Item = PosterKey>,
    ) -> Vec<PosterKey> {
        let mut needed: Vec<PosterKey> = Vec::new();
        for key in keys {
            match self.entries.get_mut(&key) {
                Some(entry) => {
                    entry.users.insert(user);
                }
                None if !needed.contains(&key) => needed.push(key),
                None => {}
            }
        }
        if needed.is_empty() {
            return needed;
        }
        let held = self
            .entries
            .values()
            .filter(|entry| entry.users.is_empty() || entry.users.contains(user))
            .count();
        if held > POSTER_CACHE_LIMIT {
            self.entries.retain(|_, entry| {
                entry.users.remove(user);
                !entry.users.is_empty()
            });
        }
        for key in &needed {
            self.entries.insert(
                key.clone(),
                Entry {
                    picture: None,
                    users: BTreeSet::from([user]),
                },
            );
        }
        needed
    }

    /// A read's answer: the picture, or `None` when there is no poster. An
    /// answer for a key the cache let go of meanwhile still goes in.
    pub fn fill(&mut self, key: PosterKey, picture: Option<T>) {
        self.entries
            .entry(key)
            .or_insert_with(|| Entry {
                picture: None,
                users: BTreeSet::new(),
            })
            .picture = picture;
    }

    /// `user` lets go of every session `listed` says it no longer has; a key
    /// no other page wants goes.
    pub fn keep(&mut self, user: &'static str, listed: impl Fn(&str) -> bool) {
        self.entries.retain(|(id, _), entry| {
            if listed(id) {
                return true;
            }
            entry.users.remove(user);
            !entry.users.is_empty()
        });
    }
}

impl<B: LibraryBackend, F: LibraryFiles> Library<B, F> {
    /// The backend is connected and its loopback server known: a poster can
    /// be read (`sessionPosterUrl` is `null` without a connection).
    pub fn serves_posters(&self) -> bool {
        let data = self.data.borrow();
        data.online && data.server.is_some()
    }

    /// `SessionPoster`'s read: the poster, else the one `sessions.poster`
    /// backfill for an older recording and a second read.
    pub async fn poster_or_backfill(
        &self,
        session_id: &str,
        version: Option<i64>,
    ) -> Option<Vec<u8>> {
        if let Some(bytes) = self.poster(session_id, version).await {
            return Some(bytes);
        }
        if self.ensure_poster(session_id).await {
            self.poster(session_id, version).await
        } else {
            None
        }
    }

    /// Reads these posters one after another; never put the authenticated
    /// poster URL in the scene or diagnostics.
    pub async fn load_posters(&self, keys: Vec<PosterKey>) -> Vec<(PosterKey, Option<Vec<u8>>)> {
        let mut pictures = Vec::with_capacity(keys.len());
        for (id, version) in keys {
            let bytes = self.poster_or_backfill(&id, version).await;
            pictures.push(((id, version), bytes));
        }
        pictures
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const LIBRARY: &str = "library";
    const CLEAN_CUT: &str = "clean-cut";

    fn key(id: &str, version: Option<i64>) -> PosterKey {
        (id.to_string(), version)
    }

    #[test]
    fn want_returns_only_new_keys_once_and_holds_them_pending() {
        let mut cache = PosterCache::<u32>::default();
        let needed = cache.want(
            LIBRARY,
            [key("a", Some(1)), key("b", None), key("a", Some(1))],
        );
        assert_eq!(needed, vec![key("a", Some(1)), key("b", None)]);
        assert_eq!(cache.len(), 2);
        assert!(cache.contains(&key("a", Some(1))));
        assert_eq!(cache.get("a", Some(1)), None);
        // On its way: a second want reads nothing again.
        assert!(cache.want(LIBRARY, [key("a", Some(1))]).is_empty());
        assert!(cache.want(CLEAN_CUT, [key("b", None)]).is_empty());
    }

    #[test]
    fn a_new_version_is_a_new_poster() {
        let mut cache = PosterCache::<u32>::default();
        cache.want(LIBRARY, [key("a", Some(1))]);
        cache.fill(key("a", Some(1)), Some(7));
        assert_eq!(
            cache.want(LIBRARY, [key("a", Some(2))]),
            vec![key("a", Some(2))]
        );
        assert_eq!(cache.get("a", Some(1)), Some(&7));
        assert_eq!(cache.get("a", Some(2)), None);
    }

    #[test]
    fn fill_keeps_the_picture_or_none() {
        let mut cache = PosterCache::<u32>::default();
        cache.want(LIBRARY, [key("a", None), key("b", None)]);
        cache.fill(key("a", None), Some(1));
        cache.fill(key("b", None), None);
        assert_eq!(cache.get("a", None), Some(&1));
        assert_eq!(cache.get("b", None), None);
        // No poster is known: it isn't read again.
        assert!(cache.contains(&key("b", None)));
        assert!(cache.want(LIBRARY, [key("b", None)]).is_empty());
    }

    #[test]
    fn past_the_limit_the_next_new_want_starts_again() {
        let mut cache = PosterCache::<u32>::default();
        let many = (0..=POSTER_CACHE_LIMIT).map(|n| key(&n.to_string(), None));
        cache.want(LIBRARY, many);
        assert_eq!(cache.len(), POSTER_CACHE_LIMIT + 1);
        // Nothing new: nothing changes.
        assert!(cache.want(LIBRARY, [key("0", None)]).is_empty());
        assert_eq!(cache.len(), POSTER_CACHE_LIMIT + 1);
        assert_eq!(
            cache.want(LIBRARY, [key("new", None)]),
            vec![key("new", None)]
        );
        assert_eq!(cache.len(), 1);
        assert!(cache.contains(&key("new", None)));
    }

    #[test]
    fn one_pages_long_list_never_clears_another_pages_keys() {
        let mut cache = PosterCache::<u32>::default();
        let library = (0..150).map(|n| key(&format!("lib-{n}"), None));
        cache.want(LIBRARY, library);
        cache.fill(key("lib-0", None), Some(1));
        // Clean cut's Show all: past the limit of its own keys, one shared
        // with the Library.
        let clean_cut = (0..=POSTER_CACHE_LIMIT)
            .map(|n| key(&format!("cut-{n}"), None))
            .chain([key("lib-0", None)]);
        cache.want(CLEAN_CUT, clean_cut);
        assert_eq!(cache.len(), 150 + POSTER_CACHE_LIMIT + 1);

        // The Library's next new key: it holds 150, so nothing restarts.
        assert_eq!(
            cache.want(LIBRARY, [key("lib-new", None)]),
            vec![key("lib-new", None)]
        );
        assert_eq!(cache.len(), 150 + POSTER_CACHE_LIMIT + 2);

        // Clean cut's next new key restarts only its own keys: the
        // Library's stay, the shared one with its picture too.
        assert_eq!(
            cache.want(CLEAN_CUT, [key("cut-new", None)]),
            vec![key("cut-new", None)]
        );
        assert_eq!(cache.len(), 151 + 1);
        assert_eq!(cache.get("lib-0", None), Some(&1));
        assert!(cache.contains(&key("lib-149", None)));
        assert!(cache.contains(&key("lib-new", None)));
        assert!(!cache.contains(&key("cut-0", None)));
        // The Library no longer lists lib-0: Clean cut let go of it too.
        cache.keep(LIBRARY, |id| id != "lib-0");
        assert!(!cache.contains(&key("lib-0", None)));
    }

    #[test]
    fn a_restart_drops_answers_no_page_holds() {
        let mut cache = PosterCache::<u32>::default();
        cache.want(CLEAN_CUT, [key("cut", None)]);
        cache.fill(key("orphan", None), Some(1));
        let many = (0..POSTER_CACHE_LIMIT).map(|n| key(&n.to_string(), None));
        cache.want(LIBRARY, many);
        // 200 of the Library's and the orphan: past the limit.
        cache.want(LIBRARY, [key("new", None)]);
        assert!(!cache.contains(&key("orphan", None)));
        assert!(cache.contains(&key("cut", None)));
        assert!(cache.contains(&key("new", None)));
        assert_eq!(cache.len(), 2);
    }

    #[test]
    fn an_answer_after_a_restart_still_goes_in() {
        let mut cache = PosterCache::<u32>::default();
        cache.fill(key("gone", None), Some(3));
        assert_eq!(cache.get("gone", None), Some(&3));
    }

    #[test]
    fn keep_drops_a_session_only_when_no_page_wants_it() {
        let mut cache = PosterCache::<u32>::default();
        cache.want(LIBRARY, [key("a", None), key("b", None)]);
        cache.want(CLEAN_CUT, [key("b", None), key("c", None)]);
        cache.fill(key("b", None), Some(2));

        // The Library no longer lists a or b: a goes, Clean cut keeps b.
        cache.keep(LIBRARY, |id| id == "c");
        assert!(!cache.contains(&key("a", None)));
        assert_eq!(cache.get("b", None), Some(&2));
        assert!(cache.contains(&key("c", None)));

        // Clean cut lets go of b too: nobody wants it.
        cache.keep(CLEAN_CUT, |id| id == "c");
        assert!(!cache.contains(&key("b", None)));
        assert!(cache.contains(&key("c", None)));
    }

    #[test]
    fn keep_drops_an_unwanted_answer_the_page_does_not_list() {
        let mut cache = PosterCache::<u32>::default();
        cache.fill(key("x", None), Some(1));
        cache.fill(key("y", None), Some(2));
        cache.keep(LIBRARY, |id| id == "y");
        assert!(!cache.contains(&key("x", None)));
        assert_eq!(cache.get("y", None), Some(&2));
    }

    #[test]
    fn keep_leaves_every_key_of_a_listed_session() {
        let mut cache = PosterCache::<u32>::default();
        cache.want(LIBRARY, [key("a", Some(1)), key("a", Some(2))]);
        cache.keep(LIBRARY, |id| id == "a");
        assert_eq!(cache.len(), 2);
    }
}
