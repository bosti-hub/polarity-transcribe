//! Projects on disk.
//!
//! One folder per project holds everything derived from the recordings: decoded audio caches,
//! preview files, intermediate results and the transcript. Nothing is written anywhere else,
//! so deleting the folder removes every trace of the interview that the app created.

use crate::asr::Language;
use crate::ffmpeg::Channel;
use crate::fsutil::{now_ms, read_json, write_json};
use crate::stereo::{StereoKind, StereoVerdict};
use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Status {
    /// Audio is being chosen and trimmed.
    Setup,
    /// A transcription job exists (running, interrupted or waiting to resume).
    Processing,
    /// Transcript is available.
    Ready,
    Failed,
}

fn one() -> f32 {
    1.0
}

fn yes() -> bool {
    true
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Source {
    pub file_name: String,
    /// Where the file was imported from. Informational only; the app never touches it again.
    pub original_path: String,
    pub duration: f64,
    /// Channels kept in the cache: 1, or 2 when left and right differ.
    pub channels: u8,
    /// Linear gain applied at import to bring quiet recordings to a usable level.
    #[serde(default = "one")]
    pub gain: f32,
    pub stereo: StereoVerdict,
    pub trim_start: f64,
    pub trim_end: f64,
    /// Last-modified time of the original file (ms since the epoch): usually the recording date.
    #[serde(default)]
    pub modified_ms: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Project {
    pub id: String,
    pub name: String,
    pub created_at: u64,
    pub updated_at: u64,
    pub language: Language,
    /// Slot 0 and optionally slot 1.
    pub sources: Vec<Option<Source>>,
    /// Manual override for one two-channel file: `Some(true)` = one speaker per channel.
    pub split_stereo: Option<bool>,
    /// Expected speakers for a single recording: 1 (a lecture or presentation: voices are not
    /// told apart), 2 or 3. 0 is treated as 2.
    pub speaker_count: u8,
    /// Pauses longer than this get a pause tag (seconds).
    pub pause_threshold: f64,
    /// Verbatim transcript: hesitation fillers ("[uhm]") and pause tags are written out. Off
    /// for a lecture, where they only get in the way of reading.
    #[serde(default = "yes")]
    pub verbatim: bool,
    /// Names and terms the recogniser should know about.
    pub glossary: Vec<String>,
    /// Model id; `None` = the app default.
    pub model: Option<String>,
    pub status: Status,
    /// Length of the transcribed region in seconds (0 until known).
    pub duration: f64,
    pub error: Option<String>,

    // ---- interview details (all optional; older projects have none)
    /// The study this interview belongs to.
    #[serde(default)]
    pub study_id: Option<String>,
    /// Participants (ids within the study) who are interviewed.
    #[serde(default)]
    pub participant_ids: Vec<String>,
    /// Date of the interview (YYYY-MM-DD); `None` = the recording's file date.
    #[serde(default)]
    pub interview_date: Option<String>,
    #[serde(default)]
    pub interviewer: String,
    #[serde(default)]
    pub tags: Vec<String>,
    /// Field notes, memo.
    #[serde(default)]
    pub notes: String,
    /// How far the researcher has got with the transcript.
    #[serde(default)]
    pub review: Review,
}

/// Manual progress after transcription.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Review {
    /// Not yet checked against the audio.
    #[default]
    Todo,
    Checked,
    Anonymised,
    Done,
}

/// How the recordings map to speaker tracks.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Layout {
    /// One recording with everyone on it.
    Single,
    /// One file, one speaker per channel.
    SplitStereo,
    /// Two separate recordings of the same conversation.
    DualFile,
}

/// One speaker track: a channel of a source between its trim points.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct TrackSpec {
    pub source: usize,
    pub channel: Channel,
    pub start: f64,
    pub end: f64,
}

impl Project {
    pub fn source(&self, slot: usize) -> Option<&Source> {
        self.sources.get(slot).and_then(|s| s.as_ref())
    }

    pub fn layout(&self) -> Layout {
        match (self.source(0), self.source(1)) {
            (Some(_), Some(_)) => Layout::DualFile,
            (Some(s), None) | (None, Some(s)) => {
                let auto = s.stereo.kind == StereoKind::SplitSpeakers;
                if s.channels == 2 && self.split_stereo.unwrap_or(auto) {
                    Layout::SplitStereo
                } else {
                    Layout::Single
                }
            }
            (None, None) => Layout::Single,
        }
    }

    /// Speaker tracks in order (speaker 1 first).
    pub fn tracks(&self) -> Vec<TrackSpec> {
        let mono = |slot: usize, s: &Source| TrackSpec {
            source: slot,
            channel: if s.channels == 2 { s.stereo.mono_channel } else { Channel::Left },
            start: s.trim_start,
            end: s.trim_end,
        };
        match self.layout() {
            Layout::DualFile => vec![mono(0, self.source(0).unwrap()), mono(1, self.source(1).unwrap())],
            Layout::SplitStereo => {
                let (slot, s) = self.only_source().unwrap();
                [Channel::Left, Channel::Right]
                    .into_iter()
                    .map(|channel| TrackSpec { source: slot, channel, start: s.trim_start, end: s.trim_end })
                    .collect()
            }
            Layout::Single => self.only_source().map(|(slot, s)| vec![mono(slot, s)]).unwrap_or_default(),
        }
    }

    fn only_source(&self) -> Option<(usize, &Source)> {
        self.sources.iter().enumerate().find_map(|(i, s)| s.as_ref().map(|s| (i, s)))
    }
}

/// File names inside a project folder.
pub mod files {
    pub const PROJECT: &str = "project.json";
    pub const TRANSCRIPT: &str = "transcript.json";
    pub const TRANSCRIPT_BACKUP: &str = "transcript.backup.json";
    /// Editor state that is not transcript text (rules, labels, quotes).
    pub const EXTRAS: &str = "extras.json";
    pub const JOB_DIR: &str = "job";

    pub fn pcm(slot: usize, right: bool) -> String {
        format!("source{}_{}.pcm", slot + 1, if right { "r" } else { "l" })
    }
    pub fn peaks(slot: usize, right: bool) -> String {
        format!("source{}_{}.peaks", slot + 1, if right { "r" } else { "l" })
    }
    pub fn preview(slot: usize) -> String {
        format!("source{}.m4a", slot + 1)
    }
}

#[derive(Debug, Clone)]
pub struct Store {
    root: PathBuf,
}

impl Store {
    pub fn new(root: impl Into<PathBuf>) -> Result<Self> {
        let root = root.into();
        fs::create_dir_all(&root).with_context(|| format!("could not create {}", root.display()))?;
        Ok(Self { root })
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    pub fn dir(&self, id: &str) -> Result<PathBuf> {
        // Ids are generated by us; refuse anything that could escape the projects folder.
        if id.is_empty() || !id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') {
            bail!("invalid project id");
        }
        Ok(self.root.join(id))
    }

    pub fn create(&self, name: &str, language: Language) -> Result<Project> {
        let id = uuid::Uuid::new_v4().to_string();
        let dir = self.dir(&id)?;
        fs::create_dir_all(&dir)?;
        let now = now_ms();
        let p = Project {
            id,
            name: name.trim().to_string(),
            created_at: now,
            updated_at: now,
            language,
            sources: vec![None, None],
            split_stereo: None,
            speaker_count: 2,
            pause_threshold: 3.0,
            verbatim: true,
            glossary: Vec::new(),
            model: None,
            status: Status::Setup,
            duration: 0.0,
            error: None,
            study_id: None,
            participant_ids: Vec::new(),
            interview_date: None,
            interviewer: String::new(),
            tags: Vec::new(),
            notes: String::new(),
            review: Review::Todo,
        };
        write_json(&dir.join(files::PROJECT), &p)?;
        Ok(p)
    }

    pub fn load(&self, id: &str) -> Result<Project> {
        read_json(&self.dir(id)?.join(files::PROJECT))
    }

    pub fn save(&self, project: &mut Project) -> Result<()> {
        project.updated_at = now_ms();
        write_json(&self.dir(&project.id)?.join(files::PROJECT), project)
    }

    /// All readable projects, most recently changed first.
    pub fn list(&self) -> Vec<Project> {
        let mut out: Vec<Project> = fs::read_dir(&self.root)
            .into_iter()
            .flatten()
            .flatten()
            .filter(|e| e.path().is_dir())
            .filter_map(|e| read_json::<Project>(&e.path().join(files::PROJECT)).ok())
            .collect();
        out.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
        out
    }

    /// Permanently remove a project and every file derived from its recordings.
    pub fn delete(&self, id: &str) -> Result<()> {
        let dir = self.dir(id)?;
        if dir.exists() {
            fs::remove_dir_all(&dir).with_context(|| format!("could not delete {}", dir.display()))?;
        }
        Ok(())
    }

    /// Remove leftovers of interrupted writes and imports (run at startup).
    pub fn sweep(&self) {
        for entry in fs::read_dir(&self.root).into_iter().flatten().flatten() {
            let dir = entry.path();
            if !dir.is_dir() {
                continue;
            }
            if !dir.join(files::PROJECT).exists() {
                // A folder without a project file is an aborted creation.
                let _ = fs::remove_dir_all(&dir);
                continue;
            }
            for f in fs::read_dir(&dir).into_iter().flatten().flatten() {
                let p = f.path();
                let name = p.file_name().and_then(|n| n.to_str()).unwrap_or("");
                // Unfinished files are called "<name>.part", "<name>.tmp" or "<name>.part.<ext>".
                if name.ends_with(".tmp") || name.ends_with(".part") || name.contains(".part.") {
                    let _ = fs::remove_file(&p);
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_store() -> (Store, PathBuf) {
        let dir = std::env::temp_dir().join(format!("pt-test-{}", uuid::Uuid::new_v4()));
        (Store::new(&dir).unwrap(), dir)
    }

    #[test]
    fn sweep_removes_unfinished_files_only() {
        let (store, dir) = temp_store();
        let p = store.create("Interview", Language::Nl).unwrap();
        let pdir = store.dir(&p.id).unwrap();
        for name in ["source1_l.pcm.part", "source1.part.m4a", "transcript.json.tmp", "source1.m4a", "transcript.json"] {
            fs::write(pdir.join(name), b"x").unwrap();
        }
        fs::create_dir_all(store.root().join("no-project-file")).unwrap();
        store.sweep();
        let mut left: Vec<String> = fs::read_dir(&pdir).unwrap().flatten().map(|e| e.file_name().to_string_lossy().into_owned()).collect();
        left.sort();
        assert_eq!(left, ["project.json", "source1.m4a", "transcript.json"]);
        assert!(!store.root().join("no-project-file").exists());
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn create_list_delete() {
        let (store, dir) = temp_store();
        let mut p = store.create(" Interview 1 ", Language::Nl).unwrap();
        assert_eq!(p.name, "Interview 1");
        p.name = "Renamed".into();
        store.save(&mut p).unwrap();
        let list = store.list();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].name, "Renamed");
        store.delete(&p.id).unwrap();
        assert!(store.list().is_empty());
        assert!(store.dir("../evil").is_err());
        let _ = fs::remove_dir_all(dir);
    }
}
