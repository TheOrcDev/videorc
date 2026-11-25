//! Chat platform marks (`components/blocks/stream-manager/chat-platform.tsx`):
//! one name per platform, its glyph, and the brand tint tokens. Source and
//! platform marks are the one place saturated colour is allowed.

use gpui::Hsla;

use crate::{
    icon::IconName,
    theme::hsla,
    tokens::{Color, Theme, fixed},
};

/// A platform chat can come from.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum ChatPlatform {
    Youtube,
    Twitch,
    X,
    Facebook,
    Tiktok,
    Instagram,
    Kick,
    Custom,
}

impl ChatPlatform {
    /// One name per platform: "X", never "X / Twitter"; "Custom RTMP" for custom.
    pub fn label(self) -> &'static str {
        match self {
            Self::Youtube => "YouTube",
            Self::Twitch => "Twitch",
            Self::X => "X",
            Self::Facebook => "Facebook",
            Self::Tiktok => "TikTok",
            Self::Instagram => "Instagram",
            Self::Kick => "Kick",
            Self::Custom => "Custom RTMP",
        }
    }

    /// The mark glyph (tinted by [`Self::tint`]).
    pub fn icon(self) -> IconName {
        match self {
            Self::Youtube => IconName::YoutubeLogo,
            Self::Twitch => IconName::TwitchLogo,
            Self::X => IconName::XLogo,
            Self::Facebook => IconName::FacebookLogo,
            Self::Tiktok => IconName::TiktokLogo,
            Self::Instagram => IconName::InstagramLogo,
            Self::Kick => IconName::KickLogo,
            Self::Custom => IconName::Broadcast,
        }
    }

    /// Brand tint for the mark. X, TikTok and Custom follow the theme.
    pub fn tint(self, theme: &Theme) -> Color {
        match self {
            Self::Youtube => fixed::PLATFORM_YOUTUBE,
            Self::Twitch => fixed::PLATFORM_TWITCH_INK,
            Self::X | Self::Tiktok => theme.foreground,
            Self::Facebook => fixed::PLATFORM_FACEBOOK,
            Self::Instagram => fixed::PLATFORM_INSTAGRAM,
            Self::Kick => fixed::PLATFORM_KICK_INK,
            Self::Custom => theme.muted_foreground,
        }
    }

    /// [`Self::tint`] as an [`Hsla`] for `icon(...)`.
    pub fn tint_hsla(self, theme: &Theme) -> Hsla {
        hsla(self.tint(theme))
    }
}
