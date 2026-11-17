//! The speech models the app can use.
//!
//! Models are not shipped with the installer. They are fetched once (by the desktop shell — this
//! crate contains no network code) and verified against the checksums below, which are the
//! SHA-256 values published for the files in the whisper.cpp model repository.

use anyhow::{bail, Context, Result};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::fs::{self, File};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Tier {
    Standard,
    Light,
    Max,
}

#[derive(Debug, Clone, Copy)]
pub struct ModelSpec {
    pub id: &'static str,
    pub tier: Tier,
    pub file: &'static str,
    pub url: &'static str,
    pub size: u64,
    pub sha256: &'static str,
}

pub const CATALOG: &[ModelSpec] = &[
    ModelSpec {
        id: "large-v3-turbo-q8",
        tier: Tier::Standard,
        file: "ggml-large-v3-turbo-q8_0.bin",
        url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo-q8_0.bin",
        size: 874_188_075,
        sha256: "317eb69c11673c9de1e1f0d459b253999804ec71ac4c23c17ecf5fbe24e259a1",
    },
    ModelSpec {
        id: "small-q5",
        tier: Tier::Light,
        file: "ggml-small-q5_1.bin",
        url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small-q5_1.bin",
        size: 190_085_487,
        sha256: "ae85e4a935d7a567bd102fe55afc16bb595bdb618e11b2fc7591bc08120411bb",
    },
    ModelSpec {
        id: "large-v3-q5",
        tier: Tier::Max,
        file: "ggml-large-v3-q5_0.bin",
        url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-q5_0.bin",
        size: 1_081_140_203,
        sha256: "d75795ecff3f83b5faa89d1900604ad8c780abd5739fae406de19f23ecd98ad1",
    },
];

/// Speaker-embedding model used to tell voices apart on single-microphone recordings
/// (WeSpeaker ResNet34-LM trained on VoxCeleb). Small, and fetched together with a speech model.
pub const VOICE_MODEL: ModelSpec = ModelSpec {
    id: "voice",
    tier: Tier::Standard,
    file: "wespeaker_en_voxceleb_resnet34_LM.onnx",
    url: "https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/wespeaker_en_voxceleb_resnet34_LM.onnx",
    size: 26_530_550,
    sha256: "e9848563da86f263117134dfd7ad63c92355b37de492b55e325400c9d9c39012",
};

/// Voice-activity model (Silero VAD, MIT licence). Under 1 MB, so it ships inside the app.
const VAD_MODEL: &[u8] = include_bytes!("../assets/ggml-silero-v5.1.2.bin");
const VAD_FILE: &str = "ggml-silero-v5.1.2.bin";

pub fn spec(id: &str) -> Option<&'static ModelSpec> {
    CATALOG.iter().find(|m| m.id == id)
}

impl ModelSpec {
    pub fn path(&self, models_dir: &Path) -> PathBuf {
        models_dir.join(self.file)
    }
    /// Where an unfinished download is kept so it can be resumed.
    pub fn part_path(&self, models_dir: &Path) -> PathBuf {
        models_dir.join(format!("{}.part", self.file))
    }
    pub fn is_installed(&self, models_dir: &Path) -> bool {
        fs::metadata(self.path(models_dir)).map(|m| m.len() == self.size).unwrap_or(false)
    }
    pub fn partial_bytes(&self, models_dir: &Path) -> u64 {
        fs::metadata(self.part_path(models_dir)).map(|m| m.len()).unwrap_or(0)
    }
}

/// Write the bundled voice-activity model to disk if needed and return its path.
pub fn ensure_vad(models_dir: &Path) -> Result<PathBuf> {
    fs::create_dir_all(models_dir)?;
    let path = models_dir.join(VAD_FILE);
    let ok = fs::metadata(&path).map(|m| m.len() == VAD_MODEL.len() as u64).unwrap_or(false);
    if !ok {
        crate::fsutil::write_atomic(&path, VAD_MODEL)?;
    }
    Ok(path)
}

/// SHA-256 of a file as lowercase hex. `cancel` aborts early (returns an error).
pub fn sha256_file(path: &Path, cancel: &AtomicBool) -> Result<String> {
    let mut f = File::open(path).with_context(|| format!("could not open {}", path.display()))?;
    let mut hasher = Sha256::new();
    let mut buf = vec![0u8; 1 << 20];
    loop {
        if cancel.load(Ordering::Relaxed) {
            bail!("cancelled");
        }
        let n = f.read(&mut buf)?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    Ok(hasher.finalize().iter().map(|b| format!("{b:02x}")).collect())
}

/// Check a completely downloaded (or user-supplied) file and move it into place.
pub fn install_verified(spec: &ModelSpec, candidate: &Path, models_dir: &Path, cancel: &AtomicBool, copy: bool) -> Result<()> {
    let len = fs::metadata(candidate)?.len();
    if len != spec.size {
        bail!("the file has the wrong size ({len} bytes, expected {})", spec.size);
    }
    let sum = sha256_file(candidate, cancel)?;
    if sum != spec.sha256 {
        bail!("the file is damaged or is not the expected model (checksum mismatch)");
    }
    fs::create_dir_all(models_dir)?;
    let target = spec.path(models_dir);
    if copy {
        let tmp = models_dir.join(format!("{}.import", spec.file));
        fs::copy(candidate, &tmp)?;
        fs::rename(&tmp, &target)?;
    } else {
        fs::rename(candidate, &target)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn catalog_is_consistent() {
        assert_eq!(CATALOG.iter().filter(|m| m.tier == Tier::Standard).count(), 1);
        for m in CATALOG {
            assert_eq!(m.sha256.len(), 64);
            assert!(m.url.starts_with("https://") && m.url.ends_with(m.file));
            assert!(spec(m.id).is_some());
        }
    }

    #[test]
    fn bundled_vad_model_is_written_once() {
        let dir = std::env::temp_dir().join(format!("pt-models-{}", uuid::Uuid::new_v4()));
        let p = ensure_vad(&dir).unwrap();
        assert_eq!(fs::metadata(&p).unwrap().len(), VAD_MODEL.len() as u64);
        let never = AtomicBool::new(false);
        assert_eq!(sha256_file(&p, &never).unwrap(), "29940d98d42b91fbd05ce489f3ecf7c72f0a42f027e4875919a28fb4c04ea2cf");
        let _ = fs::remove_dir_all(dir);
    }
}
