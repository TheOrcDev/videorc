//! Plan 258 S5 (`camera-background-art.ts`): what the camera looks like on
//! stream with each Background pick, as data. The app draws it (the Orc over
//! the pick's room, blur, picture or screen colour) on the tiles, on the
//! popover's "What viewers see" until a frame arrives, and on the Camera
//! row's trigger; this module draws nothing.

use super::camera_background_view::{ChoiceId, Image};

/// How much the room behind the Orc is blurred.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BlurStrength {
    Slight,
    Strong,
}

/// The screen behind the Orc.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ScreenColor {
    Green,
    Blue,
}

impl ScreenColor {
    /// `SCREEN_FILL`, as `0xRRGGBBAA`. These are on-stream pixels, so they
    /// don't follow the app theme.
    pub fn fill(self) -> u32 {
        match self {
            ScreenColor::Green => 0x1fae_4bff,
            ScreenColor::Blue => 0x2456_d6ff,
        }
    }
}

/// `CameraBackgroundArtKind`: the one layer behind the Orc.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Art {
    /// His own studio, sharp.
    Room,
    /// His studio blurred (the Orc stays sharp, like the real effect).
    Blur(BlurStrength),
    /// The pick's own picture: its file.
    Picture(String),
    Screen(ScreenColor),
}

/// `choiceArt`: the picture a tile shows for its pick.
pub fn choice_art(id: &ChoiceId, picture: Option<&str>) -> Art {
    match id {
        ChoiceId::Off => Art::Room,
        ChoiceId::SlightBlur => Art::Blur(BlurStrength::Slight),
        ChoiceId::StrongBlur => Art::Blur(BlurStrength::Strong),
        ChoiceId::Green => Art::Screen(ScreenColor::Green),
        ChoiceId::Blue => Art::Screen(ScreenColor::Blue),
        ChoiceId::Image(_) => picture
            .filter(|picture| !picture.is_empty())
            .map_or(Art::Room, |picture| Art::Picture(picture.to_string())),
    }
}

/// `currentArt`: the art of the camera's pick (Off for a pick no tile
/// shows), a picture's file found in `images`. `images` is only asked for
/// when the pick is a picture.
pub fn current_art(choice: Option<&ChoiceId>, images: impl FnOnce() -> Vec<Image>) -> Art {
    match choice {
        Some(ChoiceId::Image(asset_id)) => {
            let picture = images()
                .into_iter()
                .find(|image| &image.asset_id == asset_id)
                .and_then(|image| image.picture);
            choice_art(&ChoiceId::Image(asset_id.clone()), picture.as_deref())
        }
        Some(choice) => choice_art(choice, None),
        None => Art::Room,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn each_pick_has_its_own_layer_behind_the_orc() {
        assert_eq!(choice_art(&ChoiceId::Off, None), Art::Room);
        assert_eq!(
            choice_art(&ChoiceId::SlightBlur, None),
            Art::Blur(BlurStrength::Slight)
        );
        assert_eq!(
            choice_art(&ChoiceId::StrongBlur, None),
            Art::Blur(BlurStrength::Strong)
        );
        assert_eq!(
            choice_art(&ChoiceId::Green, None),
            Art::Screen(ScreenColor::Green)
        );
        assert_eq!(
            choice_art(&ChoiceId::Blue, None),
            Art::Screen(ScreenColor::Blue)
        );
        // A tile's own picture never changes what a blur or a screen shows.
        assert_eq!(
            choice_art(&ChoiceId::Green, Some("/p/a.webp")),
            Art::Screen(ScreenColor::Green)
        );
    }

    #[test]
    fn a_picture_shows_itself_and_one_without_a_file_shows_the_room() {
        let id = ChoiceId::Image("code-demo".into());
        assert_eq!(
            choice_art(&id, Some("/p/code-demo.webp")),
            Art::Picture("/p/code-demo.webp".into())
        );
        assert_eq!(choice_art(&id, None), Art::Room);
        assert_eq!(choice_art(&id, Some("")), Art::Room);
    }

    #[test]
    fn the_screen_colours_are_electrons() {
        assert_eq!(ScreenColor::Green.fill(), 0x1fae4bff);
        assert_eq!(ScreenColor::Blue.fill(), 0x2456d6ff);
    }

    #[test]
    fn the_current_pick_finds_its_picture_and_asks_for_images_only_then() {
        let images = || {
            vec![
                Image {
                    asset_id: "a".into(),
                    name: "A".into(),
                    picture: Some("/p/a.webp".into()),
                },
                Image {
                    asset_id: "b".into(),
                    name: "B".into(),
                    picture: None,
                },
            ]
        };
        assert_eq!(
            current_art(Some(&ChoiceId::Image("a".into())), images),
            Art::Picture("/p/a.webp".into())
        );
        assert_eq!(
            current_art(Some(&ChoiceId::Image("b".into())), images),
            Art::Room
        );
        assert_eq!(
            current_art(Some(&ChoiceId::Image("gone".into())), images),
            Art::Room
        );
        let never = || -> Vec<Image> { panic!("only a picture asks for the images") };
        assert_eq!(
            current_art(Some(&ChoiceId::StrongBlur), never),
            Art::Blur(BlurStrength::Strong)
        );
        assert_eq!(current_art(None, never), Art::Room);
    }
}
