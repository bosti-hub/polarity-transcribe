//! The transcription job: from trimmed recordings to a transcript.
//!
//! Every stage writes its result into the project's `job/` folder before the next one starts,
//! and recognition appends one line per finished chunk. A job that is interrupted — app closed,
//! laptop out of battery — therefore continues where it stopped the next time it is started.

use crate::activity::{self, covered_seconds, BleedReport};
use crate::asr::{build_prompt, verbatim_primer, AsrModel, AsrParams, ChunkOutput};
use crate::assemble::{assemble, assign_speakers, drop_cross_talk, refine_times, AssembleOpts, SpokenWord};
use crate::chunker::{self, Chunk, ChunkOpts};
use crate::diarize::{self, Embedder, VoiceReport};
use crate::ffmpeg::{self, Channel, ANALYSIS_RATE};
use crate::fsutil::{pcm_read, pcm_write, read_json, write_atomic, write_json};
use crate::lexicon::normalize;
use crate::project::{files, Layout, Project, Status, Store, TrackSpec};
use crate::spatial::{self, DelayReport};
use crate::sync::{self, SyncMap, SyncReport};
use crate::vad::{self, SegmentOpts, Span, Vad, VAD_FRAME_SEC, VAD_HOP};
use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};
use std::fs::{self, File, OpenOptions};
use std::io::{BufRead, BufReader, BufWriter, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Instant;

const RATE: f64 = ANALYSIS_RATE as f64;

#[derive(Debug, Clone)]
pub struct JobConfig {
    pub model: PathBuf,
    /// Identifies the model in the job fingerprint.
    pub model_id: String,
    pub vad_model: PathBuf,
    /// Speaker-embedding model for single-microphone recordings; `None` disables voice separation.
    pub voice_model: Option<PathBuf>,
    pub threads: usize,
    pub use_gpu: bool,
    pub fast: bool,
    /// Names and terms shared by the whole study, added to the interview's own.
    pub extra_glossary: Vec<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Stage {
    Prepare,
    Sync,
    Voice,
    Speakers,
    Transcribe,
    Diarize,
    Finish,
}

impl Stage {
    /// Share of the whole job (start, size) used for the overall progress bar.
    fn window(self) -> (f32, f32) {
        match self {
            Stage::Prepare => (0.00, 0.02),
            Stage::Sync => (0.02, 0.02),
            Stage::Voice => (0.04, 0.03),
            Stage::Speakers => (0.07, 0.01),
            Stage::Transcribe => (0.08, 0.88),
            Stage::Diarize => (0.96, 0.03),
            Stage::Finish => (0.99, 0.01),
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Progress {
    pub stage: Stage,
    pub stage_fraction: f32,
    pub fraction: f32,
    pub eta_seconds: Option<f64>,
    pub preview: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Outcome {
    Done,
    Cancelled,
}

/// Diagnostics kept with the project after a job, shown in the app.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JobReport {
    pub sync: Option<SyncReport>,
    /// How speakers were told apart.
    pub method: Method,
    pub bleed: Option<BleedReport>,
    pub delay: Option<DelayReport>,
    pub voice: Option<VoiceReport>,
    /// Wall-clock seconds spent on recognition (summed over sessions).
    pub asr_seconds: f64,
    pub audio_seconds: f64,
    pub words: usize,
    pub model: String,
    /// The graphics device recognition ran on (the last session's), or none for the processor.
    #[serde(default)]
    pub device: Option<String>,
    /// Set when the spoken language turned out to differ from the one chosen.
    #[serde(default)]
    pub language_switch: Option<LanguageSwitch>,
    /// Passages where recognition found far fewer words than there was speech, even after a
    /// second try (see [`too_sparse`]): worth listening to. Transcript timeline, in order.
    #[serde(default)]
    pub sparse: Vec<SparseSpan>,
}

/// A passage that yielded suspiciously few words.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct SparseSpan {
    pub start: f64,
    pub end: f64,
}

/// The interview language was corrected after listening to the start of the recording.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LanguageSwitch {
    pub from: crate::asr::Language,
    pub to: crate::asr::Language,
    /// Whisper's probability for the language it switched to.
    pub probability: f32,
}

/// Switch only when the other language is clearly more likely than the chosen one.
const SWITCH_MIN_PROBABILITY: f32 = 0.5;
const SWITCH_MIN_RATIO: f32 = 3.0;

/// Decide the interview language from whisper's (Dutch, English) probabilities.
pub fn decide_language(chosen: crate::asr::Language, nl: f32, en: f32) -> Option<crate::asr::Language> {
    use crate::asr::Language;
    let (p_chosen, other, p_other) = match chosen {
        Language::Nl => (nl, Language::En, en),
        Language::En => (en, Language::Nl, nl),
    };
    (p_other > SWITCH_MIN_PROBABILITY && p_other > SWITCH_MIN_RATIO * p_chosen).then_some(other)
}

/// How words are attributed to speakers.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Method {
    /// Each speaker is transcribed from their own microphone (level difference).
    OwnMic,
    /// One stream; speakers told apart by the direction the sound comes from.
    Delay,
    /// One stream; speakers told apart by voice.
    Voice,
    /// No separation possible: everything is one speaker until corrected by hand.
    #[default]
    None,
}

/// Result of the "who speaks when" stage.
#[derive(Debug, Clone, Serialize, Deserialize)]
struct Attribution {
    method: Method,
    /// Speech spans per speaker on the master timeline.
    spans: Vec<Vec<Span>>,
    bleed: Option<BleedReport>,
    delay: Option<DelayReport>,
    #[serde(default)]
    voice: Option<VoiceReport>,
}

pub const REPORT_FILE: &str = "report.json";
pub const PLAYBACK_FILE: &str = "playback.m4a";

#[derive(Serialize, Deserialize)]
struct SyncFile {
    map: SyncMap,
    report: SyncReport,
}

#[derive(Serialize, Deserialize, Clone)]
struct PlannedChunk {
    speaker: usize,
    chunk: Chunk,
}

#[derive(Serialize, Deserialize)]
struct AsrLine {
    i: usize,
    speaker: usize,
    words: Vec<SpokenWord>,
    seconds: f64,
    /// Still far fewer words than speech after the retry (see [`too_sparse`]).
    #[serde(default)]
    sparse: bool,
}

struct Reporter<'a> {
    sink: &'a mut dyn FnMut(Progress),
}

impl Reporter<'_> {
    fn at(&mut self, stage: Stage, f: f32) {
        self.full(stage, f, None, None);
    }
    fn full(&mut self, stage: Stage, f: f32, eta: Option<f64>, preview: Option<String>) {
        let (start, size) = stage.window();
        let f = f.clamp(0.0, 1.0);
        (self.sink)(Progress { stage, stage_fraction: f, fraction: start + size * f, eta_seconds: eta, preview });
    }
}

/// Reads a source's cached PCM as one mono channel; positions outside the file are silent.
#[derive(Clone)]
struct SourceReader {
    left: PathBuf,
    right: Option<PathBuf>,
    channel: Channel,
}

impl SourceReader {
    fn new(dir: &Path, spec: &TrackSpec, channels: u8) -> Self {
        let left = dir.join(files::pcm(spec.source, false));
        let right = (channels == 2).then(|| dir.join(files::pcm(spec.source, true)));
        Self { left, right, channel: spec.channel }
    }

    fn read_one(path: &Path, start: i64, len: usize) -> Result<Vec<f32>> {
        if start >= 0 {
            return pcm_read(path, start as u64, len);
        }
        let skip = ((-start) as usize).min(len);
        let mut out = vec![0f32; skip];
        out.extend(pcm_read(path, 0, len - skip)?);
        Ok(out)
    }

    fn read(&self, start: i64, len: usize) -> Result<Vec<f32>> {
        match (&self.right, self.channel) {
            (Some(r), Channel::Right) => Self::read_one(r, start, len),
            (Some(r), Channel::Mix) => {
                let mut l = Self::read_one(&self.left, start, len)?;
                let r = Self::read_one(r, start, len)?;
                for (a, b) in l.iter_mut().zip(&r) {
                    *a = 0.5 * (*a + *b);
                }
                Ok(l)
            }
            _ => Self::read_one(&self.left, start, len),
        }
    }
}

/// One track on the master timeline, `len` samples long (reads past the end are silent).
///
/// A track that is a plain stretch of a source is read straight from the import cache; only a
/// second recording warped onto the master's clock is written out to the job folder.
#[derive(Clone)]
enum TrackAudio {
    Source { reader: SourceReader, first: i64, len: usize },
    File { path: PathBuf, len: usize },
}

impl TrackAudio {
    fn source(dir: &Path, spec: &TrackSpec, channels: u8, len: usize) -> Self {
        TrackAudio::Source { reader: SourceReader::new(dir, spec, channels), first: (spec.start * RATE).round() as i64, len }
    }

    fn read(&self, start: u64, n: usize) -> Result<Vec<f32>> {
        let len = match self {
            TrackAudio::Source { len, .. } | TrackAudio::File { len, .. } => *len,
        };
        let avail = (len as u64).saturating_sub(start).min(n as u64) as usize;
        let mut out = match self {
            TrackAudio::Source { reader, first, .. } => reader.read(first + start as i64, avail)?,
            TrackAudio::File { path, .. } => pcm_read(path, start, avail)?,
        };
        out.resize(n, 0.0);
        Ok(out)
    }
}

/// Speech probabilities for a whole track, or `None` when cancelled.
///
/// The detector starts afresh every five minutes anyway (see [`Vad::probabilities`]), so those
/// blocks run side by side on several cores with the same result.
fn detect_voice(
    audio: &TrackAudio,
    n_samples: usize,
    cfg: &JobConfig,
    cancel: &AtomicBool,
    progress: &mut dyn FnMut(f32),
) -> Result<Option<Vec<f32>>> {
    use std::sync::atomic::AtomicUsize;
    const BLOCK: usize = VAD_HOP * 9_375; // five minutes, as in Vad::probabilities
    let n_blocks = n_samples.div_ceil(BLOCK);
    let workers = cfg.threads.clamp(1, 8).min(n_blocks.max(1));
    let next = AtomicUsize::new(0);
    let mut blocks: Vec<Option<Vec<f32>>> = vec![None; n_blocks];
    std::thread::scope(|scope| -> Result<()> {
        let (tx, rx) = std::sync::mpsc::channel::<Result<(usize, Vec<f32>)>>();
        for _ in 0..workers {
            let (tx, next) = (tx.clone(), &next);
            scope.spawn(move || {
                let mut vad = match Vad::new(&cfg.vad_model, 1) {
                    Ok(v) => v,
                    Err(e) => {
                        let _ = tx.send(Err(e));
                        return;
                    }
                };
                while !cancel.load(Ordering::Relaxed) {
                    let b = next.fetch_add(1, Ordering::Relaxed);
                    if b >= n_blocks {
                        return;
                    }
                    let pos = b * BLOCK;
                    let r = audio.read(pos as u64, BLOCK.min(n_samples - pos)).and_then(|s| vad.probabilities(&s, |_| {}));
                    let failed = r.is_err();
                    // A closed channel means the job gave up on an error elsewhere.
                    if tx.send(r.map(|p| (b, p))).is_err() || failed {
                        return;
                    }
                }
            });
        }
        drop(tx);
        let mut done = 0;
        for msg in rx {
            let (b, p) = msg?;
            blocks[b] = Some(p);
            done += 1;
            progress(done as f32 / n_blocks as f32);
        }
        Ok(())
    })?;
    if cancel.load(Ordering::Relaxed) {
        return Ok(None);
    }
    let mut out = Vec::with_capacity(n_samples.div_ceil(VAD_HOP));
    for b in blocks {
        out.extend(b.ok_or_else(|| anyhow::anyhow!("voice detection stopped early"))?);
    }
    out.truncate(n_samples.div_ceil(VAD_HOP));
    Ok(Some(out))
}

/// The playback file being encoded on its own thread while the job goes on. Dropping it
/// waits for the thread, which stops early when the job is cancelled.
struct PlaybackRender(Option<std::thread::JoinHandle<Result<()>>>);

impl PlaybackRender {
    fn finish(&mut self) -> Result<()> {
        match self.0.take() {
            Some(h) => h.join().map_err(|_| anyhow::anyhow!("the playback encoder stopped unexpectedly"))?,
            None => Ok(()),
        }
    }
}

impl Drop for PlaybackRender {
    fn drop(&mut self) {
        let _ = self.finish();
    }
}

fn write_f32(path: &Path, data: &[f32]) -> Result<()> {
    let mut bytes = Vec::with_capacity(data.len() * 4);
    for v in data {
        bytes.extend_from_slice(&v.to_le_bytes());
    }
    write_atomic(path, &bytes)
}

fn read_f32(path: &Path) -> Result<Vec<f32>> {
    let bytes = fs::read(path)?;
    Ok(bytes.chunks_exact(4).map(|b| f32::from_le_bytes([b[0], b[1], b[2], b[3]])).collect())
}

fn merge_spans(mut all: Vec<Span>) -> Vec<Span> {
    all.sort_by(|a, b| a.start.total_cmp(&b.start));
    let mut out: Vec<Span> = Vec::new();
    for s in all {
        match out.last_mut() {
            Some(last) if s.start <= last.end => last.end = last.end.max(s.end),
            _ => out.push(s),
        }
    }
    out
}

// ------------------------------------------------------------------ quality guards

/// Detects the recogniser's failure mode on unclear audio: the same word or phrase looping.
fn looks_degenerate(words: &[String]) -> bool {
    let w: Vec<String> = words.iter().map(|s| normalize(s)).filter(|s| !s.is_empty()).collect();
    let n = w.len();
    if n < 8 {
        return false;
    }
    for len in 1..=6usize {
        let need = if len == 1 { 7 } else { 4 };
        let mut i = 0;
        while i + len * need <= n {
            let mut reps = 1;
            while i + len * (reps + 1) <= n && w[i..i + len] == w[i + len * reps..i + len * (reps + 1)] {
                reps += 1;
            }
            if reps >= need {
                return true;
            }
            i += 1;
        }
    }
    if n >= 20 {
        let mut distinct = w.clone();
        distinct.sort();
        distinct.dedup();
        if (distinct.len() as f32) < 0.25 * n as f32 {
            return true;
        }
    }
    false
}

/// Ordinary speech gives two to three words per second; a chunk with less than this, over at
/// least `SPARSE_MIN_SECONDS` of speech, most likely lost words. It happens with greedy decoding
/// on unclear audio (chatter before an interview, background noise): the decoder stops after a
/// few words. Measured on such a passage: 3 words for 15.7 s of speech on the graphics chip,
/// where beam search found 56.
const SPARSE_WORDS_PER_SECOND: f64 = 0.5;
const SPARSE_MIN_SECONDS: f64 = 8.0;

fn too_sparse(words: usize, speech_seconds: f64) -> bool {
    speech_seconds >= SPARSE_MIN_SECONDS && (words as f64) < SPARSE_WORDS_PER_SECOND * speech_seconds
}

/// Sparse passages in timeline order, with touching or overlapping ones (the two speakers'
/// streams) joined.
fn merge_sparse(mut spans: Vec<SparseSpan>) -> Vec<SparseSpan> {
    spans.sort_by(|a, b| a.start.total_cmp(&b.start));
    let mut out: Vec<SparseSpan> = Vec::new();
    for s in spans {
        match out.last_mut() {
            Some(last) if s.start <= last.end + 1.0 => last.end = last.end.max(s.end),
            _ => out.push(s),
        }
    }
    out
}

/// True if the output repeats a long stretch of the style prompt instead of the audio.
fn echoes_prompt(words: &[String], prompt: &str) -> bool {
    const N: usize = 6;
    let p: Vec<String> = prompt.split_whitespace().map(normalize).filter(|s| !s.is_empty()).collect();
    let w: Vec<String> = words.iter().map(|s| normalize(s)).filter(|s| !s.is_empty()).collect();
    if p.len() < N || w.len() < N {
        return false;
    }
    w.windows(N).any(|win| p.windows(N).any(|pw| pw == win))
}

// ------------------------------------------------------------------ the job

pub fn job_dir(project_dir: &Path) -> PathBuf {
    project_dir.join(files::JOB_DIR)
}

/// Whether an interrupted job can be continued for this project.
pub fn has_resumable_job(project_dir: &Path) -> bool {
    job_dir(project_dir).join("job.json").exists()
}

/// Run (or resume) the transcription job of a project.
pub fn run(
    store: &Store,
    project_id: &str,
    cfg: &JobConfig,
    cancel: &Arc<AtomicBool>,
    progress: &mut dyn FnMut(Progress),
) -> Result<Outcome> {
    let mut project = store.load(project_id)?;
    let dir = store.dir(project_id)?;
    let result = run_inner(&mut project, &dir, cfg, cancel, progress);
    // Reload-free status update: only the fields the job owns are touched.
    let mut fresh = store.load(project_id).unwrap_or(project.clone());
    match &result {
        Ok(Outcome::Done) => {
            fresh.status = Status::Ready;
            fresh.duration = project.duration;
            fresh.language = project.language;
            fresh.error = None;
        }
        Ok(Outcome::Cancelled) => {
            fresh.status = Status::Processing;
            fresh.language = project.language;
            fresh.error = None;
        }
        Err(e) => {
            fresh.status = Status::Failed;
            fresh.error = Some(format!("{e:#}"));
        }
    }
    store.save(&mut fresh)?;
    result
}

fn run_inner(
    project: &mut Project,
    dir: &Path,
    cfg: &JobConfig,
    cancel: &Arc<AtomicBool>,
    progress: &mut dyn FnMut(Progress),
) -> Result<Outcome> {
    let mut rep = Reporter { sink: progress };
    let cancelled = || cancel.load(Ordering::Relaxed);
    let tracks = project.tracks();
    if tracks.is_empty() {
        bail!("no audio has been added to this project");
    }
    let layout = project.layout();
    let master = tracks[0];
    let duration = master.end - master.start;
    if duration < 1.0 {
        bail!("the selected audio is shorter than one second");
    }
    let n_samples = (duration * RATE).round() as usize;
    project.duration = duration;

    // The interview's own names and terms first, then the study's (each once).
    let mut glossary: Vec<String> = Vec::new();
    for term in project.glossary.iter().chain(&cfg.extra_glossary) {
        if !glossary.iter().any(|g| g.eq_ignore_ascii_case(term)) {
            glossary.push(term.clone());
        }
    }

    // A job only continues if nothing that affects its results has changed.
    let sources: Vec<(String, f64)> = project.sources.iter().flatten().map(|s| (s.original_path.clone(), s.duration)).collect();
    let fingerprint_for = |language: crate::asr::Language| {
        serde_json::to_string(&serde_json::json!({
            "v": 1,
            "tracks": tracks,
            "layout": layout,
            "language": language,
            "glossary": glossary,
            "model": cfg.model_id,
            "fast": cfg.fast,
            "sources": sources,
        }))
    };
    let fingerprint = fingerprint_for(project.language)?;
    let job = job_dir(dir);
    let job_file = job.join("job.json");
    let same = fs::read_to_string(&job_file).map(|s| s == fingerprint).unwrap_or(false);
    if !same {
        let _ = fs::remove_dir_all(&job);
        // Made for other trims or recordings.
        let _ = fs::remove_file(dir.join(PLAYBACK_FILE));
    }
    fs::create_dir_all(&job)?;
    if !same {
        write_atomic(&job_file, fingerprint.as_bytes())?;
    }

    // ---- 1. Tracks on the master timeline ---------------------------------------------
    rep.at(Stage::Prepare, 0.0);
    let track_path = |k: usize| job.join(format!("track{}.pcm", k + 1));
    let channels_of = |spec: &TrackSpec| project.source(spec.source).map(|s| s.channels).unwrap_or(1);

    let mut audio: Vec<TrackAudio> = vec![TrackAudio::source(dir, &master, channels_of(&master), n_samples)];
    let mut sync_report = None;
    let mut sync_map = None;
    match layout {
        Layout::Single => {}
        Layout::SplitStereo => audio.push(TrackAudio::source(dir, &tracks[1], channels_of(&tracks[1]), n_samples)),
        Layout::DualFile => {
            let second = tracks[1];
            let sync_file = job.join("sync.json");
            let sf: SyncFile = match read_json(&sync_file) {
                Ok(sf) => sf,
                Err(_) => {
                    rep.at(Stage::Sync, 0.0);
                    let r1 = SourceReader::new(dir, &master, channels_of(&master));
                    let r2 = SourceReader::new(dir, &second, channels_of(&second));
                    let mut read1 = |s: i64, n: usize| r1.read(s, n);
                    let mut read2 = |s: i64, n: usize| r2.read(s, n);
                    let mut t1 = sync::Track { read: &mut read1, start: master.start, end: master.end };
                    let mut t2 = sync::Track { read: &mut read2, start: second.start, end: second.end };
                    let (map, report) = sync::estimate(&mut t1, &mut t2, |f| rep.at(Stage::Sync, 0.7 * f))?;
                    // The map from `estimate` takes master time relative to the master in-point.
                    let sf = SyncFile { map, report };
                    write_json(&sync_file, &sf)?;
                    sf
                }
            };
            if !track_path(1).exists() {
                let r2 = SourceReader::new(dir, &second, channels_of(&second));
                let mut read2 = |s: i64, n: usize| r2.read(s, n);
                let out = track_path(1);
                let part = out.with_extension("pcm.part");
                let mut w = BufWriter::new(File::create(&part)?);
                let mut done = 0usize;
                sync::warp(&mut read2, &sf.map, n_samples, second.start, second.end, |block| {
                    pcm_write(&mut w, block)?;
                    done += block.len();
                    Ok(())
                })?;
                w.flush()?;
                drop(w);
                fs::rename(&part, &out)?;
            }
            audio.push(TrackAudio::File { path: track_path(1), len: n_samples });
            rep.at(Stage::Sync, 1.0);
            sync_report = Some(sf.report.clone());
            sync_map = Some((sf.map, second));
        }
    }
    if cancelled() {
        return Ok(Outcome::Cancelled);
    }
    let n_tracks = tracks.len();

    // Playback file for the editor (speaker 1 left, speaker 2 right), encoded alongside the
    // rest of the job: it is only needed once the transcript is there.
    let playback = dir.join(PLAYBACK_FILE);
    let mut playback_render = PlaybackRender(None);
    if !playback.exists() {
        let (tracks, cancel) = (audio.clone(), cancel.clone());
        playback_render.0 = Some(std::thread::spawn(move || render_playback(&tracks, &playback, n_samples, &cancel)));
    }
    rep.at(Stage::Prepare, 1.0);

    // ---- 2. Voice activity -----------------------------------------------------------
    let mut probs: Vec<Vec<f32>> = Vec::new();
    for (k, track) in audio.iter().enumerate() {
        let file = job.join(format!("vad{}.bin", k + 1));
        let p = match read_f32(&file) {
            Ok(p) if p.len() == n_samples.div_ceil(VAD_HOP) => p,
            _ => {
                let Some(p) = detect_voice(track, n_samples, cfg, cancel, &mut |f| rep.at(Stage::Voice, (k as f32 + f) / n_tracks as f32))?
                else {
                    return Ok(Outcome::Cancelled);
                };
                write_f32(&file, &p)?;
                p
            }
        };
        probs.push(p);
    }
    rep.at(Stage::Voice, 1.0);
    let vad_spans: Vec<Vec<Span>> = probs.iter().map(|p| vad::segments(p, &SegmentOpts::default())).collect();
    let all_speech = merge_spans(vad_spans.iter().flatten().copied().collect());

    // ---- 3. Who speaks when ------------------------------------------------------------
    rep.at(Stage::Speakers, 0.0);
    let attribution_file = job.join("attribution.json");
    let attribution: Attribution = match read_json(&attribution_file) {
        Ok(a) => a,
        Err(_) => {
            let n_frames = probs[0].len();
            let wanted = if project.speaker_count >= 2 { project.speaker_count as usize } else { 2 };
            // One speaker chosen for a single recording (a lecture or presentation): nothing to
            // tell apart, so everything stays with that speaker.
            let one_speaker = n_tracks == 1 && project.speaker_count == 1;
            let mut result = Attribution { method: Method::None, spans: vec![vad_spans[0].clone()], bleed: None, delay: None, voice: None };
            if one_speaker {
                // Method::None with one span list: assembly gives every word to the one speaker.
            } else if n_tracks == 2 {
                // First choice: each microphone clearly favours its own speaker.
                let p1 = activity::frame_power(|s, n| audio[0].read(s, n), n_samples as u64)?;
                let p2 = activity::frame_power(|s, n| audio[1].read(s, n), n_samples as u64)?;
                let covered: Vec<bool> = match &sync_map {
                    Some((map, second)) => (0..p1.len())
                        .map(|f| {
                            let t2 = map.map((f as f64 + 0.5) * VAD_FRAME_SEC);
                            t2 >= second.start && t2 < second.end
                        })
                        .collect(),
                    None => vec![true; p1.len()],
                };
                let act = activity::attribute([&p1, &p2], [&probs[0], &probs[1]], &covered);
                rep.at(Stage::Speakers, 0.4);
                if act.report.separable {
                    result = Attribution { method: Method::OwnMic, spans: act.spans.to_vec(), bleed: Some(act.report), delay: None, voice: None };
                } else {
                    // Both microphones hear everyone equally (a stereo pair, two phones side
                    // by side). The arrival-time difference still tells the seats apart.
                    result.bleed = Some(act.report);
                    let speech: Vec<bool> = (0..n_frames).map(|f| probs[0][f] >= 0.5 || probs[1][f] >= 0.5).collect();
                    let (spans, report) = spatial::attribute_by_delay(
                        &mut |s, n| audio[0].read(s, n),
                        &mut |s, n| audio[1].read(s, n),
                        n_samples,
                        &speech,
                        2,
                    )?;
                    if report.separable {
                        result.method = Method::Delay;
                        result.spans = spans;
                    }
                    result.delay = Some(report);
                }
            } else if channels_of(&master) == 2 {
                // One stereo recording of a room: try the direction of the sound.
                let first = (master.start * RATE).round() as i64;
                let side = |channel| SourceReader::new(dir, &TrackSpec { channel, ..master }, 2);
                let (left, right) = (side(Channel::Left), side(Channel::Right));
                let speech: Vec<bool> = probs[0].iter().map(|p| *p >= 0.5).collect();
                let (spans, report) = spatial::attribute_by_delay(
                    &mut |s, n| left.read(first + s as i64, n),
                    &mut |s, n| right.read(first + s as i64, n),
                    n_samples,
                    &speech,
                    wanted,
                )?;
                if report.separable {
                    result.method = Method::Delay;
                    result.spans = spans;
                }
                result.delay = Some(report);
            }
            // Last resort, and the normal case for one phone on the table: tell the speakers
            // apart by their voices.
            if result.method == Method::None && !one_speaker {
                if let Some(model) = cfg.voice_model.as_ref().filter(|m| m.exists()) {
                    rep.at(Stage::Speakers, 0.5);
                    let mut embedder = Embedder::load(model, cfg.threads.min(4))?;
                    let mut stopped = false;
                    let found = diarize::attribute_by_voice(
                        &mut embedder,
                        &mut |s, n| audio[0].read(s, n),
                        n_samples,
                        &vad_spans[0],
                        wanted,
                        |f| {
                            rep.at(Stage::Speakers, 0.5 + 0.5 * f);
                            stopped = cancelled();
                            !stopped
                        },
                    )?;
                    if stopped {
                        return Ok(Outcome::Cancelled);
                    }
                    if let Some((spans, report)) = found {
                        if report.separable {
                            result.method = Method::Voice;
                            result.spans = spans;
                        }
                        result.voice = Some(report);
                    }
                }
            }
            write_json(&attribution_file, &result)?;
            result
        }
    };
    let own_mic = attribution.method == Method::OwnMic;
    // Streams that are transcribed: one per speaker with own microphones, otherwise one.
    let stream_spans: Vec<Vec<Span>> = if own_mic { attribution.spans.clone() } else { vec![vad_spans[0].clone()] };
    rep.at(Stage::Speakers, 1.0);

    // ---- 4. Chunk plan -----------------------------------------------------------------
    let plan_file = job.join("plan.json");
    let plan: Vec<PlannedChunk> = match read_json(&plan_file) {
        Ok(p) => p,
        Err(_) => {
            let mut plan: Vec<PlannedChunk> = Vec::new();
            for (k, spans) in stream_spans.iter().enumerate() {
                for chunk in chunker::plan(spans, duration, Some(&probs[k]), &ChunkOpts::default()) {
                    plan.push(PlannedChunk { speaker: k, chunk });
                }
            }
            plan.sort_by(|a, b| a.chunk.span().start.total_cmp(&b.chunk.span().start));
            write_json(&plan_file, &plan)?;
            plan
        }
    };

    // ---- 5. Recognition ------------------------------------------------------------------
    let asr_file = job.join("asr.jsonl");
    let mut done: Vec<Option<AsrLine>> = (0..plan.len()).map(|_| None).collect();
    if let Ok(f) = File::open(&asr_file) {
        for line in BufReader::new(f).lines().map_while(Result::ok) {
            // A torn last line (power loss mid-write) simply fails to parse and is redone.
            if let Ok(l) = serde_json::from_str::<AsrLine>(&line) {
                let i = l.i;
                if i < done.len() {
                    done[i] = Some(l);
                }
            }
        }
    }
    let total_audio: f64 = plan.iter().map(|p| p.chunk.duration()).sum();
    let mut done_audio: f64 = plan.iter().zip(&done).filter(|(_, d)| d.is_some()).map(|(p, _)| p.chunk.duration()).sum();

    // The audio of one planned chunk, as it is fed to the recogniser.
    let chunk_samples = |planned: &PlannedChunk| -> Result<Vec<f32>> {
        let PlannedChunk { speaker, chunk } = planned;
        let mut samples: Vec<f32> = Vec::with_capacity((chunk.duration() * RATE) as usize + 16);
        for piece in &chunk.pieces {
            let a = (piece.src.start * RATE).round() as u64;
            let b = (piece.src.end * RATE).round() as u64;
            let mut s = audio[*speaker].read(a, (b - a) as usize)?;
            if own_mic {
                activity::duck_outside(&mut s, piece.src.start, &stream_spans[*speaker], ANALYSIS_RATE);
            }
            samples.extend(s);
        }
        Ok(samples)
    };

    let mut device_used: Option<String> = None;
    // From this job or, when resuming, from the session that detected it.
    let mut language_switch: Option<LanguageSwitch> = read_json(&job.join("language.json")).ok();
    if done.iter().any(|d| d.is_none()) {
        rep.full(Stage::Transcribe, (done_audio / total_audio.max(1e-9)) as f32, None, None);
        if let Some(dir) = cfg.model.parent() {
            crate::gpu::set_check_file(dir.join("gpu-check.json"));
        }
        let mut model = match AsrModel::load(&cfg.model, cfg.use_gpu) {
            Ok(m) => m,
            Err(e) if cfg.use_gpu => {
                eprintln!("GPU initialisation failed ({e:#}); using the CPU");
                AsrModel::load(&cfg.model, false)?
            }
            Err(e) => return Err(e),
        };

        // Integrated graphics that have not been tried before race the processor once, on the
        // first chunk still to do. The graphics run comes second, after a short warm-up,
        // because the Vulkan backend prepares its shaders on first use.
        if let Some(device) = model.device.clone().filter(crate::gpu::needs_check) {
            if let Some(first) = plan.iter().zip(&done).find(|(_, d)| d.is_none()).map(|(p, _)| p) {
                let sample = chunk_samples(first)?;
                let params = AsrParams { fast: cfg.fast, abort: Some(cancel.clone()), ..AsrParams::new(project.language, cfg.threads) };
                let timed = |m: &AsrModel, warm_up: bool| -> Result<f64> {
                    let mut session = m.session()?;
                    if warm_up {
                        session.transcribe(&sample[..sample.len().min(RATE as usize * 2)], &params)?;
                    }
                    let t = Instant::now();
                    session.transcribe(&sample, &params)?;
                    Ok(t.elapsed().as_secs_f64())
                };
                let cpu_model = AsrModel::load(&cfg.model, false)?;
                let cpu = timed(&cpu_model, false);
                let gpu = timed(&model, true);
                if cancelled() {
                    return Ok(Outcome::Cancelled);
                }
                let (gpu, cpu) = (gpu?, cpu?);
                let use_gpu = crate::gpu::record_check(&device, gpu, cpu, cfg.threads);
                eprintln!(
                    "speed check on {:.1} s of audio: {} {gpu:.1} s, processor ({} threads) {cpu:.1} s: using the {}",
                    sample.len() as f64 / RATE,
                    device.name,
                    cfg.threads,
                    if use_gpu { "graphics chip" } else { "processor" }
                );
                if !use_gpu {
                    model = cpu_model;
                }
            }
        }
        device_used = model.device.as_ref().map(|d| d.name.clone());

        // A fresh job first listens to the start of the recording: an interview transcribed in
        // the wrong language comes out as a (bad) translation. The language chosen is a starting
        // point; what is spoken decides.
        if done.iter().all(|d| d.is_none()) && std::env::var_os("PT_NO_LANG_DETECT").is_none() {
            let mut session = model.session()?;
            let (mut nl, mut en, mut n) = (0f32, 0f32, 0f32);
            for planned in plan.iter().take(3) {
                let samples = chunk_samples(planned)?;
                if samples.len() < RATE as usize * 5 {
                    continue;
                }
                if let Ok((a, b)) = session.detect_language(&samples, cfg.threads) {
                    nl += a;
                    en += b;
                    n += 1.0;
                }
            }
            if n > 0.0 {
                let (nl, en) = (nl / n, en / n);
                if let Some(to) = decide_language(project.language, nl, en) {
                    eprintln!("spoken language is {} (nl {nl:.2}, en {en:.2}); switching from {}", to.code(), project.language.code());
                    language_switch = Some(LanguageSwitch { from: project.language, to, probability: nl.max(en) });
                    project.language = to;
                    // A resumed job must keep the language it started with.
                    write_atomic(&job_file, fingerprint_for(to)?.as_bytes())?;
                    write_json(&job.join("language.json"), &language_switch)?;
                }
            }
        }
        let mut session = model.session()?;
        let mut log = OpenOptions::new().create(true).append(true).open(&asr_file)?;
        // Continuity context per speaker: the end of what they said last.
        let mut tails: Vec<Option<String>> = vec![None; stream_spans.len()];
        for l in done.iter().map_while(|d| d.as_ref()) {
            tails[l.speaker] = tail_of(&l.words).or(tails[l.speaker].take());
        }
        let session_start = Instant::now();
        let mut session_audio = 0f64;

        for i in 0..plan.len() {
            if done[i].is_some() {
                continue;
            }
            if cancelled() {
                return Ok(Outcome::Cancelled);
            }
            let PlannedChunk { speaker, chunk } = &plan[i];
            let samples = chunk_samples(&plan[i])?;

            let started = Instant::now();
            let lang = project.language;
            let base = AsrParams { fast: cfg.fast, abort: Some(cancel.clone()), ..AsrParams::new(lang, cfg.threads) };
            let primer = verbatim_primer(lang);
            // Three attempts, each with less context that could mislead the decoder.
            let prompts = [
                build_prompt(lang, &glossary, tails[*speaker].as_deref()),
                build_prompt(lang, &glossary, None),
                String::new(),
            ];
            let mut out = ChunkOutput::default();
            let mut suspicious = false;
            for prompt in prompts {
                out = match session.transcribe(&samples, &AsrParams { prompt, ..base.clone() }) {
                    Ok(out) => out,
                    // An aborted decode surfaces as an error; that is a clean stop, not a failure.
                    Err(_) if cancelled() => return Ok(Outcome::Cancelled),
                    Err(e) => return Err(e),
                };
                if cancelled() {
                    return Ok(Outcome::Cancelled);
                }
                let texts: Vec<String> = out.words.iter().map(|w| w.text.clone()).collect();
                suspicious = looks_degenerate(&texts) || echoes_prompt(&texts, primer);
                if !suspicious {
                    break;
                }
            }
            // Far fewer words than speech: try once more with beam search, which does not stop
            // early the way greedy decoding can, and keep whichever found more.
            let speech: f64 = chunk.pieces.iter().map(|p| p.src.len()).sum();
            let mut sparse = !suspicious && too_sparse(out.words.len(), speech);
            if sparse {
                let params = AsrParams { prompt: build_prompt(lang, &glossary, None), beam_size: 5, ..base.clone() };
                let retry = match session.transcribe(&samples, &params) {
                    Ok(out) => out,
                    Err(_) if cancelled() => return Ok(Outcome::Cancelled),
                    Err(e) => return Err(e),
                };
                let texts: Vec<String> = retry.words.iter().map(|w| w.text.clone()).collect();
                let usable = !looks_degenerate(&texts) && !echoes_prompt(&texts, primer);
                eprintln!(
                    "chunk at {:.1} s: {} words for {speech:.1} s of speech; beam search found {}{}",
                    chunk.span().start,
                    out.words.len(),
                    retry.words.len(),
                    if usable { "" } else { " (unusable)" }
                );
                if usable && retry.words.len() > out.words.len() {
                    out = retry;
                }
                sparse = too_sparse(out.words.len(), speech);
            }
            let words: Vec<SpokenWord> = out
                .words
                .iter()
                .map(|w| SpokenWord {
                    speaker: *speaker,
                    text: w.text.clone(),
                    start: chunk.to_source(w.start as f64),
                    end: chunk.to_source(w.end as f64),
                    // Output that still looks like a loop after all retries is flagged for review.
                    prob: if suspicious { w.prob.min(0.2) } else { w.prob },
                })
                .collect();
            let line = AsrLine { i, speaker: *speaker, words, seconds: started.elapsed().as_secs_f64(), sparse };
            let mut json = serde_json::to_string(&line)?;
            json.push('\n');
            log.write_all(json.as_bytes())?;
            log.sync_data()?;

            if !suspicious {
                tails[*speaker] = tail_of(&line.words).or(tails[*speaker].take());
            }
            let preview = line.words.iter().map(|w| w.text.as_str()).collect::<Vec<_>>().join(" ");
            done[i] = Some(line);
            done_audio += chunk.duration();
            session_audio += chunk.duration();
            let rate = session_start.elapsed().as_secs_f64() / session_audio.max(1e-9);
            let eta = (total_audio - done_audio).max(0.0) * rate;
            rep.full(
                Stage::Transcribe,
                (done_audio / total_audio.max(1e-9)) as f32,
                Some(eta),
                (!preview.is_empty()).then_some(preview),
            );
        }
    }
    rep.full(Stage::Transcribe, 1.0, Some(0.0), None);

    // ---- 6. Assemble ----------------------------------------------------------------------
    rep.at(Stage::Finish, 0.0);
    playback_render.finish().context("could not create the playback audio")?;
    if cancelled() {
        return Ok(Outcome::Cancelled);
    }
    let asr_seconds: f64 = done.iter().flatten().map(|l| l.seconds).sum();
    let sparse = merge_sparse(
        done.iter()
            .flatten()
            .filter(|l| l.sparse)
            .map(|l| {
                let span = plan[l.i].chunk.span();
                SparseSpan { start: span.start, end: span.end }
            })
            .collect(),
    );
    let mut per_stream: Vec<Vec<SpokenWord>> = vec![Vec::new(); stream_spans.len()];
    for line in done.into_iter().flatten() {
        per_stream[line.speaker].extend(line.words);
    }
    for (k, words) in per_stream.iter_mut().enumerate() {
        words.sort_by(|a, b| a.start.total_cmp(&b.start));
        if own_mic {
            // Words the microphone only heard as bleed lie outside the speaker's own activity.
            words.retain(|w| {
                let len = (w.end - w.start).max(0.05);
                covered_seconds(&stream_spans[k], w.start - 0.15, w.end + 0.15) >= 0.3 * len
            });
        }
        refine_times(words, &stream_spans[k]);
    }
    let (words, speaker_count) = if own_mic {
        let mut it = per_stream.into_iter();
        let pair = [it.next().unwrap(), it.next().unwrap()];
        (drop_cross_talk(pair, &[stream_spans[0].clone(), stream_spans[1].clone()]), 2)
    } else {
        let mut words = per_stream.pop().unwrap();
        if attribution.method != Method::None {
            // Voice comparison works on 1.5 s windows; the microphone-based methods are exact.
            let slack = if attribution.method == Method::Voice { 0.75 } else { 0.0 };
            assign_speakers(&mut words, &attribution.spans, project.language, slack);
        }
        (words, attribution.spans.len().max(1))
    };
    let n_words = words.len();
    let transcript = assemble(
        words,
        &all_speech,
        duration,
        &AssembleOpts { language: project.language, pause_threshold: project.pause_threshold, speaker_count, mark_overlap: own_mic, verbatim: project.verbatim },
    );

    let transcript_file = dir.join(files::TRANSCRIPT);
    if transcript_file.exists() {
        let _ = fs::rename(&transcript_file, dir.join(files::TRANSCRIPT_BACKUP));
    }
    write_json(&transcript_file, &transcript)?;
    write_json(
        &dir.join(REPORT_FILE),
        &JobReport {
            sync: sync_report,
            method: attribution.method,
            bleed: attribution.bleed,
            delay: attribution.delay,
            voice: attribution.voice,
            asr_seconds,
            audio_seconds: duration,
            words: n_words,
            model: cfg.model_id.clone(),
            device: device_used,
            language_switch,
            sparse,
        },
    )?;
    // The job folder holds copies of the audio; it is no longer needed.
    // (PT_KEEP_JOB keeps it, so developers can re-run the assembly without recognising again.)
    if std::env::var_os("PT_KEEP_JOB").is_none() {
        let _ = fs::remove_dir_all(&job);
    }
    rep.at(Stage::Finish, 1.0);
    Ok(Outcome::Done)
}

fn tail_of(words: &[SpokenWord]) -> Option<String> {
    if words.is_empty() {
        return None;
    }
    let from = words.len().saturating_sub(24);
    Some(words[from..].iter().map(|w| w.text.as_str()).collect::<Vec<_>>().join(" "))
}

/// Encode the aligned tracks into one AAC file (mono, or stereo with one speaker per side).
/// Stops without a file when `cancel` is set.
fn render_playback(tracks: &[TrackAudio], out: &Path, n_samples: usize, cancel: &AtomicBool) -> Result<()> {
    use std::process::Stdio;
    let part = out.with_extension("part.m4a");
    let mut cmd = ffmpeg::ffmpeg_command();
    cmd.arg("-y");
    cmd.args(["-f", "s16le", "-ar", &ANALYSIS_RATE.to_string(), "-ac", &tracks.len().to_string(), "-i", "pipe:0"]);
    // The fast coder is about five times quicker than the default one at these settings.
    cmd.args(["-c:a", "aac", "-aac_coder", "fast", "-b:a", if tracks.len() == 2 { "112k" } else { "64k" }]);
    cmd.args(["-movflags", "+faststart", "-f", "mp4"]).arg(&part);
    cmd.stdin(Stdio::piped()).stdout(Stdio::null()).stderr(Stdio::piped());
    let mut child = cmd.spawn().context("could not start FFmpeg")?;
    let mut stdin = child.stdin.take().unwrap();
    let write = (|| -> Result<bool> {
        let mut pos = 0usize;
        let mut buf: Vec<u8> = Vec::new();
        while pos < n_samples {
            if cancel.load(Ordering::Relaxed) {
                return Ok(false);
            }
            let n = (16_000 * 20).min(n_samples - pos);
            let blocks: Vec<Vec<f32>> = tracks.iter().map(|t| t.read(pos as u64, n)).collect::<Result<_>>()?;
            buf.clear();
            for i in 0..n {
                for b in &blocks {
                    buf.extend_from_slice(&crate::fsutil::f32_to_i16(b[i]).to_le_bytes());
                }
            }
            stdin.write_all(&buf)?;
            pos += n;
        }
        Ok(true)
    })();
    drop(stdin);
    if !matches!(write, Ok(true)) {
        let _ = child.kill();
    }
    let output = child.wait_with_output()?;
    let complete = match write {
        Ok(c) => c,
        Err(e) => {
            let _ = fs::remove_file(&part);
            return Err(e);
        }
    };
    if !complete {
        let _ = fs::remove_file(&part);
        return Ok(());
    }
    if !output.status.success() {
        let _ = fs::remove_file(&part);
        bail!("FFmpeg failed: {}", String::from_utf8_lossy(&output.stderr).lines().last().unwrap_or(""));
    }
    fs::rename(&part, out)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn words(s: &str) -> Vec<String> {
        s.split_whitespace().map(String::from).collect()
    }

    #[test]
    fn the_spoken_language_wins_only_when_clearly_more_likely() {
        use crate::asr::Language::{En, Nl};
        // Dutch chosen, English clearly spoken: switch.
        assert_eq!(decide_language(Nl, 0.05, 0.9), Some(En));
        // English chosen for a Dutch interview: switch back.
        assert_eq!(decide_language(En, 0.8, 0.1), Some(Nl));
        // Unclear, or the chosen language is plausible: keep it.
        assert_eq!(decide_language(Nl, 0.3, 0.6), None);
        assert_eq!(decide_language(Nl, 0.45, 0.4), None);
        // Neither language (for example German): keep it.
        assert_eq!(decide_language(Nl, 0.02, 0.03), None);
    }

    #[test]
    fn sparse_chunks_are_recognised() {
        assert!(too_sparse(3, 15.7));
        assert!(!too_sparse(34, 13.9));
        // Too short to judge: a few words in a few seconds is normal.
        assert!(!too_sparse(1, 6.0));
        // Slow but real speech is not flagged.
        assert!(!too_sparse(10, 15.0));
    }

    #[test]
    fn sparse_spans_are_ordered_and_joined() {
        let s = |start, end| SparseSpan { start, end };
        assert_eq!(merge_sparse(vec![s(50.0, 60.0), s(10.0, 20.0), s(20.5, 30.0)]), vec![s(10.0, 30.0), s(50.0, 60.0)]);
    }

    #[test]
    fn loops_are_detected() {
        assert!(looks_degenerate(&words("ja ja ja ja ja ja ja ja")));
        assert!(looks_degenerate(&words("dat is zo dat is zo dat is zo dat is zo dat is zo")));
        assert!(!looks_degenerate(&words("ja ja, nee dat klopt wel, maar ik denk dat het anders zit")));
        assert!(!looks_degenerate(&words("ik ik weet het niet, ik ik denk van wel")));
    }

    #[test]
    fn prompt_echo_is_detected() {
        let primer = verbatim_primer(crate::asr::Language::Nl);
        assert!(echoes_prompt(&words("Nou, ehm, weet je, ik, ik weet het niet. Oké."), primer));
        assert!(!echoes_prompt(&words("Nou, ik weet het niet, misschien morgen."), primer));
    }
}
