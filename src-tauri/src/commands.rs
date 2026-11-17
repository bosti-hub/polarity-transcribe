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
pub fn set_settings(app: tauri::AppHandle, state: State<'_, AppState>, settings: Settings) -> CmdResult<()> {
    state.save_settings(&settings).map_err(err)?;
    let language_changed = state.settings.lock().unwrap().ui_language != settings.ui_language;
    #[cfg(target_os = "macos")]
    if language_changed {
        // The menu bar follows the app's language.
        if let Ok(menu) = crate::menu::build(&app, settings.ui_language == "nl") {
            let _ = app.set_menu(menu);
        }
    }
    #[cfg(not(target_os = "macos"))]
    let _ = (app, language_changed);
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
    /// Built-in labels the researcher removed from this interview's list.
    hidden_tags: Vec<String>,
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

/// Voice anonymisation for quote fragments. Both modes start from a random factor (0.80 to
/// 0.88, different for every fragment and not stored anywhere) by which pitch and formants are
/// lowered at the original speed.
/// - `tv`: as on television: a deeper voice whose shift also drifts slowly over time (vibrato at
///   a random rate), band-limited and compressed so it is clear and loud. Hard to undo because
///   the shift is unknown and changes over time, but not impossible in principle. Measured on a
///   Dutch interview: about 80% of the words still recognised.
/// - `whisper`: additionally replaces the phase of every short frame with random values, so the
///   fundamental frequency (pitch, intonation) is gone for good. Irreversible, less intelligible
///   (about 60%).
fn anonymise_filter(mode: &str) -> String {
    // Random values without a random-number crate: the clock's nanoseconds are unpredictable
    // enough here (the values only have to be unknown, not cryptographically secret).
    let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.subsec_nanos()).unwrap_or(0);
    let factor = 0.80 + 0.08 * (nanos % 1000) as f64 / 999.0;
    let drift = 0.25 + 0.25 * ((nanos / 1000) % 1000) as f64 / 999.0;
    let mut chain = format!(
        "aresample=44100,asetrate={rate},aresample=44100,atempo={tempo:.6},vibrato=f={drift:.3}:d=0.08,\
         highpass=f=150,lowpass=f=6000,\
         acompressor=threshold=-26dB:ratio=5:attack=5:release=150:makeup=8,alimiter=limit=0.95",
        rate = (44100.0 * factor).round() as u32,
        tempo = 1.0 / factor,
    );
    if mode == "whisper" {
        chain.push_str(",afftfilt=real='hypot(re,im)*cos(2*PI*random(0))':imag='hypot(re,im)*sin(2*PI*random(1))':win_size=512:overlap=0.75");
    }
    chain
}

/// Cut a passage out of an interview's playback audio into its own file (for quotes). `start`
/// and `end` are seconds on the transcript's timeline; `dest` ends in .m4a (AAC), .mp3 or .wav.
/// Re-encodes, so the cut is exact rather than snapped to the nearest audio frame. With `voice`
/// ("tv" or "whisper"), the voice is anonymised (see `anonymise_filter`); `bleeps` are spans
/// (transcript timeline) to beep out, such as pseudonymised names.
#[tauri::command]
pub async fn export_clip(
    state: State<'_, AppState>,
    id: String,
    start: f64,
    end: f64,
    dest: String,
    voice: Option<String>,
    bleeps: Option<Vec<(f64, f64)>>,
) -> CmdResult<()> {
    let dir = state.store.dir(&id).map_err(err)?;
    let source = dir.join(pt_core::pipeline::PLAYBACK_FILE);
    if !source.is_file() {
        return Err("this interview has no playback audio".into());
    }
    let start = start.max(0.0);
    if !(end > start) {
        return Err("the passage is empty".into());
    }
    let to = PathBuf::from(dest);
    let ext = to.extension().map(|e| e.to_string_lossy().to_lowercase()).unwrap_or_default();
    tauri::async_runtime::spawn_blocking(move || -> CmdResult<()> {
        if let Some(parent) = to.parent() {
            std::fs::create_dir_all(parent).map_err(|e| format!("could not create {}: {e}", parent.display()))?;
        }
        let mut cmd = pt_core::ffmpeg::ffmpeg_command();
        cmd.arg("-y")
            .args(["-ss", &format!("{start:.3}")])
            .arg("-i")
            .arg(&source)
            .args(["-t", &format!("{:.3}", end - start)])
            .arg("-vn");
        let filters: Vec<String> = [voice.as_deref().map(anonymise_filter), bleep_filter(&bleeps.unwrap_or_default(), start, end, voice.is_some())]
            .into_iter()
            .flatten()
            .collect();
        if !filters.is_empty() {
            cmd.arg("-af").arg(filters.join(","));
        }
        match ext.as_str() {
            "wav" => cmd.args(["-c:a", "pcm_s16le"]),
            "mp3" => cmd.args(["-c:a", "libmp3lame", "-b:a", "128k"]),
            _ => cmd.args(["-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart"]),
        };
        let out = cmd.arg(&to).output().map_err(|e| format!("could not start FFmpeg: {e}"))?;
        if !out.status.success() {
            return Err(format!("FFmpeg could not cut the passage: {}", String::from_utf8_lossy(&out.stderr).trim()));
        }
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// A beep over each span (seconds on the interview's timeline) of a fragment that starts at
/// `start`: a 1 kHz tone in place of the voice, a little wider than the words, as the
/// recogniser's word times are not exact. About as loud as the voice: `loud` for the disguised
/// voices, which are compressed to a high level. None when there is nothing to beep.
fn bleep_filter(spans: &[(f64, f64)], start: f64, end: f64, loud: bool) -> Option<String> {
    let parts: Vec<String> = spans
        .iter()
        .map(|&(s, e)| ((s - start - 0.08).max(0.0), (e - start + 0.06).min(end - start)))
        .filter(|(s, e)| e > s)
        .map(|(s, e)| format!("between(t,{s:.3},{e:.3})"))
        .collect();
    if parts.is_empty() {
        return None;
    }
    let level = if loud { 0.18 } else { 0.07 };
    Some(format!("aeval=exprs='if({},{level}*sin(2*PI*1000*t),val(ch))'", parts.join("+")))
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

/// Open one of the project's own web pages in the default browser. Only these fixed addresses
/// can be opened, so the frontend cannot use this to open arbitrary links.
#[tauri::command]
pub fn open_project_page(page: String) -> CmdResult<()> {
    let url = match page.as_str() {
        "home" => "https://github.com/bosti-hub/polarity-transcribe",
        "issues" => "https://github.com/bosti-hub/polarity-transcribe/issues",
        "license" => "https://github.com/bosti-hub/polarity-transcribe/blob/main/LICENSE",
        _ => return Err("unknown page".into()),
    };
    #[cfg(target_os = "windows")]
    let result = std::process::Command::new("explorer").arg(url).spawn();
    #[cfg(target_os = "macos")]
    let result = std::process::Command::new("open").arg(url).spawn();
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    let result = std::process::Command::new("xdg-open").arg(url).spawn();
    result.map(|_| ()).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::bleep_filter;

    #[test]
    fn bleeps_are_relative_to_the_fragment_and_clamped() {
        assert_eq!(bleep_filter(&[], 10.0, 20.0, false), None);
        assert_eq!(bleep_filter(&[(30.0, 31.0)], 10.0, 20.0, false), None);
        let f = bleep_filter(&[(9.5, 10.5), (12.0, 12.4), (19.9, 21.0)], 10.0, 20.0, true).unwrap();
        assert_eq!(f, "aeval=exprs='if(between(t,0.000,0.560)+between(t,1.920,2.460)+between(t,9.820,10.000),0.18*sin(2*PI*1000*t),val(ch))'");
    }
}
