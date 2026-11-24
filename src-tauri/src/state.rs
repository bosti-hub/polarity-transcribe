use anyhow::Result;
use pt_core::fsutil::{read_json, write_json};
use pt_core::project::Store;
use pt_core::study::StudyStore;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, VecDeque};
use std::path::PathBuf;
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex};

/// User preferences. Mirrors `Settings` in src/lib/types.ts.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    pub ui_language: String,
    pub theme: String,
    pub model: Option<String>,
    pub fast_mode: bool,
    /// 0 = automatic.
    pub threads: usize,
    pub use_gpu: bool,
    pub show_doubts: bool,
    pub doubt_threshold: f32,
    pub onboarded: bool,
    /// Look for a newer version on GitHub at startup.
    pub check_updates: bool,
    /// Seconds playback jumps back when resuming after a pause (0 = off).
    pub rewind_seconds: f64,
    /// Extra keys (for example a foot pedal) for play/pause, back and forward; "" = none.
    pub key_play_pause: String,
    pub key_back: String,
    pub key_forward: String,
    /// Underline spelling mistakes in the editor.
    pub spellcheck: bool,
    /// Open the short tour each time the app starts. Missing in older settings files, so
    /// people who updated see it once too.
    pub show_tutorial: bool,
}

impl Default for Settings {
    fn default() -> Self {
        // Follow the system language on first start: Dutch for Dutch systems, English otherwise.
        let dutch = std::env::var("LANG").map(|l| l.to_lowercase().starts_with("nl")).unwrap_or(false);
        Self {
            ui_language: if dutch { "nl" } else { "en" }.to_string(),
            theme: "system".into(),
            model: None,
            fast_mode: false,
            threads: 0,
            use_gpu: true,
            show_doubts: true,
            doubt_threshold: 0.5,
            onboarded: false,
            check_updates: true,
            rewind_seconds: 1.5,
            key_play_pause: String::new(),
            key_back: String::new(),
            key_forward: String::new(),
            spellcheck: false,
            show_tutorial: true,
        }
    }
}

/// Latest progress of the running job, as sent to the UI.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JobProgress {
    pub project_id: String,
    pub stage: pt_core::pipeline::Stage,
    pub stage_fraction: f32,
    pub fraction: f32,
    pub eta_seconds: Option<f64>,
    pub preview: Option<String>,
    /// "running" | "done" | "error" | "cancelled"
    pub state: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

pub struct JobHandle {
    pub project_id: String,
    pub cancel: Arc<AtomicBool>,
    pub last: Arc<Mutex<Option<JobProgress>>>,
}

pub struct AppState {
    pub data_dir: PathBuf,
    pub models_dir: PathBuf,
    pub store: Store,
    pub studies: StudyStore,
    /// Held while a study file is read, changed and written, so changes never overwrite each other.
    pub study_lock: Mutex<()>,
    pub settings: Mutex<Settings>,
    /// Cancel flags of running imports, keyed by (project id, slot).
    pub imports: Mutex<HashMap<(String, usize), Arc<AtomicBool>>>,
    /// Cancel flags of running model downloads, keyed by model id.
    pub downloads: Mutex<HashMap<String, Arc<AtomicBool>>>,
    /// The transcription job, if one is running. Only one runs at a time: it uses every core.
    pub job: Mutex<Option<JobHandle>>,
    /// Interviews waiting to be transcribed after the running one, in order.
    pub queue: Mutex<VecDeque<String>>,
}

impl AppState {
    pub fn new(data_dir: PathBuf) -> Result<Self> {
        std::fs::create_dir_all(&data_dir)?;
        let models_dir = data_dir.join("models");
        std::fs::create_dir_all(&models_dir)?;
        let store = Store::new(data_dir.join("projects"))?;
        let studies = StudyStore::new(data_dir.join("studies"))?;
        let settings = read_json(&data_dir.join("settings.json")).unwrap_or_default();
        Ok(Self {
            data_dir,
            models_dir,
            store,
            studies,
            study_lock: Mutex::new(()),
            settings: Mutex::new(settings),
            imports: Mutex::new(HashMap::new()),
            downloads: Mutex::new(HashMap::new()),
            job: Mutex::new(None),
            queue: Mutex::new(VecDeque::new()),
        })
    }

    pub fn save_settings(&self, settings: &Settings) -> Result<()> {
        write_json(&self.data_dir.join("settings.json"), settings)
    }
}
