//! Time alignment of two recordings of the same conversation.
//!
//! Consumer recorders start at different moments, run on clocks that differ by tens of parts
//! per million, and sometimes drop or skip audio. We therefore estimate a *time map* from the
//! master track to the second track instead of a single offset:
//!
//! 1. Coarse offset from the cross-correlation of speech-onset envelopes of the whole files.
//! 2. Local offsets from GCC-PHAT on short windows spread over the recording.
//! 3. A robust piecewise-linear fit through those local offsets: the slope is the clock drift,
//!    a break is a discontinuity in one of the recordings.
//!
//! The second track is then resampled along that map onto the master timeline.

use anyhow::{bail, Result};
use rustfft::{num_complex::Complex32, FftPlanner};
use serde::{Deserialize, Serialize};

const RATE: f64 = 16_000.0;
/// Open-ended segment bounds (finite so the map survives a JSON round trip).
const FAR: f64 = 1e12;
/// Envelope rate for the coarse search.
const ENV_HOP: usize = 160; // 10 ms
const ENV_RATE: f64 = RATE / ENV_HOP as f64;

/// Reads `len` samples starting at absolute sample `start` (zero-filled outside the file).
pub type Reader<'a> = dyn FnMut(i64, usize) -> Result<Vec<f32>> + 'a;

/// One linear piece of the time map: `t2 = a + b * t` for master time `t` in `[t0, t1)`.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct Segment {
    pub t0: f64,
    pub t1: f64,
    pub a: f64,
    pub b: f64,
}

/// Maps master time (seconds from the master track's in-point) to time in the second file.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SyncMap {
    pub segments: Vec<Segment>,
}

impl SyncMap {
    pub fn constant(offset: f64) -> Self {
        Self { segments: vec![Segment { t0: -FAR, t1: FAR, a: offset, b: 1.0 }] }
    }

    pub fn map(&self, t: f64) -> f64 {
        let seg = self
            .segments
            .iter()
            .find(|s| t < s.t1)
            .or(self.segments.last())
            .expect("sync map has at least one segment");
        seg.a + seg.b * t
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncReport {
    /// Offset of the second file at master time 0: `t2 = offset + …` (seconds).
    pub offset: f64,
    /// Clock difference in parts per million (positive: second recorder runs fast).
    pub drift_ppm: f64,
    /// Number of local measurements that agreed with the fit / were attempted.
    pub windows_used: usize,
    pub windows_total: usize,
    /// Discontinuities found in the alignment.
    pub jumps: usize,
    /// Typical deviation of local measurements from the fit, in milliseconds.
    pub residual_ms: f64,
}

// ------------------------------------------------------------------ envelopes

/// Onset-strength envelope at 100 Hz: positive change of log energy. Robust to gain and
/// microphone differences, sharp enough to align to a few tens of milliseconds.
pub fn onset_envelope(read: &mut Reader<'_>, start: i64, len: usize) -> Result<Vec<f32>> {
    const BLOCK: usize = ENV_HOP * 6_000; // one minute
    let mut env = Vec::with_capacity(len / ENV_HOP + 1);
    let mut prev = None::<f32>;
    let mut pos = 0usize;
    while pos < len {
        let n = BLOCK.min(len - pos);
        let block = read(start + pos as i64, n)?;
        for frame in block.chunks_exact(ENV_HOP) {
            let e: f32 = frame.iter().map(|v| v * v).sum::<f32>() / ENV_HOP as f32;
            let db = 10.0 * (e + 1e-9).log10();
            env.push(prev.map_or(0.0, |p| (db - p).max(0.0)));
            prev = Some(db);
        }
        pos += n;
    }
    // Remove the mean so silence does not correlate with silence.
    let mean = env.iter().sum::<f32>() / env.len().max(1) as f32;
    for v in &mut env {
        *v -= mean;
    }
    Ok(env)
}

/// Lag (in envelope frames) that best aligns `b` to `a`: `a[i] ≈ b[i + lag]`.
/// Returns the lag and how many standard deviations the peak stands out.
pub fn envelope_lag(a: &[f32], b: &[f32]) -> (i64, f32) {
    let n = (a.len() + b.len()).next_power_of_two();
    let mut planner = FftPlanner::<f32>::new();
    let fft = planner.plan_fft_forward(n);
    let ifft = planner.plan_fft_inverse(n);
    let mut fa: Vec<Complex32> = a.iter().map(|v| Complex32::new(*v, 0.0)).collect();
    let mut fb: Vec<Complex32> = b.iter().map(|v| Complex32::new(*v, 0.0)).collect();
    fa.resize(n, Complex32::default());
    fb.resize(n, Complex32::default());
    fft.process(&mut fa);
    fft.process(&mut fb);
    for (x, y) in fa.iter_mut().zip(&fb) {
        *x = x.conj() * y;
    }
    ifft.process(&mut fa);
    // Index k holds sum_i a[i] * b[i + k]; negative lags wrap around.
    let max_pos = b.len() as i64 - 1;
    let max_neg = a.len() as i64 - 1;
    let mut best = (0i64, f32::MIN);
    let (mut sum, mut sum2, mut count) = (0f64, 0f64, 0usize);
    let mut consider = |lag: i64, v: f32| {
        sum += v as f64;
        sum2 += (v as f64) * (v as f64);
        count += 1;
        if v > best.1 {
            best = (lag, v);
        }
    };
    for k in 0..=max_pos.min(n as i64 / 2 - 1) {
        consider(k, fa[k as usize].re);
    }
    for k in 1..=max_neg.min(n as i64 / 2 - 1) {
        consider(-k, fa[n - k as usize].re);
    }
    let mean = sum / count.max(1) as f64;
    let std = (sum2 / count.max(1) as f64 - mean * mean).max(1e-12).sqrt();
    (best.0, ((best.1 as f64 - mean) / std) as f32)
}

// ------------------------------------------------------------------ GCC-PHAT

/// Generalised cross-correlation with phase transform, restricted to the speech band.
///
/// Finds where `a` occurs inside the longer `b`: returns `lag` in samples such that
/// `b[i + lag] ≈ a[i]` with `0 <= lag <= b.len() - a.len()`, and a peak-to-noise score.
pub struct GccPhat {
    n: usize,
    fft: std::sync::Arc<dyn rustfft::Fft<f32>>,
    ifft: std::sync::Arc<dyn rustfft::Fft<f32>>,
}

impl GccPhat {
    pub fn new(max_len: usize) -> Self {
        let n = max_len.next_power_of_two();
        let mut planner = FftPlanner::<f32>::new();
        Self { n, fft: planner.plan_fft_forward(n), ifft: planner.plan_fft_inverse(n) }
    }

    pub fn locate(&self, a: &[f32], b: &[f32]) -> (usize, f32) {
        let n = self.n;
        assert!(b.len() <= n && a.len() <= b.len());
        let mut fa: Vec<Complex32> = a.iter().map(|v| Complex32::new(*v, 0.0)).collect();
        let mut fb: Vec<Complex32> = b.iter().map(|v| Complex32::new(*v, 0.0)).collect();
        fa.resize(n, Complex32::default());
        fb.resize(n, Complex32::default());
        self.fft.process(&mut fa);
        self.fft.process(&mut fb);
        let lo = (200.0 / RATE * n as f64) as usize;
        let hi = (4_000.0 / RATE * n as f64) as usize;
        for k in 0..n {
            let f = k.min(n - k);
            if f < lo || f > hi {
                fa[k] = Complex32::default();
            } else {
                let r = fa[k].conj() * fb[k];
                let mag = r.norm();
                fa[k] = if mag > 1e-12 { r / mag } else { Complex32::default() };
            }
        }
        self.ifft.process(&mut fa);
        let range = b.len() - a.len() + 1;
        let mut best = (0usize, f32::MIN);
        let mut sum2 = 0f64;
        for (k, v) in fa.iter().take(range).enumerate() {
            sum2 += (v.re as f64) * (v.re as f64);
            if v.re > best.1 {
                best = (k, v.re);
            }
        }
        let rms = (sum2 / range as f64).max(1e-18).sqrt();
        (best.0, (best.1 as f64 / rms) as f32)
    }
}

// ------------------------------------------------------------------ robust fit

#[derive(Debug, Clone, Copy)]
struct Point {
    /// Master time (s).
    t: f64,
    /// Offset `t2 - t` (s).
    y: f64,
}

/// Local offsets within this distance of the fit count as agreeing (seconds). Covers the
/// acoustic path difference between two microphones in one room.
const TOLERANCE: f64 = 0.012;
/// Largest plausible clock difference.
const MAX_DRIFT: f64 = 2e-3;

/// Local offsets this close to each other come from the same sound source (seconds).
///
/// In a room, each speaker reaches the two microphones with a slightly different delay, so
/// the local offsets form parallel lines a fraction of a millisecond apart. Fitting through
/// all of them would turn "speaker A talks early, speaker B late" into apparent clock drift;
/// the final fit therefore uses only the tightest group.
const FINE_TOLERANCE: f64 = 0.00015;

/// Largest subset of `idx` that lies within `tol` of one line with a plausible slope.
fn consensus(points: &[Point], idx: &[usize], tol: f64) -> Vec<usize> {
    let count = |a: f64, d: f64| -> Vec<usize> {
        idx.iter().copied().filter(|&i| (points[i].y - (a + d * points[i].t)).abs() <= tol).collect()
    };
    let mut best: Vec<usize> = Vec::new();
    // Zero-drift candidates through every point, and a line through every (sub-sampled) pair.
    for &i in idx {
        let inl = count(points[i].y, 0.0);
        if inl.len() > best.len() {
            best = inl;
        }
    }
    let step = (idx.len() / 120).max(1);
    for x in (0..idx.len()).step_by(step) {
        for y in (x + 1..idx.len()).step_by(step) {
            let (i, j) = (idx[x], idx[y]);
            let dt = points[j].t - points[i].t;
            if dt < 30.0 {
                continue;
            }
            let d = (points[j].y - points[i].y) / dt;
            if d.abs() > MAX_DRIFT {
                continue;
            }
            let inl = count(points[i].y - d * points[i].t, d);
            if inl.len() > best.len() {
                best = inl;
            }
        }
    }
    best
}

/// Least-squares line through the given points. The slope (clock drift) is only kept when it
/// is clearly larger than its own uncertainty; otherwise the offset is taken as constant.
fn least_squares(points: &[Point], idx: &[usize]) -> (f64, f64) {
    let n = idx.len() as f64;
    let mt = idx.iter().map(|&i| points[i].t).sum::<f64>() / n;
    let my = idx.iter().map(|&i| points[i].y).sum::<f64>() / n;
    let stt: f64 = idx.iter().map(|&i| (points[i].t - mt).powi(2)).sum();
    let sty: f64 = idx.iter().map(|&i| (points[i].t - mt) * (points[i].y - my)).sum();
    if idx.len() < 4 || stt < 60.0 * 60.0 {
        return (my, 0.0);
    }
    let d = (sty / stt).clamp(-MAX_DRIFT, MAX_DRIFT);
    let a = my - d * mt;
    let sse: f64 = idx.iter().map(|&i| (points[i].y - (a + d * points[i].t)).powi(2)).sum();
    // Measurement noise is never below a quarter of a sample.
    let sigma = (sse / (n - 2.0)).sqrt().max(0.25 / RATE);
    let se = sigma / stt.sqrt();
    if d.abs() < 4.0 * se {
        (my, 0.0)
    } else {
        (a, d)
    }
}

/// Best line `y = a + d t` through the points. Returns the line and the indices of all
/// points that agree with it to within the coarse tolerance.
fn fit_line(points: &[Point]) -> Option<(f64, f64, Vec<usize>)> {
    if points.is_empty() {
        return None;
    }
    let all: Vec<usize> = (0..points.len()).collect();
    let rough = consensus(points, &all, TOLERANCE);
    if rough.is_empty() {
        return None;
    }
    let tight = consensus(points, &rough, FINE_TOLERANCE);
    let basis = if tight.len() >= 3 && tight.len() * 5 >= rough.len() { &tight } else { &rough };
    let (a, d) = least_squares(points, basis);
    let inliers: Vec<usize> =
        all.into_iter().filter(|&i| (points[i].y - (a + d * points[i].t)).abs() <= TOLERANCE).collect();
    Some((a, d, inliers))
}

/// Fit one or more lines; points before/after the main consensus that form their own
/// consistent group become separate segments (a jump in one of the recordings).
fn fit_segments(points: &[Point], out: &mut Vec<(f64, f64, f64, f64, usize)>, depth: usize) {
    const MIN_POINTS: usize = 3;
    let Some((a, d, inliers)) = fit_line(points) else { return };
    if inliers.len() < MIN_POINTS {
        return;
    }
    let first = *inliers.first().unwrap();
    let last = *inliers.last().unwrap();
    if depth < 6 && first >= MIN_POINTS {
        fit_segments(&points[..first], out, depth + 1);
    }
    out.push((points[first].t, points[last].t, a, d, inliers.len()));
    if depth < 6 && points.len() - 1 - last >= MIN_POINTS {
        fit_segments(&points[last + 1..], out, depth + 1);
    }
}

// ------------------------------------------------------------------ estimate

pub struct Track<'a> {
    pub read: &'a mut Reader<'a>,
    /// Trim in/out in seconds on the file timeline.
    pub start: f64,
    pub end: f64,
}

/// Coarse offset between the trimmed regions of two tracks using onset envelopes.
/// Returns `(offset, score)`: `file2_time ≈ file1_time + offset`.
pub fn coarse_offset(t1: &mut Track<'_>, t2: &mut Track<'_>) -> Result<(f64, f32)> {
    let s1 = (t1.start * RATE) as i64;
    let s2 = (t2.start * RATE) as i64;
    let e1 = onset_envelope(t1.read, s1, ((t1.end - t1.start) * RATE) as usize)?;
    let e2 = onset_envelope(t2.read, s2, ((t2.end - t2.start) * RATE) as usize)?;
    if e1.len() < 200 || e2.len() < 200 {
        bail!("the selected audio is too short to synchronise");
    }
    let (lag, score) = envelope_lag(&e1, &e2);
    Ok((t2.start - t1.start + lag as f64 / ENV_RATE, score))
}

/// Estimate the full time map from the master track (`t1`) to the second track (`t2`).
pub fn estimate(
    t1: &mut Track<'_>,
    t2: &mut Track<'_>,
    mut progress: impl FnMut(f32),
) -> Result<(SyncMap, SyncReport)> {
    let (coarse, coarse_score) = coarse_offset(t1, t2)?;
    progress(0.2);
    let master_len = t1.end - t1.start;

    // Local measurements.
    const WINDOW: f64 = 12.0;
    let search = 1.5f64; // seconds either side of the prediction
    let n_windows = ((master_len / 10.0).ceil() as usize).clamp(8, 300).min(((master_len - WINDOW) / 2.0).max(1.0) as usize);
    let hop = if n_windows > 1 { (master_len - WINDOW).max(0.0) / (n_windows - 1) as f64 } else { 0.0 };
    let wlen = (WINDOW.min(master_len) * RATE) as usize;
    let slen = wlen + (2.0 * search * RATE) as usize;
    let gcc = GccPhat::new(slen);

    let mut points: Vec<Point> = Vec::new();
    let mut attempted = 0usize;
    for i in 0..n_windows {
        let t = i as f64 * hop;
        let a = (t1.read)(((t1.start + t) * RATE).round() as i64, wlen)?;
        let energy: f32 = a.iter().map(|v| v * v).sum::<f32>() / wlen as f32;
        if energy < 1e-7 {
            continue; // digital silence
        }
        // Predicted file-2 position of this window, minus the search margin.
        let b_start = ((t1.start + t + coarse - search) * RATE).round() as i64;
        let b = (t2.read)(b_start, slen)?;
        attempted += 1;
        let (lag, score) = gcc.locate(&a, &b);
        if score >= 8.0 {
            let t2_abs = (b_start + lag as i64) as f64 / RATE;
            points.push(Point { t, y: t2_abs - t });
        }
        progress(0.2 + 0.8 * (i + 1) as f32 / n_windows as f32);
    }

    if points.len() < 3 {
        if coarse_score < 6.0 {
            bail!("the two recordings could not be synchronised: they do not seem to contain the same conversation");
        }
        // Too little clean overlap for a drift estimate: fall back to the coarse offset.
        let offset = t1.start + coarse;
        return Ok((
            SyncMap::constant(offset),
            SyncReport { offset, drift_ppm: 0.0, windows_used: points.len(), windows_total: attempted, jumps: 0, residual_ms: 10.0 },
        ));
    }

    let mut segs: Vec<(f64, f64, f64, f64, usize)> = Vec::new();
    fit_segments(&points, &mut segs, 0);
    if segs.is_empty() {
        bail!("the two recordings could not be synchronised reliably");
    }
    segs.sort_by(|x, y| x.0.total_cmp(&y.0));

    let used: usize = segs.iter().map(|s| s.4).sum();
    let main = *segs.iter().max_by_key(|s| s.4).unwrap();
    let mut residuals: Vec<f64> = points
        .iter()
        .filter_map(|p| {
            segs.iter()
                .map(|s| (p.y - (s.2 + s.3 * p.t)).abs())
                .filter(|r| *r <= TOLERANCE)
                .min_by(|a, b| a.total_cmp(b))
        })
        .collect();
    residuals.sort_by(|a, b| a.total_cmp(b));
    let residual_ms = residuals.get(residuals.len() / 2).copied().unwrap_or(0.0) * 1000.0;

    let mut segments = Vec::with_capacity(segs.len());
    for (i, s) in segs.iter().enumerate() {
        let t0 = if i == 0 { -FAR } else { (segs[i - 1].1 + s.0) / 2.0 };
        let t1 = if i + 1 == segs.len() { FAR } else { (s.1 + segs[i + 1].0) / 2.0 };
        // y = a + d t  →  t2 = a + (1 + d) t
        segments.push(Segment { t0, t1, a: s.2, b: 1.0 + s.3 });
    }
    let report = SyncReport {
        offset: main.2,
        drift_ppm: main.3 * 1e6,
        windows_used: used,
        windows_total: attempted,
        jumps: segments.len() - 1,
        residual_ms,
    };
    Ok((SyncMap { segments }, report))
}

// ------------------------------------------------------------------ resampling

const TAPS: usize = 16;
const PHASES: usize = 256;

fn sinc_table() -> Vec<[f32; TAPS]> {
    let mut table = vec![[0f32; TAPS]; PHASES + 1];
    for (p, row) in table.iter_mut().enumerate() {
        let frac = p as f64 / PHASES as f64;
        let mut sum = 0f64;
        let mut vals = [0f64; TAPS];
        for (k, v) in vals.iter_mut().enumerate() {
            // Tap k sits at integer offset k - (TAPS/2 - 1) from the base sample.
            let x = k as f64 - (TAPS as f64 / 2.0 - 1.0) - frac;
            let sinc = if x.abs() < 1e-9 { 1.0 } else { (std::f64::consts::PI * x).sin() / (std::f64::consts::PI * x) };
            let w = 0.5 + 0.5 * (std::f64::consts::PI * x / (TAPS as f64 / 2.0)).cos();
            *v = sinc * w.max(0.0);
            sum += *v;
        }
        for (k, v) in vals.iter().enumerate() {
            row[k] = (*v / sum) as f32;
        }
    }
    table
}

/// Resample the second track onto the master timeline.
///
/// Produces `n_out` samples; output sample `n` is the second file at time `map(n / RATE)`.
/// Positions outside `[valid_start, valid_end)` (seconds on the second file) are silent.
/// `sink` receives consecutive blocks.
pub fn warp(
    read: &mut Reader<'_>,
    map: &SyncMap,
    n_out: usize,
    valid_start: f64,
    valid_end: f64,
    mut sink: impl FnMut(&[f32]) -> Result<()>,
) -> Result<()> {
    const BLOCK: usize = 16_000 * 4;
    let table = sinc_table();
    let half = (TAPS / 2) as i64;
    let mut out = Vec::with_capacity(BLOCK);
    let mut n = 0usize;
    while n < n_out {
        let len = BLOCK.min(n_out - n);
        // Input range needed for this block (the map is monotonic within a block except at jumps).
        let p_first = map.map(n as f64 / RATE) * RATE;
        let p_last = map.map((n + len - 1) as f64 / RATE) * RATE;
        let (lo, hi) = if p_first <= p_last { (p_first, p_last) } else { (p_last, p_first) };
        let mut in_start = lo.floor() as i64 - half - 4;
        let mut in_len = (hi.ceil() as i64 - in_start + half + 8).max(0) as usize;
        // A jump inside the block can make the range huge; cap it and fall back to per-sample reads.
        let sane = in_len <= BLOCK * 8;
        if !sane {
            in_start = 0;
            in_len = 0;
        }
        let input = if sane { read(in_start, in_len)? } else { Vec::new() };
        out.clear();
        for i in 0..len {
            let t2 = map.map((n + i) as f64 / RATE);
            if t2 < valid_start || t2 >= valid_end {
                out.push(0.0);
                continue;
            }
            let p = t2 * RATE;
            let base = p.floor();
            let phase = ((p - base) * PHASES as f64).round() as usize;
            let coeffs = &table[phase];
            let first = base as i64 - (half - 1);
            let mut acc = 0f32;
            if sane {
                let off = first - in_start;
                if off >= 0 && (off as usize + TAPS) <= input.len() {
                    let src = &input[off as usize..off as usize + TAPS];
                    for k in 0..TAPS {
                        acc += src[k] * coeffs[k];
                    }
                }
            } else {
                let src = read(first, TAPS)?;
                for k in 0..TAPS {
                    acc += src[k] * coeffs[k];
                }
            }
            out.push(acc);
        }
        sink(&out)?;
        n += len;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Speech-like test signal: noise bursts with irregular timing.
    fn signal(seed: u64, len: usize) -> Vec<f32> {
        let mut x = seed | 1;
        let mut next = move || {
            x ^= x << 13;
            x ^= x >> 7;
            x ^= x << 17;
            ((x >> 11) as f64 / (1u64 << 53) as f64) as f32
        };
        let mut out = Vec::with_capacity(len);
        let mut lp = 0f32;
        while out.len() < len {
            let on = next() > 0.4;
            let dur = (2_000.0 + next() * 14_000.0) as usize;
            let amp = if on { 0.1 + next() * 0.3 } else { 0.001 };
            for _ in 0..dur.min(len - out.len()) {
                // Light low-pass so the spectrum is not perfectly white.
                lp = 0.6 * lp + 0.4 * (next() * 2.0 - 1.0);
                out.push(lp * amp);
            }
        }
        out
    }

    fn reader(data: &[f32]) -> impl FnMut(i64, usize) -> Result<Vec<f32>> + '_ {
        move |start, len| {
            Ok((0..len as i64)
                .map(|i| {
                    let p = start + i;
                    if p >= 0 && (p as usize) < data.len() { data[p as usize] } else { 0.0 }
                })
                .collect())
        }
    }

    /// Linear-interpolating resampler used to simulate a second recorder: output sample n is
    /// `src` at time `offset + rate * n / RATE`.
    fn record(src: &[f32], offset: f64, rate: f64, len: usize, noise_seed: u64) -> Vec<f32> {
        let noise = signal(noise_seed, len);
        (0..len)
            .map(|n| {
                let p = (offset + rate * n as f64 / RATE) * RATE;
                let i = p.floor() as i64;
                let f = (p - i as f64) as f32;
                let get = |k: i64| if k >= 0 && (k as usize) < src.len() { src[k as usize] } else { 0.0 };
                get(i) * (1.0 - f) + get(i + 1) * f + noise[n] * 0.02
            })
            .collect()
    }

    #[test]
    fn gcc_finds_a_window_inside_a_longer_buffer() {
        let src = signal(7, 16_000 * 8);
        let a = &src[32_000..32_000 + 48_000];
        let b = &src[20_000..20_000 + 80_000];
        let (lag, score) = GccPhat::new(b.len()).locate(a, b);
        assert_eq!(lag, 12_000);
        assert!(score > 20.0);
    }

    #[test]
    fn envelope_lag_sign() {
        let src = signal(3, 16_000 * 60);
        let mut r1 = reader(&src);
        let e1 = onset_envelope(&mut r1, 0, src.len()).unwrap();
        // Second recording starts 2.5 s later: its sample i is src[i + 40000].
        let shifted = &src[40_000..];
        let mut r2 = reader(shifted);
        let e2 = onset_envelope(&mut r2, 0, shifted.len()).unwrap();
        let (lag, score) = envelope_lag(&e1, &e2);
        // e1[i] ≈ e2[i + lag] with lag = -250 frames.
        assert!((lag + 250).abs() <= 1, "lag {lag}");
        assert!(score > 8.0);
    }

    #[test]
    fn recovers_offset_and_drift() {
        // Ten minutes; recorder 2 started 3.2 s after recorder 1 and runs 80 ppm fast.
        let len = 16_000 * 600;
        let src = signal(11, len + 16_000 * 10);
        let rec1: Vec<f32> = src[..len].to_vec();
        // rec2 sample n = src at time 3.2 + (1 + 80e-6) * n / RATE
        let rec2 = record(&src, 3.2, 1.0 + 80e-6, len - 16_000 * 5, 99);

        let mut r1 = reader(&rec1);
        let mut r2 = reader(&rec2);
        let mut t1 = Track { read: &mut r1, start: 0.0, end: rec1.len() as f64 / RATE };
        let mut t2 = Track { read: &mut r2, start: 0.0, end: rec2.len() as f64 / RATE };
        let (map, report) = estimate(&mut t1, &mut t2, |_| {}).unwrap();
        // Master time t (in rec1 = src time t) is rec2 time (t - 3.2) / (1 + 80e-6).
        let expect = |t: f64| (t - 3.2) / (1.0 + 80e-6);
        for t in [10.0, 300.0, 590.0] {
            let err = (map.map(t) - expect(t)).abs();
            assert!(err < 0.002, "t={t} err={err} report={report:?}");
        }
        assert!((report.drift_ppm + 80.0).abs() < 15.0, "{report:?}");
        assert_eq!(report.jumps, 0);
    }

    #[test]
    fn detects_a_jump() {
        // Recorder 2 lost 0.75 s of audio at the five-minute mark.
        let len = 16_000 * 600;
        let src = signal(21, len + 16_000 * 10);
        let rec1: Vec<f32> = src[..len].to_vec();
        let mut rec2: Vec<f32> = src[16_000..16_000 * 300].to_vec(); // starts 1 s late
        rec2.extend_from_slice(&src[16_000 * 300 + 12_000..len]);
        let mut r1 = reader(&rec1);
        let mut r2 = reader(&rec2);
        let mut t1 = Track { read: &mut r1, start: 0.0, end: rec1.len() as f64 / RATE };
        let mut t2 = Track { read: &mut r2, start: 0.0, end: rec2.len() as f64 / RATE };
        let (map, report) = estimate(&mut t1, &mut t2, |_| {}).unwrap();
        assert_eq!(report.jumps, 1, "{report:?}");
        assert!((map.map(100.0) - 99.0).abs() < 0.002);
        assert!((map.map(500.0) - (500.0 - 1.0 - 0.75)).abs() < 0.002);
    }

    #[test]
    fn warp_undoes_offset_and_drift() {
        let len = 16_000 * 30;
        let src = signal(5, len + 16_000 * 4);
        let rec2 = record(&src, 1.0, 1.0 + 200e-6, len, 77);
        // Map master t → rec2 time.
        let map = SyncMap { segments: vec![Segment { t0: -FAR, t1: FAR, a: -1.0 / (1.0 + 200e-6), b: 1.0 / (1.0 + 200e-6) }] };
        let mut r2 = reader(&rec2);
        let mut out = Vec::new();
        warp(&mut r2, &map, 16_000 * 20, 0.0, rec2.len() as f64 / RATE, |b| {
            out.extend_from_slice(b);
            Ok(())
        })
        .unwrap();
        // Compare with the source (ignoring the first second, which precedes rec2).
        let (mut num, mut den) = (0f64, 0f64);
        for n in 32_000..16_000 * 20 {
            let d = (out[n] - src[n]) as f64;
            num += d * d;
            den += (src[n] as f64).powi(2);
        }
        // Residual is the added noise plus interpolation error: well below the signal.
        assert!(num / den < 0.05, "relative error {}", num / den);
    }
}
