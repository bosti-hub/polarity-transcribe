//! Model management commands: listing, downloading with resume, importing, removing.
//!
//! This is the only place in the application that talks to the network, and only when the
//! user asks for a model.

use crate::state::AppState;
use pt_core::models::{self, ModelSpec, Tier, CATALOG};
use serde::Serialize;
use std::fs::{self, OpenOptions};
use std::io::{Read, Write};
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager, State};

type CmdResult<T> = Result<T, String>;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelInfo {
    id: &'static str,
    tier: Tier,
    size_bytes: u64,
    installed: bool,
    partial_bytes: u64,
    recommended: bool,
    /// The speech model is there but the small voice model that comes with it is not (its
    /// download failed or was interrupted). Speakers on a single recording cannot be told apart
    /// until it is fetched.
    extras_missing: bool,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct DownloadProgress {
    id: String,
    received_bytes: u64,
    total_bytes: u64,
    speed: f64,
    /// "downloading" | "verifying" | "done" | "error" | "paused"
    state: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

#[tauri::command]
pub fn list_models(state: State<'_, AppState>) -> Vec<ModelInfo> {
    let extras_missing = !models::VOICE_MODEL.is_installed(&state.models_dir);
    CATALOG
        .iter()
        .map(|m| ModelInfo {
            id: m.id,
            tier: m.tier,
            size_bytes: m.size,
            installed: m.is_installed(&state.models_dir),
            partial_bytes: m.partial_bytes(&state.models_dir),
            recommended: m.tier == Tier::Standard,
            extras_missing,
        })
        .collect()
}

/// Download (or continue downloading) one model. Returns immediately; progress and the final
/// result arrive as `download-progress` events.
#[tauri::command]
pub fn download_model(app: AppHandle, state: State<'_, AppState>, id: String) -> CmdResult<()> {
    let spec = models::spec(&id).ok_or("unknown model")?;
    let cancel = Arc::new(AtomicBool::new(false));
    {
        let mut downloads = state.downloads.lock().unwrap();
        if downloads.contains_key(&id) {
            return Ok(()); // already running
        }
        downloads.insert(id.clone(), cancel.clone());
    }
    let models_dir = state.models_dir.clone();
    std::thread::spawn(move || {
        let emit = |received: u64, speed: f64, st: &'static str, error: Option<String>| {
            let _ = app.emit(
                "download-progress",
                DownloadProgress { id: id.clone(), received_bytes: received, total_bytes: spec.size, speed, state: st, error },
            );
        };
        let result = download(spec, &models_dir, &cancel, &emit);
        app.state::<AppState>().downloads.lock().unwrap().remove(&id);
        match result {
            Ok(true) => emit(spec.size, 0.0, "done", None),
            Ok(false) => emit(spec.partial_bytes(&models_dir), 0.0, "paused", None),
            Err(e) => emit(spec.partial_bytes(&models_dir), 0.0, "error", Some(format!("{e:#}"))),
        }
    });
    Ok(())
}

/// Returns `Ok(true)` when the model is installed, `Ok(false)` when paused by the user.
fn download(
    spec: &'static ModelSpec,
    models_dir: &Path,
    cancel: &AtomicBool,
    emit: &dyn Fn(u64, f64, &'static str, Option<String>),
) -> anyhow::Result<bool> {
    fs::create_dir_all(models_dir)?;
    if !spec.is_installed(models_dir) {
        if !fetch(spec, models_dir, cancel, &|received, speed| emit(received, speed, "downloading", None))? {
            return Ok(false);
        }
        emit(spec.size, 0.0, "verifying", None);
        if !verify(spec, models_dir, cancel)? {
            return Ok(false);
        }
    }
    // The small voice model (for telling speakers apart on single-microphone recordings)
    // comes along with the first speech model.
    let voice = &models::VOICE_MODEL;
    if !voice.is_installed(models_dir) {
        emit(spec.size, 0.0, "verifying", None);
        if !fetch(voice, models_dir, cancel, &|_, _| {})? || !verify(voice, models_dir, cancel)? {
            return Ok(false);
        }
    }
    Ok(true)
}

/// Check the finished download and move it into place. `Ok(false)` = cancelled.
fn verify(spec: &'static ModelSpec, models_dir: &Path, cancel: &AtomicBool) -> anyhow::Result<bool> {
    let part = spec.part_path(models_dir);
    match models::install_verified(spec, &part, models_dir, cancel, false) {
        Ok(()) => Ok(true),
        Err(_) if cancel.load(Ordering::Relaxed) => Ok(false),
        Err(e) => {
            // A corrupt file cannot be resumed.
            let _ = fs::remove_file(&part);
            Err(e)
        }
    }
}

/// Download a file into its `.part` path, continuing a previous attempt if there is one.
/// `Ok(false)` = cancelled; the partial file is kept for resuming.
fn fetch(spec: &'static ModelSpec, models_dir: &Path, cancel: &AtomicBool, progress: &dyn Fn(u64, f64)) -> anyhow::Result<bool> {
    use anyhow::{bail, Context};
    let part = spec.part_path(models_dir);
    let mut have = spec.partial_bytes(models_dir);
    if have > spec.size {
        fs::remove_file(&part)?;
        have = 0;
    }
    if have == spec.size {
        return Ok(true);
    }
    let client = reqwest::blocking::Client::builder()
        .user_agent(concat!("PolarityTranscribe/", env!("CARGO_PKG_VERSION")))
        .connect_timeout(Duration::from_secs(20))
        .timeout(None)
        .build()?;
    let mut req = client.get(spec.url);
    if have > 0 {
        req = req.header(reqwest::header::RANGE, format!("bytes={have}-"));
    }
    let mut resp = req.send().context("could not reach the download server (is there an internet connection?)")?;
    let status = resp.status();
    if have > 0 && status == reqwest::StatusCode::OK {
        // The server ignored the range request: start over.
        have = 0;
    } else if !(status == reqwest::StatusCode::OK || status == reqwest::StatusCode::PARTIAL_CONTENT) {
        bail!("the download server answered with {status}");
    }
    let mut file = OpenOptions::new().create(true).write(true).truncate(have == 0).append(have > 0).open(&part)?;
    let mut buf = vec![0u8; 256 * 1024];
    let mut last_emit = Instant::now();
    let mut window_start = Instant::now();
    let mut window_bytes = 0u64;
    let mut speed = 0f64;
    progress(have, 0.0);
    loop {
        if cancel.load(Ordering::Relaxed) {
            file.flush()?;
            return Ok(false);
        }
        let n = resp.read(&mut buf).context("the connection was interrupted; the download can be resumed")?;
        if n == 0 {
            break;
        }
        file.write_all(&buf[..n]).context("could not write the model file (disk full?)")?;
        have += n as u64;
        window_bytes += n as u64;
        if last_emit.elapsed() >= Duration::from_millis(250) {
            let dt = window_start.elapsed().as_secs_f64();
            if dt >= 1.0 {
                let inst = window_bytes as f64 / dt;
                speed = if speed == 0.0 { inst } else { 0.6 * speed + 0.4 * inst };
                window_start = Instant::now();
                window_bytes = 0;
            }
            progress(have, speed);
            last_emit = Instant::now();
        }
    }
    file.sync_all()?;
    if have < spec.size {
        bail!("the connection was interrupted; the download can be resumed");
    }
    Ok(true)
}

#[tauri::command]
pub fn cancel_download(state: State<'_, AppState>, id: String) {
    if let Some(flag) = state.downloads.lock().unwrap().get(&id) {
        flag.store(true, Ordering::Relaxed);
    }
}

#[tauri::command]
pub fn delete_model(state: State<'_, AppState>, id: String) -> CmdResult<()> {
    let spec = models::spec(&id).ok_or("unknown model")?;
    if let Some(flag) = state.downloads.lock().unwrap().get(&id) {
        flag.store(true, Ordering::Relaxed);
    }
    let _ = fs::remove_file(spec.part_path(&state.models_dir));
    match fs::remove_file(spec.path(&state.models_dir)) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

/// Install a model from a file the user downloaded elsewhere (for computers without internet).
#[tauri::command]
pub async fn import_model(state: State<'_, AppState>, id: String, path: String) -> CmdResult<()> {
    let models_dir = state.models_dir.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let never = AtomicBool::new(false);
        let src = Path::new(&path);
        // Accept any catalogue model: the file size tells which one it is.
        let len = fs::metadata(src).map_err(|e| e.to_string())?.len();
        let spec = CATALOG
            .iter()
            .chain(std::iter::once(&models::VOICE_MODEL))
            .find(|m| m.size == len)
            .or_else(|| models::spec(&id))
            .ok_or("unknown model")?;
        models::install_verified(spec, src, &models_dir, &never, true).map_err(|e| format!("{e:#}"))
    })
    .await
    .map_err(|e| e.to_string())?
}
