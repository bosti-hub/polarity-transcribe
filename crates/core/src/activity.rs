//! Who is speaking when, from two time-aligned microphones in the same room.
//!
//! Each microphone mostly hears its own speaker but also, more faintly, the other one
//! ("bleed"). We never try to remove bleed from the audio — that damages the speech and hurts
//! recognition. Instead we decide per 32 ms frame which speaker(s) are really talking, and
//! later transcribe each speaker only from their own microphone during their own activity.
//!
//! The decision uses the level ratio between the microphones. When only speaker 1 talks the
//! ratio sits at one characteristic value, when only speaker 2 talks at another; both values
//! are learned from the recording itself, so different phone gains and distances do not matter.
//! A frame whose ratio is clearly away from the "other speaker only" value contains the
//! microphone's own speaker; frames in between contain both (genuine overlap).

use crate::vad::{Span, VAD_FRAME_SEC, VAD_HOP};
use anyhow::Result;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BleedReport {
    /// Level of mic 1 over mic 2 in dB while only speaker 1 / only speaker 2 talks.
    pub ratio_speaker1_db: f32,
    pub ratio_speaker2_db: f32,
    /// Difference between the two; below ~6 dB the microphones cannot tell the speakers apart.
    pub separation_db: f32,
    pub separable: bool,
    /// Seconds of speech attributed to each speaker and to both at once.
    pub speaker1_sec: f64,
    pub speaker2_sec: f64,
    pub overlap_sec: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Activity {
    /// Speech spans per speaker on the master timeline.
    pub spans: [Vec<Span>; 2],
    pub report: BleedReport,
}

/// Per-frame power of a track after a gentle high-pass (removes rumble and handling noise
/// that would otherwise dominate the level comparison).
pub fn frame_power(mut read: impl FnMut(u64, usize) -> Result<Vec<f32>>, total_samples: u64) -> Result<Vec<f32>> {
    const BLOCK: usize = VAD_HOP * 2_000;
    let n_frames = (total_samples as usize).div_ceil(VAD_HOP);
    let mut out = Vec::with_capacity(n_frames);
    let (mut x1, mut y1) = (0f32, 0f32);
    let mut pos = 0u64;
    while pos < total_samples {
        let n = BLOCK.min((total_samples - pos) as usize);
        let block = read(pos, n)?;
        for frame in block.chunks(VAD_HOP) {
            let mut acc = 0f32;
            for &x in frame {
                // One-pole DC blocker with a corner around 130 Hz.
                let y = x - x1 + 0.95 * y1;
                x1 = x;
                y1 = y;
                acc += y * y;
            }
            out.push(acc / frame.len() as f32);
        }
        pos += n as u64;
    }
    Ok(out)
}

/// Centered moving average over `2 * radius + 1` frames.
fn smooth(p: &[f32], radius: usize) -> Vec<f32> {
    let mut prefix = Vec::with_capacity(p.len() + 1);
    let mut acc = 0f64;
    prefix.push(0f64);
    for &v in p {
        acc += v as f64;
        prefix.push(acc);
    }
    (0..p.len())
        .map(|i| {
            let lo = i.saturating_sub(radius);
            let hi = (i + radius + 1).min(p.len());
            ((prefix[hi] - prefix[lo]) / (hi - lo) as f64) as f32
        })
        .collect()
}

fn percentile(values: &mut [f32], q: f64) -> f32 {
    if values.is_empty() {
        return 0.0;
    }
    values.sort_by(|a, b| a.total_cmp(b));
    values[((values.len() - 1) as f64 * q).round() as usize]
}

/// The two characteristic level ratios (dB): where the histogram peaks on either side.
fn ratio_modes(ratios: &[f32]) -> (f32, f32) {
    // 2-means to find the dividing line.
    let mut sorted = ratios.to_vec();
    let mut lo = percentile(&mut sorted, 0.15);
    let mut hi = percentile(&mut sorted, 0.85);
    for _ in 0..25 {
        let mid = (lo + hi) / 2.0;
        let (mut sl, mut nl, mut sh, mut nh) = (0f64, 0usize, 0f64, 0usize);
        for &r in ratios {
            if r < mid {
                sl += r as f64;
                nl += 1;
            } else {
                sh += r as f64;
                nh += 1;
            }
        }
        if nl == 0 || nh == 0 {
            break;
        }
        lo = (sl / nl as f64) as f32;
        hi = (sh / nh as f64) as f32;
    }
    let mid = (lo + hi) / 2.0;
    // Histogram mode on each side: single-speaker frames pile up at the true ratio, while
    // mixed and transitional frames only form a tail towards the middle.
    const MIN: f32 = -60.0;
    const BINS: usize = 120;
    let mut hist = [0f32; BINS];
    for &r in ratios {
        let b = (r - MIN).clamp(0.0, BINS as f32 - 1.0) as usize;
        hist[b] += 1.0;
    }
    let smoothed: Vec<f32> = (0..BINS)
        .map(|i| (i.saturating_sub(2)..=(i + 2).min(BINS - 1)).map(|j| hist[j]).sum::<f32>())
        .collect();
    let mid_bin = ((mid - MIN) as usize).clamp(1, BINS - 2);
    let mode = |range: std::ops::Range<usize>| -> f32 {
        range.max_by(|&a, &b| smoothed[a].total_cmp(&smoothed[b])).map(|b| MIN + b as f32 + 0.5).unwrap_or(mid)
    };
    (mode(0..mid_bin), mode(mid_bin..BINS))
}

fn to_spans(active: &[bool]) -> Vec<Span> {
    // Close short gaps, then drop blips.
    const MAX_GAP: usize = 9; // ~0.3 s
    const MIN_RUN: usize = 3; // ~0.1 s
    let mut runs: Vec<(usize, usize)> = Vec::new();
    let mut start = None;
    for (i, &a) in active.iter().enumerate() {
        match (a, start) {
            (true, None) => start = Some(i),
            (false, Some(s)) => {
                runs.push((s, i));
                start = None;
            }
            _ => {}
        }
    }
    if let Some(s) = start {
        runs.push((s, active.len()));
    }
    let mut merged: Vec<(usize, usize)> = Vec::new();
    for r in runs {
        match merged.last_mut() {
            Some(last) if r.0 - last.1 <= MAX_GAP => last.1 = r.1,
            _ => merged.push(r),
        }
    }
    merged
        .into_iter()
        .filter(|r| r.1 - r.0 >= MIN_RUN)
        .map(|r| Span::new(r.0 as f64 * VAD_FRAME_SEC, r.1 as f64 * VAD_FRAME_SEC))
        .collect()
}

/// Attribute speech to two speakers.
///
/// `power` are per-frame powers of the two aligned tracks ([`frame_power`]), `vad` the speech
/// probabilities of the same tracks. `covered[f]` is false where the second track has no audio.
pub fn attribute(power: [&[f32]; 2], vad: [&[f32]; 2], covered: &[bool]) -> Activity {
    let n = power[0].len().min(power[1].len()).min(vad[0].len()).min(vad[1].len());
    let p1 = smooth(&power[0][..n], 2);
    let p2 = smooth(&power[1][..n], 2);
    let is_covered = |f: usize| covered.get(f).copied().unwrap_or(true);

    // Noise floors from the quietest frames.
    let floor = |p: &[f32]| -> f32 {
        let mut v: Vec<f32> = p.iter().enumerate().filter(|(f, _)| is_covered(*f)).map(|(_, v)| *v).collect();
        percentile(&mut v, 0.10).max(1e-10)
    };
    let (nf1, nf2) = (floor(&p1), floor(&p2));
    let q = |p: f32, nf: f32| (p - nf).max(nf * 0.05);

    // Level ratios where someone clearly speaks.
    let mut ratios = Vec::new();
    for f in 0..n {
        if !is_covered(f) || vad[0][f].max(vad[1][f]) < 0.5 {
            continue;
        }
        if p1[f] < nf1 * 6.0 && p2[f] < nf2 * 6.0 {
            continue;
        }
        ratios.push(10.0 * (q(p1[f], nf1) / q(p2[f], nf2)).log10());
    }
    let (c_lo, c_hi) = if ratios.len() >= 50 { ratio_modes(&ratios) } else { (0.0, 0.0) };
    let separation = c_hi - c_lo;
    let separable = separation >= 6.0;

    // A speaker is talking when their microphone is clearly louder than the other speaker's
    // bleed alone would make it.
    let margin = (separation / 3.0).clamp(2.0, 6.0);
    let mut a1 = vec![false; n];
    let mut a2 = vec![false; n];
    for f in 0..n {
        if !is_covered(f) {
            // Only one recording here: everything audible goes to track 1 for now.
            a1[f] = vad[0][f] >= 0.5;
            continue;
        }
        let speech1 = vad[0][f] >= 0.4 && p1[f] > nf1 * 4.0;
        let speech2 = vad[1][f] >= 0.4 && p2[f] > nf2 * 4.0;
        if !speech1 && !speech2 {
            continue;
        }
        let r = 10.0 * (q(p1[f], nf1) / q(p2[f], nf2)).log10();
        if separable {
            a1[f] = speech1 && r > c_lo + margin;
            a2[f] = speech2 && r < c_hi - margin;
        } else {
            // Not separable: fall back to "louder microphone wins".
            a1[f] = speech1 && r >= 0.0;
            a2[f] = speech2 && r < 0.0;
        }
    }
    let spans = [to_spans(&a1), to_spans(&a2)];

    let total = |s: &[Span]| s.iter().map(|x| x.len()).sum::<f64>();
    let overlap = overlap_seconds(&spans[0], &spans[1]);
    let report = BleedReport {
        ratio_speaker1_db: c_hi,
        ratio_speaker2_db: c_lo,
        separation_db: separation,
        separable,
        speaker1_sec: total(&spans[0]),
        speaker2_sec: total(&spans[1]),
        overlap_sec: overlap,
    };
    Activity { spans, report }
}

/// The level ratio between the two microphones over time, kept after the speaker detection to
/// tell, for a stretch of a few tenths of a second, whose voice was really sounding.
pub struct Levels {
    ratio_db: Vec<f32>,
    /// How far the louder microphone is above its noise floor (0 in silence).
    weight: Vec<f32>,
    speaker1_db: f32,
    speaker2_db: f32,
}

impl Levels {
    /// `power` as for [`attribute`]; `report` is what [`attribute`] learned from the recording.
    pub fn new(power: [&[f32]; 2], report: &BleedReport) -> Self {
        let n = power[0].len().min(power[1].len());
        let p1 = smooth(&power[0][..n], 2);
        let p2 = smooth(&power[1][..n], 2);
        let floor = |p: &[f32]| percentile(&mut p.to_vec(), 0.10).max(1e-10);
        let (nf1, nf2) = (floor(&p1), floor(&p2));
        let q = |p: f32, nf: f32| (p - nf).max(nf * 0.05);
        let ratio_db = (0..n).map(|f| 10.0 * (q(p1[f], nf1) / q(p2[f], nf2)).log10()).collect();
        let weight = (0..n).map(|f| (p1[f] / nf1).max(p2[f] / nf2) - 1.0).map(|w| w.max(0.0)).collect();
        Levels { ratio_db, weight, speaker1_db: report.ratio_speaker1_db, speaker2_db: report.ratio_speaker2_db }
    }

    /// How far apart the two microphones are on their own speaker (dB). Below about 10 dB each
    /// microphone hears the other speaker nearly as well, and [`Levels::owner`] says little.
    pub fn separation(&self) -> f32 {
        self.speaker1_db - self.speaker2_db
    }

    /// The speaker (0 or 1) whose voice the microphones show during `[start, end)`, or `None`
    /// when both are sounding, nothing is, or the microphones cannot tell the two apart.
    pub fn owner(&self, start: f64, end: f64) -> Option<usize> {
        let separation = self.speaker1_db - self.speaker2_db;
        if separation < 6.0 {
            return None;
        }
        let a = ((start.max(0.0) / VAD_FRAME_SEC) as usize).min(self.ratio_db.len());
        let b = ((end.max(start + 0.08) / VAD_FRAME_SEC).ceil() as usize).clamp(a, self.ratio_db.len());
        let (mut sum, mut total) = (0f64, 0f64);
        for f in a..b {
            sum += self.ratio_db[f] as f64 * self.weight[f] as f64;
            total += self.weight[f] as f64;
        }
        if total <= 0.0 {
            return None;
        }
        let r = (sum / total) as f32;
        let margin = separation / 3.0;
        if r >= self.speaker1_db - margin {
            Some(0)
        } else if r <= self.speaker2_db + margin {
            Some(1)
        } else {
            None
        }
    }
}

pub fn overlap_seconds(a: &[Span], b: &[Span]) -> f64 {
    let (mut i, mut j, mut acc) = (0, 0, 0.0);
    while i < a.len() && j < b.len() {
        let lo = a[i].start.max(b[j].start);
        let hi = a[i].end.min(b[j].end);
        if hi > lo {
            acc += hi - lo;
        }
        if a[i].end < b[j].end {
            i += 1;
        } else {
            j += 1;
        }
    }
    acc
}

/// Seconds of `[start, end)` covered by `spans` (sorted, non-overlapping).
pub fn covered_seconds(spans: &[Span], start: f64, end: f64) -> f64 {
    let first = spans.partition_point(|s| s.end <= start);
    spans[first..]
        .iter()
        .take_while(|s| s.start < end)
        .map(|s| (s.end.min(end) - s.start.max(start)).max(0.0))
        .sum()
}

/// Gain envelope for one chunk piece: full level while the speaker talks, strongly reduced
/// elsewhere, with short ramps. Keeps the speaker's own words untouched while making sure the
/// recogniser does not pick up the other person's bleed in the gaps.
pub fn duck_outside(samples: &mut [f32], piece_start: f64, own: &[Span], rate: u32) {
    const GUARD: f64 = 0.12;
    const FLOOR: f32 = 0.08; // about -22 dB
    let ramp = (rate as f64 * 0.025) as usize;
    let n = samples.len();
    let piece_end = piece_start + n as f64 / rate as f64;
    let mut gain = vec![FLOOR; n];
    let first = own.partition_point(|s| s.end + GUARD <= piece_start);
    for s in own[first..].iter().take_while(|s| s.start - GUARD < piece_end) {
        let a = (((s.start - GUARD - piece_start) * rate as f64).round().max(0.0) as usize).min(n);
        let b = (((s.end + GUARD - piece_start) * rate as f64).round().max(0.0) as usize).min(n);
        for g in &mut gain[a..b] {
            *g = 1.0;
        }
    }
    // Smooth the steps with a short linear ramp (forward then backward slew limit).
    let step = (1.0 - FLOOR) / ramp.max(1) as f32;
    for i in 1..n {
        if gain[i] > gain[i - 1] + step {
            gain[i] = gain[i - 1] + step;
        }
    }
    for i in (0..n.saturating_sub(1)).rev() {
        if gain[i] > gain[i + 1] + step {
            gain[i] = gain[i + 1] + step;
        }
    }
    for (s, g) in samples.iter_mut().zip(&gain) {
        *s *= g;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Build frame powers for a scripted conversation.
    /// `script`: (frames, speaker1 talking, speaker2 talking).
    fn simulate(script: &[(usize, bool, bool)], bleed12: f32, bleed21: f32) -> (Vec<f32>, Vec<f32>, Vec<f32>, Vec<f32>) {
        let (mut p1, mut p2, mut v1, mut v2) = (vec![], vec![], vec![], vec![]);
        let mut x = 12345u64;
        let mut jitter = move || {
            x ^= x << 13;
            x ^= x >> 7;
            x ^= x << 17;
            0.6 + 0.8 * ((x >> 11) as f32 / (1u64 << 53) as f32)
        };
        for &(frames, s1, s2) in script {
            for _ in 0..frames {
                let a = if s1 { 0.01 * jitter() } else { 0.0 };
                let b = if s2 { 0.02 * jitter() } else { 0.0 };
                let noise = 1e-6;
                p1.push(a + bleed21 * b * jitter() + noise);
                p2.push(b + bleed12 * a * jitter() + noise);
                let any = if s1 || s2 { 0.95 } else { 0.02 };
                v1.push(any);
                v2.push(any);
            }
        }
        (p1, p2, v1, v2)
    }

    #[test]
    fn separates_alternating_speakers_and_ignores_bleed() {
        let mut script = Vec::new();
        for _ in 0..30 {
            script.push((90, true, false));
            script.push((15, false, false));
            script.push((120, false, true));
            script.push((15, false, false));
        }
        let (p1, p2, v1, v2) = simulate(&script, 0.05, 0.04);
        let covered = vec![true; p1.len()];
        let act = attribute([&p1, &p2], [&v1, &v2], &covered);
        assert!(act.report.separable, "{:?}", act.report);
        let s1 = 30.0 * 90.0 * VAD_FRAME_SEC;
        let s2 = 30.0 * 120.0 * VAD_FRAME_SEC;
        assert!((act.report.speaker1_sec - s1).abs() / s1 < 0.08, "{:?}", act.report);
        assert!((act.report.speaker2_sec - s2).abs() / s2 < 0.08, "{:?}", act.report);
        assert!(act.report.overlap_sec < 0.03 * (s1 + s2), "{:?}", act.report);
    }

    #[test]
    fn keeps_genuine_overlap() {
        let mut script = Vec::new();
        for _ in 0..20 {
            script.push((100, true, false));
            script.push((40, true, true)); // both talk
            script.push((100, false, true));
            script.push((20, false, false));
        }
        let (p1, p2, v1, v2) = simulate(&script, 0.03, 0.03);
        let covered = vec![true; p1.len()];
        let act = attribute([&p1, &p2], [&v1, &v2], &covered);
        let expected = 20.0 * 40.0 * VAD_FRAME_SEC;
        assert!(act.report.overlap_sec > 0.7 * expected, "{:?}", act.report);
        assert!(act.report.overlap_sec < 1.5 * expected, "{:?}", act.report);
    }

    #[test]
    fn levels_tell_whose_voice_a_stretch_is() {
        // 100 frames speaker 1 alone, 100 frames speaker 2 alone, 100 frames silence.
        let script = [(100, true, false), (100, false, true), (100, false, false)];
        let (p1, p2, v1, v2) = simulate(&script, 0.05, 0.04);
        let covered = vec![true; p1.len()];
        let act = attribute([&p1, &p2], [&v1, &v2], &covered);
        let levels = Levels::new([&p1, &p2], &act.report);
        let t = |f: usize| f as f64 * VAD_FRAME_SEC;
        assert_eq!(levels.owner(t(40), t(50)), Some(0));
        assert_eq!(levels.owner(t(140), t(150)), Some(1));
        assert_eq!(levels.owner(t(240), t(250)), None);
    }

    #[test]
    fn ducking_keeps_own_speech_at_full_level() {
        let mut s = vec![1.0f32; 16_000];
        duck_outside(&mut s, 10.0, &[Span::new(10.4, 10.6)], 16_000);
        assert!((s[8_000] - 1.0).abs() < 1e-6); // inside the span
        assert!(s[1_000] < 0.1); // far outside
        assert!(s[15_000] < 0.1);
    }
}
