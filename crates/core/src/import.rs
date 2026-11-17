//! Bringing a recording into a project.
//!
//! One FFmpeg pass produces everything the rest of the app needs:
//! - 16 kHz PCM caches per channel (analysis and recognition),
//! - an AAC preview at the source quality for the trimmer,
//! - waveform peaks,
//! - the stereo verdict.

use crate::ffmpeg::{self, Channel, DecodeOpts, ANALYSIS_RATE};
use crate::fsutil::{pcm_write, write_atomic};
use crate::project::{files, Source};
use crate::stereo::{StereoAnalyzer, StereoKind};
use anyhow::{anyhow, bail, Context, Result};
use std::fs::{self, File};
use std::io::{BufWriter, Write};
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};

/// Samples per waveform peak (20 ms at 16 kHz → 50 peaks per second).
pub const PEAK_BIN: usize = 320;
pub const PEAKS_PER_SECOND: f64 = ANALYSIS_RATE as f64 / PEAK_BIN as f64;

/// Collects one peak per bin as a square-root-companded byte, which keeps quiet speech visible.
struct PeakBuilder {
    out: Vec<u8>,
    max: f32,
    count: usize,
}

impl PeakBuilder {
    fn new() -> Self {
        Self { out: Vec::new(), max: 0.0, count: 0 }
    }
    #[inline]
    fn push(&mut self, v: f32) {
        self.max = self.max.max(v.abs());
        self.count += 1;
        if self.count == PEAK_BIN {
            self.flush();
        }
    }
    fn flush(&mut self) {
        if self.count > 0 {
            self.out.push((self.max.min(1.0).sqrt() * 255.0).round() as u8);
            self.max = 0.0;
            self.count = 0;
        }
    }
}

/// Linear gain that brings the loud passages of a recording to about half of full scale.
///
/// Based on the 99.5th percentile of 20 ms peaks, so a single door slam does not decide the
/// level. Never attenuates, and never amplifies more than 40 dB.
fn level_gain(bin_peaks: &mut [f32]) -> f32 {
    if bin_peaks.is_empty() {
        return 1.0;
    }
    bin_peaks.sort_by(|a, b| a.total_cmp(b));
    let robust = bin_peaks[(bin_peaks.len() as f64 * 0.995) as usize % bin_peaks.len()];
    if robust < 1e-5 {
        return 1.0;
    }
    (0.5 / robust).clamp(1.0, 100.0)
}

/// Import `path` into slot `slot` of the project stored in `dir`.
///
/// `progress` receives 0..1. Setting `cancel` aborts and removes partial files.
pub fn import_source(
    dir: &Path,
    slot: usize,
    path: &Path,
    cancel: &AtomicBool,
    mut progress: impl FnMut(f32),
) -> Result<Source> {
    let probe = ffmpeg::probe(path)?;
    if !probe.has_audio {
        bail!("no audio track found in {}", path.display());
    }
    let total = probe.duration.unwrap_or(0.0);

    // Pass 1: measure the level. Many recorders (especially 32-bit float ones) produce very
    // quiet files; a fixed gain makes the caches, the preview and the waveform usable without
    // changing the balance between channels.
    const PASS1: f32 = 0.3;
    let gain = {
        let mut bin_peaks: Vec<f32> = Vec::new();
        let (mut max, mut count) = (0f32, 0usize);
        let mut frames = 0u64;
        let mut last = -1f32;
        let opts = DecodeOpts {
            sample_rate: ANALYSIS_RATE,
            channels: vec![Channel::Left, Channel::Right],
            start: None,
            duration: None,
        };
        ffmpeg::decode_stream(path, &opts, |block| {
            if cancel.load(Ordering::Relaxed) {
                return false;
            }
            for s in block.chunks_exact(2) {
                max = max.max(s[0].abs()).max(s[1].abs());
                count += 1;
                if count == PEAK_BIN {
                    bin_peaks.push(max);
                    max = 0.0;
                    count = 0;
                }
            }
            frames += (block.len() / 2) as u64;
            if total > 0.0 {
                let f = (frames as f64 / ANALYSIS_RATE as f64 / total).min(1.0) as f32 * PASS1;
                if f - last >= 0.005 {
                    last = f;
                    progress(f);
                }
            }
            true
        })?;
        if cancel.load(Ordering::Relaxed) {
            bail!("cancelled");
        }
        level_gain(&mut bin_peaks)
    };

    let part = |name: String| dir.join(format!("{name}.part"));
    let pcm_l = part(files::pcm(slot, false));
    let pcm_r = part(files::pcm(slot, true));
    let preview_part = dir.join(format!("source{}.part.m4a", slot + 1));
    let cleanup = || {
        for p in [&pcm_l, &pcm_r, &preview_part] {
            let _ = fs::remove_file(p);
        }
    };

    let mut cmd = ffmpeg::ffmpeg_command();
    cmd.arg("-y").arg("-i").arg(path);
    // Output 1: analysis PCM on stdout, always two channels.
    cmd.args(["-map", "0:a:0", "-vn", "-sn", "-dn"]);
    cmd.args(["-af", &format!("aformat=channel_layouts=stereo,volume={gain:.4}")]);
    cmd.args(["-ar", &ANALYSIS_RATE.to_string(), "-f", "f32le", "pipe:1"]);
    // Output 2: preview for the trimmer, mono or stereo as recorded.
    cmd.args(["-map", "0:a:0", "-vn", "-sn", "-dn"]);
    cmd.args([
        "-af",
        &format!("aformat=channel_layouts=mono|stereo:sample_rates=48000|44100|32000|24000|22050|16000,volume={gain:.4}"),
    ]);
    cmd.args(["-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart", "-f", "mp4"]);
    cmd.arg(&preview_part);

    let mut w_l = BufWriter::new(File::create(&pcm_l)?);
    let mut w_r = BufWriter::new(File::create(&pcm_r)?);
    let mut analyzer = StereoAnalyzer::new();
    let (mut peaks_l, mut peaks_r) = (PeakBuilder::new(), PeakBuilder::new());
    let (mut left, mut right) = (Vec::new(), Vec::new());
    let mut frames_done = 0u64;
    let mut io_err: Option<std::io::Error> = None;
    let mut last_report = -1f32;

    let result = ffmpeg::stream_pcm(cmd, 2, |block| {
        if cancel.load(Ordering::Relaxed) {
            return false;
        }
        analyzer.push(block);
        left.clear();
        right.clear();
        for s in block.chunks_exact(2) {
            left.push(s[0]);
            right.push(s[1]);
            peaks_l.push(s[0]);
            peaks_r.push(s[1]);
        }
        if let Err(e) = pcm_write(&mut w_l, &left).and_then(|_| pcm_write(&mut w_r, &right)) {
            io_err = Some(e);
            return false;
        }
        frames_done += left.len() as u64;
        if total > 0.0 {
            let f = PASS1 + (1.0 - PASS1) * (frames_done as f64 / ANALYSIS_RATE as f64 / total).min(0.99) as f32;
            if f - last_report >= 0.005 {
                last_report = f;
                progress(f);
            }
        }
        true
    });

    let finish = (|| -> Result<Source> {
        let frames = result?;
        if let Some(e) = io_err {
            return Err(anyhow!(e).context("could not write the audio cache (disk full?)"));
        }
        if cancel.load(Ordering::Relaxed) {
            bail!("cancelled");
        }
        w_l.flush()?;
        w_r.flush()?;
        drop((w_l, w_r));
        peaks_l.flush();
        peaks_r.flush();

        let verdict = analyzer.finish();
        let duration = frames as f64 / ANALYSIS_RATE as f64;
        let stereo = verdict.kind != StereoKind::Mono;

        // A mono recording keeps a single cache: the channel that carries the signal.
        let keep_right_as_left = !stereo && verdict.mono_channel == Channel::Right;
        let (src_l, peaks_main) = if keep_right_as_left { (&pcm_r, &peaks_r.out) } else { (&pcm_l, &peaks_l.out) };
        fs::rename(src_l, dir.join(files::pcm(slot, false))).context("could not store the audio cache")?;
        write_atomic(&dir.join(files::peaks(slot, false)), peaks_main)?;
        if stereo {
            fs::rename(&pcm_r, dir.join(files::pcm(slot, true)))?;
            write_atomic(&dir.join(files::peaks(slot, true)), &peaks_r.out)?;
        } else {
            let _ = fs::remove_file(if keep_right_as_left { &pcm_l } else { &pcm_r });
            let _ = fs::remove_file(dir.join(files::pcm(slot, true)));
            let _ = fs::remove_file(dir.join(files::peaks(slot, true)));
        }
        fs::rename(&preview_part, dir.join(files::preview(slot))).context("could not store the preview audio")?;

        Ok(Source {
            file_name: path.file_name().and_then(|n| n.to_str()).unwrap_or("audio").to_string(),
            original_path: path.to_string_lossy().into_owned(),
            duration,
            channels: if stereo { 2 } else { 1 },
            gain,
            stereo: verdict,
            trim_start: 0.0,
            trim_end: duration,
            modified_ms: fs::metadata(path)
                .and_then(|m| m.modified())
                .ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_millis() as u64),
        })
    })();

    match finish {
        Ok(src) => {
            progress(1.0);
            Ok(src)
        }
        Err(e) => {
            cleanup();
            Err(e)
        }
    }
}

/// Delete every cached file of a slot.
pub fn remove_source(dir: &Path, slot: usize) {
    for name in [
        files::pcm(slot, false),
        files::pcm(slot, true),
        files::peaks(slot, false),
        files::peaks(slot, true),
        files::preview(slot),
    ] {
        let _ = fs::remove_file(dir.join(name));
    }
}
