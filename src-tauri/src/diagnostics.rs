//! System information for support: when transcription fails or is slow on someone's computer,
//! they copy this text from Settings > About and send it along with their question. It
//! describes the computer and the app (versions, processor, memory, graphics chips and the
//! speed checks, models, FFmpeg, recent transcription figures) and never the research data:
//! interview names, file names and the user's folders are replaced before anything is shown.
//! Nothing is sent anywhere; the person decides what to do with the text.

use std::fmt::Write as _;
use std::path::Path;

use pt_core::project::Status;
use tauri::State;

use crate::state::AppState;

#[tauri::command]
pub fn system_info(app: tauri::AppHandle, state: State<'_, AppState>) -> String {
    let mut out = String::new();
    let _ = write_report(&mut out, &app, &state);
    scrub(&out, &state)
}

fn write_report(out: &mut String, app: &tauri::AppHandle, state: &AppState) -> std::fmt::Result {
    let mut sys = sysinfo::System::new();
    sys.refresh_memory();
    sys.refresh_cpu_all();
    let gb = |b: u64| b as f64 / 1_073_741_824.0;

    writeln!(out, "Polarity Transcribe {}", app.package_info().version)?;
    writeln!(
        out,
        "Build: {} {}, graphics backend: {}",
        std::env::consts::OS,
        std::env::consts::ARCH,
        if cfg!(feature = "vulkan") {
            "Vulkan"
        } else if cfg!(feature = "metal") {
            "Metal"
        } else if cfg!(feature = "cuda") {
            "CUDA"
        } else {
            "none (processor only)"
        }
    )?;
    writeln!(out, "System: {}", sysinfo::System::long_os_version().unwrap_or_else(|| "unknown".into()))?;
    if let Some(k) = sysinfo::System::kernel_version() {
        writeln!(out, "Kernel: {k}")?;
    }
    writeln!(
        out,
        "Processor: {} ({} threads, {} cores), AVX2/FMA/F16C: {}",
        sys.cpus().first().map(|c| c.brand().trim().to_string()).unwrap_or_default(),
        std::thread::available_parallelism().map(|n| n.get()).unwrap_or(0),
        sysinfo::System::physical_core_count().unwrap_or(0),
        if crate::commands::cpu_supported() { "yes" } else { "NO (recognition not supported)" }
    )?;
    writeln!(out, "Memory: {:.1} GB, {:.1} GB available", gb(sys.total_memory()), gb(sys.available_memory()))?;

    // Graphics: every device, how its name is classified, the speed checks so far, the choice.
    writeln!(out)?;
    let (picked, _) = crate::commands::gpu_choice(&state.models_dir);
    let devices = pt_core::gpu::devices();
    if !crate::jobs::GPU_BUILD {
        writeln!(out, "Graphics: not used by this build")?;
    } else if devices.is_empty() {
        writeln!(out, "Graphics: no usable device found (no Vulkan driver, or none with enough memory)")?;
    } else {
        writeln!(out, "Graphics devices:")?;
        for d in &devices {
            writeln!(
                out,
                "  {}: {} ({}, {} MiB), name says: {:?}",
                d.index,
                d.name,
                if d.integrated { "integrated" } else { "graphics card" },
                d.memory_mib,
                pt_core::gpu::classify(d)
            )?;
        }
    }
    match std::fs::read_to_string(state.models_dir.join("gpu-check.json")) {
        Ok(checks) => writeln!(out, "Speed checks (gpu-check.json): {}", checks.split_whitespace().collect::<Vec<_>>().join(" "))?,
        Err(_) => writeln!(out, "Speed checks: none yet")?,
    }
    let settings = state.settings.lock().map(|s| s.clone()).ok();
    let use_gpu = settings.as_ref().map(|s| s.use_gpu).unwrap_or(true);
    writeln!(
        out,
        "Transcribes on: {}{}",
        picked.map(|d| d.name).unwrap_or_else(|| "the processor".into()),
        if use_gpu { "" } else { " (graphics switched off in Settings)" }
    )?;
    if let Ok(v) = std::env::var("PT_GPU_DEVICE") {
        writeln!(out, "PT_GPU_DEVICE={v}")?;
    }

    // Settings that change how transcription runs (no paths, no names).
    if let Some(s) = &settings {
        writeln!(
            out,
            "Settings: language {}, model {}, fast mode {}, threads {}, graphics {}",
            s.ui_language,
            s.model.as_deref().unwrap_or("default"),
            s.fast_mode,
            if s.threads == 0 { "automatic".to_string() } else { s.threads.to_string() },
            if s.use_gpu { "on" } else { "off" }
        )?;
    }

    // Models on disk.
    writeln!(out)?;
    writeln!(out, "Models:")?;
    let mut models: Vec<(String, u64)> = std::fs::read_dir(&state.models_dir)
        .map(|it| {
            it.flatten()
                .filter(|e| e.file_type().map(|t| t.is_file()).unwrap_or(false))
                .map(|e| (e.file_name().to_string_lossy().into_owned(), e.metadata().map(|m| m.len()).unwrap_or(0)))
                .filter(|(n, _)| n != "gpu-check.json")
                .collect()
        })
        .unwrap_or_default();
    models.sort();
    if models.is_empty() {
        writeln!(out, "  none")?;
    }
    for (name, size) in models {
        writeln!(out, "  {name} ({:.0} MB)", size as f64 / 1_048_576.0)?;
    }

    // FFmpeg: which one, and whether it starts.
    writeln!(out)?;
    let ffmpeg = pt_core::ffmpeg::ffmpeg_path();
    let which = if std::env::var_os("PT_FFMPEG").is_some() {
        "PT_FFMPEG"
    } else if ffmpeg.is_absolute() {
        "bundled with the app"
    } else {
        "from PATH"
    };
    let mut cmd = std::process::Command::new(&ffmpeg);
    cmd.arg("-version");
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    let version = cmd
        .output()
        .ok()
        .filter(|o| o.status.success())
        .and_then(|o| String::from_utf8_lossy(&o.stdout).lines().next().map(str::to_string))
        .unwrap_or_else(|| "does not start".into());
    writeln!(out, "FFmpeg ({which}): {version}")?;

    // The most recent interviews: how transcription went, and any error.
    writeln!(out)?;
    let mut projects = state.store.list();
    projects.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
    writeln!(out, "Interviews: {} in total; the most recent:", projects.len())?;
    for (n, p) in projects.iter().take(5).enumerate() {
        let sources = p.sources.iter().flatten().count();
        let length: f64 = p.sources.iter().flatten().map(|s| s.duration).fold(0.0, f64::max);
        write!(out, "  {}. {:?}, {} recording(s), {:.0} min", n + 1, p.status, sources, length / 60.0)?;
        let report = state
            .store
            .dir(&p.id)
            .ok()
            .and_then(|dir| read_report(&dir.join(pt_core::pipeline::REPORT_FILE)));
        if let Some(r) = report {
            write!(
                out,
                "; {} words, recognition {:.1}x real time on {}, speakers told apart by {:?}, model {}",
                r.words,
                r.audio_seconds / r.asr_seconds.max(1e-9),
                r.device.as_deref().unwrap_or("the processor"),
                r.method,
                r.model
            )?;
            if !r.sparse.is_empty() {
                write!(out, ", {} passage(s) with few words", r.sparse.len())?;
            }
        }
        writeln!(out)?;
        if p.status == Status::Failed || p.error.is_some() {
            writeln!(out, "     error: {}", p.error.as_deref().unwrap_or("(no message)"))?;
        }
    }
    Ok(())
}

fn read_report(path: &Path) -> Option<pt_core::pipeline::JobReport> {
    serde_json::from_slice(&std::fs::read(path).ok()?).ok()
}

/// Replace what could identify the research or the person: interview names, the names and
/// folders of the imported recordings, the app's data folder and the home folder.
fn scrub(text: &str, state: &AppState) -> String {
    let mut secrets: Vec<(String, &str)> = Vec::new();
    for p in state.store.list() {
        secrets.push((p.name.clone(), "<interview>"));
        for s in p.sources.iter().flatten() {
            let path = Path::new(&s.original_path);
            if let Some(parent) = path.parent() {
                secrets.push((parent.to_string_lossy().into_owned(), "<folder>"));
            }
            secrets.push((s.original_path.clone(), "<recording>"));
            secrets.push((s.file_name.clone(), "<recording>"));
            if let Some(stem) = path.file_stem() {
                secrets.push((stem.to_string_lossy().into_owned(), "<recording>"));
            }
        }
    }
    secrets.push((state.data_dir.to_string_lossy().into_owned(), "<app data>"));
    if let Some(home) = std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" }) {
        secrets.push((home.to_string_lossy().into_owned(), "~"));
    }
    if let Ok(user) = std::env::var(if cfg!(windows) { "USERNAME" } else { "USER" }) {
        secrets.push((user, "<user>"));
    }
    // Longest first, so a full path is replaced before the folder or name inside it.
    secrets.retain(|(s, _)| s.trim().chars().count() >= 3);
    secrets.sort_by(|a, b| b.0.len().cmp(&a.0.len()));
    secrets.dedup_by(|a, b| a.0 == b.0);
    let mut out = text.to_string();
    for (secret, with) in secrets {
        out = replace_ignoring_case(&out, &secret, with);
    }
    out
}

/// `text` with every occurrence of `find` replaced, ignoring ASCII case (Windows paths).
fn replace_ignoring_case(text: &str, find: &str, with: &str) -> String {
    let lower = text.to_ascii_lowercase();
    let needle = find.to_ascii_lowercase();
    let mut out = String::with_capacity(text.len());
    let mut last = 0;
    for (i, _) in lower.match_indices(&needle) {
        if i < last {
            continue;
        }
        out.push_str(&text[last..i]);
        out.push_str(with);
        last = i + needle.len();
    }
    out.push_str(&text[last..]);
    out
}

#[cfg(test)]
mod tests {
    use super::replace_ignoring_case;

    #[test]
    fn replaces_paths_whatever_their_case() {
        assert_eq!(
            replace_ignoring_case(r"could not read C:\Users\Jan\Interview Piet.mp3: denied", r"c:\users\jan\interview piet.mp3", "<recording>"),
            "could not read <recording>: denied"
        );
        assert_eq!(replace_ignoring_case("Piet en piet", "piet", "<x>"), "<x> en <x>");
    }
}
