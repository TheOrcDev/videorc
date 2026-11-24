//! The main window's pages, as the rest of the core names them (plan 260
//! S1.6a, L7): today's `WorkspaceTab` ids (`components/workspace-nav.tsx`)
//! and the names `shared/sidebar-pages.ts` gives them.
//!
//! Only what the core's other modules read lands here for now: a toast's
//! door to a page ([`crate::notices::NoticeAction::OpenPage`]). The sidebar's
//! zones and keys are the app menu's (`desktop::menu`, L4); videorc-rust's
//! navigation from outside a page, the shell's chords and the stored theme
//! (`nav.rs` there) wait for the shell (S2.1), caught up then with today's
//! sidebar of 2026-11-20.

/// A page of the main window (`WorkspaceTab`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum PageId {
    Studio,
    Sources,
    /// Scene (id `layouts`).
    Layouts,
    Captions,
    /// Output (id `recording`).
    Recording,
    /// Destinations (id `live`).
    Live,
    Guests,
    Avatar,
    /// Sidekick (id `ai`).
    Ai,
    /// Images (id `assets`).
    Assets,
    Sounds,
    Library,
    Settings,
    /// Health: no sidebar row and no key.
    Diagnostics,
}

/// Every page: the sidebar's rows top to bottom (`SIDEBAR_LAYOUT`), then
/// Health.
pub const PAGES: [PageId; 14] = [
    PageId::Studio,
    PageId::Sources,
    PageId::Layouts,
    PageId::Captions,
    PageId::Recording,
    PageId::Live,
    PageId::Guests,
    PageId::Avatar,
    PageId::Ai,
    PageId::Assets,
    PageId::Sounds,
    PageId::Library,
    PageId::Settings,
    PageId::Diagnostics,
];

impl PageId {
    /// The id `openWorkspaceTab`, deep links and the smokes use.
    pub fn id(self) -> &'static str {
        match self {
            PageId::Studio => "studio",
            PageId::Sources => "sources",
            PageId::Layouts => "layouts",
            PageId::Captions => "captions",
            PageId::Recording => "recording",
            PageId::Live => "live",
            PageId::Guests => "guests",
            PageId::Avatar => "avatar",
            PageId::Ai => "ai",
            PageId::Assets => "assets",
            PageId::Sounds => "sounds",
            PageId::Library => "library",
            PageId::Settings => "settings",
            PageId::Diagnostics => "diagnostics",
        }
    }

    pub fn parse(id: &str) -> Option<PageId> {
        PAGES.into_iter().find(|page| page.id() == id)
    }

    /// `SIDEBAR_PAGE_LABELS`, and Health's own.
    pub fn label(self) -> &'static str {
        match self {
            PageId::Studio => "Studio",
            PageId::Sources => "Sources",
            PageId::Layouts => "Scene",
            PageId::Captions => "Captions",
            PageId::Recording => "Output",
            PageId::Live => "Destinations",
            PageId::Guests => "Guests",
            PageId::Avatar => "Avatar",
            PageId::Ai => "Sidekick",
            PageId::Assets => "Images",
            PageId::Sounds => "Sounds",
            PageId::Library => "Library",
            PageId::Settings => "Settings",
            PageId::Diagnostics => "Health",
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_page_reads_back_from_its_id_with_today_s_names() {
        for page in PAGES {
            assert_eq!(PageId::parse(page.id()), Some(page));
        }
        assert_eq!(PageId::parse("streaming"), None);
        assert_eq!(PageId::Live.label(), "Destinations");
        assert_eq!(PageId::Ai.label(), "Sidekick");
        assert_eq!(PageId::Assets.label(), "Images");
        assert_eq!(PageId::Recording.label(), "Output");
    }

    /// The sidebar's rows are the View menu's pages, in the same order (the
    /// menu leaves Settings to the App menu).
    #[test]
    fn the_rows_match_the_app_menu() {
        let menu: Vec<&str> = crate::desktop::menu::PAGE_GROUPS
            .iter()
            .flat_map(|group| group.iter().map(|page| page.title))
            .collect();
        let rows: Vec<&str> = PAGES[..12].iter().map(|page| page.label()).collect();
        assert_eq!(rows, menu);
        assert_eq!(PAGES[12], PageId::Settings);
    }
}
