//! Running the transcription job in the background and reporting its progress.

use crate::state::{AppState, JobHandle, JobProgress};
use pt_core::models::{self, CATALOG};
use pt_core::pipeline::{self, JobConfig, Outcome, Stage};
use pt_core::project::Status;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager, State};

type CmdResult<T> = Result<T, String>;

fn err(e: anyhow::Error) -> String {
    format!("{e:#}")
}

/// Whether this build can use a GPU at all.
pub const GPU_BUILD: bool = cfg!(any(feature = "vulkan", feature = "metal", feature = "cuda"));

/// Threads for recognition: the physical cores, but not more than eight (no gain beyond that).
pub fn default_threads() -> usize {
    let physical = sysinfo::System::physical_core_count();
    let logical = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(4);
    physical.unwrap_or(logical.div_ceil(2)).clamp(1, 8)
}

/// Transcribe an interview now, or after the running one if another is busy.
#[tauri::command]
pub fn start_job(app: AppHandle, state: State<'_, AppState>, id: String) -> CmdResult<()> {
    enqueue(&app, &state, vec![id])
}

/// Transcribe several interviews one after another (the first now if nothing is running).
#[tauri::command]
pub fn queue_jobs(app: AppHandle, state: State<'_, AppState>, ids: Vec<String>) -> CmdResult<()> {
    enqueue(&app, &state, ids)
}

/// Interviews waiting for their turn, in order.
#[tauri::command]
pub fn job_queue(state: State<'_, AppState>) -> Vec<String> {
    state.queue.lock().unwrap().iter().cloned().collect()
}

fn enqueue(app: &AppHandle, state: &AppState, ids: Vec<String>) -> CmdResult<()> {
    let busy = state.job.lock().unwrap().as_ref().map(|j| j.project_id.clone());
    let mut first_error = None;
    for id in ids {
        if busy.as_deref() == Some(id.as_str()) || state.queue.lock().unwrap().contains(&id) {
            continue;
        }
        let running = state.job.lock().unwrap().is_some();
        if running {
            state.queue.lock().unwrap().push_back(id);
        } else if let Err(e) = launch(app, state, id) {
            first_error.get_or_insert(e);
        }
    }
    emit_queue(app, state);
    first_error.map_or(Ok(()), Err)
}

fn emit_queue(app: &AppHandle, state: &AppState) {
    let queue: Vec<String> = state.queue.lock().unwrap().iter().cloned().collect();
    let _ = app.emit("queue-changed", queue);
}

/// Start the next waiting interview, skipping any that cannot start.
fn start_next(app: &AppHandle) {
    let state = app.state::<AppState>();
    loop {
        let Some(id) = state.queue.lock().unwrap().pop_front() else { break };
        match launch(app, &state, id.clone()) {
            Ok(()) => break,
            Err(e) => {
                let _ = app.emit(
                    "job-progress",
                    JobProgress {
                        project_id: id,
                        stage: Stage::Prepare,
                        stage_fraction: 0.0,
                        fraction: 0.0,
                        eta_seconds: None,
                        preview: None,
                        state: "error",
                        error: Some(e),
                    },
                );
            }
        }
    }
    emit_queue(app, &state);
}

/// Name the speakers of an interview in a study by role ("Interviewer" and the participant code).
fn name_speakers(state: &AppState, id: &str) {
    let Ok(project) = state.store.load(id) else { return };
    let Some(study) = project.study_id.as_deref().and_then(|s| state.studies.load(s).ok()) else { return };
    let respondent = match project.participant_ids.as_slice() {
        [one] => study.participant(one).map(|p| p.code.clone()),
        _ => None,
    }
    .filter(|c| !c.is_empty())
    .unwrap_or_else(|| if study.language == pt_core::asr::Language::Nl { "Respondent".into() } else { "Participant".into() });
    let Ok(dir) = state.store.dir(id) else { return };
    let path = dir.join(pt_core::project::files::TRANSCRIPT);
    let Ok(mut transcript) = pt_core::fsutil::read_json::<pt_core::transcript::Transcript>(&path) else { return };
    if pt_core::transcript::name_by_role(&mut transcript, &study.interviewer_label, &respondent) {
        let _ = pt_core::fsutil::write_json(&path, &transcript);
    }
}

fn launch(app: &AppHandle, state: &AppState, id: String) -> CmdResult<()> {
    let app = app.clone();
    let settings = state.settings.lock().unwrap().clone();
    let mut project = state.store.load(&id).map_err(err)?;
    if !project.sources.iter().any(Option::is_some) {
        return Err("this interview has no recording yet".into());
    }
    let extra_glossary = project.study_id.as_deref().and_then(|s| state.studies.load(s).ok()).map(|s| s.glossary).unwrap_or_default();

    // The model: the project's own choice, else the preferred one, else any installed model.
    let wanted = project.model.clone().or(settings.model.clone());
    let spec = wanted
        .as_deref()
        .and_then(models::spec)
        .filter(|m| m.is_installed(&state.models_dir))
        .or_else(|| CATALOG.iter().find(|m| m.is_installed(&state.models_dir)))
        .ok_or("no speech model is installed yet")?;
    let vad_model = models::ensure_vad(&state.models_dir).map_err(err)?;

    let cancel = Arc::new(AtomicBool::new(false));
    let last = Arc::new(Mutex::new(None));
    {
        let mut job = state.job.lock().unwrap();
        if let Some(running) = job.as_ref() {
            return if running.project_id == id {
                Ok(())
            } else {
                Err("another transcription is still running; wait for it to finish or interrupt it first".into())
            };
        }
        *job = Some(JobHandle { project_id: id.clone(), cancel: cancel.clone(), last: last.clone() });
    }
    project.status = Status::Processing;
    project.error = None;
    state.store.save(&mut project).map_err(err)?;

    let cfg = JobConfig {
        model: spec.path(&state.models_dir),
        model_id: spec.id.to_string(),
        vad_model,
        voice_model: Some(models::VOICE_MODEL.path(&state.models_dir)).filter(|p| p.exists()),
        threads: if settings.threads > 0 { settings.threads } else { default_threads() },
        use_gpu: settings.use_gpu && GPU_BUILD,
        fast: settings.fast_mode,
        extra_glossary,
    };
    let store = state.store.clone();

    std::thread::Builder::new()
        .name("transcription".into())
        .spawn(move || {
            // Keep the computer awake for as long as the job runs. Closing the lid or an empty
            // battery still stops it, which is what the checkpoints are for.
            let _awake = keepawake::Builder::default()
                .idle(true)
                .sleep(true)
                .reason("Transcribing an interview")
                .app_name("Polarity Transcribe")
                .app_reverse_domain("nl.polarity.transcribe")
                .create()
                .ok();

            let publish = |p: JobProgress| {
                *last.lock().unwrap() = Some(p.clone());
                let _ = app.emit("job-progress", p);
            };
            let mut last_sent = Instant::now() - Duration::from_secs(1);
            let mut last_stage = None;
            let pid = id.clone();
            let mut on_progress = |p: pipeline::Progress| {
                // The pipeline reports very often; the UI needs a few updates per second.
                let important = last_stage != Some(p.stage) || p.preview.is_some();
                if !important && last_sent.elapsed() < Duration::from_millis(250) {
                    return;
                }
                last_sent = Instant::now();
                last_stage = Some(p.stage);
                publish(JobProgress {
                    project_id: pid.clone(),
                    stage: p.stage,
                    stage_fraction: p.stage_fraction,
                    fraction: p.fraction,
                    eta_seconds: p.eta_seconds,
                    preview: p.preview,
                    state: "running",
                    error: None,
                });
            };
            let result = pipeline::run(&store, &id, &cfg, &cancel, &mut on_progress);
            if matches!(result, Ok(Outcome::Done)) {
                name_speakers(&app.state::<AppState>(), &id);
            }

            let previous = last.lock().unwrap().clone();
            let (stage, fraction) = previous.map(|p| (p.stage, p.fraction)).unwrap_or((Stage::Prepare, 0.0));
            let finished = |state: &'static str, fraction: f32, error: Option<String>| JobProgress {
                project_id: id.clone(),
                stage: if state == "done" { Stage::Finish } else { stage },
                stage_fraction: if state == "done" { 1.0 } else { 0.0 },
                fraction,
                eta_seconds: None,
                preview: None,
                state,
                error,
            };
            let interrupted = matches!(result, Ok(Outcome::Cancelled));
            let last_event = match result {
                Ok(Outcome::Done) => finished("done", 1.0, None),
                Ok(Outcome::Cancelled) => finished("cancelled", fraction, None),
                Err(e) => finished("error", fraction, Some(format!("{e:#}"))),
            };
            let state = app.state::<AppState>();
            // Clear the handle before the final event so the UI can start another job at once.
            *state.job.lock().unwrap() = None;
            let _ = app.emit("job-progress", last_event);
            // An interruption by the user also stops the queue (they may need the computer);
            // deleting the interview that was running does not.
            let deleted = !store.dir(&id).map(|d| d.exists()).unwrap_or(false);
            if interrupted && !deleted {
                state.queue.lock().unwrap().clear();
                emit_queue(&app, &state);
            } else {
                start_next(&app);
            }
        })
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn cancel_job(app: AppHandle, state: State<'_, AppState>, id: String) {
    // A waiting interview just leaves the queue.
    let was_queued = {
        let mut queue = state.queue.lock().unwrap();
        let before = queue.len();
        queue.retain(|q| q != &id);
        queue.len() != before
    };
    if was_queued {
        emit_queue(&app, &state);
        return;
    }
    if let Some(job) = state.job.lock().unwrap().as_ref() {
        if job.project_id == id {
            job.cancel.store(true, Ordering::Relaxed);
        }
    }
}

/// Progress of the job for this project if it is running right now.
#[tauri::command]
pub fn job_status(state: State<'_, AppState>, id: String) -> Option<JobProgress> {
    let job = state.job.lock().unwrap();
    let job = job.as_ref().filter(|j| j.project_id == id)?;
    let last = job.last.lock().unwrap().clone();
    Some(last.unwrap_or(JobProgress {
        project_id: id,
        stage: Stage::Prepare,
        stage_fraction: 0.0,
        fraction: 0.0,
        eta_seconds: None,
        preview: None,
        state: "running",
        error: None,
    }))
}

/// Stop the running job when the application exits, so the checkpoint is left in a clean state.
pub fn stop_all(state: &AppState) {
    state.queue.lock().unwrap().clear();
    if let Some(job) = state.job.lock().unwrap().as_ref() {
        job.cancel.store(true, Ordering::Relaxed);
    }
}
