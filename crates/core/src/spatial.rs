//! Speaker attribution from the *direction* of the sound.
//!
//! Two microphones that sit some distance apart (a stereo pair, two phones side by side) hear
//! every speaker at almost the same level, so level cannot tell the speakers apart. But sound
//! from each seat reaches one microphone a fraction of a millisecond before the other, and
//! that delay is constant per seat. We measure the delay per 32 ms frame with GCC-PHAT, find
//! the characteristic delays in the recording, and label each speech frame with the speaker
//! whose delay fits best.
//!
//! In a long recording the seating can change: a new conversation with someone else on the
//! other chair, a phone that gets moved. The delays are therefore followed section by section
//! (three minutes at a time) instead of being fixed for the whole file.

use crate::vad::{Span, VAD_FRAME_SEC, VAD_HOP};
use anyhow::Result;
use rustfft::{num_complex::Complex32, FftPlanner};
use serde::{Deserialize, Serialize};

const RATE: f32 = 16_000.0;
const WINDOW: usize = 1024;
/// Zero-padding factor of the correlation (sub-sample delay resolution).
const UP: usize = 4;
/// Largest delay searched, in samples (2.5 ms ≈ 85 cm of path difference).
const MAX_LAG: usize = 40;
const BINS: usize = 2 * MAX_LAG * UP + 1;
/// Length of a section in frames (three minutes): the stretch over which the seats are assumed
/// to stay where they are.
const SECTION_FRAMES: usize = 5_625;
/// A section needs this many clearly directional frames (about five seconds) to have a say.
const MIN_SECTION_FRAMES: f32 = 150.0;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DelayReport {
    /// Characteristic delay per speaker in milliseconds.
    pub delays_ms: Vec<f32>,
    /// Smallest distance between two speakers' delays in milliseconds.
    pub separation_ms: f32,
    pub separable: bool,
    pub speaker_sec: Vec<f64>,
    /// How often the seating changed during the recording. After a change the speaker numbers
    /// may belong to different people.
    #[serde(default)]
    pub seating_changes: usize,
}

/// Computes band-limited GCC-PHAT correlations frame by frame.
struct DelayAnalyzer {
    window: Vec<f32>,
    fft: std::sync::Arc<dyn rustfft::Fft<f32>>,
    ifft: std::sync::Arc<dyn rustfft::Fft<f32>>,
    a: Vec<Complex32>,
    b: Vec<Complex32>,
    up: Vec<Complex32>,
}

impl DelayAnalyzer {
    fn new() -> Self {
        let mut planner = FftPlanner::<f32>::new();
        Self {
            window: (0..WINDOW)
                .map(|i| 0.5 - 0.5 * (2.0 * std::f32::consts::PI * i as f32 / WINDOW as f32).cos())
                .collect(),
            fft: planner.plan_fft_forward(WINDOW),
            ifft: planner.plan_fft_inverse(WINDOW * UP),
            a: vec![Complex32::default(); WINDOW],
            b: vec![Complex32::default(); WINDOW],
            up: vec![Complex32::default(); WINDOW * UP],
        }
    }

    /// Correlation over delays `-MAX_LAG..=MAX_LAG` in steps of `1/UP` sample.
    /// Index `i` is delay `(i - MAX_LAG*UP) / UP`: positive when `y` lags `x`.
    fn correlate(&mut self, x: &[f32], y: &[f32], out: &mut [f32; BINS]) {
        for i in 0..WINDOW {
            self.a[i] = Complex32::new(x[i] * self.window[i], 0.0);
            self.b[i] = Complex32::new(y[i] * self.window[i], 0.0);
        }
        self.fft.process(&mut self.a);
        self.fft.process(&mut self.b);
        self.up.fill(Complex32::default());
        let lo = (300.0 / RATE * WINDOW as f32) as usize;
        let hi = (3_800.0 / RATE * WINDOW as f32) as usize;
        let n_up = WINDOW * UP;
        for k in lo..=hi {
            let r = self.a[k].conj() * self.b[k];
            let mag = r.norm();
            if mag > 1e-12 {
                let v = r / mag;
                self.up[k] = v;
                self.up[n_up - k] = v.conj();
            }
        }
        self.ifft.process(&mut self.up);
        let centre = MAX_LAG * UP;
        // A single clean delay would give exactly 1.0 at its lag.
        let norm = 1.0 / (2 * (hi - lo + 1)) as f32;
        for (i, o) in out.iter_mut().enumerate() {
            let lag = i as isize - centre as isize;
            let idx = if lag >= 0 { lag as usize } else { (n_up as isize + lag) as usize };
            *o = self.up[idx].re * norm;
        }
    }
}

fn for_each_frame(
    read1: &mut dyn FnMut(u64, usize) -> Result<Vec<f32>>,
    read2: &mut dyn FnMut(u64, usize) -> Result<Vec<f32>>,
    n_samples: usize,
    mut f: impl FnMut(usize, &[f32; BINS]),
) -> Result<()> {
    const BLOCK_FRAMES: usize = 2_000;
    let n_frames = n_samples.div_ceil(VAD_HOP);
    let mut analyzer = DelayAnalyzer::new();
    let mut corr = [0f32; BINS];
    let mut frame = 0usize;
    while frame < n_frames {
        let frames = BLOCK_FRAMES.min(n_frames - frame);
        let start = frame * VAD_HOP;
        let len = frames * VAD_HOP + (WINDOW - VAD_HOP);
        let x = read1(start as u64, len)?;
        let y = read2(start as u64, len)?;
        for i in 0..frames {
            let o = i * VAD_HOP;
            analyzer.correlate(&x[o..o + WINDOW], &y[o..o + WINDOW], &mut corr);
            f(frame + i, &corr);
        }
        frame += frames;
    }
    Ok(())
}

/// Histogram smoothed over five bins.
fn smoothed(hist: &[f32]) -> Vec<f32> {
    (0..BINS)
        .map(|i| {
            let lo = i.saturating_sub(2);
            let hi = (i + 2).min(BINS - 1);
            hist[lo..=hi].iter().sum::<f32>()
        })
        .collect()
}

/// Share of the directional frames that lie within one sample of delay bin `c`.
fn share(hist: &[f32], c: usize) -> f32 {
    let total: f32 = hist.iter().sum();
    if total <= 0.0 {
        return 0.0;
    }
    let lo = c.saturating_sub(UP);
    let hi = (c + UP).min(BINS - 1);
    hist[lo..=hi].iter().sum::<f32>() / total
}

/// The up to `k` strongest delays in a histogram, each at least two samples from the others and
/// each accounting for at least `min_share` of the frames.
fn pick_peaks(hist: &[f32], k: usize, min_share: f32) -> Vec<usize> {
    let smooth = smoothed(hist);
    let mut peaks: Vec<(usize, f32)> = (1..BINS - 1)
        .filter(|&i| smooth[i] >= smooth[i - 1] && smooth[i] > smooth[i + 1] && smooth[i] > 0.0)
        .map(|i| (i, smooth[i]))
        .collect();
    peaks.sort_by(|a, b| b.1.total_cmp(&a.1));
    let mut chosen: Vec<usize> = Vec::new();
    for (bin, _) in peaks {
        if chosen.len() == k {
            break;
        }
        // Keep clear of the flanks of an already chosen peak (two samples either side).
        if chosen.iter().all(|&c| (c as isize - bin as isize).unsigned_abs() >= 2 * UP) {
            chosen.push(bin);
        }
    }
    chosen.retain(|&c| share(hist, c) >= min_share);
    chosen
}

/// Order newly found seats so that each speaker keeps the seat closest to their old one.
fn match_seats(found: &[usize], old: &[usize]) -> Vec<usize> {
    fn search(found: &[usize], old: &[usize], used: &mut Vec<bool>, pick: &mut Vec<usize>, best: &mut (usize, Vec<usize>), cost: usize) {
        if pick.len() == old.len() {
            if cost < best.0 {
                *best = (cost, pick.clone());
            }
            return;
        }
        let s = pick.len();
        for (i, &f) in found.iter().enumerate() {
            if used[i] {
                continue;
            }
            used[i] = true;
            pick.push(f);
            // A seat that moved far has moved; how far does not matter.
            let d = (f as isize - old[s] as isize).unsigned_abs().min(2 * UP);
            search(found, old, used, pick, best, cost + d);
            pick.pop();
            used[i] = false;
        }
    }
    let mut best = (usize::MAX, old.to_vec());
    search(found, old, &mut vec![false; found.len()], &mut Vec::new(), &mut best, 0);
    best.1
}

/// The delay of every speaker's seat in each section, and how often the seating changed.
///
/// The seats are kept as long as everybody is still heard from where they sat (following slow
/// drift). They are replaced only when someone's seat has fallen silent *and* the section shows
/// a full set of clear new directions; a section in which one person does all the talking
/// changes nothing.
fn track_seating(local: &[Vec<f32>], global: &[usize]) -> (Vec<Vec<usize>>, usize) {
    let n_sp = global.len();
    let mut out: Vec<Option<Vec<usize>>> = Vec::with_capacity(local.len());
    let mut current: Option<Vec<usize>> = None;
    let mut changes = 0usize;
    for hist in local {
        if hist.iter().sum::<f32>() >= MIN_SECTION_FRAMES {
            match current.as_mut() {
                None => {
                    let mut found = pick_peaks(hist, n_sp, 0.10);
                    if found.len() == n_sp {
                        found.sort_unstable();
                        current = Some(found);
                    }
                }
                Some(seats) => {
                    if seats.iter().all(|&c| share(hist, c) >= 0.03) {
                        let smooth = smoothed(hist);
                        for c in seats.iter_mut() {
                            let lo = c.saturating_sub(2);
                            let hi = (*c + 2).min(BINS - 1);
                            *c = (lo..=hi).max_by(|&x, &y| smooth[x].total_cmp(&smooth[y])).unwrap_or(*c);
                        }
                    } else if seats.iter().any(|&c| share(hist, c) < 0.01) {
                        let found = pick_peaks(hist, n_sp, 0.10);
                        if found.len() == n_sp {
                            *seats = match_seats(&found, seats);
                            changes += 1;
                        }
                    }
                }
            }
        }
        out.push(current.clone());
    }
    // Sections before the first clear one use its seats; without any, the whole-file delays.
    let first = out.iter().flatten().next().cloned().unwrap_or_else(|| global.to_vec());
    (out.into_iter().map(|seats| seats.unwrap_or_else(|| first.clone())).collect(), changes)
}

/// Attribute speech to `k` speakers by inter-microphone delay.
///
/// `speech[f]` says whether frame `f` (32 ms grid) contains speech. Returns per-speaker spans,
/// speakers ordered by first appearance.
pub fn attribute_by_delay(
    read1: &mut dyn FnMut(u64, usize) -> Result<Vec<f32>>,
    read2: &mut dyn FnMut(u64, usize) -> Result<Vec<f32>>,
    n_samples: usize,
    speech: &[bool],
    k: usize,
) -> Result<(Vec<Vec<Span>>, DelayReport)> {
    attribute_in_sections(read1, read2, n_samples, speech, k, SECTION_FRAMES)
}

fn attribute_in_sections(
    read1: &mut dyn FnMut(u64, usize) -> Result<Vec<f32>>,
    read2: &mut dyn FnMut(u64, usize) -> Result<Vec<f32>>,
    n_samples: usize,
    speech: &[bool],
    k: usize,
    section: usize,
) -> Result<(Vec<Vec<Span>>, DelayReport)> {
    let k = k.clamp(2, 4);
    let n_frames = n_samples.div_ceil(VAD_HOP).min(speech.len());
    let centre = (MAX_LAG * UP) as isize;
    let n_sections = n_frames.div_ceil(section).max(1);

    // Pass 1: where do the delays cluster, in the whole recording and in each section?
    let mut hist = vec![0f32; BINS];
    let mut local = vec![vec![0f32; BINS]; n_sections];
    let mut confident = 0usize;
    for_each_frame(read1, read2, n_samples, |f, corr| {
        if f >= n_frames || !speech[f] {
            return;
        }
        let (mut best, mut peak, mut sum2) = (0usize, f32::MIN, 0f32);
        for (i, &v) in corr.iter().enumerate() {
            sum2 += v * v;
            if v > peak {
                peak = v;
                best = i;
            }
        }
        let rms = (sum2 / BINS as f32).sqrt().max(1e-9);
        if peak / rms >= 4.0 {
            hist[best] += 1.0;
            local[f / section][best] += 1.0;
            confident += 1;
        }
    })?;

    let not_separable = |spans: Vec<Vec<Span>>| DelayReport {
        delays_ms: Vec::new(),
        separation_ms: 0.0,
        separable: false,
        speaker_sec: spans.iter().map(|s| s.iter().map(|x| x.len()).sum()).collect(),
        seating_changes: 0,
    };
    if confident < 60 {
        return Ok((vec![Vec::new(); k], not_separable(Vec::new())));
    }

    // The seats in the recording as a whole decide whether the speakers can be told apart at all.
    let chosen = pick_peaks(&hist, k, 0.03);
    if chosen.len() < 2 {
        return Ok((vec![Vec::new(); k], not_separable(Vec::new())));
    }
    let (seats, seating_changes) = track_seating(&local, &chosen);
    let centres = seats[0].clone();
    if std::env::var_os("PT_DEBUG_DELAY").is_some() {
        let smooth = smoothed(&hist);
        let top = smooth.iter().copied().fold(0f32, f32::max).max(1.0);
        for (i, v) in smooth.iter().enumerate() {
            if *v > 0.01 * top {
                eprintln!("{:+7.2} {:6.0} {}", (i as isize - centre) as f32 / UP as f32, v, "#".repeat((60.0 * v / top) as usize));
            }
        }
        eprintln!("whole file {chosen:?}, {seating_changes} seating change(s)");
        let mut last: Option<&Vec<usize>> = None;
        for (b, s) in seats.iter().enumerate() {
            if last != Some(s) {
                eprintln!("  from section {b}: {s:?}");
                last = Some(s);
            }
        }
    }

    // Pass 2: score every frame against each speaker's delay in its section.
    let n_sp = centres.len();
    let mut scores = vec![0f32; n_frames * n_sp];
    for_each_frame(read1, read2, n_samples, |f, corr| {
        if f >= n_frames {
            return;
        }
        for (s, &c) in seats[f / section].iter().enumerate() {
            let lo = c.saturating_sub(1);
            let hi = (c + 1).min(BINS - 1);
            scores[f * n_sp + s] = corr[lo..=hi].iter().copied().fold(f32::MIN, f32::max);
        }
    })?;

    let mut label = decode_speakers(&scores, &speech[..n_frames], n_sp, 0.45);
    confirm_short_turns(&mut label, &scores, n_sp);
    let (spans, rank) = spans_in_order(&label, n_sp);

    let to_ms = |bin: usize| (bin as isize - centre) as f32 / UP as f32 / RATE * 1000.0;
    let mut delays_ms = vec![0f32; n_sp];
    for (s, &c) in centres.iter().enumerate() {
        delays_ms[rank[s]] = to_ms(c);
    }
    let mut separation = f32::MAX;
    for i in 0..n_sp {
        for j in i + 1..n_sp {
            separation = separation.min((delays_ms[i] - delays_ms[j]).abs());
        }
    }
    let report = DelayReport {
        speaker_sec: spans.iter().map(|s| s.iter().map(|x| x.len()).sum()).collect(),
        delays_ms,
        separation_ms: separation,
        // Two samples at 16 kHz (0.125 ms, about 4 cm of path difference) is the least we trust.
        separable: separation >= 0.12,
        seating_changes,
    };
    Ok((spans, report))
}

/// Most likely speaker per speech frame (Viterbi).
///
/// `scores[f * n_sp + s]` says how well frame `f` fits speaker `s`. Changing speaker costs
/// `switch_cost`, so a few ambiguous frames inside a sentence do not flip the label while a
/// short answer of a few hundred milliseconds still does. Changes during silence are cheap.
pub(crate) fn decode_speakers(scores: &[f32], speech: &[bool], n_sp: usize, switch_cost: f32) -> Vec<Option<usize>> {
    const SWITCH_IN_SILENCE: f32 = 0.03;
    let n_frames = speech.len().min(scores.len() / n_sp.max(1));
    let mut best_prev = vec![0u8; n_frames * n_sp];
    let mut dp = vec![0f32; n_sp];
    let mut next = vec![0f32; n_sp];
    for f in 0..n_frames {
        let cost = if speech[f] { switch_cost } else { SWITCH_IN_SILENCE };
        let (mut top, mut top_s) = (f32::MIN, 0usize);
        for (s, v) in dp.iter().enumerate() {
            if *v > top {
                top = *v;
                top_s = s;
            }
        }
        for s in 0..n_sp {
            let (from, base) = if dp[s] >= top - cost { (s, dp[s]) } else { (top_s, top - cost) };
            let emit = if speech[f] { scores[f * n_sp + s].max(0.0) } else { 0.0 };
            next[s] = base + emit;
            best_prev[f * n_sp + s] = from as u8;
        }
        // Keep numbers small on long recordings.
        let m = next.iter().copied().fold(f32::MIN, f32::max);
        for (d, n) in dp.iter_mut().zip(&next) {
            *d = n - m;
        }
    }
    let mut label: Vec<Option<usize>> = vec![None; n_frames];
    let mut state = dp.iter().enumerate().max_by(|a, b| a.1.total_cmp(b.1)).map(|(s, _)| s).unwrap_or(0);
    for f in (0..n_frames).rev() {
        if speech[f] {
            label[f] = Some(state);
        }
        state = best_prev[f * n_sp + state] as usize;
    }
    label
}

/// A short stretch given to the listener in the middle of someone's talk (a "ja" in a pause of the
/// speaker) is kept only when the delays clearly point to the listener. Returns how many such
/// stretches were given back to the speaker.
///
/// Such a stretch is a handful of frames of quiet speech, and changing speaker during the
/// silence around it costs almost nothing, so a few noisy frames could otherwise hand the
/// speaker's own "ja" to the other person. The test is a t-statistic of the per-frame score
/// difference against [`SHORT_TURN_T`].
pub(crate) fn confirm_short_turns(label: &mut [Option<usize>], scores: &[f32], n_sp: usize) -> usize {
    /// Longest stretch checked: about 1.3 seconds of speech.
    const MAX_FRAMES: usize = 40;
    /// The surrounding talk must be this close (about 4 seconds) for the stretch to be "inside" it.
    const MAX_GAP: usize = 125;
    let min_t: f32 = std::env::var("PT_SHORT_TURN_T").ok().and_then(|v| v.parse().ok()).unwrap_or(SHORT_TURN_T);
    let debug = std::env::var_os("PT_DEBUG_DELAY").is_some();

    // Runs of one speaker over the labelled (speech) frames.
    let mut runs: Vec<(usize, usize, usize)> = Vec::new(); // (speaker, first, last)
    for (f, l) in label.iter().enumerate() {
        if let Some(s) = *l {
            match runs.last_mut() {
                Some(r) if r.0 == s => r.2 = f,
                _ => runs.push((s, f, f)),
            }
        }
    }
    let mut changed = 0;
    for i in 1..runs.len().saturating_sub(1) {
        let (host, _, prev_last) = runs[i - 1];
        let (sp, first, last) = runs[i];
        let (next_sp, next_first, _) = runs[i + 1];
        if host != next_sp || host == sp || first - prev_last > MAX_GAP || next_first - last > MAX_GAP {
            continue;
        }
        let diff: Vec<f32> =
            (first..=last).filter(|&f| label[f].is_some()).map(|f| scores[f * n_sp + sp] - scores[f * n_sp + host]).collect();
        if diff.len() > MAX_FRAMES {
            continue;
        }
        let n = diff.len() as f32;
        let mean = diff.iter().sum::<f32>() / n;
        let var = diff.iter().map(|d| (d - mean) * (d - mean)).sum::<f32>() / (n - 1.0).max(1.0);
        let t = if n < 3.0 { 0.0 } else { mean / (var.sqrt() / n.sqrt()).max(1e-6) };
        let keep = t >= min_t;
        if debug {
            eprintln!(
                "short-turn {:.2} {:.2} frames {} mean {:.3} t {:.2} {}",
                first as f64 * VAD_FRAME_SEC,
                (last + 1) as f64 * VAD_FRAME_SEC,
                diff.len(),
                mean,
                t,
                if keep { "keep" } else { "merge" }
            );
        }
        if !keep {
            for l in label[first..=last].iter_mut().flatten() {
                *l = host;
            }
            runs[i].0 = host;
            changed += 1;
        }
    }
    changed
}

/// See [`confirm_short_turns`]. Zero: only a stretch whose frames on average favour the speaker
/// who was already talking is given back. A stricter test (t ≥ 2) was tried on the 142-minute
/// test recording: it also removed genuine short answers ("Ja, klopt." with only two clear
/// frames), while the flickers it caught were already repaired by the sentence-level checks in
/// the assembly. Revisit with a hand-corrected reference.
const SHORT_TURN_T: f32 = 0.0;

/// Turn frame labels into spans per speaker, numbering speakers by first appearance.
/// Also returns `rank[original index] = speaker number`.
pub(crate) fn spans_in_order(label: &[Option<usize>], n_sp: usize) -> (Vec<Vec<Span>>, Vec<usize>) {
    let mut order: Vec<usize> = Vec::new();
    for l in label.iter().flatten() {
        if !order.contains(l) {
            order.push(*l);
        }
    }
    for s in 0..n_sp {
        if !order.contains(&s) {
            order.push(s);
        }
    }
    let rank: Vec<usize> = (0..n_sp).map(|s| order.iter().position(|o| *o == s).unwrap()).collect();
    let mut spans: Vec<Vec<Span>> = vec![Vec::new(); n_sp];
    let mut run: Option<(usize, usize)> = None; // (speaker, start frame)
    for f in 0..=label.len() {
        let cur = if f < label.len() { label[f] } else { None };
        match (run, cur) {
            (Some((s, _)), Some(c)) if s == c => {}
            (Some((s, start)), _) => {
                spans[rank[s]].push(Span::new(start as f64 * VAD_FRAME_SEC, f as f64 * VAD_FRAME_SEC));
                run = cur.map(|c| (c, f));
            }
            (None, Some(c)) => run = Some((c, f)),
            (None, None) => {}
        }
    }
    (spans, rank)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn noise(seed: u64, len: usize) -> Vec<f32> {
        let mut x = seed | 1;
        let mut lp = 0f32;
        (0..len)
            .map(|_| {
                x ^= x << 13;
                x ^= x >> 7;
                x ^= x << 17;
                let v = ((x >> 11) as f64 / (1u64 << 53) as f64) as f32 * 2.0 - 1.0;
                lp = 0.5 * lp + 0.5 * v;
                lp * 0.3
            })
            .collect()
    }

    #[test]
    fn two_seats_are_separated_by_delay() {
        // Speaker A reaches both microphones at once; speaker B reaches mic 2 six samples later.
        let seconds = 40;
        let n = 16_000 * seconds;
        let a = noise(1, n + 64);
        let b = noise(2, n + 64);
        let mut m1 = vec![0f32; n];
        let mut m2 = vec![0f32; n];
        let turn = 16_000 * 4;
        for i in 0..n {
            let a_talks = (i / turn) % 2 == 0;
            if a_talks {
                m1[i] = a[i + 8];
                m2[i] = a[i + 8];
            } else {
                m1[i] = b[i + 8];
                m2[i] = b[i + 8 - 6];
            }
        }
        let speech = vec![true; n.div_ceil(VAD_HOP)];
        let mut r1 = |s: u64, len: usize| -> Result<Vec<f32>> {
            Ok((0..len).map(|i| m1.get(s as usize + i).copied().unwrap_or(0.0)).collect())
        };
        let mut r2 = |s: u64, len: usize| -> Result<Vec<f32>> {
            Ok((0..len).map(|i| m2.get(s as usize + i).copied().unwrap_or(0.0)).collect())
        };
        let (spans, report) = attribute_by_delay(&mut r1, &mut r2, n, &speech, 2).unwrap();
        assert!(report.separable, "{report:?}");
        assert!((report.separation_ms - 6.0 / 16.0).abs() < 0.05, "{report:?}");
        let half = seconds as f64 / 2.0;
        for s in &report.speaker_sec {
            assert!((s - half).abs() < 1.5, "{report:?}");
        }
        // Speaker A talks first, so they are speaker 1 and own the first four seconds.
        assert!(spans[0][0].start < 0.1 && (spans[0][0].end - 4.0).abs() < 0.3, "{:?}", spans[0][0]);
    }

    #[test]
    fn a_change_of_seats_is_followed() {
        // First half: A (no delay) and B (six samples late on mic 2).
        // Second half: A stays, and C sits on the other side (seven samples early on mic 2).
        let seconds = 160;
        let n = 16_000 * seconds;
        let a = noise(1, n + 64);
        let b = noise(2, n + 64);
        let c = noise(5, n + 64);
        let mut m1 = vec![0f32; n];
        let mut m2 = vec![0f32; n];
        let turn = 16_000 * 4;
        for i in 0..n {
            let a_talks = (i / turn) % 2 == 0;
            let first_half = i < n / 2;
            if a_talks {
                m1[i] = a[i + 8];
                m2[i] = a[i + 8];
            } else if first_half {
                m1[i] = b[i + 8];
                m2[i] = b[i + 8 - 6];
            } else {
                m1[i] = c[i + 8];
                m2[i] = c[i + 8 + 7];
            }
        }
        let speech = vec![true; n.div_ceil(VAD_HOP)];
        let mut r1 = |s: u64, len: usize| -> Result<Vec<f32>> {
            Ok((0..len).map(|i| m1.get(s as usize + i).copied().unwrap_or(0.0)).collect())
        };
        let mut r2 = |s: u64, len: usize| -> Result<Vec<f32>> {
            Ok((0..len).map(|i| m2.get(s as usize + i).copied().unwrap_or(0.0)).collect())
        };
        // Sections of 20 seconds, so the change at 80 s falls on a section boundary.
        let (spans, report) = attribute_in_sections(&mut r1, &mut r2, n, &speech, 2, 625).unwrap();
        assert_eq!(report.seating_changes, 1, "{report:?}");
        // A keeps their number across the change, and both halves are split evenly.
        let half = seconds as f64 / 2.0;
        for s in &report.speaker_sec {
            assert!((s - half).abs() < 3.0, "{report:?}");
        }
        let a_spans = &spans[0];
        assert!(a_spans.iter().any(|x| x.start < 1.0), "{a_spans:?}");
        assert!(a_spans.iter().any(|x| (x.start - 152.0).abs() < 0.5), "{a_spans:?}");
    }

    #[test]
    fn a_short_turn_needs_consistent_evidence() {
        // Speaker 0 talks, pauses, a short stretch labelled speaker 1, then speaker 0 again.
        let build = |island: &dyn Fn(usize) -> (f32, f32)| {
            let mut label = Vec::new();
            let mut scores = Vec::new();
            for f in 0..100 {
                let (l, s) = match f {
                    0..=39 | 60..=99 => (Some(0), (0.5, 0.1)),
                    45..=54 => (Some(1), island(f)),
                    _ => (None, (0.0, 0.0)),
                };
                label.push(l);
                scores.extend([s.0, s.1]);
            }
            (label, scores)
        };
        // Noisy frames that on balance fit the speaker who was talking: the stretch goes back.
        let (mut label, scores) = build(&|f| if f % 2 == 0 { (0.1, 0.4) } else { (0.45, 0.1) });
        assert_eq!(confirm_short_turns(&mut label, &scores, 2), 1);
        assert!(label[45..55].iter().all(|l| *l == Some(0)));
        // Every frame clearly favours speaker 1: a real "ja" from the listener stays.
        let (mut label, scores) = build(&|f| (0.1, 0.45 + 0.02 * (f % 3) as f32));
        assert_eq!(confirm_short_turns(&mut label, &scores, 2), 0);
        assert!(label[45..55].iter().all(|l| *l == Some(1)));
    }

    #[test]
    fn identical_channels_are_not_separable() {
        let n = 16_000 * 10;
        let a = noise(3, n);
        let speech = vec![true; n.div_ceil(VAD_HOP)];
        let mut r1 = |s: u64, len: usize| -> Result<Vec<f32>> {
            Ok((0..len).map(|i| a.get(s as usize + i).copied().unwrap_or(0.0)).collect())
        };
        let a2 = a.clone();
        let mut r2 = |s: u64, len: usize| -> Result<Vec<f32>> {
            Ok((0..len).map(|i| a2.get(s as usize + i).copied().unwrap_or(0.0)).collect())
        };
        let (_, report) = attribute_by_delay(&mut r1, &mut r2, n, &speech, 2).unwrap();
        assert!(!report.separable);
    }
}
