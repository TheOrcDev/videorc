//! The source choice (plan 260: this part lands in S1.6b with the scenes
//! and sources). S1.6a holds only the kind of picker, which a toast's Use
//! it names (`NoticeAction::UseSource`).

/// `SessionSourceKind`: what one picker chooses.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum SourceKind {
    Capture,
    Camera,
    Microphone,
}

impl SourceKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Capture => "capture",
            Self::Camera => "camera",
            Self::Microphone => "microphone",
        }
    }

    pub fn parse(text: &str) -> Option<Self> {
        match text {
            "capture" => Some(Self::Capture),
            "camera" => Some(Self::Camera),
            "microphone" => Some(Self::Microphone),
            _ => None,
        }
    }
}
