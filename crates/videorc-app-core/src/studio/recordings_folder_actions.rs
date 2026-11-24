//! Where recordings go, in the Studio (plan 260 S1.6a part 6b, from
//! `videorc-rust`'s plan 220 S3.6b): the stored folder
//! (`videorc.recordingsFolder`, P3-D1), its choice and Use default, its
//! facts for the pages that show them, and the capability every start
//! carries ([`super::recordings_folder`]).

use std::future::Future;
use std::path::PathBuf;
use std::pin::Pin;
use std::sync::Arc;

use super::Studio;
use super::backend::StudioBackend;
use super::recordings_folder::{
    DirectoryFacts, StoredFolder, copy, directory_facts, folder_missing,
};
use super::settings::{SettingWrite, keys};

/// Issues the `output-directory` capability for a path on the admin
/// credential (the app's `Resources::authorize_output_directory`), or why
/// it couldn't. The app sets it once at launch
/// ([`Studio::set_output_authorizer`]).
pub type OutputAuthorizer = Arc<
    dyn Fn(PathBuf) -> Pin<Box<dyn Future<Output = Result<String, String>> + Send>> + Send + Sync,
>;

/// What a start sends for the folder: nothing (the backend's default), or
/// the chosen folder's capability; `Err` refuses the start with its words.
pub(super) type FolderCapability = Result<Option<String>, String>;

impl<B: StudioBackend> Studio<B> {
    /// The chosen folder, from the store; `None` is the default folder.
    pub fn recordings_folder(&self) -> Option<StoredFolder> {
        StoredFolder::read(&self.lock().settings)
    }

    /// The app's capability issuer (set once at launch).
    pub fn set_output_authorizer(&self, authorize: OutputAuthorizer) {
        *self
            .output_authorizer
            .lock()
            .unwrap_or_else(|e| e.into_inner()) = Some(authorize);
    }

    /// Choose…'s answer: the folder, kept as a plain path.
    pub async fn set_recordings_folder(&self, folder: StoredFolder) {
        self.write_folder(SettingWrite::Put {
            key: keys::RECORDINGS_FOLDER.to_string(),
            value: super::settings::encode(&folder),
        })
        .await;
    }

    /// Use default: recordings go to the backend's default folder again.
    pub async fn use_default_recordings_folder(&self) {
        self.write_folder(SettingWrite::Delete {
            key: keys::RECORDINGS_FOLDER.to_string(),
        })
        .await;
    }

    async fn write_folder(&self, write: SettingWrite) {
        if let Err(error) = self.write_settings(vec![write]).await {
            self.config.logger.warn(format!(
                "Studio: the recordings folder was not saved: {}",
                error.message
            ));
        }
    }

    /// `checkDirectory(handle)`: the chosen folder's facts, for the Output
    /// page's row and the Library's free space (read when they open and when
    /// the folder changes; never at launch, as in Electron). The answer
    /// lands in the snapshot only while that folder is still the chosen one.
    pub async fn read_recordings_folder_facts(&self) -> Option<DirectoryFacts> {
        let folder = self.recordings_folder()?;
        let path = folder.path.clone();
        let facts = tokio::task::spawn_blocking(move || directory_facts(&path))
            .await
            .ok()?;
        let current = {
            let mut inner = self.lock();
            let current = StoredFolder::read(&inner.settings)
                .is_some_and(|chosen| chosen.path == folder.path);
            if current {
                inner.recordings_folder_facts = Some((folder.path.clone(), facts));
            }
            current
        };
        if !current {
            return None;
        }
        self.publish();
        Some(facts)
    }

    /// `authorizeOutputDirectory` before a start: the chosen folder's
    /// capability, or the refusal: the folder gone (by name, as main's
    /// `DirectoryUnavailableError` says it), or no capability to be had (no
    /// issuer in this run, or the issuer refused).
    pub(super) async fn recordings_folder_capability(&self) -> FolderCapability {
        let Some(folder) = self.recordings_folder() else {
            return Ok(None);
        };
        let path = folder.path.clone();
        let missing = tokio::task::spawn_blocking(move || folder_missing(&path))
            .await
            .unwrap_or(false);
        if missing {
            self.config.logger.warn(format!(
                "Studio: the recordings folder {} is gone.",
                folder.path.display()
            ));
            return Err(copy::folder_missing(&folder.name()));
        }
        let authorize = self
            .output_authorizer
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone();
        let Some(authorize) = authorize else {
            return Err(copy::FOLDER_UNAVAILABLE.to_string());
        };
        match authorize(folder.path.clone()).await {
            Ok(capability) => Ok(Some(capability)),
            Err(error) => {
                self.config.logger.warn(format!(
                    "Studio: the recordings folder could not be authorized: {error}"
                ));
                Err(copy::FOLDER_UNAVAILABLE.to_string())
            }
        }
    }
}
