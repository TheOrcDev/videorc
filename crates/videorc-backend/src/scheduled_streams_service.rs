use crate::{
    scheduled_streams::*,
    scheduled_youtube::{self, YouTubeEvents},
    state::AppState,
    streaming::StreamPlatform,
};
use anyhow::{Context, Result, bail};
use chrono::Utc;
use serde_json::{Value, json};

pub async fn api(state: &AppState, account_id: &str) -> Result<YouTubeEvents> {
    if let Some(message) = crate::oauth::provider_oauth_unavailable_message(StreamPlatform::Youtube)
    {
        bail!("{message}");
    }
    #[cfg(debug_assertions)]
    if account_id == "scheduled-smoke-channel"
        && let Some(base) = smoke_api_base()?
    {
        return Ok(YouTubeEvents {
            client: reqwest::Client::new(),
            token: "local-fixture-only".into(),
            base,
            refresh_context: None,
        });
    }
    let credential = crate::youtube_account_credentials(state, Some(account_id))?;
    if credential.account.account_id != account_id {
        bail!("Reconnect the exact scheduled channel.");
    }
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(20))
        .build()?;
    let fresh = crate::fresh_platform_access_token(state, &credential, &client).await?;
    Ok(YouTubeEvents {
        client,
        token: fresh.access_token,
        base: "https://www.googleapis.com".into(),
        refresh_context: if fresh.refreshed {
            None
        } else {
            Some((state.clone(), credential))
        },
    })
}

pub async fn dispatch(state: &AppState, method: &str, params: Value) -> Result<Value> {
    let action = method
        .strip_prefix("scheduledStreams.")
        .context("Invalid scheduling method")?;
    match action {
        "capabilities" => {
            return Ok(
                json!({"provider":"youtube","available":crate::oauth::provider_oauth_unavailable_message(StreamPlatform::Youtube).is_none(),"reason":crate::oauth::provider_oauth_unavailable_message(StreamPlatform::Youtube),"accounts":state.database.list_platform_accounts()?.into_iter().filter(|a|a.platform==StreamPlatform::Youtube).collect::<Vec<_>>(),"fields":["title","description","thumbnail","time","privacy","audience"],"audienceEditable":false}),
            );
        }
        "list" => {
            return Ok(serde_json::to_value(
                state
                    .database
                    .scheduled_events()?
                    .into_iter()
                    .map(ScheduledStreamEvent::public)
                    .collect::<Vec<_>>(),
            )?);
        }
        "get" => {
            return Ok(serde_json::to_value(
                state
                    .database
                    .scheduled_event(params["eventId"].as_str().context("Event ID required")?)?
                    .public(),
            )?);
        }
        "operation" => {
            return Ok(serde_json::to_value(
                state.database.scheduled_operation(
                    params["operationId"]
                        .as_str()
                        .context("Operation ID required")?,
                )?,
            )?);
        }
        "resolveTime" => {
            let utc = resolve_time(
                params["localStart"].as_str().unwrap_or(""),
                params["timeZone"].as_str().unwrap_or(""),
                params["offsetChoice"].as_str(),
            )?;
            return Ok(json!({"startUtc":utc.to_rfc3339()}));
        }
        "candidates" => {
            let event = state
                .database
                .scheduled_event(params["eventId"].as_str().context("Event ID required")?)?;
            let api = api(state, &event.account_id).await?;
            let (kind, candidates) = if unknown_ingest(&event) {
                (
                    "ingest",
                    available_ingest_candidates(state, &event, api.stream_candidates().await?)?,
                )
            } else {
                (
                    "broadcast",
                    available_candidates(state, &event, api.candidates().await?)?,
                )
            };
            return Ok(json!(
                candidates
                    .into_iter()
                    .map(|candidate| candidate_projection(kind, &candidate))
                    .collect::<Vec<_>>()
            ));
        }
        _ => (),
    }
    if !matches!(
        action,
        "saveDraft"
            | "schedule"
            | "update"
            | "cancel"
            | "refresh"
            | "duplicate"
            | "recover"
            | "prepareForGoLive"
            | "releasePreparation"
            | "activate"
            | "complete"
    ) {
        bail!("Unknown scheduling operation.");
    }
    let mutation: Mutation = serde_json::from_value(params)?;
    let mut event = match state.database.scheduled_event(&mutation.event_id) {
        Ok(event) => event,
        Err(_) if action == "saveDraft" && mutation.expected_revision == 0 => {
            let account = mutation
                .account_id
                .as_ref()
                .context("Choose a YouTube channel.")?;
            let accounts = state.database.list_platform_accounts()?;
            let channel = accounts
                .iter()
                .find(|a| a.platform == StreamPlatform::Youtube && a.account_id == *account)
                .context("Connect this YouTube channel first.")?;
            ScheduledStreamEvent::draft(
                mutation.event_id.clone(),
                account.clone(),
                channel.account_label.clone(),
                mutation
                    .metadata
                    .clone()
                    .context("Event metadata required")?,
            )?
        }
        Err(error) => return Err(error),
    };
    // A repeated UUID returns the first intent even when its original revision
    // has advanced. Never mutate requested metadata before checking the journal.
    if let Some(operation) = state.database.scheduled_operation(&mutation.operation_id)? {
        if operation.event_id != event.id
            || operation.action != action
            || operation.fingerprint != mutation_fingerprint(&mutation)?
        {
            bail!("Operation UUID belongs to another intent.");
        }
        return Ok(serde_json::to_value(operation)?);
    }
    if mutation
        .account_id
        .as_ref()
        .is_some_and(|a| *a != event.account_id)
    {
        bail!("An event cannot move to another channel.");
    }
    if matches!(
        action,
        "saveDraft" | "schedule" | "update" | "cancel" | "duplicate"
    ) {
        event.editable()?;
    }
    if let Some(metadata) = &mutation.metadata {
        if !matches!(action, "saveDraft" | "update") {
            bail!("Metadata edits require Save draft or Update.");
        }
        if event.provider_event_id.is_some()
            && metadata.made_for_kids != event.requested.made_for_kids
        {
            bail!("Change audience in YouTube Studio, then refresh the event.");
        }
        if event.provider_event_id.is_some()
            && event.requested.thumbnail_asset_id.is_some()
            && metadata.thumbnail_asset_id.is_none()
        {
            bail!("An uploaded thumbnail can be replaced, not removed.");
        }
        event.start_utc = metadata.validate(
            action == "update"
                && (metadata.local_start != event.requested.local_start
                    || metadata.time_zone != event.requested.time_zone
                    || metadata.offset_choice != event.requested.offset_choice),
        )?;
        if let Some(id) = &metadata.thumbnail_asset_id {
            state.resource_authority.resolve_managed_thumbnail(id)?;
        }
        event.requested = metadata.clone();
    }
    if action == "saveDraft" && event.provider_event_id.is_some() {
        bail!("Use Update for a published event.");
    }
    if action == "schedule" {
        if event.provider_event_id.is_none() && event.create_uncertain {
            bail!("The create response is unknown. Recover this event before scheduling again.");
        }
        event.start_utc = event
            .requested
            .validate(event.provider_event_id.is_none())?;
    }
    if action == "prepareForGoLive" && mutation.confirmation_fingerprint.is_none() {
        bail!("Review this scheduled event in Go Live confirmation first.");
    }
    if matches!(
        action,
        "prepareForGoLive" | "activate" | "complete" | "releasePreparation"
    ) {
        let attempt = mutation
            .attempt_id
            .as_ref()
            .context("Preparation attempt required")?;
        uuid::Uuid::parse_str(attempt)?;
        if let Some(preparation) = &event.preparation {
            if preparation.attempt_id != *attempt {
                bail!("Another preparation owns this event. Recover it first.");
            }
        } else if action != "prepareForGoLive" {
            bail!("This event has no owned preparation.");
        }
    }
    let (event, operation, started) = state
        .database
        .begin_scheduled_operation(event, &mutation, action)?;
    if started {
        let state = state.clone();
        let action = action.to_string();
        let operation = operation.clone();
        tokio::spawn(async move {
            let mut event = event;
            let mut operation = operation;
            let result = execute(&state, &action, &mutation, &mut event, &mut operation).await;
            settle_operation_result(&mut event, &mut operation, result);
            event.updated_at = Utc::now().to_rfc3339();
            if state
                .database
                .checkpoint_scheduled_operation(&event, &operation, true)
                .is_err()
            {
                // Preserve the last durable provider identity and release its lease
                // with an explicit reconciliation result if a final write fails.
                let failure=ScheduleError {code:"storage".into(),message:"The event result could not be saved. Refresh or recover it before retrying.".into()};
                operation.state = "needs-reconciliation".into();
                operation.error = Some(failure.clone());
                if let Ok(durable) = state.database.scheduled_event(&event.id) {
                    event = durable;
                }
                event.operation_state = "needs-reconciliation".into();
                event.error = Some(failure);
                if state
                    .database
                    .checkpoint_scheduled_operation(&event, &operation, true)
                    .is_err()
                {
                    tracing::error!(
                        "Scheduled event storage unavailable; operation requires restart recovery"
                    );
                }
            }
            state.emit_event("scheduledStreams.changed", event.public());
        });
    }
    Ok(serde_json::to_value(operation)?)
}

fn settle_operation_result(
    event: &mut ScheduledStreamEvent,
    operation: &mut ScheduleOperation,
    result: Result<()>,
) {
    match result {
        Ok(()) => {
            event.operation_state = "idle".into();
            operation.state = "complete".into();
        }
        Err(error) => {
            let definite_rejection = error
                .downcast_ref::<crate::scheduled_youtube::YouTubeRejection>()
                .is_some_and(|error| error.status < 500);
            if operation.stage == "creating-event" && definite_rejection {
                event.create_uncertain = false;
            }
            if operation.stage == "creating-stream" && definite_rejection {
                event.preparation = None;
            }
            if operation.stage == "deleting" && definite_rejection {
                event.cancel_uncertain = false;
            }
            let unknown = !definite_rejection
                && matches!(
                    operation.stage.as_str(),
                    "creating-event" | "creating-stream" | "transitioning" | "deleting"
                );
            let status = if unknown {
                "needs-reconciliation"
            } else {
                "needs-retry"
            };
            event.operation_state = status.into();
            operation.state = status.into();
            let error = sanitized_error(&error);
            event.error = Some(error.clone());
            operation.error = Some(error);
        }
    }
}

fn unknown_ingest(event: &ScheduledStreamEvent) -> bool {
    event
        .preparation
        .as_ref()
        .is_some_and(|p| p.phase == "creating-stream")
}
fn candidate_projection(kind: &str, candidate: &Value) -> Value {
    json!({"candidateKind":kind,"id":candidate["id"],"snippet":{"title":candidate["snippet"]["title"],"scheduledStartTime":candidate["snippet"]["scheduledStartTime"]},"profile":{"resolution":candidate["cdn"]["resolution"],"frameRate":candidate["cdn"]["frameRate"]}})
}
fn available_ingest_candidates(
    state: &AppState,
    event: &ScheduledStreamEvent,
    candidates: Vec<Value>,
) -> Result<Vec<Value>> {
    let preparation = event
        .preparation
        .as_ref()
        .context("No ingest preparation to recover")?;
    let video: crate::protocol::VideoSettings =
        serde_json::from_value(preparation.profile.clone())?;
    let existing = state.database.scheduled_events()?;
    Ok(candidates
        .into_iter()
        .filter(|candidate| {
            candidate["snippet"]["channelId"].as_str() == Some(event.account_id.as_str())
                && matches!(
                    candidate["status"]["streamStatus"].as_str(),
                    Some("inactive" | "ready" | "created")
                )
                && candidate["cdn"]["ingestionType"].as_str() == Some("rtmp")
                && candidate["cdn"]["resolution"].as_str()
                    == Some(crate::youtube::youtube_resolution(
                        video.width.min(video.height),
                    ))
                && candidate["cdn"]["frameRate"].as_str()
                    == Some(crate::youtube::youtube_frame_rate(video.fps))
                && !existing
                    .iter()
                    .filter(|saved| saved.id != event.id && saved.account_id == event.account_id)
                    .any(|saved| {
                        [&saved.preparation, &saved.retained_ingest]
                            .into_iter()
                            .flatten()
                            .any(|p| p.stream_id.as_deref() == candidate["id"].as_str())
                    })
        })
        .collect())
}

fn hydrate_requested_metadata(event: &mut ScheduledStreamEvent, current: &Value) -> Result<()> {
    if let Some(title) = current.pointer("/snippet/title").and_then(Value::as_str) {
        event.requested.title = title.into();
    }
    if let Some(description) = current
        .pointer("/snippet/description")
        .and_then(Value::as_str)
    {
        event.requested.description = description.into();
    }
    if let Some(privacy) = current
        .pointer("/status/privacyStatus")
        .and_then(Value::as_str)
    {
        event.requested.privacy = privacy.into();
    }
    if let Some(kids) = current
        .pointer("/status/selfDeclaredMadeForKids")
        .and_then(Value::as_bool)
    {
        event.requested.made_for_kids = kids;
    }
    if let Some(start) = current
        .pointer("/snippet/scheduledStartTime")
        .and_then(Value::as_str)
    {
        let utc = chrono::DateTime::parse_from_rfc3339(start)?;
        let zone: chrono_tz::Tz = event.requested.time_zone.parse()?;
        event.requested.local_start = utc
            .with_timezone(&zone)
            .format("%Y-%m-%dT%H:%M")
            .to_string();
        let local = utc.with_timezone(&zone).naive_local();
        event.requested.offset_choice = match chrono::TimeZone::from_local_datetime(&zone, &local) {
            chrono::LocalResult::Ambiguous(earlier, _) => Some(
                if earlier.with_timezone(&Utc) == utc.with_timezone(&Utc) {
                    "earlier"
                } else {
                    "later"
                }
                .into(),
            ),
            _ => None,
        };
        event.start_utc = utc.with_timezone(&Utc).to_rfc3339();
    }
    Ok(())
}

fn available_candidates(
    state: &AppState,
    event: &ScheduledStreamEvent,
    candidates: Vec<Value>,
) -> Result<Vec<Value>> {
    let existing = state.database.scheduled_events()?;
    Ok(candidates
        .into_iter()
        .filter(|candidate| {
            candidate["snippet"]["channelId"].as_str() == Some(event.account_id.as_str())
                && !existing.iter().any(|saved| {
                    saved.id != event.id
                        && saved.account_id == event.account_id
                        && saved.provider_event_id.as_deref() == candidate["id"].as_str()
                })
        })
        .collect())
}

fn checkpoint(
    state: &AppState,
    event: &ScheduledStreamEvent,
    op: &mut ScheduleOperation,
    stage: &str,
) -> Result<()> {
    op.stage = stage.into();
    state
        .database
        .checkpoint_scheduled_operation(event, op, false)
}
fn confirmed(event: &mut ScheduledStreamEvent, remote: Value) -> Result<()> {
    let id = remote["id"]
        .as_str()
        .context("Missing broadcast identity")?;
    if event
        .provider_event_id
        .as_ref()
        .is_some_and(|old| old != id)
    {
        bail!("Provider identity mismatch");
    }
    if let Some(channel) = remote.pointer("/snippet/channelId").and_then(Value::as_str)
        && channel != event.account_id
    {
        bail!("Provider channel mismatch");
    }
    event.create_uncertain = false;
    event.provider_event_id = Some(id.into());
    event.watch_url = Some(format!("https://www.youtube.com/watch?v={id}"));
    event.lifecycle = scheduled_youtube::lifecycle(&remote).into();
    event.confirmed = Some(remote);
    event.last_synced_at = Some(Utc::now().to_rfc3339());
    Ok(())
}

async fn execute(
    state: &AppState,
    action: &str,
    mutation: &Mutation,
    event: &mut ScheduledStreamEvent,
    op: &mut ScheduleOperation,
) -> Result<()> {
    if action == "saveDraft" {
        return Ok(());
    }
    if action == "duplicate" {
        let mut metadata = event.requested.clone();
        metadata.local_start = (Utc::now() + chrono::Duration::hours(1))
            .format("%Y-%m-%dT%H:%M")
            .to_string();
        metadata.time_zone = "UTC".into();
        metadata.offset_choice = None;
        metadata.privacy = "private".into();
        let new_id = uuid::Uuid::new_v4().to_string();
        let draft = ScheduledStreamEvent::draft(
            new_id.clone(),
            event.account_id.clone(),
            event.account_label.clone(),
            metadata,
        )?;
        let mut create = mutation.clone();
        create.event_id = new_id;
        create.operation_id = uuid::Uuid::new_v4().to_string();
        create.expected_revision = 0;
        let (mut draft, mut journal, _) =
            state
                .database
                .begin_scheduled_operation(draft, &create, "saveDraft")?;
        draft.operation_state = "idle".into();
        journal.state = "complete".into();
        state
            .database
            .checkpoint_scheduled_operation(&draft, &journal, true)?;
        return Ok(());
    }
    if action == "cancel" && event.provider_event_id.is_none() {
        if event.create_uncertain {
            bail!("Recover the unknown creation before canceling its event.");
        }
        event.lifecycle = "canceled".into();
        return Ok(());
    }
    let api = api(state, &event.account_id).await?;
    execute_provider(
        state,
        action,
        mutation,
        event,
        op,
        &api,
        crate::secrets::put_secret,
    )
    .await
}

async fn execute_provider(
    state: &AppState,
    action: &str,
    mutation: &Mutation,
    event: &mut ScheduledStreamEvent,
    op: &mut ScheduleOperation,
    api: &YouTubeEvents,
    put_secret: impl Fn(&str, &str) -> Result<()>,
) -> Result<()> {
    if action == "schedule" {
        if event.provider_event_id.is_none() {
            if event.create_uncertain {
                bail!("Unknown creation requires recovery before retrying.");
            }
            event.create_uncertain = true;
            checkpoint(state, event, op, "creating-event")?;
            let remote = api.create(event).await?;
            confirmed(event, remote)?;
            checkpoint(state, event, op, "event-created")?;
        }
        upload_thumbnail(state, api, event, op).await?;
        return Ok(());
    }
    if action == "recover" && event.provider_event_id.is_none() {
        if mutation
            .candidate_kind
            .as_deref()
            .is_some_and(|kind| kind != "broadcast")
        {
            bail!("Choose a broadcast candidate for this event.");
        }
        let id = mutation
            .candidate_id
            .as_ref()
            .context("Select an upcoming event explicitly in recovery.")?;
        let candidates = available_candidates(state, event, api.candidates().await?)?;
        let selected = candidates
            .into_iter()
            .find(|v| v["id"].as_str() == Some(id.as_str()))
            .context("Candidate is no longer an owned upcoming event")?;
        hydrate_requested_metadata(event, &selected)?;
        confirmed(event, selected)?;
        event.ownership = "recovery-adopted".into();
        return Ok(());
    }
    let id = event
        .provider_event_id
        .clone()
        .context("Schedule this draft first.")?;
    let current = api.get(&id).await?;
    let Some(current) = current else {
        event.lifecycle = if action == "cancel" || event.cancel_uncertain {
            "canceled"
        } else {
            "missing"
        }
        .into();
        if action == "refresh" || action == "recover" || action == "cancel" {
            return Ok(());
        }
        bail!("This event was deleted on YouTube.");
    };
    let life = scheduled_youtube::lifecycle(&current);
    if action == "recover" && unknown_ingest(event) {
        if mutation.candidate_kind.as_deref() != Some("ingest") {
            bail!("Explicitly select an owned inactive ingest stream to recover.");
        }
        let chosen = mutation
            .candidate_id
            .as_deref()
            .context("Select an ingest stream explicitly")?;
        let candidates = available_ingest_candidates(state, event, api.stream_candidates().await?)?;
        if !candidates
            .iter()
            .any(|candidate| candidate["id"].as_str() == Some(chosen))
        {
            bail!(
                "Ingest candidate is active, incompatible, already managed, or belongs to another channel."
            );
        }
        // Re-read both resources after selection; names alone never prove ownership.
        let fresh = available_ingest_candidates(state, event, vec![api.stream(chosen).await?])?;
        if fresh.is_empty() {
            bail!("Ingest candidate changed; choose an inactive compatible stream.");
        }
        let broadcast = api
            .get(&id)
            .await?
            .context("Event missing during ingest recovery")?;
        let bound = broadcast["contentDetails"]["boundStreamId"]
            .as_str()
            .unwrap_or("");
        if scheduled_youtube::lifecycle(&broadcast) != "scheduled"
            || (!bound.is_empty() && bound != chosen)
        {
            bail!("The event has another active or external ingest binding.");
        }
        let preparation = event.preparation.as_mut().unwrap();
        preparation.stream_id = Some(chosen.into());
        preparation.phase = "stream-created".into();
        checkpoint(state, event, op, "ingest-recovered")?;
    }
    if action == "refresh" || action == "recover" {
        hydrate_requested_metadata(event, &current)?;
        confirmed(event, current)?;
        if action == "recover"
            && let Some(preparation) = &event.preparation
        {
            if preparation.phase == "creating-stream" {
                bail!(
                    "Inspect the unknown ingest stream in YouTube Studio before preparing again."
                );
            }
            if event.lifecycle == "live" {
                bail!("This event is live. Stop its owning session before recovering it.");
            }
            if let Some(stream) = &preparation.stream_id {
                let stream = api.stream(stream).await?;
                if stream
                    .pointer("/status/streamStatus")
                    .and_then(Value::as_str)
                    == Some("active")
                {
                    bail!("The previous ingest is still active.");
                }
            }
            event.retained_ingest = event.preparation.take();
        }
        return Ok(());
    }
    if action == "update" {
        if life != "scheduled" {
            bail!("Only unstarted upcoming events can be edited.");
        }
        if event.confirmed.as_ref().is_some_and(|old| {
            scheduled_youtube::metadata_snapshot(old)
                != scheduled_youtube::metadata_snapshot(&current)
        }) {
            bail!("external metadata changed");
        }
        let result = api.update(event, &current).await?;
        confirmed(event, result)?;
        checkpoint(state, event, op, "metadata-updated")?;
        upload_thumbnail(state, api, event, op).await?;
        return Ok(());
    }
    if action == "cancel" {
        if life != "scheduled" {
            bail!("Live events must be stopped, not deleted.");
        }
        event.cancel_uncertain = true;
        checkpoint(state, event, op, "deleting")?;
        api.delete(&id).await?;
        if api.get(&id).await?.is_some() {
            bail!("Deletion not yet confirmed");
        }
        event.lifecycle = "canceled".into();
        event.cancel_uncertain = false;
        return Ok(());
    }
    if action == "prepareForGoLive" {
        if mutation
            .confirmation_fingerprint
            .as_ref()
            .is_some_and(|expected| *expected != confirmation_fingerprint(&current))
        {
            bail!(
                "external event changed after confirmation. Review it and confirm Go Live again."
            );
        }

        if life != "scheduled" {
            bail!("This event is no longer an upcoming broadcast.");
        }
        let video = mutation.video.as_ref().context("Output profile required")?;
        let target = mutation.target_id.as_ref().context("Target ID required")?;
        crate::resource_authority::validate_asset_id(target)?;
        let profile = serde_json::to_value(video)?;
        let bound = current
            .pointer("/contentDetails/boundStreamId")
            .and_then(Value::as_str)
            .unwrap_or("");
        if let Some(preparation) = &event.preparation {
            if preparation.profile != profile || preparation.target_id != *target {
                bail!("The prepared output profile or destination changed.");
            }
            if preparation.phase == "creating-stream" {
                bail!("Unknown stream creation requires recovery in YouTube Studio.");
            }
        } else {
            if let Some(mut retained) = event.retained_ingest.clone() {
                if retained.profile != profile
                    || retained.target_id != *target
                    || (!bound.is_empty() && retained.stream_id.as_deref() != Some(bound))
                {
                    bail!(
                        "The saved ingest binding or output profile changed. Review it in YouTube Studio."
                    );
                }
                if api
                    .stream(
                        retained
                            .stream_id
                            .as_deref()
                            .context("Saved ingest ID unavailable")?,
                    )
                    .await?
                    .pointer("/status/streamStatus")
                    .and_then(Value::as_str)
                    == Some("active")
                {
                    bail!("The previous ingest is still active.");
                }
                retained.attempt_id = mutation.attempt_id.clone().unwrap();
                retained.session_id = None;
                event.preparation = Some(retained);
            } else if !bound.is_empty() {
                bail!("This event has an external ingest binding. Review it in YouTube Studio.");
            }
            if event.preparation.is_none() {
                event.preparation = Some(Preparation {
                    attempt_id: mutation.attempt_id.clone().unwrap(),
                    target_id: target.clone(),
                    stream_id: None,
                    profile,
                    phase: "reserved".into(),
                    session_id: None,
                    prepared: None,
                });
            }
        }
        if event.preparation.as_ref().unwrap().prepared.is_none() {
            let stream =
                if let Some(stream_id) = event.preparation.as_ref().unwrap().stream_id.clone() {
                    api.stream(&stream_id).await?
                } else {
                    event.preparation.as_mut().unwrap().phase = "creating-stream".into();
                    checkpoint(state, event, op, "creating-stream")?;
                    api.create_stream(event, video).await?
                };
            let stream_id = stream["id"]
                .as_str()
                .context("Missing stream ID")?
                .to_string();
            event.preparation.as_mut().unwrap().stream_id = Some(stream_id.clone());
            event.preparation.as_mut().unwrap().phase = "stream-created".into();
            checkpoint(state, event, op, "stream-created")?;
            let secret_ref = format!("youtube-scheduled-{}-{}", event.id, target);
            let key = stream
                .pointer("/cdn/ingestionInfo/streamName")
                .and_then(Value::as_str)
                .context("Missing ingest key")?;
            put_secret(&secret_ref, key)?;
            let prepared = crate::youtube::PreparedYouTubeBroadcast {
                platform: StreamPlatform::Youtube,
                account_id: event.account_id.clone(),
                account_label: event.account_label.clone(),
                broadcast_id: id.clone(),
                stream_id: stream_id.clone(),
                server_url: stream
                    .pointer("/cdn/ingestionInfo/ingestionAddress")
                    .and_then(Value::as_str)
                    .context("Missing ingest server")?
                    .into(),
                stream_key_secret_ref: secret_ref,
                stream_key_present: true,
                redacted_url: "rtmp://<youtube-ingest>/<stream-key>".into(),
                title: current
                    .pointer("/snippet/title")
                    .and_then(Value::as_str)
                    .unwrap_or(&event.requested.title)
                    .into(),
                description: current
                    .pointer("/snippet/description")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .into(),
                privacy: serde_json::from_value(current["status"]["privacyStatus"].clone())?,
                made_for_kids: current["status"]["selfDeclaredMadeForKids"]
                    .as_bool()
                    .unwrap_or(false),
                scheduled_start_time: event.start_utc.clone(),
            };
            event.preparation.as_mut().unwrap().prepared = Some(prepared);
            checkpoint(state, event, op, "credentials-stored")?;
        }
        let owned_stream = event
            .preparation
            .as_ref()
            .and_then(|p| p.stream_id.as_deref())
            .context("Missing owned stream")?;
        if !bound.is_empty() && bound != owned_stream {
            bail!("This event was bound to another encoder externally.");
        }
        if bound != owned_stream {
            api.bind(&id, owned_stream).await?;
        }
        let preparation = event.preparation.as_mut().unwrap();
        preparation.phase = "prepared".into();
        event.lifecycle = "preparing".into();
        op.result = Some(serde_json::to_value(
            preparation
                .prepared
                .as_ref()
                .context("Prepared credentials unavailable")?,
        )?);
        return Ok(());
    }
    let preparation = event.preparation.as_ref().context("No preparation owner")?;
    if preparation.attempt_id != mutation.attempt_id.as_deref().unwrap_or("") {
        bail!("Stale preparation owner");
    }
    if action == "activate" {
        let session = mutation
            .session_id
            .as_ref()
            .context("Owning session required")?;
        let active = state.recording.lock().await;
        if !active
            .as_ref()
            .is_some_and(|active| active.session_id == *session && !active.stop_requested)
        {
            bail!("Only the active owning session can activate this event.");
        }
        drop(active);
        let targets = crate::recording::current_stream_targets_snapshot(state).await?;
        if targets.session_id != *session
            || !targets.targets.iter().any(|target| {
                target.target_id == preparation.target_id
                    && target.platform == StreamPlatform::Youtube
            })
        {
            bail!("The active session does not own this YouTube destination.");
        }
        if preparation
            .session_id
            .as_ref()
            .is_some_and(|old| old != session)
        {
            bail!("Another session owns activation");
        }
        let stream_id = preparation.stream_id.as_ref().context("No ingest stream")?;
        let mut ingest_active = false;
        for attempt in 0..8 {
            let stream = api.stream(stream_id).await?;
            if stream
                .pointer("/status/streamStatus")
                .and_then(Value::as_str)
                == Some("active")
            {
                ingest_active = true;
                break;
            }
            if attempt < 7 {
                tokio::time::sleep(std::time::Duration::from_secs(2)).await;
            }
        }
        if !ingest_active {
            bail!("YouTube ingest is not active yet");
        }
        if !state
            .recording
            .lock()
            .await
            .as_ref()
            .is_some_and(|active| active.session_id == *session && !active.stop_requested)
        {
            bail!("The owning session ended before activation.");
        }
        event.preparation.as_mut().unwrap().session_id = Some(session.clone());
        event.preparation.as_mut().unwrap().phase = "activating".into();
        checkpoint(state, event, op, "transitioning")?;
        api.transition(&id, "live").await?;
        let remote = api
            .get(&id)
            .await?
            .context("Event missing after activation")?;
        confirmed(event, remote)?;
        event.preparation.as_mut().unwrap().phase = "live".into();
        op.result = Some(
            json!({"platform":"youtube","accountId":event.account_id,"broadcastId":id,"requestedStatus":"live","lifecycleStatus":"live","message":"Scheduled event is live."}),
        );
        return Ok(());
    }
    if action == "releasePreparation" || action == "complete" {
        if !matches!(life, "live" | "scheduled" | "completed") {
            bail!("Reconcile the unknown provider lifecycle before releasing ownership.");
        }
        if life == "live" {
            if preparation.session_id.is_none() || preparation.session_id != mutation.session_id {
                bail!("Only the owning live session can complete this event.");
            }
            checkpoint(state, event, op, "transitioning")?;
            api.transition(&id, "complete").await?;
            let remote = api
                .get(&id)
                .await?
                .context("Event missing after completion")?;
            confirmed(event, remote)?;
        } else {
            confirmed(event, current)?;
        }
        event.retained_ingest = event.preparation.take();
        op.result = Some(
            json!({"platform":"youtube","accountId":event.account_id,"broadcastId":id,"requestedStatus":"complete","lifecycleStatus":if event.lifecycle=="completed" {"complete"} else {"ready"},"message":if event.lifecycle=="completed" {"Scheduled event completed."} else {"Upcoming event preserved."}}),
        );
        return Ok(());
    }
    bail!("Unsupported scheduling action")
}
async fn upload_thumbnail(
    state: &AppState,
    api: &YouTubeEvents,
    event: &mut ScheduledStreamEvent,
    op: &mut ScheduleOperation,
) -> Result<()> {
    if let Some(asset) = &event.requested.thumbnail_asset_id {
        let path = state.resource_authority.resolve_managed_thumbnail(asset)?;
        event.thumbnail_state = "pending".into();
        checkpoint(state, event, op, "uploading-thumbnail")?;
        if let Err(error) = api
            .thumbnail(
                event
                    .provider_event_id
                    .as_deref()
                    .context("Missing broadcast")?,
                &path,
                asset,
            )
            .await
        {
            event.thumbnail_state = "error".into();
            return Err(error);
        }
        event.thumbnail_state = "uploaded".into();
    }
    Ok(())
}

#[cfg(debug_assertions)]
pub fn smoke_api_base() -> Result<Option<String>> {
    let Ok(value) = std::env::var("VIDEORC_SCHEDULED_STREAMS_SMOKE_URL") else {
        return Ok(None);
    };
    let url = reqwest::Url::parse(&value)?;
    if url.scheme() != "http"
        || url.host_str() != Some("127.0.0.1")
        || url.port().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.path() != "/"
        || url.query().is_some()
    {
        bail!("Scheduling smoke endpoint must be a bare loopback origin.");
    }
    Ok(Some(value.trim_end_matches('/').into()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{
        Router,
        extract::{Request, State},
        http::StatusCode,
        response::IntoResponse,
    };
    use std::sync::{Arc, Mutex};
    use tokio::net::TcpListener;
    #[derive(Default)]
    struct Fixture {
        calls: Vec<(String, String, Value)>,
        events: Vec<Value>,
        stream_count: usize,
        streams: Vec<Value>,
        fail_bind: bool,
        reject_create: bool,
        lose_create: bool,
        reject_stream: bool,
        lose_stream: bool,
        lose_delete: bool,
        rate_limit_reads: usize,
    }
    async fn respond(
        State(fixture): State<Arc<Mutex<Fixture>>>,
        request: Request,
    ) -> axum::response::Response {
        let method = request.method().to_string();
        let path = request.uri().path().to_string();
        let query: std::collections::HashMap<String, String> =
            reqwest::Url::parse(&format!("http://local{}", request.uri()))
                .unwrap()
                .query_pairs()
                .into_owned()
                .collect();
        let bytes = axum::body::to_bytes(request.into_body(), 2 * 1024 * 1024)
            .await
            .unwrap();
        let body = serde_json::from_slice::<Value>(&bytes).unwrap_or(Value::Null);
        let mut fixture = fixture.lock().unwrap();
        fixture
            .calls
            .push((method.clone(), path.clone(), body.clone()));
        if method == "GET" && fixture.rate_limit_reads > 0 {
            fixture.rate_limit_reads -= 1;
            return (
                StatusCode::TOO_MANY_REQUESTS,
                [("retry-after", "0")],
                axum::Json(json!({"error":{}})),
            )
                .into_response();
        }
        let value = match (method.as_str(), path.as_str()) {
            ("POST", "/youtube/v3/liveBroadcasts") => {
                if fixture.reject_create {
                    return (
                        StatusCode::FORBIDDEN,
                        axum::Json(
                            json!({"error":{"errors":[{"reason":"liveStreamingNotEnabled"}]}}),
                        ),
                    )
                        .into_response();
                }
                let mut event = body;
                event["id"] = json!(format!("broadcast-{}", fixture.events.len() + 1));
                event["status"]["lifeCycleStatus"] = json!("ready");
                event["snippet"]["channelId"] = json!("channel");
                fixture.events.push(event.clone());
                if fixture.lose_create {
                    return (StatusCode::OK, "malformed accepted response").into_response();
                }
                event
            }
            ("GET", "/youtube/v3/liveBroadcasts") => {
                json!({"items":fixture.events.iter().filter(|e|query.get("id").is_none_or(|id|e["id"].as_str()==Some(id))).cloned().collect::<Vec<_>>()})
            }
            ("PUT", "/youtube/v3/liveBroadcasts") => {
                let event = fixture
                    .events
                    .iter_mut()
                    .find(|e| e["id"] == body["id"])
                    .unwrap();
                event["snippet"] = body["snippet"].clone();
                event["status"]["privacyStatus"] = body["status"]["privacyStatus"].clone();
                event.clone()
            }
            ("DELETE", "/youtube/v3/liveBroadcasts") => {
                fixture
                    .events
                    .retain(|e| e["id"].as_str() != query.get("id").map(String::as_str));
                if fixture.lose_delete {
                    return (StatusCode::OK, "malformed accepted response").into_response();
                }
                return StatusCode::NO_CONTENT.into_response();
            }
            ("POST", "/youtube/v3/liveStreams") => {
                if fixture.reject_stream {
                    return (StatusCode::FORBIDDEN, axum::Json(json!({"error":{}})))
                        .into_response();
                }
                fixture.stream_count += 1;
                let mut stream = body;
                stream["id"] = json!(format!("stream-{}", fixture.stream_count));
                stream["snippet"]["channelId"] = json!("channel");
                stream["status"] = json!({"streamStatus":"inactive"});
                stream["cdn"]["ingestionInfo"] = json!({"ingestionAddress":"rtmp://127.0.0.1/live","streamName":format!("fixture-key-{}",fixture.stream_count)});
                fixture.streams.push(stream.clone());
                if fixture.lose_stream {
                    return (StatusCode::OK, "malformed accepted response").into_response();
                }
                stream
            }
            ("GET", "/youtube/v3/liveStreams") => {
                json!({"items":fixture.streams.iter().filter(|stream|query.get("id").is_none_or(|id|stream["id"].as_str()==Some(id))).cloned().collect::<Vec<_>>()})
            }
            ("POST", "/youtube/v3/liveBroadcasts/bind") => {
                if fixture.fail_bind {
                    return (
                        StatusCode::INTERNAL_SERVER_ERROR,
                        axum::Json(json!({"error":{}})),
                    )
                        .into_response();
                }
                let event = fixture
                    .events
                    .iter_mut()
                    .find(|e| e["id"].as_str() == query.get("id").map(String::as_str))
                    .unwrap();
                event["contentDetails"]["boundStreamId"] = json!(query["streamId"]);
                event.clone()
            }
            _ => return StatusCode::NOT_FOUND.into_response(),
        };
        axum::Json(value).into_response()
    }
    async fn fixture() -> (
        YouTubeEvents,
        Arc<Mutex<Fixture>>,
        tokio::task::JoinHandle<()>,
    ) {
        let data = Arc::new(Mutex::new(Fixture::default()));
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let router = Router::new().fallback(respond).with_state(data.clone());
        let handle = tokio::spawn(async move {
            axum::serve(listener, router).await.unwrap();
        });
        (
            YouTubeEvents {
                client: reqwest::Client::new(),
                token: "fixture".into(),
                base: format!("http://127.0.0.1:{port}"),
                refresh_context: None,
            },
            data,
            handle,
        )
    }
    fn state() -> AppState {
        let (events, _) = tokio::sync::broadcast::channel(16);
        AppState::new(
            "test".into(),
            0,
            events,
            crate::storage::Database::open_in_memory_for_tests(),
        )
    }
    fn event() -> ScheduledStreamEvent {
        ScheduledStreamEvent::draft(
            uuid::Uuid::new_v4().to_string(),
            "channel".into(),
            "Channel".into(),
            EventMetadata {
                title: "Scheduled".into(),
                description: "Description".into(),
                privacy: "private".into(),
                made_for_kids: false,
                local_start: "2035-01-01T12:00".into(),
                time_zone: "UTC".into(),
                offset_choice: None,
                thumbnail_asset_id: None,
            },
        )
        .unwrap()
    }
    fn mutation(event: &ScheduledStreamEvent) -> Mutation {
        Mutation {
            operation_id: uuid::Uuid::new_v4().to_string(),
            event_id: event.id.clone(),
            expected_revision: event.revision,
            metadata: None,
            account_id: Some(event.account_id.clone()),
            candidate_id: None,
            candidate_kind: None,
            attempt_id: Some(uuid::Uuid::new_v4().to_string()),
            target_id: Some("youtube".into()),
            video: Some(
                serde_json::from_value(
                    json!({"preset":"custom","width":640,"height":360,"fps":30,"bitrateKbps":2000}),
                )
                .unwrap(),
            ),
            session_id: None,
            confirmation_fingerprint: None,
        }
    }
    fn reserve(
        state: &AppState,
        event: ScheduledStreamEvent,
    ) -> (ScheduledStreamEvent, Mutation, ScheduleOperation) {
        let m = mutation(&event);
        let (e, op, _) = state
            .database
            .begin_scheduled_operation(event, &m, "saveDraft")
            .unwrap();
        (e, m, op)
    }
    #[tokio::test]
    async fn scheduled_creation_is_metadata_only_and_manual() {
        let (api, fixture, handle) = fixture().await;
        let state = state();
        let (mut event, m, mut op) = reserve(&state, event());
        execute_provider(&state, "schedule", &m, &mut event, &mut op, &api, |_, _| {
            Ok(())
        })
        .await
        .unwrap();
        let data = fixture.lock().unwrap();
        assert_eq!(data.stream_count, 0);
        assert_eq!(data.calls.len(), 1);
        assert_eq!(data.calls[0].2["contentDetails"]["enableAutoStart"], false);
        assert_eq!(data.calls[0].2["contentDetails"]["enableAutoStop"], false);
        assert_eq!(
            state
                .database
                .scheduled_event(&event.id)
                .unwrap()
                .provider_event_id,
            event.provider_event_id
        );
        assert!(!event.create_uncertain);
        handle.abort();
    }
    #[tokio::test]
    async fn prepare_reuses_event_and_resumes_failed_bind_without_second_stream() {
        let (api, fixture, handle) = fixture().await;
        let state = state();
        let (mut event, m, mut op) = reserve(&state, event());
        execute_provider(&state, "schedule", &m, &mut event, &mut op, &api, |_, _| {
            Ok(())
        })
        .await
        .unwrap();
        fixture.lock().unwrap().fail_bind = true;
        assert!(
            execute_provider(
                &state,
                "prepareForGoLive",
                &m,
                &mut event,
                &mut op,
                &api,
                |_, _| Ok(())
            )
            .await
            .is_err()
        );
        assert!(event.preparation.as_ref().unwrap().prepared.is_some());
        fixture.lock().unwrap().fail_bind = false;
        execute_provider(&state, "recover", &m, &mut event, &mut op, &api, |_, _| {
            Ok(())
        })
        .await
        .unwrap();
        assert!(event.preparation.is_none());
        let m = mutation(&event);
        execute_provider(
            &state,
            "prepareForGoLive",
            &m,
            &mut event,
            &mut op,
            &api,
            |_, _| Ok(()),
        )
        .await
        .unwrap();
        assert_eq!(fixture.lock().unwrap().stream_count, 1);
        assert_eq!(fixture.lock().unwrap().events.len(), 1);
        execute_provider(
            &state,
            "releasePreparation",
            &m,
            &mut event,
            &mut op,
            &api,
            |_, _| Ok(()),
        )
        .await
        .unwrap();
        assert_eq!(event.lifecycle, "scheduled");
        assert!(event.retained_ingest.is_some());
        let next = mutation(&event);
        execute_provider(
            &state,
            "prepareForGoLive",
            &next,
            &mut event,
            &mut op,
            &api,
            |_, _| Ok(()),
        )
        .await
        .unwrap();
        assert_eq!(fixture.lock().unwrap().stream_count, 1);
        handle.abort();
    }
    #[tokio::test]
    async fn external_edit_requires_explicit_refresh_before_update() {
        let (api, fixture, handle) = fixture().await;
        let state = state();
        let (mut event, m, mut op) = reserve(&state, event());
        execute_provider(&state, "schedule", &m, &mut event, &mut op, &api, |_, _| {
            Ok(())
        })
        .await
        .unwrap();
        fixture.lock().unwrap().events[0]["snippet"]["title"] = json!("Edited in Studio");
        assert!(
            execute_provider(&state, "update", &m, &mut event, &mut op, &api, |_, _| Ok(
                ()
            ))
            .await
            .unwrap_err()
            .to_string()
            .contains("external")
        );
        execute_provider(&state, "refresh", &m, &mut event, &mut op, &api, |_, _| {
            Ok(())
        })
        .await
        .unwrap();
        assert_eq!(event.requested.title, "Edited in Studio");
        handle.abort();
    }
    #[tokio::test]
    async fn cancel_refuses_live_and_confirms_remote_absence() {
        let (api, fixture, handle) = fixture().await;
        let state = state();
        let (mut event, m, mut op) = reserve(&state, event());
        execute_provider(&state, "schedule", &m, &mut event, &mut op, &api, |_, _| {
            Ok(())
        })
        .await
        .unwrap();
        fixture.lock().unwrap().events[0]["status"]["lifeCycleStatus"] = json!("live");
        assert!(
            execute_provider(&state, "cancel", &m, &mut event, &mut op, &api, |_, _| Ok(
                ()
            ))
            .await
            .is_err()
        );
        assert_eq!(fixture.lock().unwrap().events.len(), 1);
        fixture.lock().unwrap().events[0]["status"]["lifeCycleStatus"] = json!("ready");
        execute_provider(&state, "cancel", &m, &mut event, &mut op, &api, |_, _| {
            Ok(())
        })
        .await
        .unwrap();
        assert_eq!(event.lifecycle, "canceled");
        assert!(fixture.lock().unwrap().events.is_empty());
        handle.abort();
    }
    #[tokio::test]
    async fn lost_ingest_requires_explicit_compatible_owned_candidate_and_reuses_it() {
        let (api, fixture, handle) = fixture().await;
        let state = state();
        let (mut event, mut m, mut op) = reserve(&state, event());
        execute_provider(&state, "schedule", &m, &mut event, &mut op, &api, |_, _| {
            Ok(())
        })
        .await
        .unwrap();
        let broadcast = event.provider_event_id.clone();
        let watch = event.watch_url.clone();
        fixture.lock().unwrap().lose_stream = true;
        let result = execute_provider(
            &state,
            "prepareForGoLive",
            &m,
            &mut event,
            &mut op,
            &api,
            |_, _| Ok(()),
        )
        .await;
        assert!(result.is_err());
        settle_operation_result(&mut event, &mut op, result);
        assert!(unknown_ingest(&event));
        let valid = fixture.lock().unwrap().streams[0].clone();
        let mut bad = Vec::new();
        for reason in ["active", "profile", "channel"] {
            let mut stream = valid.clone();
            stream["id"] = json!(reason);
            match reason {
                "active" => stream["status"]["streamStatus"] = json!("active"),
                "profile" => stream["cdn"]["frameRate"] = json!("60fps"),
                _ => stream["snippet"]["channelId"] = json!("another-channel"),
            };
            bad.push(stream);
        }
        fixture.lock().unwrap().streams.extend(bad);
        let candidates =
            available_ingest_candidates(&state, &event, api.stream_candidates().await.unwrap())
                .unwrap();
        assert_eq!(candidates.len(), 1);
        let mut other = event.clone();
        other.id = uuid::Uuid::new_v4().to_string();
        other.provider_event_id = None;
        other.revision = 0;
        other.preparation.as_mut().unwrap().stream_id = Some("stream-1".into());
        let (other, _, other_op) = reserve(&state, other);
        assert!(
            available_ingest_candidates(&state, &event, vec![valid.clone()])
                .unwrap()
                .is_empty()
        );
        let mut other = other;
        other.preparation = None;
        state
            .database
            .checkpoint_scheduled_operation(&other, &other_op, true)
            .unwrap();
        let projection = candidate_projection("ingest", &candidates[0]).to_string();
        assert!(!projection.contains("ingestionInfo"));
        assert!(!projection.contains("fixture-key"));
        assert!(!projection.contains("rtmp://"));
        m.candidate_kind = Some("ingest".into());
        for candidate in ["active", "profile", "channel"] {
            m.candidate_id = Some(candidate.into());
            assert!(
                execute_provider(&state, "recover", &m, &mut event, &mut op, &api, |_, _| Ok(
                    ()
                ))
                .await
                .is_err()
            );
            assert!(unknown_ingest(&event));
        }
        m.candidate_id = Some("stream-1".into());
        fixture.lock().unwrap().events[0]["contentDetails"]["boundStreamId"] = json!("external");
        assert!(
            execute_provider(&state, "recover", &m, &mut event, &mut op, &api, |_, _| Ok(
                ()
            ))
            .await
            .is_err()
        );
        fixture.lock().unwrap().events[0]["contentDetails"]["boundStreamId"] = json!("");
        execute_provider(&state, "recover", &m, &mut event, &mut op, &api, |_, _| {
            Ok(())
        })
        .await
        .unwrap();
        assert_eq!(
            event.retained_ingest.as_ref().unwrap().stream_id.as_deref(),
            Some("stream-1")
        );
        m.attempt_id = Some(uuid::Uuid::new_v4().to_string());
        execute_provider(
            &state,
            "prepareForGoLive",
            &m,
            &mut event,
            &mut op,
            &api,
            |_, _| Ok(()),
        )
        .await
        .unwrap();
        assert_eq!(fixture.lock().unwrap().stream_count, 1);
        assert_eq!(event.provider_event_id, broadcast);
        assert_eq!(event.watch_url, watch);
        assert_eq!(
            fixture.lock().unwrap().events[0]["contentDetails"]["boundStreamId"],
            "stream-1"
        );
        handle.abort();
    }
    #[tokio::test]
    async fn explicit_adoption_immediately_uses_remote_metadata() {
        let (api, fixture, handle) = fixture().await;
        let state = state();
        let (mut event, mut m, mut op) = reserve(&state, event());
        fixture.lock().unwrap().events.push(json!({"id":"existing-upcoming","snippet":{"channelId":"channel","title":"Remote title","description":"Remote description","scheduledStartTime":"2035-02-01T16:00:00Z"},"status":{"lifeCycleStatus":"ready","privacyStatus":"public","selfDeclaredMadeForKids":true}}));
        m.candidate_id = Some("existing-upcoming".into());
        execute_provider(&state, "recover", &m, &mut event, &mut op, &api, |_, _| {
            Ok(())
        })
        .await
        .unwrap();
        assert_eq!(event.requested.title, "Remote title");
        assert_eq!(event.requested.privacy, "public");
        assert!(event.requested.made_for_kids);
        assert_eq!(event.requested.local_start, "2035-02-01T16:00");
        assert_eq!(event.start_utc, "2035-02-01T16:00:00+00:00");
        handle.abort();
    }
    #[tokio::test]
    async fn recovery_cannot_adopt_another_local_events_provider_identity() {
        let (api, fixture, handle) = fixture().await;
        let state = state();
        let (mut first, m, mut op) = reserve(&state, event());
        execute_provider(&state, "schedule", &m, &mut first, &mut op, &api, |_, _| {
            Ok(())
        })
        .await
        .unwrap();
        let (mut second, mut m, mut op) = reserve(&state, event());
        m.candidate_id = first.provider_event_id.clone();
        assert!(
            execute_provider(
                &state,
                "recover",
                &m,
                &mut second,
                &mut op,
                &api,
                |_, _| Ok(())
            )
            .await
            .is_err()
        );
        assert!(second.provider_event_id.is_none());
        assert!(
            available_candidates(&state, &second, fixture.lock().unwrap().events.clone())
                .unwrap()
                .is_empty()
        );
        handle.abort();
    }
    #[tokio::test]
    async fn two_events_isolate_profiles_secrets_and_stale_owner_cleanup() {
        let (api, fixture, handle) = fixture().await;
        let state = state();
        let secrets = Mutex::new(std::collections::HashMap::new());
        for vertical in [false, true] {
            let (mut event, mut m, mut op) = reserve(&state, event());
            m.target_id = Some(
                if vertical {
                    "youtube-vertical"
                } else {
                    "youtube-horizontal"
                }
                .into(),
            );
            if vertical {
                let video = m.video.as_mut().unwrap();
                video.width = 360;
                video.height = 640;
                video.fps = 60;
            }
            execute_provider(&state, "schedule", &m, &mut event, &mut op, &api, |_, _| {
                Ok(())
            })
            .await
            .unwrap();
            execute_provider(
                &state,
                "prepareForGoLive",
                &m,
                &mut event,
                &mut op,
                &api,
                |key, value| {
                    secrets
                        .lock()
                        .unwrap()
                        .insert(key.to_string(), value.to_string());
                    Ok(())
                },
            )
            .await
            .unwrap();
            execute_provider(
                &state,
                "releasePreparation",
                &m,
                &mut event,
                &mut op,
                &api,
                |_, _| Ok(()),
            )
            .await
            .unwrap();
            let mut next = m.clone();
            next.attempt_id = Some(uuid::Uuid::new_v4().to_string());
            execute_provider(
                &state,
                "prepareForGoLive",
                &next,
                &mut event,
                &mut op,
                &api,
                |_, _| Ok(()),
            )
            .await
            .unwrap();
            m.session_id = Some("old-session".into());
            assert!(
                execute_provider(
                    &state,
                    "releasePreparation",
                    &m,
                    &mut event,
                    &mut op,
                    &api,
                    |_, _| Ok(())
                )
                .await
                .unwrap_err()
                .to_string()
                .contains("Stale")
            );
            assert_eq!(
                event.preparation.as_ref().unwrap().attempt_id,
                next.attempt_id.unwrap()
            );
        }
        let secrets = secrets.lock().unwrap();
        assert_eq!(secrets.len(), 2);
        let values: std::collections::HashSet<_> = secrets.values().collect();
        assert_eq!(values.len(), 2);
        let fixture = fixture.lock().unwrap();
        assert_eq!(fixture.stream_count, 2);
        assert_eq!(fixture.events.len(), 2);
        let profiles: Vec<_> = fixture
            .calls
            .iter()
            .filter(|(method, path, _)| method == "POST" && path.ends_with("liveStreams"))
            .map(|(_, _, body)| body["cdn"]["frameRate"].clone())
            .collect();
        assert_eq!(profiles, vec![json!("30fps"), json!("60fps")]);
        handle.abort();
    }
    #[tokio::test]
    async fn definite_rejections_allow_retry_but_lost_acceptance_does_not() {
        for stream in [false, true] {
            for lost in [false, true] {
                let (api, fixture, handle) = fixture().await;
                let state = state();
                let (mut event, m, mut op) = reserve(&state, event());
                if stream {
                    execute_provider(&state, "schedule", &m, &mut event, &mut op, &api, |_, _| {
                        Ok(())
                    })
                    .await
                    .unwrap();
                }
                {
                    let mut f = fixture.lock().unwrap();
                    if stream {
                        f.lose_stream = lost;
                        f.reject_stream = !lost;
                    } else {
                        f.lose_create = lost;
                        f.reject_create = !lost;
                    }
                }
                let action = if stream {
                    "prepareForGoLive"
                } else {
                    "schedule"
                };
                let result =
                    execute_provider(&state, action, &m, &mut event, &mut op, &api, |_, _| Ok(()))
                        .await;
                assert!(result.is_err());
                settle_operation_result(&mut event, &mut op, result);
                assert_eq!(
                    if stream {
                        event.preparation.is_some()
                    } else {
                        event.create_uncertain
                    },
                    lost
                );
                {
                    let mut f = fixture.lock().unwrap();
                    f.reject_create = false;
                    f.reject_stream = false;
                    f.lose_create = false;
                    f.lose_stream = false;
                }
                let retried =
                    execute_provider(&state, action, &m, &mut event, &mut op, &api, |_, _| Ok(()))
                        .await;
                assert_eq!(retried.is_err(), lost);
                let f = fixture.lock().unwrap();
                assert_eq!(f.events.len(), 1);
                if stream {
                    assert_eq!(f.stream_count, 1);
                }
                handle.abort();
            }
        }
    }
    #[tokio::test]
    async fn lost_delete_recovers_canceled_but_external_deletion_is_missing() {
        for owned in [true, false] {
            let (api, fixture, handle) = fixture().await;
            let state = state();
            let (mut event, m, mut op) = reserve(&state, event());
            execute_provider(&state, "schedule", &m, &mut event, &mut op, &api, |_, _| {
                Ok(())
            })
            .await
            .unwrap();
            if owned {
                fixture.lock().unwrap().lose_delete = true;
                assert!(
                    execute_provider(&state, "cancel", &m, &mut event, &mut op, &api, |_, _| Ok(
                        ()
                    ))
                    .await
                    .is_err()
                );
                assert!(event.cancel_uncertain);
            } else {
                fixture.lock().unwrap().events.clear();
            }
            execute_provider(&state, "refresh", &m, &mut event, &mut op, &api, |_, _| {
                Ok(())
            })
            .await
            .unwrap();
            assert_eq!(event.lifecycle, if owned { "canceled" } else { "missing" });
            handle.abort();
        }
    }
    #[tokio::test]
    async fn refreshed_dst_fold_retains_exact_remote_instant_and_read_backoff() {
        let (api, fixture, handle) = fixture().await;
        let state = state();
        let (mut event, mut m, mut op) = reserve(&state, event());
        execute_provider(&state, "schedule", &m, &mut event, &mut op, &api, |_, _| {
            Ok(())
        })
        .await
        .unwrap();
        event.requested.time_zone = "Europe/Madrid".into();
        event.requested.offset_choice = Some("earlier".into());
        {
            let mut f = fixture.lock().unwrap();
            f.events[0]["snippet"]["scheduledStartTime"] = json!("2035-10-28T01:30:00Z");
            f.rate_limit_reads = 2;
        }
        execute_provider(&state, "refresh", &m, &mut event, &mut op, &api, |_, _| {
            Ok(())
        })
        .await
        .unwrap();
        assert_eq!(event.requested.offset_choice.as_deref(), Some("later"));
        m.metadata = Some(event.requested.clone());
        execute_provider(&state, "update", &m, &mut event, &mut op, &api, |_, _| {
            Ok(())
        })
        .await
        .unwrap();
        assert_eq!(
            chrono::DateTime::parse_from_rfc3339(
                fixture.lock().unwrap().events[0]["snippet"]["scheduledStartTime"]
                    .as_str()
                    .unwrap()
            )
            .unwrap()
            .timestamp(),
            chrono::DateTime::parse_from_rfc3339("2035-10-28T01:30:00Z")
                .unwrap()
                .timestamp()
        );
        handle.abort();
    }
    #[tokio::test]
    async fn arbitrary_session_cannot_publish_a_prepared_event() {
        let (api, _, handle) = fixture().await;
        let state = state();
        let (mut event, mut m, mut op) = reserve(&state, event());
        execute_provider(&state, "schedule", &m, &mut event, &mut op, &api, |_, _| {
            Ok(())
        })
        .await
        .unwrap();
        execute_provider(
            &state,
            "prepareForGoLive",
            &m,
            &mut event,
            &mut op,
            &api,
            |_, _| Ok(()),
        )
        .await
        .unwrap();
        m.session_id = Some("fake-session".into());
        assert!(
            execute_provider(
                &state,
                "activate",
                &m,
                &mut event,
                &mut op,
                &api,
                |_, _| Ok(())
            )
            .await
            .unwrap_err()
            .to_string()
            .contains("owning session")
        );
        handle.abort();
    }
}

pub async fn resolve_preflight_metadata(
    state: &AppState,
    params: &mut crate::preflight::GoLivePreflightParams,
) -> Result<()> {
    for (target_id, event_id) in &params.scheduled_event_ids {
        let target = params
            .streaming
            .targets
            .iter()
            .find(|target| {
                target.id == *target_id
                    && (target.enabled || params.streaming.enabled_target_ids.contains(target_id))
            })
            .context("Scheduled destination is not enabled")?;
        let event = state.database.scheduled_event(event_id)?;
        if target.platform != StreamPlatform::Youtube
            || target.auth_mode != crate::streaming::StreamAuthMode::Oauth
            || target.account_id.as_deref() != Some(&event.account_id)
        {
            bail!("Scheduled event belongs to a different destination/channel.");
        }
        if event.lifecycle != "scheduled"
            || event.preparation.is_some()
            || event.operation_state == "pending"
        {
            bail!("This scheduled event needs recovery or is no longer upcoming.");
        }
        let provider_id = event
            .provider_event_id
            .as_ref()
            .context("The event has not been confirmed on YouTube")?;
        let confirmed = api(state, &event.account_id)
            .await?
            .get(provider_id)
            .await?
            .context("Scheduled event was deleted on YouTube")?;
        if scheduled_youtube::lifecycle(&confirmed) != "scheduled" {
            bail!("This event is no longer upcoming on YouTube.");
        }
        params.scheduled_confirmations.insert(
            target_id.clone(),
            ScheduledConfirmation {
                event_id: event.id.clone(),
                fingerprint: confirmation_fingerprint(&confirmed),
                title: confirmed["snippet"]["title"].as_str().unwrap_or("").into(),
                privacy: confirmed["status"]["privacyStatus"]
                    .as_str()
                    .unwrap_or("")
                    .into(),
                start_utc: confirmed["snippet"]["scheduledStartTime"]
                    .as_str()
                    .unwrap_or("")
                    .into(),
            },
        );
        params.scheduled_metadata.insert(
            target_id.clone(),
            crate::streaming::StreamMetadataDraft {
                title: confirmed
                    .pointer("/snippet/title")
                    .and_then(Value::as_str)
                    .context("Scheduled title unavailable")?
                    .into(),
                description: confirmed
                    .pointer("/snippet/description")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .into(),
                default_privacy: serde_json::from_value(
                    confirmed["status"]["privacyStatus"].clone(),
                )?,
                target_overrides: vec![],
                updated_at: event.updated_at,
            },
        );
    }
    Ok(())
}
