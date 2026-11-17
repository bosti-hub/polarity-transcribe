//! Packs speech spans into recognition chunks.
//!
//! Whisper's encoder always processes a 30-second window, so cost is per chunk, not per second.
//! We therefore pack as much speech as possible into each chunk, cut only at pauses, and shorten
//! long silences (they add nothing and invite hallucinations). Each chunk keeps a piece map so
//! word times can be translated back to the track timeline exactly.

use crate::vad::{Span, VAD_FRAME_SEC};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct Piece {
    /// Source range on the track timeline (seconds).
    pub src: Span,
    /// Offset of this piece inside the chunk audio (seconds).
    pub at: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Chunk {
    pub pieces: Vec<Piece>,
}

impl Chunk {
    pub fn duration(&self) -> f64 {
        self.pieces.last().map(|p| p.at + p.src.len()).unwrap_or(0.0)
    }
    pub fn span(&self) -> Span {
        Span::new(
            self.pieces.first().map(|p| p.src.start).unwrap_or(0.0),
            self.pieces.last().map(|p| p.src.end).unwrap_or(0.0),
        )
    }
    /// Translate a time inside the chunk audio to the track timeline.
    pub fn to_source(&self, t: f64) -> f64 {
        let mut last = match self.pieces.first() {
            Some(p) => p,
            None => return t,
        };
        for p in &self.pieces {
            if t < p.at {
                break;
            }
            last = p;
        }
        last.src.start + (t - last.at).clamp(0.0, last.src.len())
    }
    /// Copy this chunk's audio out of a full-track sample buffer.
    pub fn extract(&self, track: &[f32], rate: u32) -> Vec<f32> {
        let mut out = Vec::with_capacity((self.duration() * rate as f64) as usize + 16);
        for p in &self.pieces {
            let a = ((p.src.start * rate as f64).round() as usize).min(track.len());
            let b = ((p.src.end * rate as f64).round() as usize).min(track.len());
            out.extend_from_slice(&track[a..b]);
        }
        out
    }
}

#[derive(Debug, Clone)]
pub struct ChunkOpts {
    /// Maximum chunk audio length in seconds (Whisper's window is 30 s).
    pub max_len: f64,
    /// Silence kept before the first and after the last word of a chunk.
    pub edge_pad: f64,
    /// Longest silence kept inside a chunk; longer ones are shortened to this.
    pub max_gap: f64,
    /// When a chunk is full, prefer cutting at the longest pause after this much audio.
    pub min_fill: f64,
}

impl Default for ChunkOpts {
    fn default() -> Self {
        Self { max_len: 28.0, edge_pad: 0.20, max_gap: 0.8, min_fill: 14.0 }
    }
}

/// Split spans that are too long for one chunk at their weakest speech frames.
fn split_long(spans: &[Span], probs: Option<&[f32]>, limit: f64) -> Vec<Span> {
    let mut out = Vec::with_capacity(spans.len());
    for &s in spans {
        let mut cur = s;
        while cur.len() > limit {
            // Look for the lowest speech probability in the last 40% of the allowed window.
            let lo = cur.start + limit * 0.6;
            let hi = cur.start + limit;
            let cut = match probs {
                Some(p) => {
                    let a = (lo / VAD_FRAME_SEC) as usize;
                    let b = ((hi / VAD_FRAME_SEC) as usize).min(p.len());
                    (a..b)
                        .min_by(|&i, &j| p[i].total_cmp(&p[j]))
                        .map(|i| (i as f64 + 0.5) * VAD_FRAME_SEC)
                        .unwrap_or(hi)
                }
                None => hi,
            };
            out.push(Span::new(cur.start, cut));
            cur = Span::new(cut, cur.end);
        }
        out.push(cur);
    }
    out
}

/// Plan chunks for one track.
///
/// `speech` must be sorted and non-overlapping. `probs` (VAD frame probabilities) are optional
/// and only used to find good cut points inside very long uninterrupted speech.
pub fn plan(speech: &[Span], total_len: f64, probs: Option<&[f32]>, opts: &ChunkOpts) -> Vec<Chunk> {
    let half_gap = opts.max_gap / 2.0;
    let spans = split_long(speech, probs, opts.max_len - 2.0 * opts.edge_pad - 0.5);

    // Chunk-audio length contributed by span i when it follows span i-1 in the same chunk.
    let gap_before = |i: usize| -> f64 { (spans[i].start - spans[i - 1].end).max(0.0) };
    let kept_gap = |i: usize| -> f64 { gap_before(i).min(opts.max_gap) };

    let mut groups: Vec<(usize, usize)> = Vec::new(); // [first, last] inclusive
    let mut first = 0usize;
    while first < spans.len() {
        let mut len = spans[first].len() + 2.0 * opts.edge_pad;
        let mut last = first;
        while last + 1 < spans.len() {
            let add = kept_gap(last + 1) + spans[last + 1].len();
            if len + add > opts.max_len {
                break;
            }
            len += add;
            last += 1;
        }
        // If we stopped because the chunk is full, back up to the longest pause in the tail.
        if last + 1 < spans.len() {
            let mut acc = spans[first].len() + 2.0 * opts.edge_pad;
            let mut best: Option<(usize, f64)> = None;
            for j in first + 1..=last + 1 {
                // Candidate cut between j-1 and j.
                if acc >= opts.min_fill {
                    let g = gap_before(j);
                    if best.map_or(true, |(_, bg)| g > bg) {
                        best = Some((j, g));
                    }
                }
                if j <= last {
                    acc += kept_gap(j) + spans[j].len();
                }
            }
            if let Some((j, _)) = best {
                last = j - 1;
            }
        }
        groups.push((first, last));
        first = last + 1;
    }

    groups
        .into_iter()
        .map(|(a, b)| {
            let mut pieces: Vec<Piece> = Vec::new();
            let mut at = 0.0;
            let mut cur_start = (spans[a].start - opts.edge_pad).max(0.0);
            for i in a..=b {
                let is_last = i == b;
                let next_gap = if is_last { f64::INFINITY } else { gap_before(i + 1) };
                if !is_last && next_gap <= opts.max_gap {
                    continue; // audio runs straight through this pause
                }
                let pad = if is_last { opts.edge_pad } else { half_gap };
                let end = (spans[i].end + pad).min(total_len);
                let src = Span::new(cur_start, end.max(cur_start));
                pieces.push(Piece { src, at });
                at += src.len();
                if !is_last {
                    cur_start = (spans[i + 1].start - half_gap).max(end);
                }
            }
            Chunk { pieces }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn s(a: f64, b: f64) -> Span {
        Span::new(a, b)
    }

    #[test]
    fn short_speech_becomes_one_chunk_with_padding() {
        let c = plan(&[s(1.0, 3.0)], 10.0, None, &ChunkOpts::default());
        assert_eq!(c.len(), 1);
        assert_eq!(c[0].pieces.len(), 1);
        assert!((c[0].pieces[0].src.start - 0.8).abs() < 1e-9);
        assert!((c[0].pieces[0].src.end - 3.2).abs() < 1e-9);
    }

    #[test]
    fn long_silences_are_shortened_and_times_map_back() {
        let c = plan(&[s(1.0, 3.0), s(10.0, 12.0)], 20.0, None, &ChunkOpts::default());
        assert_eq!(c.len(), 1);
        let ch = &c[0];
        assert_eq!(ch.pieces.len(), 2);
        // 0.2 pad + 2 s + 0.4 | 0.4 + 2 s + 0.2 pad
        assert!((ch.duration() - 5.2).abs() < 1e-9);
        assert!((ch.to_source(0.2) - 1.0).abs() < 1e-9);
        // 0.4 s into the second piece is where the second span starts.
        assert!((ch.to_source(2.6 + 0.4) - 10.0).abs() < 1e-9);
    }

    #[test]
    fn chunks_never_exceed_the_window() {
        let mut spans = Vec::new();
        let mut t = 0.0;
        for i in 0..200 {
            let len = 0.5 + (i % 7) as f64 * 0.9;
            spans.push(s(t, t + len));
            t += len + 0.3 + (i % 5) as f64 * 0.4;
        }
        let opts = ChunkOpts::default();
        let chunks = plan(&spans, t, None, &opts);
        assert!(chunks.len() > 5);
        for c in &chunks {
            assert!(c.duration() <= opts.max_len + 1e-6, "{}", c.duration());
        }
        // Every span is covered exactly once, in order.
        let covered: f64 = chunks.iter().flat_map(|c| c.pieces.iter()).map(|p| p.src.len()).sum();
        let speech: f64 = spans.iter().map(|s| s.len()).sum();
        assert!(covered >= speech);
    }

    #[test]
    fn uninterrupted_speech_is_split() {
        let chunks = plan(&[s(0.0, 100.0)], 100.0, None, &ChunkOpts::default());
        assert!(chunks.len() >= 4);
        for c in &chunks {
            assert!(c.duration() <= 28.0 + 1e-6);
        }
    }
}
