//! Export and import of interviews and studies as one ZIP file, to pass work on to a colleague.
//! The archive itself is in `pt_core::share`.

use crate::state::AppState;
use pt_core::share::{self, Imported, Kind};
use std::path::PathBuf;
use tauri::{AppHandle, Manager};

type CmdResult<T> = Result<T, String>;

fn err(e: anyhow::Error) -> String {
    format!("{e:#}")
}

/// Write a whole study (`study_id`) or the interviews `ids` to a ZIP file at `dest`. Returns how
/// many interviews went in; interviews that are not transcribed yet are left out.
#[tauri::command]
pub async fn export_archive(app: AppHandle, study_id: Option<String>, ids: Vec<String>, dest: String) -> CmdResult<usize> {
    tauri::async_runtime::spawn_blocking(move || -> CmdResult<usize> {
        let state = app.state::<AppState>();
        let all = state.store.list();
        let (kind, projects) = match &study_id {
            Some(sid) => (Kind::Study, all.into_iter().filter(|p| p.study_id.as_deref() == Some(sid.as_str())).collect::<Vec<_>>()),
            None => (Kind::Interviews, all.into_iter().filter(|p| ids.contains(&p.id)).collect()),
        };
        // A selection of interviews takes their study along when they share one.
        let sid = study_id.clone().or_else(|| {
            let first = projects.first()?.study_id.clone()?;
            projects.iter().all(|p| p.study_id.as_deref() == Some(first.as_str())).then_some(first)
        });
        let study = match sid {
            Some(id) => Some(state.studies.load(&id).map_err(err)?),
            None => None,
        };
        share::export(&state.store, kind, study.as_ref(), &projects, &PathBuf::from(dest)).map_err(err)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Import a ZIP file made by `export_archive`. `copy_suffix` is added to the name of a study or
/// interview that is already on this computer, so the two versions can be told apart.
#[tauri::command]
pub async fn import_archive(app: AppHandle, path: String, copy_suffix: String) -> CmdResult<Imported> {
    tauri::async_runtime::spawn_blocking(move || -> CmdResult<Imported> {
        let state = app.state::<AppState>();
        let _guard = state.study_lock.lock().unwrap();
        share::import(&state.store, &state.studies, &PathBuf::from(path), &copy_suffix).map_err(err)
    })
    .await
    .map_err(|e| e.to_string())?
}
