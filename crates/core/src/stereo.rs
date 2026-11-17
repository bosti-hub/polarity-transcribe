//! Decides what a two-channel recording actually contains.
//!
//! Consumer recorders produce very different "stereo" files:
//! - a mono signal duplicated on both channels,
//! - a main track plus a quieter *safety track* (same audio, lower gain),
//! - a real stereo room recording,
//! - two wireless microphones, one speaker per channel.
//!
//! Only the last one should be split into two speaker tracks.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum StereoKind {
    /// Source had one channel, or both channels are identical.
    Mono,
    /// Same audio at two gain levels.
    SafetyTrack,
    /// One room recorded with a stereo microphone.
    RoomStereo,
    /// One speaker per channel.
    SplitSpeakers,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StereoVerdict {
    pub kind: StereoKind,
    /// 0..1, how clear the decision was.
    pub confidence: f32,
    /// Correlation between the channels at zero lag (1 = identical).
    pub correlation: f32,
    /// Median level of left minus right, in dB, while someone is speaking.
    pub level_diff_db: f32,
    /// Share of active time in which the left / right channel clearly dominates.
    pub left_dominant: f32,
    pub right_dominant: f32,
    /// Share of samples at full scale per channel (clipping).
    pub clipped_left: f32,
    pub clipped_right: f32,
    /// Channel to use when the file is treated as one recording.
    pub mono_channel: crate::ffmpeg::Channel,
}

const FRAME: usize = 320; // 20 ms at 16 kHz

/// Streaming analyser fed with interleaved stereo samples at 16 kHz.
pub struct StereoAnalyzer {
    carry: Vec<f32>,
    // Per-frame energies in dB.
    left_db: Vec<f32>,
    right_db: Vec<f32>,
    sum_ll: f64,
    sum_rr: f64,
    sum_lr: f64,
    sum_dd: f64,
    clip_l: u64,
    clip_r: u64,
    n: u64,
}

impl Default for StereoAnalyzer {
    fn default() -> Self {
        Self::new()
    }
}

impl StereoAnalyzer {
    pub fn new() -> Self {
        Self {
            carry: Vec::new(),
            left_db: Vec::new(),
            right_db: Vec::new(),
            sum_ll: 0.0,
            sum_rr: 0.0,
            sum_lr: 0.0,
            sum_dd: 0.0,
            clip_l: 0,
            clip_r: 0,
            n: 0,
        }
    }

    pub fn push(&mut self, interleaved: &[f32]) {
        self.carry.extend_from_slice(interleaved);
        let frame_len = FRAME * 2;
        let mut pos = 0;
        while pos + frame_len <= self.carry.len() {
            let (mut ll, mut rr) = (0f64, 0f64);
            for s in self.carry[pos..pos + frame_len].chunks_exact(2) {
                let (l, r) = (s[0] as f64, s[1] as f64);
                ll += l * l;
                rr += r * r;
                self.sum_lr += l * r;
                let d = l - r;
                self.sum_dd += d * d;
                if s[0].abs() >= 0.999 {
                    self.clip_l += 1;
                }
                if s[1].abs() >= 0.999 {
                    self.clip_r += 1;
                }
            }
            self.sum_ll += ll;
            self.sum_rr += rr;
            self.n += FRAME as u64;
            self.left_db.push(10.0 * ((ll / FRAME as f64) + 1e-12).log10() as f32);
            self.right_db.push(10.0 * ((rr / FRAME as f64) + 1e-12).log10() as f32);
            pos += frame_len;
        }
        self.carry.drain(..pos);
    }

    pub fn finish(self) -> StereoVerdict {
        use crate::ffmpeg::Channel;
        let n = self.n.max(1) as f64;
        let clipped_left = (self.clip_l as f64 / n) as f32;
        let clipped_right = (self.clip_r as f64 / n) as f32;
        let total = self.sum_ll + self.sum_rr;
        let base = |kind, confidence, mono_channel| StereoVerdict {
            kind,
            confidence,
            correlation: 1.0,
            level_diff_db: 0.0,
            left_dominant: 0.0,
            right_dominant: 0.0,
            clipped_left,
            clipped_right,
            mono_channel,
        };
        if total <= 1e-9 {
            return base(StereoKind::Mono, 1.0, Channel::Mix);
        }
        // Identical channels: the difference signal carries (almost) no energy.
        if self.sum_dd / total < 1e-4 {
            return base(StereoKind::Mono, 1.0, Channel::Left);
        }
        // One channel silent: treat the live one as a mono recording.
        if self.sum_rr / total < 1e-4 {
            return base(StereoKind::Mono, 0.9, Channel::Left);
        }
        if self.sum_ll / total < 1e-4 {
            return base(StereoKind::Mono, 0.9, Channel::Right);
        }

        let correlation = (self.sum_lr / (self.sum_ll.sqrt() * self.sum_rr.sqrt())) as f32;

        // "Active" frames: someone is speaking on at least one channel.
        let mut loud: Vec<f32> =
            self.left_db.iter().zip(&self.right_db).map(|(l, r)| l.max(*r)).collect();
        loud.sort_by(|a, b| a.total_cmp(b));
        // Speech sits within ~30 dB of the loudest passages; anything below is room noise.
        let peak = loud[loud.len() * 95 / 100];
        let gate = (peak - 30.0).max(-65.0);
        let mut diffs: Vec<f32> = self
            .left_db
            .iter()
            .zip(&self.right_db)
            .filter(|(l, r)| l.max(**r) > gate)
            .map(|(l, r)| l - r)
            .collect();
        if diffs.is_empty() {
            let mut v = base(StereoKind::RoomStereo, 0.3, Channel::Mix);
            v.correlation = correlation;
            return v;
        }
        diffs.sort_by(|a, b| a.total_cmp(b));
        let median = diffs[diffs.len() / 2];
        let p10 = diffs[diffs.len() / 10];
        let p90 = diffs[diffs.len() * 9 / 10];
        let spread = p90 - p10;
        let left_dominant = diffs.iter().filter(|d| **d > 6.0).count() as f32 / diffs.len() as f32;
        let right_dominant = diffs.iter().filter(|d| **d < -6.0).count() as f32 / diffs.len() as f32;

        let louder = if median >= 0.0 { Channel::Left } else { Channel::Right };
        let quieter = if median >= 0.0 { Channel::Right } else { Channel::Left };
        let louder_clip = if median >= 0.0 { clipped_left } else { clipped_right };

        let (kind, confidence, mono_channel) = if correlation > 0.9 && spread < 4.0 {
            if median.abs() > 2.0 {
                // Prefer the main track unless it clips noticeably; then the safety track is cleaner.
                let ch = if louder_clip > 0.0005 { quieter } else { louder };
                (StereoKind::SafetyTrack, ((correlation - 0.9) * 10.0).clamp(0.5, 1.0), ch)
            } else {
                (StereoKind::RoomStereo, 0.8, Channel::Mix)
            }
        } else if left_dominant > 0.08 && right_dominant > 0.08 && correlation < 0.6 && spread > 12.0 {
            let balance = left_dominant.min(right_dominant) / 0.25;
            let sep = ((spread - 12.0) / 12.0).clamp(0.0, 1.0);
            (StereoKind::SplitSpeakers, (0.5 + 0.25 * balance.min(1.0) + 0.25 * sep).min(1.0), Channel::Mix)
        } else {
            (StereoKind::RoomStereo, 0.6, Channel::Mix)
        };

        StereoVerdict {
            kind,
            confidence,
            correlation,
            level_diff_db: median,
            left_dominant,
            right_dominant,
            clipped_left,
            clipped_right,
            mono_channel,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ffmpeg::Channel;

    /// Deterministic noise bursts that look like speech activity.
    fn speechy(seed: u64, len: usize, phase: usize) -> Vec<f32> {
        let mut x = seed.wrapping_mul(0x9E3779B97F4A7C15) | 1;
        (0..len)
            .map(|i| {
                x ^= x << 13;
                x ^= x >> 7;
                x ^= x << 17;
                let noise = ((x >> 11) as f64 / (1u64 << 53) as f64) as f32 * 2.0 - 1.0;
                // 1.5 s talking, 1.5 s quiet, with an offset per speaker.
                let on = ((i + phase) / 24_000) % 2 == 0;
                noise * if on { 0.3 } else { 0.002 }
            })
            .collect()
    }

    fn analyse(l: &[f32], r: &[f32]) -> StereoVerdict {
        let mut a = StereoAnalyzer::new();
        let inter: Vec<f32> = l.iter().zip(r).flat_map(|(a, b)| [*a, *b]).collect();
        for block in inter.chunks(8_000) {
            a.push(block);
        }
        a.finish()
    }

    #[test]
    fn duplicated_mono() {
        let s = speechy(1, 160_000, 0);
        assert_eq!(analyse(&s, &s).kind, StereoKind::Mono);
    }

    #[test]
    fn safety_track() {
        let s = speechy(1, 160_000, 0);
        let quiet: Vec<f32> = s.iter().map(|v| v * 0.25).collect();
        let v = analyse(&s, &quiet);
        assert_eq!(v.kind, StereoKind::SafetyTrack);
        assert_eq!(v.mono_channel, Channel::Left);
        assert!((v.level_diff_db - 12.04).abs() < 0.5);
    }

    #[test]
    fn clipped_main_prefers_safety_track() {
        let s: Vec<f32> = speechy(1, 160_000, 0).iter().map(|v| (v * 6.0).clamp(-1.0, 1.0)).collect();
        let quiet: Vec<f32> = speechy(1, 160_000, 0).iter().map(|v| v * 1.5).collect();
        let v = analyse(&s, &quiet);
        assert_eq!(v.kind, StereoKind::SafetyTrack);
        assert_eq!(v.mono_channel, Channel::Right);
    }

    #[test]
    fn two_microphones_with_bleed() {
        let a = speechy(1, 320_000, 0);
        let b = speechy(2, 320_000, 24_000);
        let l: Vec<f32> = a.iter().zip(&b).map(|(a, b)| a + 0.15 * b).collect();
        let r: Vec<f32> = a.iter().zip(&b).map(|(a, b)| b + 0.15 * a).collect();
        let v = analyse(&l, &r);
        assert_eq!(v.kind, StereoKind::SplitSpeakers, "{v:?}");
    }

    #[test]
    fn room_stereo() {
        let a = speechy(1, 320_000, 0);
        let b = speechy(2, 320_000, 24_000);
        // Both speakers reach both capsules at similar level.
        let l: Vec<f32> = a.iter().zip(&b).map(|(a, b)| a + 0.8 * b).collect();
        let r: Vec<f32> = a.iter().zip(&b).map(|(a, b)| 0.8 * a + b).collect();
        let v = analyse(&l, &r);
        assert_eq!(v.kind, StereoKind::RoomStereo, "{v:?}");
    }
}
