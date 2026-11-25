//! Composer completions for the Stream Manager (`chat-pane.tsx` P976): the
//! slash list and a bare `!` row. Named `!` replies wait on Studio's chat
//! commands driver.

/// One completion row: the value to insert and a short hint.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ComposerCompletion {
    pub value: &'static str,
    pub hint: &'static str,
}

/// The composer's own slash commands, in offer order.
pub const COMPOSER_COMMANDS: &[ComposerCompletion] = &[
    ComposerCompletion {
        value: "/hide",
        hint: " · Hide screen",
    },
    ComposerCompletion {
        value: "/show",
        hint: " · Show screen",
    },
    ComposerCompletion {
        value: "/marker",
        hint: " [title] · Save a timeline point",
    },
    ComposerCompletion {
        value: "/clip",
        hint: " · Save the last seconds as a clip",
    },
    ComposerCompletion {
        value: "/clip 60",
        hint: " · Save the last minute as a clip",
    },
    ComposerCompletion {
        value: "/banner",
        hint: " [name] · Show or hide a banner",
    },
    ComposerCompletion {
        value: "/sound",
        hint: " [name] · Play a sound",
    },
    ComposerCompletion {
        value: "/sidekick",
        hint: " [words] · Ask Sidekick",
    },
    ComposerCompletion {
        value: "/buddy",
        hint: " [words] · Ask Sidekick",
    },
    ComposerCompletion {
        value: "/help",
        hint: " · Command help",
    },
];

/// The completion row that opens the chat command editor (plan 226).
pub const EDIT_CHAT_COMMANDS: &str = "edit-chat-commands";

/// Completions for the current draft: slash prefix match, or the edit row
/// under a bare `!`. Empty when the draft is ordinary chat.
pub fn composer_completions(draft: &str) -> Vec<ComposerCompletion> {
    let trimmed = draft.trim_start();
    if trimmed.is_empty() {
        return Vec::new();
    }
    if trimmed.starts_with('!') {
        // `!!` escapes to literal chat; a named `!go` is ordinary until the
        // chat-commands driver lands — only a bare `!` offers the editor row.
        if trimmed == "!" {
            return vec![ComposerCompletion {
                value: EDIT_CHAT_COMMANDS,
                hint: " · Edit chat commands…",
            }];
        }
        return Vec::new();
    }
    if !trimmed.starts_with('/') {
        return Vec::new();
    }
    // A leading `//` is escaped chat.
    if trimmed.starts_with("//") {
        return Vec::new();
    }
    let needle = trimmed.to_ascii_lowercase();
    COMPOSER_COMMANDS
        .iter()
        .filter(|row| row.value.to_ascii_lowercase().starts_with(&needle))
        .cloned()
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn slash_prefix_filters_and_bang_offers_edit() {
        let hide = composer_completions("/hi");
        assert_eq!(hide.len(), 1);
        assert_eq!(hide[0].value, "/hide");
        assert!(composer_completions("hello").is_empty());
        assert!(composer_completions("//hide").is_empty());
        let bang = composer_completions("!");
        assert_eq!(bang[0].value, EDIT_CHAT_COMMANDS);
        assert!(composer_completions("!go").is_empty());
    }
}
