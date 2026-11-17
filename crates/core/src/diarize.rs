//! Telling speakers apart by voice, for recordings made with a single microphone.
//!
//! Short overlapping windows of speech are turned into voice "fingerprints" by a speaker
//! embedding network (WeSpeaker ResNet34). The fingerprints are clustered into the expected
//! number of speakers, and each speech frame is labelled with the speaker whose voice it
//! matches, using the same sequence decoding as the direction-based method.
//!
//! This is the least precise of the three ways to attribute speech (own microphone, direction,
//! voice): it cannot resolve turns much shorter than a second and it does not detect overlap.

use crate::spatial::{decode_speakers, spans_in_order};
use crate::vad::{Span, VAD_FRAME_SEC, VAD_HOP};
use anyhow::{anyhow, Context, Result};
use ort::session::builder::GraphOptimizationLevel;
use ort::session::Session;
use ort::value::Tensor;
use rustfft::{num_complex::Complex32, FftPlanner};
use serde::{Deserialize, Serialize};
use std::path::Path;

const RATE: usize = 16_000;
const FRAME_LEN: usize = 400;
const FRAME_SHIFT: usize = 160;
const N_FFT: usize = 512;
const N_MELS: usize = 80;
/// Embedding window and hop in samples (1.5 s / 0.75 s).
const WINDOW: usize = 24_000;
const HOP: usize = 12_000;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VoiceReport {
    /// Cosine similarity between the two most similar speaker voices (1 = identical).
    pub similarity: f32,
    pub separable: bool,
    pub speaker_sec: Vec<f64>,
}

/// Kaldi-compatible log mel filterbank features with mean normalisation, as the model expects.
pub struct Fbank {
    fft: std::sync::Arc<dyn rustfft::Fft<f32>>,
    window: Vec<f32>,
    /// Per mel bin: (first FFT bin, weights).
    filters: Vec<(usize, Vec<f32>)>,
}

impl Default for Fbank {
    fn default() -> Self {
        Self::new()
    }
}

impl Fbank {
    pub fn new() -> Self {
        let mel = |f: f64| 1127.0 * (1.0 + f / 700.0).ln();
        let (lo, hi) = (mel(20.0), mel(RATE as f64 / 2.0));
        let edge = |i: usize| lo + (hi - lo) * i as f64 / (N_MELS + 1) as f64;
        let bins = N_FFT / 2 + 1;
        let filters = (0..N_MELS)
            .map(|b| {
                let (l, c, r) = (edge(b), edge(b + 1), edge(b + 2));
                let mut first = None;
                let mut weights = Vec::new();
                for k in 0..bins {
                    let m = mel(k as f64 * RATE as f64 / N_FFT as f64);
                    let w = ((m - l) / (c - l)).min((r - m) / (r - c));
                    if w > 0.0 {
                        first.get_or_insert(k);
                        weights.push(w as f32);
                    } else if first.is_some() {
                        break;
                    }
                }
                (first.unwrap_or(0), weights)
            })
            .collect();
        Self {
            fft: FftPlanner::<f32>::new().plan_fft_forward(N_FFT),
            // Povey window.
            window: (0..FRAME_LEN)
                .map(|n| (0.5 - 0.5 * (2.0 * std::f64::consts::PI * n as f64 / (FRAME_LEN - 1) as f64).cos()).powf(0.85) as f32)
                .collect(),
            filters,
        }
    }

    /// Features for `samples` as rows of 80 values; returns the number of rows.
    pub fn compute(&self, samples: &[f32], out: &mut Vec<f32>) -> usize {
        if samples.len() < FRAME_LEN {
            return 0;
        }
        let n = 1 + (samples.len() - FRAME_LEN) / FRAME_SHIFT;
        let start = out.len();
        let mut buf = vec![Complex32::default(); N_FFT];
        let mut frame = [0f32; FRAME_LEN];
        for t in 0..n {
            let src = &samples[t * FRAME_SHIFT..t * FRAME_SHIFT + FRAME_LEN];
            // The model was trained on 16-bit sample values.
            let mean = src.iter().sum::<f32>() / FRAME_LEN as f32;
            for (d, s) in frame.iter_mut().zip(src) {
                *d = (s - mean) * 32768.0;
            }
            for i in (1..FRAME_LEN).rev() {
                frame[i] -= 0.97 * frame[i - 1];
            }
            frame[0] -= 0.97 * frame[0];
            buf.fill(Complex32::default());
            for i in 0..FRAME_LEN {
                buf[i].re = frame[i] * self.window[i];
            }
            self.fft.process(&mut buf);
            for (first, weights) in &self.filters {
                let e: f32 = weights.iter().enumerate().map(|(i, w)| w * buf[first + i].norm_sqr()).sum();
                out.push(e.max(f32::EPSILON).ln());
            }
        }
        // Cepstral mean normalisation over the window.
        let rows = &mut out[start..];
        for m in 0..N_MELS {
            let mean = (0..n).map(|t| rows[t * N_MELS + m]).sum::<f32>() / n as f32;
            for t in 0..n {
                rows[t * N_MELS + m] -= mean;
            }
        }
        n
    }
}

pub struct Embedder {
    session: Session,
    /// Keeps the ONNX Runtime environment alive for as long as the session is used.
    _env: ort::environment::Environment,
    input: String,
    fbank: Fbank,
}

/// The ONNX Runtime environment. ONNX Runtime allows only one per process, so it is created on
/// first use and shared by every voice model loaded afterwards (one per transcription job).
fn environment() -> std::result::Result<ort::environment::Environment, String> {
    static ENV: std::sync::OnceLock<std::result::Result<ort::environment::Environment, String>> = std::sync::OnceLock::new();
    ENV.get_or_init(|| {
        // No usage data may leave the machine: switch ONNX Runtime telemetry off explicitly.
        ort::environment::init().with_name("polarity-transcribe").with_telemetry(false).build().map_err(|e| e.to_string())
    })
    .clone()
}

impl Embedder {
    pub fn load(model: &Path, threads: usize) -> Result<Self> {
        let fail = |e: String| anyhow!("could not load the voice model {}: {e}", model.display());
        let env = environment().map_err(fail)?;
        let builder = Session::builder(&env).map_err(|e| fail(e.to_string()))?;
        let builder = builder.with_optimization_level(GraphOptimizationLevel::Level3).map_err(|e| fail(e.to_string()))?;
        let mut builder = builder.with_intra_threads(threads.max(1)).map_err(|e| fail(e.to_string()))?;
        let session = builder.commit_from_file(model).map_err(|e| fail(e.to_string()))?;
        let input = session.inputs().first().map(|i| i.name().to_string()).context("voice model has no input")?;
        Ok(Self { session, _env: env, input, fbank: Fbank::new() })
    }

    /// Unit-length voice embeddings for equally long windows of audio.
    pub fn embed(&mut self, windows: &[&[f32]]) -> Result<Vec<Vec<f32>>> {
        if windows.is_empty() {
            return Ok(Vec::new());
        }
        let mut feats: Vec<f32> = Vec::new();
        let mut rows = 0;
        for w in windows {
            rows = self.fbank.compute(w, &mut feats);
        }
        let tensor = Tensor::from_array(([windows.len(), rows, N_MELS], feats)).map_err(|e| anyhow!("voice model input: {e}"))?;
        let outputs = self.session.run(ort::inputs![self.input.as_str() => tensor]).map_err(|e| anyhow!("voice model failed: {e}"))?;
        let (shape, data) = outputs[0].try_extract_tensor::<f32>().map_err(|e| anyhow!("voice model output: {e}"))?;
        let dim = *shape.last().context("voice model output has no shape")? as usize;
        Ok(data
            .chunks_exact(dim)
            .map(|v| {
                let norm = v.iter().map(|x| x * x).sum::<f32>().sqrt().max(1e-9);
                v.iter().map(|x| x / norm).collect()
            })
            .collect())
    }
}

fn dot(a: &[f32], b: &[f32]) -> f32 {
    a.iter().zip(b).map(|(x, y)| x * y).sum()
}

/// Cluster unit vectors into `k` groups (spherical k-means with farthest-point start).
/// Returns the unit-length centroids.
fn cluster(embs: &[Vec<f32>], k: usize) -> Vec<Vec<f32>> {
    let dim = embs[0].len();
    let normalise = |v: &mut Vec<f32>| {
        let n = v.iter().map(|x| x * x).sum::<f32>().sqrt().max(1e-9);
        v.iter_mut().for_each(|x| *x /= n);
    };
    // Start with the voice least like the average, then repeatedly add the one least like
    // everything chosen so far.
    let mut mean = vec![0f32; dim];
    for e in embs {
        for (m, x) in mean.iter_mut().zip(e) {
            *m += x;
        }
    }
    normalise(&mut mean);
    let first = (0..embs.len()).min_by(|&a, &b| dot(&embs[a], &mean).total_cmp(&dot(&embs[b], &mean))).unwrap();
    let mut centroids = vec![embs[first].clone()];
    while centroids.len() < k {
        let far = (0..embs.len())
            .min_by(|&a, &b| {
                let sa = centroids.iter().map(|c| dot(&embs[a], c)).fold(f32::MIN, f32::max);
                let sb = centroids.iter().map(|c| dot(&embs[b], c)).fold(f32::MIN, f32::max);
                sa.total_cmp(&sb)
            })
            .unwrap();
        centroids.push(embs[far].clone());
    }
    for _ in 0..40 {
        let mut sums = vec![vec![0f32; dim]; k];
        let mut counts = vec![0usize; k];
        for e in embs {
            let best = (0..k).max_by(|&a, &b| dot(e, &centroids[a]).total_cmp(&dot(e, &centroids[b]))).unwrap();
            counts[best] += 1;
            for (s, x) in sums[best].iter_mut().zip(e) {
                *s += x;
            }
        }
        let mut moved = 0f32;
        for c in 0..k {
            if counts[c] == 0 {
                continue;
            }
            normalise(&mut sums[c]);
            moved = moved.max(1.0 - dot(&sums[c], &centroids[c]));
            centroids[c] = std::mem::take(&mut sums[c]);
        }
        if moved < 1e-5 {
            break;
        }
    }
    centroids
}

/// Attribute speech to `k` speakers by voice.
///
/// `speech` are the voice-activity spans; `read(start, len)` returns 16 kHz samples.
pub fn attribute_by_voice(
    embedder: &mut Embedder,
    read: &mut dyn FnMut(u64, usize) -> Result<Vec<f32>>,
    n_samples: usize,
    speech: &[Span],
    k: usize,
    mut progress: impl FnMut(f32) -> bool,
) -> Result<Option<(Vec<Vec<Span>>, VoiceReport)>> {
    let k = k.clamp(2, 4);
    // Window positions (in samples) inside speech.
    let mut starts: Vec<usize> = Vec::new();
    let mut merged: Vec<Span> = Vec::new();
    for s in speech {
        match merged.last_mut() {
            Some(last) if s.start - last.end < 0.3 => last.end = s.end,
            _ => merged.push(*s),
        }
    }
    for s in &merged {
        let a = (s.start * RATE as f64) as usize;
        let b = ((s.end * RATE as f64) as usize).min(n_samples);
        if b < a + RATE / 2 {
            continue;
        }
        if b - a <= WINDOW {
            // A short utterance: one window centred on it.
            let centre = (a + b) / 2;
            starts.push(centre.saturating_sub(WINDOW / 2).min(n_samples.saturating_sub(WINDOW)));
            continue;
        }
        let mut pos = a;
        while pos + WINDOW <= b {
            starts.push(pos);
            pos += HOP;
        }
        if pos < b && b >= WINDOW {
            starts.push(b - WINDOW);
        }
    }
    if starts.len() < 4 * k || n_samples < WINDOW {
        return Ok(None);
    }

    // Embeddings, in batches.
    const BATCH: usize = 16;
    let mut embs: Vec<Vec<f32>> = Vec::with_capacity(starts.len());
    for (i, batch) in starts.chunks(BATCH).enumerate() {
        let audio: Vec<Vec<f32>> = batch.iter().map(|&s| read(s as u64, WINDOW)).collect::<Result<_>>()?;
        let refs: Vec<&[f32]> = audio.iter().map(|a| a.as_slice()).collect();
        embs.extend(embedder.embed(&refs)?);
        if !progress(((i + 1) * BATCH).min(starts.len()) as f32 / starts.len() as f32) {
            return Ok(None);
        }
    }

    let centroids = cluster(&embs, k);
    let mut similarity = f32::MIN;
    for i in 0..k {
        for j in i + 1..k {
            similarity = similarity.max(dot(&centroids[i], &centroids[j]));
        }
    }

    // Spread each window's similarity to the speakers over the frames it covers, weighting
    // the middle of the window most.
    let n_frames = n_samples.div_ceil(VAD_HOP);
    let mut scores = vec![0f32; n_frames * k];
    let mut weight = vec![0f32; n_frames];
    for (&start, e) in starts.iter().zip(&embs) {
        let sims: Vec<f32> = centroids.iter().map(|c| dot(e, c)).collect();
        // Rescale so the best speaker scores 1 and an average match 0: comparable across windows.
        let top = sims.iter().copied().fold(f32::MIN, f32::max);
        let mean = sims.iter().sum::<f32>() / k as f32;
        let span = (top - mean).max(1e-3);
        let f0 = start / VAD_HOP;
        let f1 = ((start + WINDOW) / VAD_HOP).min(n_frames);
        let mid = (f0 + f1) as f32 / 2.0;
        let half = (f1 - f0) as f32 / 2.0;
        for f in f0..f1 {
            let w = 1.0 - ((f as f32 + 0.5 - mid).abs() / half).min(1.0) * 0.8;
            weight[f] += w;
            for s in 0..k {
                scores[f * k + s] += w * ((sims[s] - mean) / span).max(0.0);
            }
        }
    }
    let mut is_speech = vec![false; n_frames];
    for s in speech {
        let a = (s.start / VAD_FRAME_SEC) as usize;
        let b = ((s.end / VAD_FRAME_SEC).ceil() as usize).min(n_frames);
        for f in a..b {
            is_speech[f] = true;
        }
    }
    for f in 0..n_frames {
        if weight[f] > 0.0 {
            for s in 0..k {
                scores[f * k + s] /= weight[f];
            }
        }
    }
    let label = decode_speakers(&scores, &is_speech, k, 0.45);
    let (spans, _) = spans_in_order(&label, k);
    let report = VoiceReport {
        similarity,
        // Two clusters of one and the same voice are much more alike than two people.
        separable: similarity < 0.7,
        speaker_sec: spans.iter().map(|s| s.iter().map(|x| x.len()).sum()).collect(),
    };
    Ok(Some((spans, report)))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Two transcriptions in one app session each load the voice model. Needs the model file
    /// in `models/` (not present on CI, where the test does nothing).
    #[test]
    fn the_voice_model_loads_twice_in_one_process() {
        let model = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../models/wespeaker_en_voxceleb_resnet34_LM.onnx");
        if !model.exists() {
            return;
        }
        let first = Embedder::load(&model, 1).unwrap();
        drop(first);
        assert!(Embedder::load(&model, 1).is_ok());
    }

    #[test]
    fn fbank_has_expected_shape_and_is_mean_normalised() {
        let samples: Vec<f32> = (0..WINDOW).map(|i| (i as f32 * 0.05).sin() * 0.1 + (i as f32 * 0.31).sin() * 0.05).collect();
        let mut out = Vec::new();
        let rows = Fbank::new().compute(&samples, &mut out);
        assert_eq!(rows, 148);
        assert_eq!(out.len(), rows * N_MELS);
        for m in [0, 40, 79] {
            let mean: f32 = (0..rows).map(|t| out[t * N_MELS + m]).sum::<f32>() / rows as f32;
            assert!(mean.abs() < 1e-3);
        }
    }

    #[test]
    fn clustering_separates_two_directions() {
        let mut embs = Vec::new();
        for i in 0..40 {
            let j = (i % 5) as f32 * 0.05;
            embs.push(vec![1.0 - j, j, 0.1]);
            embs.push(vec![j, 1.0 - j, -0.1]);
        }
        for e in &mut embs {
            let n = e.iter().map(|x| x * x).sum::<f32>().sqrt();
            e.iter_mut().for_each(|x| *x /= n);
        }
        let c = cluster(&embs, 2);
        assert!(dot(&c[0], &c[1]) < 0.5);
    }
}
