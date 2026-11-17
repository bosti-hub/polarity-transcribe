//! Voice activity detection (Silero VAD running on the whisper.cpp runtime).
//!
//! We only take frame-level speech probabilities from the model and do the segmentation
//! ourselves, because the same probabilities also drive pause measurement and speaker
//! attribution.

use anyhow::{anyhow, Result};
use std::path::Path;
use whisper_rs::{WhisperVadContext, WhisperVadContextParams};

/// Silero frame hop at 16 kHz: 512 samples = 32 ms.
pub const VAD_HOP: usize = 512;
pub const VAD_FRAME_SEC: f64 = VAD_HOP as f64 / 16_000.0;

pub struct Vad {
    ctx: WhisperVadContext,
}

impl Vad {
    pub fn new(model: &Path, threads: usize) -> Result<Self> {
        crate::asr::silence_native_logs();
        let mut p = WhisperVadContextParams::new();
        p.set_n_threads(threads.max(1) as i32);
        p.set_use_gpu(false);
        let ctx = WhisperVadContext::new(
            model.to_str().ok_or_else(|| anyhow!("VAD model path is not valid UTF-8"))?,
            p,
        )
        .map_err(|e| anyhow!("could not load VAD model {}: {e}", model.display()))?;
        Ok(Self { ctx })
    }

    /// Speech probability per 32 ms frame for 16 kHz mono `samples`.
    ///
    /// Long inputs are processed in blocks so memory stays flat; the recurrent state is reset at
    /// block boundaries, which only matters for a few frames.
    pub fn probabilities(&mut self, samples: &[f32], mut progress: impl FnMut(f32)) -> Result<Vec<f32>> {
        const BLOCK: usize = VAD_HOP * 9375; // 5 minutes
        let mut out = Vec::with_capacity(samples.len() / VAD_HOP + 1);
        let mut pos = 0;
        while pos < samples.len() {
            let end = (pos + BLOCK).min(samples.len());
            self.ctx
                .detect_speech(&samples[pos..end])
                .map_err(|e| anyhow!("voice detection failed: {e}"))?;
            let want = (end - pos).div_ceil(VAD_HOP);
            let probs = self.ctx.probabilities();
            out.extend(probs.iter().take(want).copied());
            // Keep the frame grid aligned even if the model returned fewer frames.
            for _ in probs.len().min(want)..want {
                out.push(0.0);
            }
            pos = end;
            progress(pos as f32 / samples.len() as f32);
        }
        Ok(out)
    }
}

/// A span of time in seconds.
#[derive(Debug, Clone, Copy, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct Span {
    pub start: f64,
    pub end: f64,
}

impl Span {
    pub fn new(start: f64, end: f64) -> Self {
        Self { start, end }
    }
    pub fn len(&self) -> f64 {
        self.end - self.start
    }
    pub fn is_empty(&self) -> bool {
        self.end <= self.start
    }
}

#[derive(Debug, Clone)]
pub struct SegmentOpts {
    /// Probability above which speech starts.
    pub on: f32,
    /// Probability below which speech ends (hysteresis).
    pub off: f32,
    /// Speech shorter than this is discarded.
    pub min_speech: f64,
    /// Silence shorter than this does not split a segment.
    pub min_silence: f64,
}

impl Default for SegmentOpts {
    fn default() -> Self {
        Self { on: 0.5, off: 0.35, min_speech: 0.10, min_silence: 0.20 }
    }
}

/// Turn frame probabilities into speech spans (hysteresis thresholding).
pub fn segments(probs: &[f32], opts: &SegmentOpts) -> Vec<Span> {
    let mut raw: Vec<Span> = Vec::new();
    let mut start: Option<usize> = None;
    for (i, &p) in probs.iter().enumerate() {
        match start {
            None if p >= opts.on => start = Some(i),
            Some(s) if p < opts.off => {
                raw.push(Span::new(s as f64 * VAD_FRAME_SEC, i as f64 * VAD_FRAME_SEC));
                start = None;
            }
            _ => {}
        }
    }
    if let Some(s) = start {
        raw.push(Span::new(s as f64 * VAD_FRAME_SEC, probs.len() as f64 * VAD_FRAME_SEC));
    }
    // Bridge short silences, then drop blips.
    let mut merged: Vec<Span> = Vec::new();
    for s in raw {
        match merged.last_mut() {
            Some(last) if s.start - last.end < opts.min_silence => last.end = s.end,
            _ => merged.push(s),
        }
    }
    merged.retain(|s| s.len() >= opts.min_speech);
    merged
}
