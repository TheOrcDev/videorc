use crate::protocol::{
    AudioTrack, RecordingContainer, RecordingFinalizationState, RecordingPipelineStage,
    RecordingPipelineStageState, RecordingPipelineStageStatus, RecordingPipelineStatus,
};

#[derive(Debug, Clone)]
pub struct RecordingPipeline {
    status: RecordingPipelineStatus,
}

impl RecordingPipeline {
    pub fn new(record_enabled: bool, stream_enabled: bool, audio_tracks: &[AudioTrack]) -> Self {
        let has_audio = !audio_tracks.is_empty();
        let stages = vec![
            stage(
                RecordingPipelineStage::Capture,
                RecordingPipelineStageState::Starting,
                None,
            ),
            stage(
                RecordingPipelineStage::Render,
                RecordingPipelineStageState::Starting,
                None,
            ),
            stage(
                RecordingPipelineStage::VideoEncoder,
                RecordingPipelineStageState::Starting,
                None,
            ),
            stage(
                RecordingPipelineStage::AudioEncoder,
                if has_audio {
                    RecordingPipelineStageState::Starting
                } else {
                    RecordingPipelineStageState::Skipped
                },
                if has_audio {
                    None
                } else {
                    Some("No audio source selected.".to_string())
                },
            ),
            stage(
                RecordingPipelineStage::Muxer,
                RecordingPipelineStageState::Starting,
                None,
            ),
        ];

        Self {
            status: RecordingPipelineStatus {
                container: container_for_outputs(record_enabled, stream_enabled),
                finalization: RecordingFinalizationState::None,
                stages,
            },
        }
    }

    pub fn status(&self) -> RecordingPipelineStatus {
        self.status.clone()
    }

    pub fn mark_running(&mut self) {
        self.status.finalization = RecordingFinalizationState::None;
        for stage in &mut self.status.stages {
            if stage.state != RecordingPipelineStageState::Skipped {
                stage.state = RecordingPipelineStageState::Running;
                stage.detail = None;
            }
        }
    }

    pub fn mark_finalizing(&mut self, detail: impl Into<String>) {
        self.status.finalization = RecordingFinalizationState::Finalizing;
        let detail = detail.into();
        for stage in &mut self.status.stages {
            match stage.stage {
                RecordingPipelineStage::Muxer => {
                    stage.state = RecordingPipelineStageState::Finalizing;
                    stage.detail = Some(detail.clone());
                }
                RecordingPipelineStage::AudioEncoder
                    if stage.state == RecordingPipelineStageState::Skipped => {}
                _ => {
                    stage.state = RecordingPipelineStageState::Finished;
                    stage.detail = None;
                }
            }
        }
    }

    pub fn mark_finished(&mut self) {
        self.status.finalization = RecordingFinalizationState::Finalized;
        for stage in &mut self.status.stages {
            if stage.state != RecordingPipelineStageState::Skipped {
                stage.state = RecordingPipelineStageState::Finished;
                stage.detail = None;
            }
        }
    }

    pub fn mark_failed(&mut self, failed_stage: RecordingPipelineStage, detail: impl Into<String>) {
        self.status.finalization = RecordingFinalizationState::Failed;
        let detail = detail.into();
        for stage in &mut self.status.stages {
            if stage.stage == failed_stage {
                stage.state = RecordingPipelineStageState::Failed;
                stage.detail = Some(detail.clone());
            } else if stage.state != RecordingPipelineStageState::Skipped {
                stage.state = RecordingPipelineStageState::Finished;
                stage.detail = None;
            }
        }
    }
}

pub fn container_for_outputs(record_enabled: bool, stream_enabled: bool) -> RecordingContainer {
    match (record_enabled, stream_enabled) {
        (true, true) => RecordingContainer::Tee,
        (true, false) => RecordingContainer::Mkv,
        (false, true) => RecordingContainer::Flv,
        (false, false) => RecordingContainer::None,
    }
}

pub fn container_key(container: &RecordingContainer) -> &'static str {
    match container {
        RecordingContainer::None => "none",
        RecordingContainer::Mkv => "mkv",
        RecordingContainer::Flv => "flv",
        RecordingContainer::Tee => "tee",
    }
}

fn stage(
    stage: RecordingPipelineStage,
    state: RecordingPipelineStageState,
    detail: Option<String>,
) -> RecordingPipelineStageStatus {
    RecordingPipelineStageStatus {
        stage,
        state,
        detail,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::AudioTrackSource;

    fn microphone_track() -> AudioTrack {
        AudioTrack {
            id: "microphone".to_string(),
            label: "Microphone".to_string(),
            source: AudioTrackSource::Microphone,
        }
    }

    #[test]
    fn dual_output_pipeline_uses_tee_container() {
        let pipeline = RecordingPipeline::new(true, true, &[microphone_track()]);
        let status = pipeline.status();

        assert_eq!(status.container, RecordingContainer::Tee);
        assert_eq!(status.finalization, RecordingFinalizationState::None);
        assert!(
            status
                .stages
                .iter()
                .all(|stage| { stage.state == RecordingPipelineStageState::Starting })
        );
    }

    #[test]
    fn no_audio_pipeline_skips_audio_encoder() {
        let pipeline = RecordingPipeline::new(true, false, &[]);
        let status = pipeline.status();
        let audio = status
            .stages
            .iter()
            .find(|stage| stage.stage == RecordingPipelineStage::AudioEncoder)
            .unwrap();

        assert_eq!(status.container, RecordingContainer::Mkv);
        assert_eq!(audio.state, RecordingPipelineStageState::Skipped);
        assert_eq!(audio.detail.as_deref(), Some("No audio source selected."));
    }

    #[test]
    fn stop_finalization_marks_only_muxer_as_finalizing() {
        let mut pipeline = RecordingPipeline::new(true, false, &[microphone_track()]);

        pipeline.mark_running();
        pipeline.mark_finalizing("Flushing file.");
        let status = pipeline.status();

        assert_eq!(status.finalization, RecordingFinalizationState::Finalizing);
        assert_eq!(
            status
                .stages
                .iter()
                .find(|stage| stage.stage == RecordingPipelineStage::Muxer)
                .unwrap()
                .state,
            RecordingPipelineStageState::Finalizing
        );
        assert_eq!(
            status
                .stages
                .iter()
                .find(|stage| stage.stage == RecordingPipelineStage::Capture)
                .unwrap()
                .state,
            RecordingPipelineStageState::Finished
        );
    }

    #[test]
    fn failed_pipeline_records_failed_stage_detail() {
        let mut pipeline = RecordingPipeline::new(true, false, &[microphone_track()]);

        pipeline.mark_running();
        pipeline.mark_failed(
            RecordingPipelineStage::Muxer,
            "FFmpeg exited with status 1.",
        );
        let status = pipeline.status();
        let muxer = status
            .stages
            .iter()
            .find(|stage| stage.stage == RecordingPipelineStage::Muxer)
            .unwrap();

        assert_eq!(status.finalization, RecordingFinalizationState::Failed);
        assert_eq!(muxer.state, RecordingPipelineStageState::Failed);
        assert_eq!(
            muxer.detail.as_deref(),
            Some("FFmpeg exited with status 1.")
        );
    }
}
