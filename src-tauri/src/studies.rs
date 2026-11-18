//! Studies and their participants.
//!
//! Every change goes through `with_study`, which holds the study lock while the file is read,
//! changed and written.

use crate::state::AppState;
use pt_core::asr::Language;
use pt_core::study::{Participant, Pseudonym, Study};
use serde::Deserialize;
use tauri::State;

type CmdResult<T> = Result<T, String>;

fn err(e: anyhow::Error) -> String {
    format!("{e:#}")
}

/// Load a study, change it and save it, all under the study lock.
pub fn with_study<T>(state: &AppState, id: &str, change: impl FnOnce(&mut Study) -> T) -> CmdResult<(Study, T)> {
    let _guard = state.study_lock.lock().unwrap();
    let mut study = state.studies.load(id).map_err(err)?;
    let out = change(&mut study);
    state.studies.save(&mut study).map_err(err)?;
    Ok((study, out))
}

/// Remove participants that were only a code and that no interview refers to any more, after
/// interview `except` stopped referring to them. Participants with attributes or notes stay.
pub fn release_participants(state: &AppState, study_id: &str, ids: &[String], except: &str) {
    if ids.is_empty() {
        return;
    }
    let still_used: Vec<String> = state
        .store
        .list()
        .into_iter()
        .filter(|p| p.id != except && p.study_id.as_deref() == Some(study_id))
        .flat_map(|p| p.participant_ids)
        .collect();
    let _ = with_study(state, study_id, |s| {
        s.participants.retain(|p| !(ids.contains(&p.id) && !still_used.contains(&p.id) && p.is_blank()));
    });
}

fn clean_list(items: Vec<String>, max: usize) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for s in items {
        let s = s.trim().to_string();
        if !s.is_empty() && !out.iter().any(|o| o.eq_ignore_ascii_case(&s)) {
            out.push(s);
        }
    }
    out.truncate(max);
    out
}

#[tauri::command]
pub fn list_studies(state: State<'_, AppState>) -> Vec<Study> {
    state.studies.list()
}

#[tauri::command]
pub fn create_study(state: State<'_, AppState>, name: String, language: Language) -> CmdResult<Study> {
    if name.trim().is_empty() {
        return Err("a study needs a name".into());
    }
    state.studies.create(&name, language).map_err(err)
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct StudyPatch {
    name: Option<String>,
    language: Option<Language>,
    glossary: Option<Vec<String>>,
    pause_threshold: Option<f64>,
    interviewer: Option<String>,
    interviewer_label: Option<String>,
    participant_prefix: Option<String>,
    attributes: Option<Vec<String>>,
    tags: Option<Vec<String>>,
    notes: Option<String>,
    pseudonyms: Option<Vec<Pseudonym>>,
    keep_terms: Option<Vec<String>>,
}

#[tauri::command]
pub fn update_study(state: State<'_, AppState>, id: String, patch: StudyPatch) -> CmdResult<Study> {
    let (study, ()) = with_study(&state, &id, |s| {
        if let Some(name) = patch.name.filter(|n| !n.trim().is_empty()) {
            s.name = name.trim().to_string();
        }
        if let Some(l) = patch.language {
            s.language = l;
        }
        if let Some(g) = patch.glossary {
            s.glossary = clean_list(g, 120);
        }
        if let Some(t) = patch.pause_threshold {
            s.pause_threshold = t.clamp(0.5, 60.0);
        }
        if let Some(i) = patch.interviewer {
            s.interviewer = i.trim().to_string();
        }
        if let Some(l) = patch.interviewer_label.filter(|l| !l.trim().is_empty()) {
            s.interviewer_label = l.trim().to_string();
        }
        if let Some(p) = patch.participant_prefix {
            s.participant_prefix = p.trim().chars().take(8).collect();
        }
        if let Some(a) = patch.attributes {
            s.attributes = clean_list(a, 30);
        }
        if let Some(t) = patch.tags {
            s.tags = clean_list(t, 200);
        }
        if let Some(n) = patch.notes {
            s.notes = n;
        }
        if let Some(list) = patch.pseudonyms {
            // Keep rules being typed (empty replacement) but not empty terms; one rule per term.
            let mut clean: Vec<Pseudonym> = Vec::new();
            for r in list {
                let find = r.find.trim().to_string();
                if !find.is_empty() && !clean.iter().any(|c| c.find.eq_ignore_ascii_case(&find)) {
                    clean.push(Pseudonym { find, replace: r.replace });
                }
            }
            clean.truncate(500);
            s.pseudonyms = clean;
        }
        if let Some(list) = patch.keep_terms {
            s.keep_terms = clean_list(list, 2000);
        }
    })?;
    Ok(study)
}

/// Delete a study. Its interviews are deleted too, or kept as interviews without a study.
#[tauri::command]
pub fn delete_study(state: State<'_, AppState>, id: String, delete_interviews: bool) -> CmdResult<()> {
    for mut p in state.store.list().into_iter().filter(|p| p.study_id.as_deref() == Some(id.as_str())) {
        if delete_interviews {
            crate::commands::delete_project_files(&state, &p.id)?;
        } else {
            p.study_id = None;
            p.participant_ids.clear();
            state.store.save(&mut p).map_err(err)?;
        }
    }
    let _guard = state.study_lock.lock().unwrap();
    state.studies.delete(&id).map_err(err)
}

/// Add (empty id) or replace a participant. A new participant without a code gets the next one.
#[tauri::command]
pub fn save_participant(state: State<'_, AppState>, study_id: String, participant: Participant) -> CmdResult<Study> {
    let (study, ()) = with_study(&state, &study_id, |s| {
        let mut p = participant;
        p.code = p.code.trim().to_string();
        if p.id.is_empty() {
            p.id = pt_core::study::new_id();
            if p.code.is_empty() {
                p.code = s.next_code();
            }
            s.participants.push(p);
        } else if let Some(slot) = s.participants.iter_mut().find(|x| x.id == p.id) {
            if p.code.is_empty() {
                p.code = slot.code.clone();
            }
            *slot = p;
        }
    })?;
    Ok(study)
}

/// Remove a participant and unlink it from every interview.
#[tauri::command]
pub fn delete_participant(state: State<'_, AppState>, study_id: String, participant_id: String) -> CmdResult<Study> {
    for mut p in state.store.list().into_iter().filter(|p| p.participant_ids.contains(&participant_id)) {
        p.participant_ids.retain(|x| x != &participant_id);
        state.store.save(&mut p).map_err(err)?;
    }
    let (study, ()) = with_study(&state, &study_id, |s| s.participants.retain(|p| p.id != participant_id))?;
    Ok(study)
}
