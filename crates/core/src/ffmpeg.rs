//! Audio decoding through an FFmpeg child process.
//!
//! Decoded PCM is streamed over a pipe, so no intermediate file ever touches the system temp
//! directory. The FFmpeg binary is looked up next to the application first (the bundled sidecar),
//! then on `PATH` (development).

use anyhow::{anyhow, bail, Context, Result};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};

/// Sample rate used for all analysis and speech recognition.
pub const ANALYSIS_RATE: u32 = 16_000;

/// Which part of the source's first audio stream to extract.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Channel {
    /// Downmix every channel to mono.
    Mix,
    Left,
    Right,
}

#[derive(Debug, Clone)]
pub struct DecodeOpts {
    pub sample_rate: u32,
    /// Output channel layout: one entry per output channel.
    pub channels: Vec<Channel>,
    /// Start offset in seconds.
    pub start: Option<f64>,
    /// Length in seconds.
    pub duration: Option<f64>,
}

impl DecodeOpts {
    pub fn mono(channel: Channel) -> Self {
        Self { sample_rate: ANALYSIS_RATE, channels: vec![channel], start: None, duration: None }
    }
    pub fn range(mut self, start: f64, duration: f64) -> Self {
        self.start = Some(start);
        self.duration = Some(duration);
        self
    }
}

/// Locate the FFmpeg executable.
pub fn ffmpeg_path() -> PathBuf {
    if let Some(p) = std::env::var_os("PT_FFMPEG") {
        return PathBuf::from(p);
    }
    let name = if cfg!(windows) { "ffmpeg.exe" } else { "ffmpeg" };
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            for cand in [dir.join(name), dir.join("resources").join(name), dir.join("../Resources").join(name)] {
                if cand.is_file() {
                    return cand;
                }
            }
        }
    }
    PathBuf::from(name)
}

/// A `Command` for FFmpeg that never opens a console window and never reads stdin.
pub fn ffmpeg_command() -> Command {
    let mut cmd = Command::new(ffmpeg_path());
    cmd.args(["-hide_banner", "-nostdin", "-v", "error"]);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    cmd
}

/// `pan` filter that maps the first stereo pair of the source to the requested output channels.
fn pan_filter(channels: &[Channel]) -> String {
    let layout = match channels.len() {
        1 => "mono",
        2 => "stereo",
        n => panic!("unsupported output channel count {n}"),
    };
    let exprs: Vec<String> = channels
        .iter()
        .enumerate()
        .map(|(i, ch)| {
            let src = match ch {
                Channel::Mix => "0.5*c0+0.5*c1",
                Channel::Left => "c0",
                Channel::Right => "c1",
            };
            format!("c{i}={src}")
        })
        .collect();
    format!("pan={layout}|{}", exprs.join("|"))
}

/// Kills the child on drop so an aborted decode never leaves FFmpeg running.
struct ChildGuard(Child);
impl Drop for ChildGuard {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

/// Decode `path` and feed interleaved f32 samples to `sink` in blocks.
///
/// The source is first normalised to stereo (mono sources are duplicated), so [`Channel::Left`]
/// and [`Channel::Right`] are always valid. `sink` returns `false` to stop early.
/// Returns the number of frames delivered.
pub fn decode_stream(
    path: &Path,
    opts: &DecodeOpts,
    sink: impl FnMut(&[f32]) -> bool,
) -> Result<u64> {
    let mut cmd = ffmpeg_command();
    if let Some(s) = opts.start {
        cmd.args(["-ss", &format!("{s:.6}")]);
    }
    if let Some(d) = opts.duration {
        cmd.args(["-t", &format!("{d:.6}")]);
    }
    cmd.arg("-i").arg(path);
    cmd.args(["-map", "0:a:0", "-vn", "-sn", "-dn"]);
    cmd.args(["-af", &format!("aformat=channel_layouts=stereo,{}", pan_filter(&opts.channels))]);
    cmd.args(["-ar", &opts.sample_rate.to_string()]);
    cmd.args(["-f", "f32le", "-"]);
    stream_pcm(cmd, opts.channels.len(), sink).with_context(|| format!("could not decode {}", path.display()))
}

/// Run a prepared FFmpeg command that writes f32le PCM with `n_ch` channels to stdout and feed
/// it to `sink` in whole frames. `sink` returns `false` to stop early (FFmpeg is then killed).
pub fn stream_pcm(mut cmd: Command, n_ch: usize, mut sink: impl FnMut(&[f32]) -> bool) -> Result<u64> {
    cmd.stdout(Stdio::piped()).stderr(Stdio::piped()).stdin(Stdio::null());
    let child = cmd
        .spawn()
        .with_context(|| format!("could not start FFmpeg ({})", ffmpeg_path().display()))?;
    let mut guard = ChildGuard(child);
    let mut stdout = guard.0.stdout.take().unwrap();
    let mut stderr = guard.0.stderr.take().unwrap();
    let err_thread = std::thread::spawn(move || {
        let mut s = String::new();
        let _ = stderr.read_to_string(&mut s);
        s
    });

    let frame_bytes = 4 * n_ch;
    let mut buf = vec![0u8; frame_bytes * 16_384];
    let mut filled = 0usize;
    let mut samples: Vec<f32> = Vec::with_capacity(buf.len() / 4);
    let mut frames = 0u64;
    loop {
        let n = stdout.read(&mut buf[filled..])?;
        if n == 0 {
            break;
        }
        filled += n;
        let usable = filled - filled % frame_bytes;
        if usable == 0 {
            continue;
        }
        samples.clear();
        samples.extend(
            buf[..usable].chunks_exact(4).map(|b| f32::from_le_bytes([b[0], b[1], b[2], b[3]])),
        );
        frames += (usable / frame_bytes) as u64;
        buf.copy_within(usable..filled, 0);
        filled -= usable;
        if !sink(&samples) {
            return Ok(frames);
        }
    }
    let status = guard.0.wait()?;
    let err = err_thread.join().unwrap_or_default();
    if !status.success() {
        let msg = err.lines().last().unwrap_or("unknown error").to_string();
        bail!("FFmpeg failed: {msg}");
    }
    if frames == 0 {
        return Err(anyhow!("the file contains no audio"));
    }
    Ok(frames)
}

/// Basic facts about a media file, read from FFmpeg's banner.
#[derive(Debug, Clone, Default)]
pub struct Probe {
    /// Duration in seconds, if the container reports one.
    pub duration: Option<f64>,
    pub has_audio: bool,
    /// The demuxer's format list, e.g. "mov,mp4,m4a,3gp,3g2,mj2".
    pub container: String,
    /// The first audio stream as FFmpeg describes it (the text after "Audio:"), e.g.
    /// "aac (LC) (mp4a / 0x6134706D), 48000 Hz, stereo, fltp, 128 kb/s (default)".
    pub audio: Option<String>,
}

impl Probe {
    /// Whether the first audio stream can be copied as it is into an MP4 file the webview plays:
    /// AAC-LC, mono or stereo, from an MP4/MOV family file, at a modest bit rate (a copy of a
    /// high-rate track would take more disk space than encoding it again).
    pub fn audio_copyable_to_mp4(&self, max_kbps: u32) -> bool {
        let Some(audio) = self.audio.as_deref() else { return false };
        if !self.container.split(',').any(|f| f == "mov" || f == "mp4") {
            return false;
        }
        let fields: Vec<&str> = audio.split(',').map(str::trim).collect();
        let codec_ok = fields.first().is_some_and(|c| c.starts_with("aac (LC)"));
        let layout_ok = fields.iter().any(|f| *f == "mono" || *f == "stereo");
        let kbps = fields.iter().find_map(|f| f.split_whitespace().next().filter(|_| f.contains("kb/s"))?.parse::<u32>().ok());
        codec_ok && layout_ok && kbps.is_some_and(|k| k <= max_kbps)
    }
}

fn parse_probe(text: &str) -> Probe {
    let mut p = Probe::default();
    for line in text.lines() {
        let line = line.trim();
        if let Some(rest) = line.strip_prefix("Input #0, ") {
            p.container = rest.split(", from").next().unwrap_or("").trim().trim_end_matches(',').to_string();
        }
        if let Some(rest) = line.strip_prefix("Duration:") {
            let stamp = rest.trim().split(',').next().unwrap_or("").trim();
            let parts: Vec<&str> = stamp.split(':').collect();
            if parts.len() == 3 {
                if let (Ok(h), Ok(m), Ok(s)) = (parts[0].parse::<f64>(), parts[1].parse::<f64>(), parts[2].parse::<f64>()) {
                    p.duration = Some(h * 3600.0 + m * 60.0 + s);
                }
            }
        }
        if line.starts_with("Stream #") {
            if let Some((_, desc)) = line.split_once("Audio: ") {
                p.has_audio = true;
                if p.audio.is_none() {
                    p.audio = Some(desc.trim().to_string());
                }
            }
        }
    }
    p
}

pub fn probe(path: &Path) -> Result<Probe> {
    let mut cmd = Command::new(ffmpeg_path());
    cmd.args(["-hide_banner", "-nostdin", "-i"]).arg(path);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000);
    }
    let out = cmd
        .stdin(Stdio::null())
        .output()
        .with_context(|| format!("could not start FFmpeg ({})", ffmpeg_path().display()))?;
    Ok(parse_probe(&String::from_utf8_lossy(&out.stderr)))
}

/// Decode a (range of a) file fully into memory as mono f32.
pub fn decode_mono(path: &Path, opts: &DecodeOpts) -> Result<Vec<f32>> {
    assert_eq!(opts.channels.len(), 1);
    let mut out = Vec::new();
    decode_stream(path, opts, |block| {
        out.extend_from_slice(block);
        true
    })?;
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    const MP4: &str = "Input #0, mov,mp4,m4a,3gp,3g2,mj2, from 'a.mp4':
  Duration: 00:03:41.33, start: 0.000000, bitrate: 7311 kb/s
  Stream #0:0[0x1](und): Video: h264 (avc1 / 0x31637661), 3840x2160, 6987 kb/s
  Stream #0:1[0x2](und): Audio: aac (LC) (mp4a / 0x6134706D), 48000 Hz, stereo, fltp, 128 kb/s (default)
  Stream #0:2[0x3](und): Audio: aac (LC) (mp4a / 0x6134706D), 48000 Hz, 5.1, fltp, 384 kb/s";

    #[test]
    fn the_banner_is_read() {
        let p = parse_probe(MP4);
        assert!((p.duration.unwrap() - 221.33).abs() < 1e-6);
        assert!(p.has_audio);
        assert_eq!(p.container, "mov,mp4,m4a,3gp,3g2,mj2");
        assert!(p.audio.as_deref().unwrap().contains("stereo"), "the first audio stream counts");
    }

    #[test]
    fn only_modest_aac_lc_in_mp4_is_copied() {
        assert!(parse_probe(MP4).audio_copyable_to_mp4(192));
        assert!(!parse_probe(&MP4.replace("128 kb/s", "320 kb/s")).audio_copyable_to_mp4(192));
        assert!(!parse_probe(&MP4.replace("aac (LC)", "aac (HE-AAC)")).audio_copyable_to_mp4(192));
        assert!(!parse_probe(&MP4.replace("stereo", "5.1")).audio_copyable_to_mp4(192));
        assert!(!parse_probe(&MP4.replace("mov,mp4,m4a,3gp,3g2,mj2", "matroska,webm")).audio_copyable_to_mp4(192));
        let wav = "Input #0, wav, from 'b.wav':\n  Duration: 02:21:44.74, bitrate: 1536 kb/s\n  Stream #0:0: Audio: pcm_f32le ([3][0][0][0] / 0x0003), 48000 Hz, mono, flt, 1536 kb/s";
        assert!(!parse_probe(wav).audio_copyable_to_mp4(192));
    }
}
