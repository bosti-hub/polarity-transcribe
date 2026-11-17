//! Small file helpers: crash-safe writes and raw PCM access.

use anyhow::{Context, Result};
use serde::{de::DeserializeOwned, Serialize};
use std::fs::{self, File};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::Path;

/// Write a file so that a crash or power loss leaves either the old or the new content,
/// never a torn file: write a sibling temp file, flush it to disk, then rename over the target.
pub fn write_atomic(path: &Path, bytes: &[u8]) -> Result<()> {
    let tmp = path.with_extension(format!(
        "{}.tmp",
        path.extension().and_then(|e| e.to_str()).unwrap_or("dat")
    ));
    {
        let mut f = File::create(&tmp).with_context(|| format!("could not write {}", tmp.display()))?;
        f.write_all(bytes)?;
        f.sync_all()?;
    }
    fs::rename(&tmp, path).with_context(|| format!("could not replace {}", path.display()))?;
    Ok(())
}

pub fn write_json<T: Serialize>(path: &Path, value: &T) -> Result<()> {
    write_atomic(path, &serde_json::to_vec_pretty(value)?)
}

pub fn read_json<T: DeserializeOwned>(path: &Path) -> Result<T> {
    let bytes = fs::read(path).with_context(|| format!("could not read {}", path.display()))?;
    serde_json::from_slice(&bytes).with_context(|| format!("{} is damaged", path.display()))
}

/// Number of samples in a raw 16-bit mono PCM file.
pub fn pcm_len(path: &Path) -> Result<u64> {
    Ok(fs::metadata(path).with_context(|| format!("missing audio cache {}", path.display()))?.len() / 2)
}

/// Read `len` samples starting at `start` from a raw 16-bit mono PCM file as f32.
/// Reads past the end are zero-filled.
pub fn pcm_read(path: &Path, start: u64, len: usize) -> Result<Vec<f32>> {
    let mut f = File::open(path).with_context(|| format!("missing audio cache {}", path.display()))?;
    let total = f.metadata()?.len() / 2;
    let mut out = vec![0f32; len];
    if start >= total || len == 0 {
        return Ok(out);
    }
    let avail = ((total - start) as usize).min(len);
    let mut bytes = vec![0u8; avail * 2];
    f.seek(SeekFrom::Start(start * 2))?;
    f.read_exact(&mut bytes)?;
    for (o, b) in out.iter_mut().zip(bytes.chunks_exact(2)) {
        *o = i16::from_le_bytes([b[0], b[1]]) as f32 / 32768.0;
    }
    Ok(out)
}

#[inline]
pub fn f32_to_i16(v: f32) -> i16 {
    (v * 32767.0).round().clamp(-32768.0, 32767.0) as i16
}

/// Append f32 samples to a writer as 16-bit PCM.
pub fn pcm_write(w: &mut impl Write, samples: &[f32]) -> std::io::Result<()> {
    let mut buf = Vec::with_capacity(samples.len() * 2);
    for &s in samples {
        buf.extend_from_slice(&f32_to_i16(s).to_le_bytes());
    }
    w.write_all(&buf)
}

pub fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}
