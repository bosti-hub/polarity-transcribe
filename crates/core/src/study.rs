//! Studies: a set of interviews with shared settings and a list of participants.
//!
//! A study is one JSON file in the `studies` folder. Interviews stay in the projects folder and
//! point to their study (`Project::study_id`), so an interview can also exist on its own and
//! can be moved between studies. Participants belong to a study; interviews refer to them by id.

use crate::asr::Language;
use crate::fsutil::{now_ms, read_json, write_json};
use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::fs;
use std::path::PathBuf;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Study {
    pub id: String,
    pub name: String,
    pub created_at: u64,
    pub updated_at: u64,
    /// Interview language for new interviews.
    pub language: Language,
    /// Names and terms the recogniser should know about in every interview of the study.
    pub glossary: Vec<String>,
    /// Pause threshold for new interviews (seconds).
    pub pause_threshold: f64,
    /// Default interviewer for new interviews.
    pub interviewer: String,
    /// Speaker label of the interviewer in transcripts ("Interviewer", "I").
    pub interviewer_label: String,
    /// Prefix of participant codes ("R" gives R01, R02, …).
    pub participant_prefix: String,
    /// Names of the participant attributes (columns), in display order.
    pub attributes: Vec<String>,
    /// Tags known in this study, in display order.
    pub tags: Vec<String>,
    pub participants: Vec<Participant>,
    pub notes: String,
    /// Replacements applied to every interview of the study when exporting.
    pub pseudonyms: Vec<Pseudonym>,
}

/// One replacement: `find` (a name or other identifying detail) becomes `replace`.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Pseudonym {
    pub find: String,
    pub replace: String,
}

impl Default for Study {
    fn default() -> Self {
        Self {
            id: String::new(),
            name: String::new(),
            created_at: 0,
            updated_at: 0,
            language: Language::Nl,
            glossary: Vec::new(),
            pause_threshold: 3.0,
            interviewer: String::new(),
            interviewer_label: "Interviewer".into(),
            participant_prefix: "R".into(),
            attributes: Vec::new(),
            tags: Vec::new(),
            participants: Vec::new(),
            notes: String::new(),
            pseudonyms: Vec::new(),
        }
    }
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Participant {
    pub id: String,
    /// Pseudonymous code used in transcripts and exports ("R03").
    pub code: String,
    /// Attribute values by attribute name.
    pub attributes: BTreeMap<String, String>,
    pub notes: String,
}

impl Participant {
    /// Nothing but a code: safe to remove when no interview refers to it any more.
    pub fn is_blank(&self) -> bool {
        self.notes.trim().is_empty() && self.attributes.values().all(|v| v.trim().is_empty())
    }
}

/// A new random id for a study or participant.
pub fn new_id() -> String {
    uuid::Uuid::new_v4().to_string()
}

impl Study {
    pub fn participant(&self, id: &str) -> Option<&Participant> {
        self.participants.iter().find(|p| p.id == id)
    }

    /// The next free code: the prefix and the lowest number above all existing ones (R01, R02…).
    pub fn next_code(&self) -> String {
        let prefix = self.participant_prefix.trim();
        let highest = self
            .participants
            .iter()
            .filter_map(|p| p.code.trim().strip_prefix(prefix).and_then(|n| n.trim().parse::<u32>().ok()))
            .max()
            .unwrap_or(0);
        format!("{prefix}{:02}", highest + 1)
    }

    /// Add a participant with the next free code and return its id.
    pub fn add_participant(&mut self) -> String {
        let p = Participant { id: new_id(), code: self.next_code(), ..Default::default() };
        let id = p.id.clone();
        self.participants.push(p);
        id
    }

    /// Remember a tag in the study's list (keeps the first spelling).
    pub fn learn_tag(&mut self, tag: &str) {
        let tag = tag.trim();
        if !tag.is_empty() && !self.tags.iter().any(|t| t.eq_ignore_ascii_case(tag)) {
            self.tags.push(tag.to_string());
        }
    }
}

#[derive(Debug, Clone)]
pub struct StudyStore {
    root: PathBuf,
}

impl StudyStore {
    pub fn new(root: impl Into<PathBuf>) -> Result<Self> {
        let root = root.into();
        fs::create_dir_all(&root).with_context(|| format!("could not create {}", root.display()))?;
        Ok(Self { root })
    }

    fn path(&self, id: &str) -> Result<PathBuf> {
        if id.is_empty() || !id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') {
            bail!("invalid study id");
        }
        Ok(self.root.join(format!("{id}.json")))
    }

    pub fn create(&self, name: &str, language: Language) -> Result<Study> {
        let now = now_ms();
        let mut s = Study {
            id: new_id(),
            name: name.trim().to_string(),
            created_at: now,
            updated_at: now,
            language,
            ..Default::default()
        };
        if language == Language::En {
            s.participant_prefix = "P".into();
        }
        write_json(&self.path(&s.id)?, &s)?;
        Ok(s)
    }

    pub fn load(&self, id: &str) -> Result<Study> {
        read_json(&self.path(id)?)
    }

    pub fn save(&self, study: &mut Study) -> Result<()> {
        study.updated_at = now_ms();
        write_json(&self.path(&study.id)?, study)
    }

    /// All readable studies, by name.
    pub fn list(&self) -> Vec<Study> {
        let mut out: Vec<Study> = fs::read_dir(&self.root)
            .into_iter()
            .flatten()
            .flatten()
            .filter(|e| e.path().extension().is_some_and(|x| x == "json"))
            .filter_map(|e| read_json::<Study>(&e.path()).ok())
            .filter(|s| !s.id.is_empty())
            .collect();
        out.sort_by_key(|s| s.name.to_lowercase());
        out
    }

    pub fn delete(&self, id: &str) -> Result<()> {
        let path = self.path(id)?;
        if path.exists() {
            fs::remove_file(&path).with_context(|| format!("could not delete {}", path.display()))?;
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn participant_codes_count_up_from_the_highest() {
        let mut s = Study::default();
        assert_eq!(s.next_code(), "R01");
        s.add_participant();
        s.add_participant();
        assert_eq!(s.participants[1].code, "R02");
        s.participants[0].code = "R07".into();
        assert_eq!(s.next_code(), "R08");
        s.participant_prefix = "P".into();
        assert_eq!(s.next_code(), "P01");
    }

    #[test]
    fn tags_are_learned_once() {
        let mut s = Study::default();
        s.learn_tag("Pilot");
        s.learn_tag("pilot");
        s.learn_tag(" ");
        assert_eq!(s.tags, ["Pilot"]);
    }

    #[test]
    fn create_list_delete() {
        let dir = std::env::temp_dir().join(format!("pt-study-{}", uuid::Uuid::new_v4()));
        let store = StudyStore::new(&dir).unwrap();
        let mut s = store.create(" Werkdruk ", Language::Nl).unwrap();
        assert_eq!(s.name, "Werkdruk");
        s.add_participant();
        store.save(&mut s).unwrap();
        let list = store.list();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].participants.len(), 1);
        assert!(store.load("../x").is_err());
        store.delete(&s.id).unwrap();
        assert!(store.list().is_empty());
        let _ = fs::remove_dir_all(dir);
    }
}
