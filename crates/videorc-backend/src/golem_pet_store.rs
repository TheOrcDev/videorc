//! The Golem's pet packs as RPCs (plan 168 S-A3): `cohost.pet.list`,
//! `cohost.pet.import`, `cohost.pet.remove` and `cohost.pet.react`.
//!
//! Packs live under the managed golem roots main hands over as
//! `VIDEORC_MANAGED_GOLEM_ROOTS` (D3): the first root is written
//! (`<root>/<personaId>/pets/<uuid>/`), the second holds the read-only
//! bundled packs (`bundled:<name>`). Main copies a folder the user picked and
//! calls `cohost.pet.import` with its token; the backend validates and
//! decodes it ([`crate::golem_pet::import_pack`]) off the async runtime.
//! Every file operation runs in `spawn_blocking`.

use std::path::PathBuf;

use serde::{Deserialize, Serialize};

use crate::cohost::{CohostSettings, GolemAvatar};
use crate::golem_pet::{self, GolemPetSummary, PetError, PetRule};
use crate::protocol::CohostSettingsPatch;
use crate::state::AppState;

/// The pack was refused: the message is the reason the Golem tab shows.
pub const COHOST_PET_INVALID: &str = "cohost-pet-invalid";
/// No pack with that id for this persona.
pub const COHOST_PET_NOT_FOUND: &str = "cohost-pet-not-found";
/// This process has no golem roots (bare `cargo run`, unit tests).
pub const COHOST_PET_UNAVAILABLE: &str = "cohost-pet-unavailable";
/// The active pack has no reaction with that id.
pub const COHOST_PET_REACTION_UNKNOWN: &str = "cohost-pet-reaction-unknown";
/// A file operation failed (the message says which).
pub const COHOST_PET_STORE_FAILED: &str = "cohost-pet-store-failed";

/// `cohost.pet.import`: the folder main copied, as `<personaId>/pets/<packId>`
/// relative to the write root.
#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CohostPetImportParams {
    pub folder_token: String,
}

/// `cohost.pet.remove`.
#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CohostPetRemoveParams {
    pub pack_id: String,
}

/// What `cohost.pet.remove` hands back: the removed id and the settings
/// after it (the persona is Still again when the pack was the active one).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CohostPetRemoved {
    pub pack_id: String,
    pub settings: CohostSettings,
}

/// `cohost.pet.react`: a reaction id of the active pack.
#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CohostPetReactParams {
    pub reaction: String,
}

/// What `cohost.pet.react` hands back once the reaction was accepted.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CohostPetReactAccepted {
    pub reaction: String,
}

/// A refusal on the wire: an error code and one plain sentence.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PetRpcError {
    pub code: &'static str,
    pub message: String,
}

impl PetRpcError {
    fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
}

impl From<PetError> for PetRpcError {
    fn from(error: PetError) -> Self {
        let code = match error.rule {
            PetRule::PackNotFound => COHOST_PET_NOT_FOUND,
            PetRule::PackIo => COHOST_PET_STORE_FAILED,
            _ => COHOST_PET_INVALID,
        };
        Self::new(code, error.message)
    }
}

fn golem_roots() -> Vec<PathBuf> {
    crate::resource_authority::configured_managed_golem_roots()
}

async fn blocking<T: Send + 'static>(
    work: impl FnOnce() -> T + Send + 'static,
) -> Result<T, PetRpcError> {
    tokio::task::spawn_blocking(work).await.map_err(|error| {
        PetRpcError::new(
            COHOST_PET_STORE_FAILED,
            format!("The pack work stopped: {error}"),
        )
    })
}

async fn active_persona(state: &AppState) -> crate::cohost::CohostPersona {
    state.cohost.lock().await.settings().persona.clone()
}

/// `cohost.pet.list`: the bundled packs and the active persona's own. A
/// folder that fails its manifest is left out and logged.
pub async fn list(state: &AppState) -> Result<Vec<GolemPetSummary>, PetRpcError> {
    list_in(state, golem_roots()).await
}

async fn list_in(
    state: &AppState,
    roots: Vec<PathBuf>,
) -> Result<Vec<GolemPetSummary>, PetRpcError> {
    let persona_id = active_persona(state).await.id;
    let (packs, skipped) = blocking(move || golem_pet::list_packs(&roots, &persona_id)).await?;
    for note in skipped {
        state.emit_log("warn", note);
    }
    Ok(packs)
}

/// `<personaId>/pets/<packId>` taken apart, or `None`.
fn parse_folder_token(token: &str) -> Option<(&str, &str)> {
    let (persona_id, rest) = token.split_once('/')?;
    let pack_id = rest.strip_prefix("pets/")?;
    (!pack_id.contains('/')).then_some((persona_id, pack_id))
}

/// `cohost.pet.import` (main only): validate and decode the folder main
/// copied for the active persona, write its sidecar when it has none, and
/// return its summary. A refusal names its reason; main removes the copy.
pub async fn import(
    state: &AppState,
    params: CohostPetImportParams,
) -> Result<GolemPetSummary, PetRpcError> {
    import_in(state, golem_roots(), params).await
}

async fn import_in(
    state: &AppState,
    roots: Vec<PathBuf>,
    params: CohostPetImportParams,
) -> Result<GolemPetSummary, PetRpcError> {
    let Some((persona_id, pack_id)) = parse_folder_token(&params.folder_token) else {
        return Err(PetRpcError::new(
            COHOST_PET_INVALID,
            "The folder token is not `<personaId>/pets/<packId>`.",
        ));
    };
    let persona = active_persona(state).await;
    if persona.id != persona_id {
        return Err(PetRpcError::new(
            COHOST_PET_INVALID,
            "The pack was copied for another Golem. Try the import again.",
        ));
    }
    if roots.is_empty() {
        return Err(PetRpcError::new(
            COHOST_PET_UNAVAILABLE,
            "Golem storage is not configured in this process.",
        ));
    }
    let persona_id = persona_id.to_string();
    let pack_id = pack_id.to_string();
    let created_at = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true);
    let summary =
        blocking(move || golem_pet::import_pack(&roots, &persona_id, &pack_id, created_at))
            .await?
            .map_err(|error| {
                // The rule names which check refused it, for support bundles.
                state.emit_log(
                    "warn",
                    format!(
                        "Golem pack refused ({}): {}",
                        error.rule.as_str(),
                        error.message
                    ),
                );
                PetRpcError::from(error)
            })?;
    state.emit_log(
        "info",
        format!(
            "Golem pack imported: {} ({} poses).",
            summary.name,
            summary.gaze_count as usize + summary.reactions.len()
        ),
    );
    Ok(summary)
}

/// `cohost.pet.remove`: delete one of the persona's own packs. When it was
/// the active pack the persona switches to Still first, so the avatar never
/// names a pack that is gone.
pub async fn remove(
    state: &AppState,
    params: CohostPetRemoveParams,
) -> Result<CohostPetRemoved, PetRpcError> {
    remove_in(state, golem_roots(), params).await
}

async fn remove_in(
    state: &AppState,
    roots: Vec<PathBuf>,
    params: CohostPetRemoveParams,
) -> Result<CohostPetRemoved, PetRpcError> {
    let persona = active_persona(state).await;
    if roots.is_empty() {
        return Err(PetRpcError::new(
            COHOST_PET_UNAVAILABLE,
            "Golem storage is not configured in this process.",
        ));
    }
    // Refuse a bundled or malformed id before touching the persona.
    if !matches!(
        golem_pet::parse_pack_id(&params.pack_id)?,
        golem_pet::PackRef::User(_)
    ) {
        return Err(PetRpcError::new(
            COHOST_PET_INVALID,
            "Built-in packs cannot be removed.",
        ));
    }
    let wears_it =
        matches!(&persona.avatar, GolemAvatar::Alive { pack_id } if *pack_id == params.pack_id);
    let settings = if wears_it {
        let mut still = persona.clone();
        still.avatar = GolemAvatar::Still;
        crate::cohost::set_cohost_settings(
            state,
            CohostSettingsPatch {
                persona: Some(still),
                ..CohostSettingsPatch::default()
            },
        )
        .await
        .map_err(|error| PetRpcError::new(error.code(), error.to_string()))?
    } else {
        crate::cohost::get_cohost_settings(state).await
    };
    let persona_id = persona.id.clone();
    let pack_id = params.pack_id.clone();
    blocking(move || golem_pet::remove_pack(&roots, &persona_id, &pack_id)).await??;
    Ok(CohostPetRemoved {
        pack_id: params.pack_id,
        settings,
    })
}

/// The reaction ids of the persona's active pack: the still pack's
/// `talk`, `laugh` and `think` (S-A4), or the Alive pack's reaction frames.
async fn active_reactions(
    roots: Vec<PathBuf>,
    persona: &crate::cohost::CohostPersona,
) -> Result<Vec<String>, PetRpcError> {
    match &persona.avatar {
        GolemAvatar::Still => Ok(golem_pet::STILL_REACTION_IDS
            .iter()
            .map(|id| id.to_string())
            .collect()),
        GolemAvatar::Alive { pack_id } => {
            let persona_id = persona.id.clone();
            let pack_id = pack_id.clone();
            let manifest = blocking(move || {
                let dir = golem_pet::pack_dir(&roots, &persona_id, &pack_id)?;
                golem_pet::read_pack_manifest(&dir).map(|(manifest, _)| manifest)
            })
            .await??;
            Ok(manifest.reaction_ids())
        }
    }
}

/// `cohost.pet.react` (the preview's Try buttons, the Say box chips): play
/// one reaction of the active pack on air. The id is checked against the
/// active pack, then the reaction goes to the animator (`golem_animator`,
/// plan 168 S-C3), queued like any event reaction (D14).
pub async fn request_reaction(
    state: &AppState,
    reaction: &str,
) -> Result<CohostPetReactAccepted, PetRpcError> {
    request_reaction_in(state, golem_roots(), reaction).await
}

async fn request_reaction_in(
    state: &AppState,
    roots: Vec<PathBuf>,
    reaction: &str,
) -> Result<CohostPetReactAccepted, PetRpcError> {
    let persona = active_persona(state).await;
    let reactions = active_reactions(roots, &persona).await?;
    if !reactions.iter().any(|id| id == reaction) {
        return Err(PetRpcError::new(
            COHOST_PET_REACTION_UNKNOWN,
            format!("The Golem's pack has no {reaction} reaction."),
        ));
    }
    // Queued like any event reaction (D14): it plays after the one on air.
    state
        .golem_sprite
        .notify(crate::golem_animator::GolemAnimatorEvent::React {
            reaction: reaction.to_string(),
        });
    Ok(CohostPetReactAccepted {
        reaction: reaction.to_string(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cohost::{CohostPersona, get_cohost_settings, set_cohost_settings};
    use crate::golem_pet::tests::{PACK_ID, synthetic_manifest, temp_roots, write_pack};
    use crate::storage::Database;
    use tokio::sync::broadcast;

    fn test_state() -> AppState {
        let (events, _) = broadcast::channel(64);
        AppState::new(
            "test-token".to_string(),
            1234,
            events,
            Database::open_in_memory_for_tests(),
        )
    }

    async fn wear(state: &AppState, avatar: GolemAvatar) {
        set_cohost_settings(
            state,
            CohostSettingsPatch {
                persona: Some(CohostPersona {
                    avatar,
                    ..CohostPersona::default()
                }),
                ..CohostSettingsPatch::default()
            },
        )
        .await
        .unwrap();
    }

    fn pack_folder(roots: &[PathBuf], persona_id: &str, pack_id: &str) -> PathBuf {
        roots[0].join(persona_id).join("pets").join(pack_id)
    }

    #[tokio::test]
    async fn golem_pet_store_imports_reacts_and_removes_the_active_pack() {
        let state = test_state();
        let roots = temp_roots();
        let persona_id = CohostPersona::default().id;
        write_pack(
            &pack_folder(&roots, &persona_id, PACK_ID),
            &synthetic_manifest("mascot.png"),
            "mascot.png",
        );

        // The token must name the active persona's folder.
        let refused = import_in(
            &state,
            roots.clone(),
            CohostPetImportParams {
                folder_token: format!("someone-else/pets/{PACK_ID}"),
            },
        )
        .await
        .unwrap_err();
        assert_eq!(refused.code, COHOST_PET_INVALID);
        let refused = import_in(
            &state,
            roots.clone(),
            CohostPetImportParams {
                folder_token: PACK_ID.to_string(),
            },
        )
        .await
        .unwrap_err();
        assert_eq!(refused.code, COHOST_PET_INVALID);
        let summary = import_in(
            &state,
            roots.clone(),
            CohostPetImportParams {
                folder_token: format!("{persona_id}/pets/{PACK_ID}"),
            },
        )
        .await
        .unwrap();
        assert_eq!(summary.pack_id, PACK_ID);
        assert_eq!(list_in(&state, roots.clone()).await.unwrap(), vec![summary]);

        // Still: the state images are the reactions.
        for id in ["talk", "laugh", "think"] {
            assert_eq!(
                request_reaction_in(&state, roots.clone(), id)
                    .await
                    .unwrap()
                    .reaction,
                id
            );
        }
        let unknown = request_reaction_in(&state, roots.clone(), "wave")
            .await
            .unwrap_err();
        assert_eq!(unknown.code, COHOST_PET_REACTION_UNKNOWN);

        // Alive: the pack's reaction frames, never its gaze cells.
        wear(
            &state,
            GolemAvatar::Alive {
                pack_id: PACK_ID.to_string(),
            },
        )
        .await;
        assert!(
            request_reaction_in(&state, roots.clone(), "laugh")
                .await
                .is_ok()
        );
        assert!(
            request_reaction_in(&state, roots.clone(), "talk-a")
                .await
                .is_ok()
        );
        for id in ["think", "center"] {
            assert_eq!(
                request_reaction_in(&state, roots.clone(), id)
                    .await
                    .unwrap_err()
                    .code,
                COHOST_PET_REACTION_UNKNOWN
            );
        }

        // Removing the worn pack switches the persona to Still.
        let removed = remove_in(
            &state,
            roots.clone(),
            CohostPetRemoveParams {
                pack_id: PACK_ID.to_string(),
            },
        )
        .await
        .unwrap();
        assert_eq!(removed.settings.persona.avatar, GolemAvatar::Still);
        assert_eq!(
            get_cohost_settings(&state).await.persona.avatar,
            GolemAvatar::Still
        );
        assert!(!pack_folder(&roots, &persona_id, PACK_ID).exists());
        assert!(list_in(&state, roots.clone()).await.unwrap().is_empty());
        let gone = remove_in(
            &state,
            roots.clone(),
            CohostPetRemoveParams {
                pack_id: PACK_ID.to_string(),
            },
        )
        .await
        .unwrap_err();
        assert_eq!(gone.code, COHOST_PET_NOT_FOUND);
        let bundled = remove_in(
            &state,
            roots.clone(),
            CohostPetRemoveParams {
                pack_id: "bundled:golem".to_string(),
            },
        )
        .await
        .unwrap_err();
        assert_eq!(bundled.code, COHOST_PET_INVALID);
        let _ = std::fs::remove_dir_all(roots[0].parent().unwrap());
    }

    #[tokio::test]
    async fn golem_pet_store_without_roots_says_so() {
        let state = test_state();
        let unavailable = import_in(
            &state,
            Vec::new(),
            CohostPetImportParams {
                folder_token: format!("default/pets/{PACK_ID}"),
            },
        )
        .await
        .unwrap_err();
        assert_eq!(unavailable.code, COHOST_PET_UNAVAILABLE);
        assert!(list_in(&state, Vec::new()).await.unwrap().is_empty());
    }

    fn high_risk_fixture(pointer: &str) -> serde_json::Value {
        let fixture: serde_json::Value = serde_json::from_str(include_str!(
            "../../../protocol-fixtures/high-risk-contracts.json"
        ))
        .expect("shared high-risk protocol fixture must be valid JSON");
        fixture
            .pointer(pointer)
            .unwrap_or_else(|| panic!("shared protocol fixture is missing {pointer}"))
            .clone()
    }

    /// The pet RPC shapes round-trip exactly as the TypeScript contract
    /// validates them (plan 168, Phase A).
    #[test]
    fn shared_high_risk_contract_fixture_matches_golem_pet_dtos() {
        for pointer in ["/golemPets/summary", "/golemPets/bundledSummary"] {
            let wire = high_risk_fixture(pointer);
            let summary: GolemPetSummary = serde_json::from_value(wire.clone()).unwrap();
            assert_eq!(serde_json::to_value(summary).unwrap(), wire, "{pointer}");
        }
        let wire = high_risk_fixture("/golemPets/importParams");
        let params: CohostPetImportParams = serde_json::from_value(wire.clone()).unwrap();
        assert_eq!(
            parse_folder_token(&params.folder_token).unwrap().0,
            "default"
        );
        assert_eq!(serde_json::to_value(params).unwrap(), wire);
        let wire = high_risk_fixture("/golemPets/removeParams");
        let params: CohostPetRemoveParams = serde_json::from_value(wire.clone()).unwrap();
        assert_eq!(serde_json::to_value(params).unwrap(), wire);
        let wire = high_risk_fixture("/golemPets/reactParams");
        let params: CohostPetReactParams = serde_json::from_value(wire.clone()).unwrap();
        assert_eq!(serde_json::to_value(params).unwrap(), wire);
        let wire = high_risk_fixture("/golemPets/reactAccepted");
        let accepted: CohostPetReactAccepted = serde_json::from_value(wire.clone()).unwrap();
        assert_eq!(serde_json::to_value(accepted).unwrap(), wire);
        // The persona's avatar rides the settings fixtures (Still by default).
        assert_eq!(
            high_risk_fixture("/cohost/settings/persona/avatar"),
            serde_json::json!({ "kind": "still" })
        );
        let patch: CohostSettingsPatch =
            serde_json::from_value(high_risk_fixture("/cohost/settingsPatch")).unwrap();
        assert_eq!(
            patch.persona.unwrap().avatar,
            GolemAvatar::Alive {
                pack_id: "0b1e9f0e-6c8a-4c55-9a3f-3f6d2b1c4e5a".to_string()
            }
        );
    }

    #[test]
    fn golem_pet_store_params_refuse_unknown_fields() {
        assert!(
            serde_json::from_value::<CohostPetReactParams>(
                serde_json::json!({ "reaction": "laugh", "extra": 1 })
            )
            .is_err()
        );
        assert!(
            serde_json::from_value::<CohostPetImportParams>(
                serde_json::json!({ "folderToken": "a" })
            )
            .is_ok()
        );
    }
}
