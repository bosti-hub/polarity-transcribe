//! Sharing interviews between researchers: one ZIP file with a whole study or a single interview.
//!
//! The archive holds what the editor needs (the transcript, the editor's extras, the diagnostics
//! and the playback audio), not the decoded audio caches: those are large and can be rebuilt from
//! the original recordings. An imported interview can therefore be read, corrected and exported,
//! but not transcribed again.
//!
//! Layout:
//! ```text
//! polarity-transcribe.json      manifest (format, app version, the study, the interview folders)
//! interviews/1/project.json
//! interviews/1/transcript.json
//! interviews/1/extras.json      (when present)
//! interviews/1/report.json      (when present)
//! interviews/1/playback.m4a
//! ```
//! Import reads only these names, so nothing in an archive can be written outside the app's own
//! folders.

use crate::fsutil::now_ms;
use crate::pipeline::{PLAYBACK_FILE, REPORT_FILE};
use crate::project::{files, Project, Status, Store};
use crate::study::{new_id, Study, StudyStore};
use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};
use std::fs::{self, File};
use std::io::{BufReader, BufWriter, Read, Write};
use std::path::Path;
use zip::write::SimpleFileOptions;
use zip::{CompressionMethod, ZipArchive, ZipWriter};

pub const MANIFEST: &str = "polarity-transcribe.json";
/// Raised when the layout changes in a way older versions cannot read.
pub const FORMAT: u32 = 1;

/// Files of an interview folder that go into the archive. The first two are required.
const SHARED: [&str; 5] = [files::PROJECT, files::TRANSCRIPT, files::EXTRAS, REPORT_FILE, PLAYBACK_FILE];
/// Most a single file may unpack to: guards against damaged or hostile archives.
const MAX_JSON: u64 = 256 << 20;
const MAX_AUDIO: u64 = 8 << 30;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Kind {
    /// A whole study: imported as a study of its own.
    Study,
    /// One or more interviews: they join their study when it is already there.
    Interviews,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Manifest {
    pub format: u32,
    pub app_version: String,
    pub exported_at: u64,
    pub kind: Kind,
    pub study: Option<Study>,
    /// Folders inside the archive, one per interview.
    pub interviews: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Imported {
    /// The study the interviews are in now, if any.
    pub study_id: Option<String>,
    /// The study was new on this computer (created by the import).
    pub new_study: bool,
    pub interviews: usize,
}

fn transcribed(store: &Store, p: &Project) -> bool {
    p.status == Status::Ready && store.dir(&p.id).is_ok_and(|d| d.join(files::TRANSCRIPT).is_file())
}

/// Write `projects` (with their `study`) to a ZIP file at `dest`. Interviews that have no
/// transcript yet are left out. Returns how many interviews were written.
pub fn export(store: &Store, kind: Kind, study: Option<&Study>, projects: &[Project], dest: &Path) -> Result<usize> {
    let projects: Vec<&Project> = projects.iter().filter(|p| transcribed(store, p)).collect();
    if projects.is_empty() {
        bail!("there is no transcribed interview to export");
    }
    // A single interview takes along only the participants it refers to, not the whole list.
    let study = study.map(|s| {
        let mut s = s.clone();
        if kind == Kind::Interviews {
            s.participants.retain(|x| projects.iter().any(|p| p.participant_ids.contains(&x.id)));
        }
        s
    });
    let manifest = Manifest {
        format: FORMAT,
        app_version: env!("CARGO_PKG_VERSION").into(),
        exported_at: now_ms(),
        kind,
        study,
        interviews: (1..=projects.len()).map(|i| format!("interviews/{i}")).collect(),
    };

    if let Some(parent) = dest.parent() {
        fs::create_dir_all(parent).with_context(|| format!("could not create {}", parent.display()))?;
    }
    let part = dest.with_extension("zip.part");
    let written = (|| -> Result<()> {
        let file = File::create(&part).with_context(|| format!("could not write {}", part.display()))?;
        let mut zip = ZipWriter::new(BufWriter::new(file));
        let deflated = SimpleFileOptions::default().compression_method(CompressionMethod::Deflated);
        // Audio is compressed already: stored as it is, which is much faster.
        let stored = SimpleFileOptions::default().compression_method(CompressionMethod::Stored);
        zip.start_file(MANIFEST, deflated)?;
        zip.write_all(&serde_json::to_vec_pretty(&manifest)?)?;
        for (p, folder) in projects.iter().zip(&manifest.interviews) {
            let dir = store.dir(&p.id)?;
            for name in SHARED {
                let path = dir.join(name);
                if !path.is_file() {
                    continue;
                }
                let size = fs::metadata(&path)?.len();
                let options = if name == PLAYBACK_FILE { stored } else { deflated };
                zip.start_file(format!("{folder}/{name}"), options.large_file(size >= u32::MAX as u64))?;
                let mut f = File::open(&path).with_context(|| format!("could not read {}", path.display()))?;
                std::io::copy(&mut f, &mut zip)?;
            }
        }
        zip.finish()?.flush()?;
        Ok(())
    })();
    if let Err(e) = written {
        let _ = fs::remove_file(&part);
        return Err(e);
    }
    fs::rename(&part, dest).with_context(|| format!("could not replace {}", dest.display()))?;
    Ok(projects.len())
}

/// Read the manifest of an archive (to check what it holds before importing).
pub fn read_manifest(src: &Path) -> Result<Manifest> {
    let mut zip = open(src)?;
    manifest(&mut zip)
}

fn open(src: &Path) -> Result<ZipArchive<BufReader<File>>> {
    let f = File::open(src).with_context(|| format!("could not open {}", src.display()))?;
    ZipArchive::new(BufReader::new(f)).context("this is not a ZIP file, or it is damaged")
}

fn manifest(zip: &mut ZipArchive<BufReader<File>>) -> Result<Manifest> {
    let bytes = match zip.by_name(MANIFEST) {
        Ok(entry) => read_limited(entry, MAX_JSON)?,
        Err(_) => bail!("this ZIP file was not exported by Polarity Transcribe"),
    };
    let m: Manifest = serde_json::from_slice(&bytes).context("the export's description is damaged")?;
    if m.format > FORMAT {
        bail!("this export was made by a newer version of Polarity Transcribe ({}); update the app first", m.app_version);
    }
    Ok(m)
}

fn read_limited(entry: impl Read, max: u64) -> Result<Vec<u8>> {
    let mut out = Vec::new();
    entry.take(max + 1).read_to_end(&mut out)?;
    if out.len() as u64 > max {
        bail!("a file in the export is too large");
    }
    Ok(out)
}

/// Import an archive. A whole study becomes a study of its own (a copy, named with
/// `copy_suffix`, when this computer already has it). Single interviews join their study when it
/// is here, adding the participants and pseudonym rules they need, and bring it along otherwise.
/// An interview that is already here is imported as a copy, also named with `copy_suffix`.
///
/// The caller holds the study lock.
pub fn import(store: &Store, studies: &StudyStore, src: &Path, copy_suffix: &str) -> Result<Imported> {
    let mut zip = open(src)?;
    let m = manifest(&mut zip)?;

    // Read and check every interview before anything is written.
    let mut interviews: Vec<(String, Project)> = Vec::new();
    for folder in &m.interviews {
        let project: Project = match zip.by_name(&format!("{folder}/{}", files::PROJECT)) {
            Ok(entry) => serde_json::from_slice(&read_limited(entry, MAX_JSON)?).context("an interview in the export is damaged")?,
            Err(_) => bail!("an interview in the export is incomplete"),
        };
        if zip.by_name(&format!("{folder}/{}", files::TRANSCRIPT)).is_err() {
            bail!("the interview \"{}\" in the export has no transcript", project.name);
        }
        interviews.push((folder.clone(), project));
    }
    if interviews.is_empty() {
        bail!("the export holds no interviews");
    }

    let (study_id, new_study) = match m.study.clone() {
        None => (None, false),
        Some(mut s) => {
            let existing = studies.load(&s.id).ok();
            match (m.kind, existing) {
                (Kind::Interviews, Some(mut here)) => {
                    merge_study(&mut here, &s);
                    studies.save(&mut here)?;
                    (Some(here.id), false)
                }
                (_, existing) => {
                    if existing.is_some() || s.id.is_empty() {
                        s.id = new_id();
                        s.name = format!("{}{copy_suffix}", s.name);
                        s.created_at = now_ms();
                    }
                    studies.save(&mut s)?;
                    (Some(s.id), true)
                }
            }
        }
    };

    let mut count = 0;
    for (folder, mut p) in interviews {
        if store.dir(&p.id).map(|d| d.exists()).unwrap_or(true) {
            p.id = uuid::Uuid::new_v4().to_string();
            p.name = format!("{}{copy_suffix}", p.name);
        }
        p.study_id = study_id.clone();
        if study_id.is_none() {
            p.participant_ids.clear();
        }
        p.status = Status::Ready;
        p.error = None;
        let dir = store.dir(&p.id)?;
        fs::create_dir_all(&dir).with_context(|| format!("could not create {}", dir.display()))?;
        let unpacked = (|| -> Result<()> {
            // project.json last: a folder without it is an unfinished import that is swept away.
            for name in SHARED.iter().filter(|n| **n != files::PROJECT) {
                let Ok(entry) = zip.by_name(&format!("{folder}/{name}")) else { continue };
                let max = if *name == PLAYBACK_FILE { MAX_AUDIO } else { MAX_JSON };
                let part = dir.join(format!("{name}.part"));
                {
                    let mut out = BufWriter::new(File::create(&part)?);
                    let copied = std::io::copy(&mut entry.take(max + 1), &mut out)?;
                    if copied > max {
                        bail!("a file in the export is too large");
                    }
                    out.flush()?;
                }
                fs::rename(&part, dir.join(name))?;
            }
            store.save(&mut p)
        })();
        if let Err(e) = unpacked {
            let _ = fs::remove_dir_all(&dir);
            return Err(e);
        }
        count += 1;
    }
    Ok(Imported { study_id, new_study, interviews: count })
}

/// Add to `here` what an interview from `theirs` (the same study elsewhere) needs: its
/// participants, and pseudonym rules, tags, terms and attributes not known here yet. Nothing
/// that is already here is changed.
fn merge_study(here: &mut Study, theirs: &Study) {
    for p in &theirs.participants {
        if !here.participants.iter().any(|x| x.id == p.id) {
            here.participants.push(p.clone());
        }
    }
    for r in &theirs.pseudonyms {
        if !here.pseudonyms.iter().any(|x| x.find.eq_ignore_ascii_case(&r.find)) {
            here.pseudonyms.push(r.clone());
        }
    }
    for t in &theirs.tags {
        here.learn_tag(t);
    }
    let add = |list: &mut Vec<String>, from: &[String]| {
        for x in from {
            if !list.iter().any(|y| y.eq_ignore_ascii_case(x)) {
                list.push(x.clone());
            }
        }
    };
    add(&mut here.keep_terms, &theirs.keep_terms);
    add(&mut here.attributes, &theirs.attributes);
    add(&mut here.glossary, &theirs.glossary);
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::asr::Language;
    use crate::study::Pseudonym;
    use std::path::PathBuf;

    struct Place {
        root: PathBuf,
        store: Store,
        studies: StudyStore,
    }

    fn place() -> Place {
        let root = std::env::temp_dir().join(format!("pt-share-{}", uuid::Uuid::new_v4()));
        Place { store: Store::new(root.join("projects")).unwrap(), studies: StudyStore::new(root.join("studies")).unwrap(), root }
    }

    fn interview(at: &Place, name: &str, study: Option<&Study>) -> Project {
        let mut p = at.store.create(name, Language::Nl).unwrap();
        p.status = Status::Ready;
        p.study_id = study.map(|s| s.id.clone());
        if let Some(s) = study {
            p.participant_ids = vec![s.participants[0].id.clone()];
        }
        at.store.save(&mut p).unwrap();
        let dir = at.store.dir(&p.id).unwrap();
        fs::write(dir.join(files::TRANSCRIPT), br#"{"words":[]}"#).unwrap();
        fs::write(dir.join(PLAYBACK_FILE), vec![7u8; 4096]).unwrap();
        fs::write(dir.join(files::pcm(0, false)), b"cache").unwrap();
        p
    }

    #[test]
    fn a_study_goes_across_and_comes_back_as_a_copy() {
        let (a, b) = (place(), place());
        let mut study = a.studies.create("Werkdruk", Language::Nl).unwrap();
        study.add_participant();
        study.add_participant();
        study.pseudonyms.push(Pseudonym { find: "Jan".into(), replace: "[collega]".into() });
        a.studies.save(&mut study).unwrap();
        let one = interview(&a, "Interview 1", Some(&study));
        let mut waiting = a.store.create("Not transcribed", Language::Nl).unwrap();
        waiting.study_id = Some(study.id.clone());
        a.store.save(&mut waiting).unwrap();

        let zip = a.root.join("out/Werkdruk.zip");
        let n = export(&a.store, Kind::Study, Some(&study), &[one.clone(), waiting], &zip).unwrap();
        assert_eq!(n, 1, "only transcribed interviews are exported");
        assert!(!a.root.join("out/Werkdruk.zip.part").exists());

        let got = import(&b.store, &b.studies, &zip, " (copy)").unwrap();
        assert!(got.new_study);
        assert_eq!(got.study_id.as_deref(), Some(study.id.as_str()), "a new study keeps its id");
        let there = b.studies.load(&study.id).unwrap();
        assert_eq!(there.participants.len(), 2);
        assert_eq!(there.pseudonyms.len(), 1);
        let list = b.store.list();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].id, one.id);
        assert_eq!(list[0].participant_ids, one.participant_ids);
        let dir = b.store.dir(&one.id).unwrap();
        assert_eq!(fs::read(dir.join(PLAYBACK_FILE)).unwrap().len(), 4096);
        assert!(dir.join(files::TRANSCRIPT).is_file());
        assert!(!dir.join(files::pcm(0, false)).exists(), "audio caches stay behind");

        // Back to the first computer: both already exist there, so they arrive as copies.
        let back = b.root.join("Werkdruk terug.zip");
        export(&b.store, Kind::Study, Some(&there), &list, &back).unwrap();
        let got = import(&a.store, &a.studies, &back, " (copy)").unwrap();
        let copy = a.studies.load(got.study_id.as_deref().unwrap()).unwrap();
        assert_ne!(copy.id, study.id);
        assert_eq!(copy.name, "Werkdruk (copy)");
        let copied: Vec<Project> = a.store.list().into_iter().filter(|p| p.study_id.as_deref() == Some(copy.id.as_str())).collect();
        assert_eq!(copied.len(), 1);
        assert_ne!(copied[0].id, one.id);
        assert_eq!(copied[0].name, "Interview 1 (copy)");

        let _ = fs::remove_dir_all(&a.root);
        let _ = fs::remove_dir_all(&b.root);
    }

    #[test]
    fn a_single_interview_joins_its_study() {
        let (a, b) = (place(), place());
        let mut study = a.studies.create("Werkdruk", Language::Nl).unwrap();
        study.add_participant();
        study.add_participant();
        a.studies.save(&mut study).unwrap();
        // The other computer has the study, without the second participant and with a rule of its own.
        let mut theirs = study.clone();
        theirs.participants.truncate(0);
        theirs.pseudonyms.push(Pseudonym { find: "Piet".into(), replace: "[P]".into() });
        b.studies.save(&mut theirs).unwrap();

        let mut p = interview(&a, "R02", Some(&study));
        p.participant_ids = vec![study.participants[1].id.clone()];
        a.store.save(&mut p).unwrap();
        let zip = a.root.join("R02.zip");
        export(&a.store, Kind::Interviews, Some(&study), &[p.clone()], &zip).unwrap();
        let m = read_manifest(&zip).unwrap();
        assert_eq!(m.study.as_ref().unwrap().participants.len(), 1, "only the participant it refers to");

        let got = import(&b.store, &b.studies, &zip, " (copy)").unwrap();
        assert!(!got.new_study);
        assert_eq!(got.study_id.as_deref(), Some(study.id.as_str()));
        let merged = b.studies.load(&study.id).unwrap();
        assert_eq!(merged.participants.len(), 1);
        assert_eq!(merged.participants[0].id, study.participants[1].id);
        assert_eq!(merged.pseudonyms.len(), 1, "rules already there are kept");
        assert_eq!(b.store.load(&p.id).unwrap().participant_ids, p.participant_ids);

        let _ = fs::remove_dir_all(&a.root);
        let _ = fs::remove_dir_all(&b.root);
    }

    #[test]
    fn other_zip_files_are_refused() {
        let a = place();
        let path = a.root.join("other.zip");
        {
            let mut zip = ZipWriter::new(File::create(&path).unwrap());
            zip.start_file("hello.txt", SimpleFileOptions::default()).unwrap();
            zip.write_all(b"hi").unwrap();
            zip.finish().unwrap();
        }
        let e = import(&a.store, &a.studies, &path, "").unwrap_err();
        assert!(format!("{e:#}").contains("not exported by Polarity Transcribe"));
        fs::write(a.root.join("plain.zip"), b"not a zip").unwrap();
        assert!(import(&a.store, &a.studies, &a.root.join("plain.zip"), "").is_err());
        assert!(a.store.list().is_empty());
        let _ = fs::remove_dir_all(&a.root);
    }
}
