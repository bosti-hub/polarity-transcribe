use crate::state::{AppState, Settings};
use pt_core::asr::Language;
use pt_core::import;
use pt_core::project::{files, Layout, Project, Review, Status};
use pt_core::transcript::Transcript;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tauri::{AppHandle, Emitter, State};

type CmdResult<T> = Result<T, String>;

fn err(e: anyhow::Error) -> String {
    format!("{e:#}")
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectView {
    #[serde(flatten)]
    project: Project,
    /// Absolute path of the project folder (for media URLs).
    dir: String,
    layout: Layout,
}

fn view(state: &AppState, project: Project) -> CmdResult<ProjectView> {
    let dir = state.store.dir(&project.id).map_err(err)?.to_string_lossy().into_owned();
    let layout = project.layout();
    Ok(ProjectView { project, dir, layout })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppInfo {
    version: String,
    data_dir: String,
    os: &'static str,
    cpu_threads: usize,
    cpu_name: String,
    ram_gb: f64,
    /// False on processors that lack the instructions the recogniser was built for.
    cpu_supported: bool,
    gpu_build: bool,
    /// The graphics device transcription would use, if the build supports one and one fits.
    gpu: Option<String>,
    /// Whether that device is built into the processor (slower than a graphics card).
    gpu_integrated: bool,
    /// Graphics built into the processor that turned out slower than the processor itself.
    gpu_slower: Option<String>,
}

/// The graphics device that would be used, and an integrated one that lost its speed race.
fn gpu_choice(models_dir: &std::path::Path) -> (Option<pt_core::gpu::GpuDevice>, Option<String>) {
    pt_core::gpu::set_check_file(models_dir.join("gpu-check.json"));
    let picked = pt_core::gpu::pick();
    let slower = if picked.is_none() {
        pt_core::gpu::devices().into_iter().find(|d| d.integrated).map(|d| d.name)
    } else {
        None
    };
    (picked, slower)
}

fn cpu_supported() -> bool {
    #[cfg(target_arch = "x86_64")]
    {
        std::is_x86_feature_detected!("avx2") && std::is_x86_feature_detected!("fma") && std::is_x86_feature_detected!("f16c")
    }
    #[cfg(not(target_arch = "x86_64"))]
    {
        true
    }
}

#[tauri::command]
pub fn app_info(app: tauri::AppHandle, state: State<'_, AppState>) -> AppInfo {
    let mut sys = sysinfo::System::new();
    sys.refresh_memory();
    sys.refresh_cpu_all();
    let (gpu, gpu_slower) = gpu_choice(&state.models_dir);
    AppInfo {
        // The version the updater compares against (from Cargo.toml).
        version: app.package_info().version.to_string(),
        data_dir: state.data_dir.to_string_lossy().into_owned(),
        os: std::env::consts::OS,
        cpu_threads: std::thread::available_parallelism().map(|n| n.get()).unwrap_or(4),
        cpu_name: sys.cpus().first().map(|c| c.brand().trim().to_string()).unwrap_or_default(),
        ram_gb: (sys.total_memory() as f64 / 1_073_741_824.0 * 10.0).round() / 10.0,
        cpu_supported: cpu_supported(),
        gpu_build: crate::jobs::GPU_BUILD,
        gpu_integrated: gpu.as_ref().is_some_and(|d| d.integrated),
        gpu: gpu.map(|d| d.name),
        gpu_slower,
    }
}

#[tauri::command]
pub fn get_settings(state: State<'_, AppState>) -> Settings {
    state.settings.lock().unwrap().clone()
}

#[tauri::command]
pub fn set_settings(state: State<'_, AppState>, settings: Settings) -> CmdResult<()> {
    state.save_settings(&settings).map_err(err)?;
    *state.settings.lock().unwrap() = settings;
    Ok(())
}

#[tauri::command]
pub fn list_projects(state: State<'_, AppState>) -> CmdResult<Vec<ProjectView>> {
    state.store.list().into_iter().map(|p| view(&state, p)).collect()
}

/// Create an interview. In a study it takes the study's defaults and gets a new participant code.
#[tauri::command]
pub fn create_project(state: State<'_, AppState>, name: String, language: Language, study_id: Option<String>) -> CmdResult<ProjectView> {
    let study = match study_id.as_deref().filter(|s| !s.is_empty()) {
        Some(id) => Some(state.studies.load(id).map_err(err)?),
        None => None,
    };
    let mut p = state.store.create(&name, study.as_ref().map(|s| s.language).unwrap_or(language)).map_err(err)?;
    if let Some(study) = study {
        join_study(&state, &mut p, &study.id)?;
        p.pause_threshold = study.pause_threshold;
        p.interviewer = study.interviewer.clone();
        state.store.save(&mut p).map_err(err)?;
    }
    view(&state, p)
}

/// Put an interview in a study with a new participant of its own.
fn join_study(state: &AppState, p: &mut Project, study_id: &str) -> CmdResult<()> {
    let (_, participant) = crate::studies::with_study(state, study_id, |s| s.add_participant())?;
    p.study_id = Some(study_id.to_string());
    p.participant_ids = vec![participant];
    Ok(())
}

#[tauri::command]
pub fn get_project(state: State<'_, AppState>, id: String) -> CmdResult<ProjectView> {
    let p = state.store.load(&id).map_err(err)?;
    view(&state, p)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrimPatch {
    slot: usize,
    start: f64,
    end: f64,
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ProjectPatch {
    name: Option<String>,
    language: Option<Language>,
    /// "auto" | "split" | "mono"
    stereo_mode: Option<String>,
    speaker_count: Option<u8>,
    pause_threshold: Option<f64>,
    glossary: Option<Vec<String>>,
    model: Option<String>,
    trims: Option<Vec<TrimPatch>>,
    /// Move to another study; "" takes the interview out of its study.
    study_id: Option<String>,
    participant_ids: Option<Vec<String>>,
    /// "YYYY-MM-DD", or "" for the recording's file date.
    interview_date: Option<String>,
    interviewer: Option<String>,
    tags: Option<Vec<String>>,
    notes: Option<String>,
    review: Option<Review>,
}

#[tauri::command]
pub fn update_project(state: State<'_, AppState>, id: String, patch: ProjectPatch) -> CmdResult<ProjectView> {
    let mut p = state.store.load(&id).map_err(err)?;
    if let Some(name) = patch.name {
        let name = name.trim();
        if !name.is_empty() {
            p.name = name.to_string();
        }
    }
    if let Some(l) = patch.language {
        p.language = l;
    }
    if let Some(mode) = patch.stereo_mode {
        p.split_stereo = match mode.as_str() {
            "split" => Some(true),
            "mono" => Some(false),
            _ => None,
        };
    }
    if let Some(n) = patch.speaker_count {
        p.speaker_count = n.min(6);
    }
    if let Some(t) = patch.pause_threshold {
        p.pause_threshold = t.clamp(0.5, 60.0);
    }
    if let Some(g) = patch.glossary {
        p.glossary = g.into_iter().map(|s| s.trim().to_string()).filter(|s| !s.is_empty()).take(60).collect();
    }
    if let Some(m) = patch.model {
        p.model = if m.is_empty() { None } else { Some(m) };
    }
    for t in patch.trims.unwrap_or_default() {
        if let Some(Some(src)) = p.sources.get_mut(t.slot) {
            let start = t.start.clamp(0.0, src.duration);
            let end = t.end.clamp(start, src.duration);
            src.trim_start = start;
            src.trim_end = end;
        }
    }

    // ---- interview details
    if let Some(target) = patch.study_id {
        let target = Some(target).filter(|t| !t.is_empty());
        if target != p.study_id {
            if let Some(old) = p.study_id.take() {
                let released = std::mem::take(&mut p.participant_ids);
                crate::studies::release_participants(&state, &old, &released, &p.id);
            }
            p.participant_ids.clear();
            if let Some(new) = target {
                join_study(&state, &mut p, &new)?;
            }
        }
    }
    if let Some(ids) = patch.participant_ids {
        if let Some(study) = p.study_id.clone() {
            let dropped: Vec<String> = p.participant_ids.iter().filter(|x| !ids.contains(x)).cloned().collect();
            p.participant_ids = ids;
            crate::studies::release_participants(&state, &study, &dropped, &p.id);
        }
    }
    if let Some(d) = patch.interview_date {
        let d = d.trim();
        let valid = d.len() == 10 && d.chars().enumerate().all(|(i, c)| if i == 4 || i == 7 { c == '-' } else { c.is_ascii_digit() });
        p.interview_date = valid.then(|| d.to_string());
    }
    if let Some(i) = patch.interviewer {
        p.interviewer = i.trim().to_string();
    }
    if let Some(tags) = patch.tags {
        let mut clean: Vec<String> = Vec::new();
        for t in tags {
            let t = t.trim().to_string();
            if !t.is_empty() && !clean.iter().any(|c| c.eq_ignore_ascii_case(&t)) {
                clean.push(t);
            }
        }
        if let Some(study) = p.study_id.clone() {
            let _ = crate::studies::with_study(&state, &study, |s| clean.iter().for_each(|t| s.learn_tag(t)));
        }
        p.tags = clean;
    }
    if let Some(n) = patch.notes {
        p.notes = n;
    }
    if let Some(r) = patch.review {
        p.review = r;
    }
    state.store.save(&mut p).map_err(err)?;
    view(&state, p)
}

#[tauri::command]
pub fn delete_project(state: State<'_, AppState>, id: String) -> CmdResult<()> {
    let project = state.store.load(&id).ok();
    delete_project_files(&state, &id)?;
    if let Some(p) = project {
        if let Some(study) = p.study_id {
            crate::studies::release_participants(&state, &study, &p.participant_ids, &p.id);
        }
    }
    Ok(())
}

/// Stop work on an interview and delete its folder.
pub fn delete_project_files(state: &AppState, id: &str) -> CmdResult<()> {
    let id = id.to_string();
    state.queue.lock().unwrap().retain(|q| q != &id);
    // Stop anything still writing into the folder first.
    for (key, flag) in state.imports.lock().unwrap().iter() {
        if key.0 == id {
            flag.store(true, Ordering::Relaxed);
        }
    }
    let running = state.job.lock().unwrap().as_ref().filter(|j| j.project_id == id).map(|j| j.cancel.clone());
    if let Some(cancel) = running {
        cancel.store(true, Ordering::Relaxed);
        // Give the job a moment to let go of its files.
        for _ in 0..100 {
            if state.job.lock().unwrap().is_none() {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(100));
        }
    }
    state.store.delete(&id).map_err(err)
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ImportProgress {
    project_id: String,
    slot: usize,
    fraction: f32,
}

/// Decode a recording into the project. Resolves when the import has finished.
#[tauri::command]
pub async fn import_audio(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
    slot: usize,
    path: String,
) -> CmdResult<ProjectView> {
    if slot > 1 {
        return Err("invalid slot".into());
    }
    let dir = state.store.dir(&id).map_err(err)?;
    let cancel = Arc::new(AtomicBool::new(false));
    if let Some(old) = state.imports.lock().unwrap().insert((id.clone(), slot), cancel.clone()) {
        old.store(true, Ordering::Relaxed);
    }

    let (pid, flag) = (id.clone(), cancel.clone());
    let result = tauri::async_runtime::spawn_blocking(move || {
        import::import_source(&dir, slot, &PathBuf::from(path), &flag, |fraction| {
            let _ = app.emit("import-progress", ImportProgress { project_id: pid.clone(), slot, fraction });
        })
    })
    .await
    .map_err(|e| e.to_string())?;

    {
        let mut imports = state.imports.lock().unwrap();
        if imports.get(&(id.clone(), slot)).is_some_and(|f| Arc::ptr_eq(f, &cancel)) {
            imports.remove(&(id.clone(), slot));
        }
    }
    let source = result.map_err(err)?;

    let mut p = state.store.load(&id).map_err(err)?;
    if p.sources.len() < 2 {
        p.sources.resize(2, None);
    }
    p.sources[slot] = Some(source);
    p.split_stereo = None;
    p.status = Status::Setup;
    state.store.save(&mut p).map_err(err)?;
    view(&state, p)
}

#[tauri::command]
pub fn cancel_import(state: State<'_, AppState>, id: String, slot: usize) {
    if let Some(flag) = state.imports.lock().unwrap().get(&(id, slot)) {
        flag.store(true, Ordering::Relaxed);
    }
}

#[tauri::command]
pub fn remove_audio(state: State<'_, AppState>, id: String, slot: usize) -> CmdResult<ProjectView> {
    let mut p = state.store.load(&id).map_err(err)?;
    let dir = state.store.dir(&id).map_err(err)?;
    if let Some(s) = p.sources.get_mut(slot) {
        *s = None;
    }
    import::remove_source(&dir, slot);
    p.split_stereo = None;
    state.store.save(&mut p).map_err(err)?;
    view(&state, p)
}

/// Waveform peaks of one channel as raw bytes (one byte per 20 ms, square-root companded).
#[tauri::command]
pub fn read_peaks(state: State<'_, AppState>, id: String, slot: usize, right: bool) -> CmdResult<tauri::ipc::Response> {
    let dir = state.store.dir(&id).map_err(err)?;
    let bytes = std::fs::read(dir.join(files::peaks(slot, right))).map_err(|e| e.to_string())?;
    Ok(tauri::ipc::Response::new(bytes))
}

/// Offset between the two recordings of a project: `file2_time = file1_time + offset`.
/// `None` when they cannot be aligned.
#[tauri::command]
pub async fn quick_sync(state: State<'_, AppState>, id: String) -> CmdResult<Option<f64>> {
    let project = state.store.load(&id).map_err(err)?;
    let dir = state.store.dir(&id).map_err(err)?;
    let (Some(a), Some(b)) = (project.source(0), project.source(1)) else { return Ok(None) };
    let (d1, d2) = (a.duration, b.duration);
    tauri::async_runtime::spawn_blocking(move || {
        use pt_core::fsutil::pcm_read;
        use pt_core::sync::{estimate, Track};
        let read = |slot: usize| {
            let path = dir.join(files::pcm(slot, false));
            move |start: i64, len: usize| -> anyhow::Result<Vec<f32>> {
                if start >= 0 {
                    return pcm_read(&path, start as u64, len);
                }
                let skip = ((-start) as usize).min(len);
                let mut out = vec![0f32; skip];
                out.extend(pcm_read(&path, 0, len - skip)?);
                Ok(out)
            }
        };
        let (mut r1, mut r2) = (read(0), read(1));
        let mut t1 = Track { read: &mut r1, start: 0.0, end: d1 };
        let mut t2 = Track { read: &mut r2, start: 0.0, end: d2 };
        Ok(estimate(&mut t1, &mut t2, |_| {}).ok().map(|(_, report)| report.offset))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub fn load_transcript(state: State<'_, AppState>, id: String) -> CmdResult<Transcript> {
    let dir = state.store.dir(&id).map_err(err)?;
    pt_core::fsutil::read_json(&dir.join(files::TRANSCRIPT)).map_err(err)
}

/// Autosave: every edit ends up here within moments. The write is atomic, so a crash never
/// leaves a half-written transcript.
#[tauri::command]
pub fn save_transcript(state: State<'_, AppState>, id: String, transcript: Transcript) -> CmdResult<()> {
    let dir = state.store.dir(&id).map_err(err)?;
    if !dir.join(files::PROJECT).exists() {
        return Err("this project no longer exists".into());
    }
    pt_core::fsutil::write_json(&dir.join(files::TRANSCRIPT), &transcript).map_err(err)
}

#[derive(Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct AnonymizeRule {
    find: String,
    replace: String,
}

/// Editor state that belongs to a project but is not transcript text.
#[derive(Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct ProjectExtras {
    anonymize: Vec<AnonymizeRule>,
    custom_tags: Vec<String>,
    /// Transcript time (seconds) up to which the researcher has checked the text against the audio.
    reviewed_until: Option<f64>,
    /// Passages the researcher saved as quotes.
    quotes: Vec<Quote>,
}

/// A saved passage: its text as it was when saved, where it is in the audio, and a note.
#[derive(Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct Quote {
    id: String,
    text: String,
    /// Start and end in transcript time (seconds).
    s: f64,
    e: f64,
    /// Speaker id of the turn the quote starts in.
    speaker: String,
    note: String,
    created_at: u64,
}

const EXTRAS_FILE: &str = "extras.json";

#[tauri::command]
pub fn load_extras(state: State<'_, AppState>, id: String) -> CmdResult<ProjectExtras> {
    let dir = state.store.dir(&id).map_err(err)?;
    Ok(pt_core::fsutil::read_json(&dir.join(EXTRAS_FILE)).unwrap_or_default())
}

#[tauri::command]
pub fn save_extras(state: State<'_, AppState>, id: String, extras: ProjectExtras) -> CmdResult<()> {
    let dir = state.store.dir(&id).map_err(err)?;
    pt_core::fsutil::write_json(&dir.join(EXTRAS_FILE), &extras).map_err(err)
}

/// Diagnostics of the last transcription (sync and speaker-separation quality).
#[tauri::command]
pub fn load_report(state: State<'_, AppState>, id: String) -> CmdResult<Option<serde_json::Value>> {
    let dir = state.store.dir(&id).map_err(err)?;
    Ok(pt_core::fsutil::read_json(&dir.join(pt_core::pipeline::REPORT_FILE)).ok())
}

/// Write an exported document to the location the user chose (folders are created as needed).
#[tauri::command]
pub fn write_file(path: String, bytes: Vec<u8>) -> CmdResult<()> {
    let path = std::path::Path::new(&path);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("could not create {}: {e}", parent.display()))?;
    }
    pt_core::fsutil::write_atomic(path, &bytes).map_err(err)
}

/// Copy the original recording of an interview (the main one) to `dest`, for analysis software
/// that links the transcript to the recording. Returns false when the original is gone.
#[tauri::command]
pub async fn copy_original(state: State<'_, AppState>, id: String, dest: String) -> CmdResult<bool> {
    let project = state.store.load(&id).map_err(err)?;
    let Some(source) = project.sources.iter().flatten().next() else { return Ok(false) };
    let from = PathBuf::from(&source.original_path);
    if !from.is_file() {
        return Ok(false);
    }
    let to = PathBuf::from(dest);
    tauri::async_runtime::spawn_blocking(move || -> CmdResult<bool> {
        if let Some(parent) = to.parent() {
            std::fs::create_dir_all(parent).map_err(|e| format!("could not create {}: {e}", parent.display()))?;
        }
        std::fs::copy(&from, &to).map_err(|e| format!("could not copy {}: {e}", from.display()))?;
        Ok(true)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Show a file or folder in the system file manager.
#[tauri::command]
pub fn reveal_in_folder(path: String) -> CmdResult<()> {
    let p = std::path::Path::new(&path);
    if !p.exists() {
        return Err("the path does not exist".into());
    }
    #[cfg(target_os = "windows")]
    let result = if p.is_dir() {
        std::process::Command::new("explorer").arg(p).spawn()
    } else {
        std::process::Command::new("explorer").arg(format!("/select,{}", p.display())).spawn()
    };
    #[cfg(target_os = "macos")]
    let result = if p.is_dir() {
        std::process::Command::new("open").arg(p).spawn()
    } else {
        std::process::Command::new("open").arg("-R").arg(p).spawn()
    };
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    let result = std::process::Command::new("xdg-open").arg(if p.is_dir() { p } else { p.parent().unwrap_or(p) }).spawn();
    result.map(|_| ()).map_err(|e| e.to_string())
}
