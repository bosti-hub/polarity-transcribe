//! Speech recognition with whisper.cpp.
//!
//! Every chunk is decoded on its own with the same verbatim-style prompt. That keeps the model's
//! sensitivity to hesitations constant over a long interview and stops a repetition loop in one
//! chunk from contaminating the next.

use anyhow::{anyhow, Result};
use serde::{Deserialize, Serialize};
use std::path::Path;
use whisper_rs::{
    DtwMode, DtwModelPreset, DtwParameters, FullParams, SamplingStrategy, WhisperContext,
    WhisperContextParameters, WhisperState,
};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Language {
    Nl,
    En,
}

impl Language {
    pub fn code(self) -> &'static str {
        match self {
            Language::Nl => "nl",
            Language::En => "en",
        }
    }
    pub fn parse(s: &str) -> Option<Self> {
        match s.to_ascii_lowercase().as_str() {
            "nl" | "dutch" | "nederlands" => Some(Language::Nl),
            "en" | "english" | "engels" => Some(Language::En),
            _ => None,
        }
    }
}

/// A recognised word with times relative to the start of the audio that was passed in.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RawWord {
    /// Text including attached punctuation, without leading space.
    pub text: String,
    pub start: f32,
    pub end: f32,
    /// Mean token probability, 0..1.
    pub prob: f32,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ChunkOutput {
    pub words: Vec<RawWord>,
    /// Mean token log-probability over the chunk.
    pub avg_logprob: f32,
    /// Highest no-speech probability over the chunk's segments.
    pub no_speech_prob: f32,
}

impl ChunkOutput {
    pub fn text(&self) -> String {
        self.words.iter().map(|w| w.text.as_str()).collect::<Vec<_>>().join(" ")
    }
}

#[derive(Debug, Clone)]
pub struct AsrParams {
    pub language: Language,
    pub threads: usize,
    /// 1 = greedy decoding.
    pub beam_size: usize,
    pub prompt: String,
    /// Shrink the encoder window to the chunk length: about 30% faster, slightly less accurate
    /// and a little less sensitive to hesitations.
    pub fast: bool,
    /// Set to true from another thread to stop the running decode.
    pub abort: Option<std::sync::Arc<std::sync::atomic::AtomicBool>>,
}

impl AsrParams {
    pub fn new(language: Language, threads: usize) -> Self {
        Self { language, threads, beam_size: 1, prompt: String::new(), fast: false, abort: None }
    }
}

/// Compute backend chosen at model load.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Backend {
    Cpu,
    Gpu,
}

pub struct AsrModel {
    ctx: WhisperContext,
    pub backend: Backend,
    /// The graphics device in use, if any.
    pub device: Option<crate::gpu::GpuDevice>,
}

fn dtw_preset(file_name: &str) -> Option<DtwModelPreset> {
    let n = file_name.to_ascii_lowercase();
    let en = n.contains(".en");
    Some(if n.contains("large-v3-turbo") {
        DtwModelPreset::LargeV3Turbo
    } else if n.contains("large-v3") {
        DtwModelPreset::LargeV3
    } else if n.contains("large-v2") {
        DtwModelPreset::LargeV2
    } else if n.contains("medium") {
        if en { DtwModelPreset::MediumEn } else { DtwModelPreset::Medium }
    } else if n.contains("small") {
        if en { DtwModelPreset::SmallEn } else { DtwModelPreset::Small }
    } else if n.contains("base") {
        if en { DtwModelPreset::BaseEn } else { DtwModelPreset::Base }
    } else if n.contains("tiny") {
        if en { DtwModelPreset::TinyEn } else { DtwModelPreset::Tiny }
    } else {
        return None;
    })
}

impl AsrModel {
    /// Load a GGML Whisper model. With `use_gpu` the best graphics device is chosen (see
    /// [`crate::gpu::pick`]); without a suitable one the processor is used.
    pub fn load(path: &Path, use_gpu: bool) -> Result<Self> {
        silence_native_logs();
        let name = path.file_name().and_then(|s| s.to_str()).unwrap_or_default().to_string();
        let device = if use_gpu { crate::gpu::pick() } else { None };
        let use_gpu = device.is_some();
        let mut p = WhisperContextParameters::new();
        p.use_gpu(use_gpu);
        if let Some(d) = &device {
            p.gpu_device(d.index);
        }
        // Cross-attention (DTW) word timing is incompatible with flash attention.
        p.flash_attn(false);
        if let Some(preset) = dtw_preset(&name).filter(|_| std::env::var_os("PT_NO_DTW").is_none()) {
            p.dtw_parameters(DtwParameters {
                mode: DtwMode::ModelPreset { model_preset: preset },
                ..Default::default()
            });
        }
        let ctx = WhisperContext::new_with_params(
            path.to_str().ok_or_else(|| anyhow!("model path is not valid UTF-8"))?,
            p,
        )
        .map_err(|e| anyhow!("could not load speech model {}: {e}", path.display()))?;
        Ok(Self { ctx, backend: if use_gpu { Backend::Gpu } else { Backend::Cpu }, device })
    }

    /// Print whisper.cpp's internal timing breakdown to stderr (diagnostics).
    pub fn print_timings(&self) {
        self.ctx.print_timings();
    }

    pub fn session(&self) -> Result<AsrSession<'_>> {
        let state = self.ctx.create_state().map_err(|e| anyhow!("could not create decoder state: {e}"))?;
        Ok(AsrSession { model: self, state })
    }
}

/// Route whisper.cpp / ggml logging away from stderr.
pub(crate) fn silence_native_logs() {
    static ONCE: std::sync::Once = std::sync::Once::new();
    ONCE.call_once(|| {
        if std::env::var_os("PT_NATIVE_LOGS").is_none() {
            whisper_rs::install_logging_hooks();
        }
    });
}

pub struct AsrSession<'a> {
    model: &'a AsrModel,
    state: WhisperState,
}

/// Whisper refuses very short inputs; pad to this many samples with silence.
const MIN_SAMPLES: usize = 16_000 + 1_600;

struct Tok {
    bytes: Vec<u8>,
    p: f32,
    /// Seconds, from cross-attention DTW when available.
    t: Option<f32>,
    t0: f32,
}

impl AsrSession<'_> {
    /// How likely the audio (16 kHz mono, the first 30 s count) is Dutch and English, from
    /// whisper's own language detection.
    pub fn detect_language(&mut self, samples: &[f32], threads: usize) -> Result<(f32, f32)> {
        let mut audio = samples.to_vec();
        if audio.len() < MIN_SAMPLES {
            audio.resize(MIN_SAMPLES, 0.0);
        }
        self.state.pcm_to_mel(&audio, threads.max(1)).map_err(|e| anyhow!("language detection failed: {e}"))?;
        let (_, probs) = self.state.lang_detect(0, threads.max(1)).map_err(|e| anyhow!("language detection failed: {e}"))?;
        let p = |code: &str| whisper_rs::get_lang_id(code).and_then(|i| probs.get(i as usize).copied()).unwrap_or(0.0);
        Ok((p("nl"), p("en")))
    }

    /// Transcribe one chunk of 16 kHz mono audio (at most ~30 s).
    pub fn transcribe(&mut self, samples: &[f32], params: &AsrParams) -> Result<ChunkOutput> {
        let padded;
        let audio: &[f32] = if samples.len() < MIN_SAMPLES {
            let mut v = samples.to_vec();
            v.resize(MIN_SAMPLES, 0.0);
            padded = v;
            &padded
        } else {
            samples
        };
        let audio_len = samples.len() as f32 / 16_000.0;

        let strategy = if params.beam_size > 1 {
            SamplingStrategy::BeamSearch { beam_size: params.beam_size as i32, patience: -1.0 }
        } else {
            SamplingStrategy::Greedy { best_of: 1 }
        };
        let mut fp = FullParams::new(strategy);
        fp.set_n_threads(params.threads.max(1) as i32);
        fp.set_language(Some(params.language.code()));
        fp.set_translate(false);
        fp.set_no_context(true);
        fp.set_print_special(false);
        fp.set_print_progress(false);
        fp.set_print_realtime(false);
        fp.set_print_timestamps(false);
        fp.set_token_timestamps(true);
        fp.set_suppress_blank(true);
        // Suppress non-speech symbol tokens ("[", "(", music notes): removes "[muziek]"-style
        // hallucinations. Fillers are ordinary word tokens and are unaffected.
        fp.set_suppress_nst(true);
        fp.set_temperature(0.0);
        fp.set_temperature_inc(0.2);
        fp.set_entropy_thold(2.4);
        fp.set_logprob_thold(-1.0);
        fp.set_no_speech_thold(0.6);
        if !params.prompt.is_empty() {
            fp.set_initial_prompt(&params.prompt);
        }
        if params.fast {
            // 50 encoder frames per second, plus a second of headroom.
            let ctx = ((audio.len() as f32 / 16_000.0 + 1.0) * 50.0).ceil() as i32;
            fp.set_audio_ctx(ctx.clamp(64, 1500));
        }
        if let Some(flag) = &params.abort {
            // whisper-rs' safe wrapper for this callback passes the wrong pointer type, so the
            // raw API is used. `params.abort` outlives the `full` call below, which keeps the
            // pointer valid for as long as whisper.cpp may call back.
            unsafe extern "C" fn should_abort(user_data: *mut std::ffi::c_void) -> bool {
                let flag = &*(user_data as *const std::sync::atomic::AtomicBool);
                flag.load(std::sync::atomic::Ordering::Relaxed)
            }
            unsafe {
                fp.set_abort_callback(Some(should_abort));
                fp.set_abort_callback_user_data(std::sync::Arc::as_ptr(flag) as *mut std::ffi::c_void);
            }
        }

        self.state.full(fp, audio).map_err(|e| anyhow!("transcription failed: {e}"))?;

        let eot = self.model.ctx.token_eot();
        let mut toks: Vec<Tok> = Vec::new();
        let mut no_speech = 0f32;
        let mut logprob_sum = 0f64;
        let mut logprob_n = 0usize;
        for seg in self.state.as_iter() {
            no_speech = no_speech.max(seg.no_speech_probability());
            for i in 0..seg.n_tokens() {
                let Some(tok) = seg.get_token(i) else { continue };
                if tok.token_id() >= eot {
                    continue;
                }
                let d = tok.token_data();
                let bytes = tok.to_bytes().map(|b| b.to_vec()).unwrap_or_default();
                if bytes.is_empty() {
                    continue;
                }
                logprob_sum += d.plog as f64;
                logprob_n += 1;
                toks.push(Tok {
                    bytes,
                    p: d.p,
                    t: (d.t_dtw >= 0).then(|| d.t_dtw as f32 / 100.0),
                    t0: d.t0 as f32 / 100.0,
                });
            }
        }
        let words = assemble_words(&toks, audio_len);
        Ok(ChunkOutput {
            words,
            avg_logprob: if logprob_n > 0 { (logprob_sum / logprob_n as f64) as f32 } else { 0.0 },
            no_speech_prob: no_speech,
        })
    }
}

fn is_punct_only(s: &str) -> bool {
    !s.is_empty() && s.chars().all(|c| !c.is_alphanumeric())
}

/// Group sub-word tokens into words.
///
/// whisper.cpp's DTW gives one time per token marking where the token *starts* on the audio
/// axis. A word starts at its first token and ends where its trailing punctuation or the next
/// word starts. Silence between words is trimmed later against voice activity.
fn assemble_words(toks: &[Tok], audio_len: f32) -> Vec<RawWord> {
    struct Acc {
        bytes: Vec<u8>,
        psum: f32,
        n: usize,
        start: f32,
        /// Start of the first trailing punctuation token, if any.
        end_hint: Option<f32>,
    }
    let mut accs: Vec<Acc> = Vec::new();
    for t in toks {
        let starts_word = t.bytes.first() == Some(&b' ');
        let tok_start = t.t.unwrap_or(t.t0);
        let punct = is_punct_only(String::from_utf8_lossy(&t.bytes).trim());
        match accs.last_mut() {
            Some(a) if !starts_word || punct => {
                if punct && a.end_hint.is_none() {
                    a.end_hint = Some(tok_start);
                }
                a.bytes.extend_from_slice(&t.bytes);
                if !punct {
                    a.psum += t.p;
                    a.n += 1;
                }
            }
            _ => accs.push(Acc { bytes: t.bytes.clone(), psum: t.p, n: 1, start: tok_start, end_hint: None }),
        }
    }
    let mut words: Vec<RawWord> = Vec::with_capacity(accs.len());
    for i in 0..accs.len() {
        let a = &accs[i];
        let text = String::from_utf8_lossy(&a.bytes).split_whitespace().collect::<Vec<_>>().join("");
        if text.is_empty() || is_punct_only(&text) {
            continue;
        }
        let start = a.start.clamp(0.0, audio_len);
        let next_start = accs.get(i + 1).map(|n| n.start).unwrap_or(audio_len);
        let end = a.end_hint.unwrap_or(next_start).min(next_start.max(start)).clamp(start, audio_len.max(start));
        words.push(RawWord { text, start, end, prob: a.psum / a.n.max(1) as f32 });
    }
    // Times must never run backwards.
    for i in 1..words.len() {
        if words[i].start < words[i - 1].start {
            words[i].start = words[i - 1].start;
        }
        if words[i].end < words[i].start {
            words[i].end = words[i].start;
        }
        if words[i - 1].end > words[i].start {
            words[i - 1].end = words[i].start;
        }
    }
    words
}

/// Style primer that shows the model a transcript in which hesitations are written out.
pub fn verbatim_primer(lang: Language) -> &'static str {
    match lang {
        Language::Nl => "Uhm, ja, ik eh... ik denk dat het, uh, hmm, best wel lastig was. Mm-hm. Nou, ehm, weet je, ik, ik weet het niet. Oké.",
        Language::En => "Um, yeah, I, uh... I think it was, hmm, kind of hard, you know. Mm-hmm. Well, erm, I mean, I, I don't know. Okay.",
    }
}

/// Build the per-chunk prompt: optional glossary, the verbatim primer, then the tail of the
/// previous chunk for continuity.
pub fn build_prompt(lang: Language, glossary: &[String], previous_tail: Option<&str>) -> String {
    let mut p = String::new();
    if !glossary.is_empty() {
        p.push_str(&glossary.join(", "));
        p.push_str(". ");
    }
    p.push_str(verbatim_primer(lang));
    if let Some(tail) = previous_tail {
        let tail = tail.trim();
        if !tail.is_empty() {
            p.push(' ');
            p.push_str(tail);
        }
    }
    p
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tok(s: &str, t: f32) -> Tok {
        Tok { bytes: s.as_bytes().to_vec(), p: 0.9, t: Some(t), t0: 0.0 }
    }

    #[test]
    fn words_are_joined_from_subword_tokens() {
        let toks = vec![tok(" Uh", 0.5), tok("m", 0.6), tok(",", 0.9), tok(" ja", 1.4), tok(".", 1.7)];
        let w = assemble_words(&toks, 5.0);
        assert_eq!(w.len(), 2);
        assert_eq!(w[0].text, "Uhm,");
        assert_eq!(w[1].text, "ja.");
        assert!((w[0].start - 0.5).abs() < 1e-6);
        assert!((w[0].end - 0.9).abs() < 1e-6);
        assert!((w[1].start - 1.4).abs() < 1e-6);
        assert!((w[1].end - 1.7).abs() < 1e-6);
    }

    #[test]
    fn word_without_punctuation_ends_at_next_word() {
        let toks = vec![tok(" een", 1.0), tok(" beetje", 1.2)];
        let w = assemble_words(&toks, 3.0);
        assert!((w[0].end - 1.2).abs() < 1e-6);
        assert!((w[1].end - 3.0).abs() < 1e-6);
    }
}
