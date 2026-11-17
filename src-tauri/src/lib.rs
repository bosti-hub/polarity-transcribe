//! Polarity Transcribe desktop shell: wires the engine (`pt-core`) to the web UI.

mod commands;
mod jobs;
mod models;
mod state;
mod studies;

use state::AppState;
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .setup(|app| {
            // Local (non-roaming) app data: interview audio must never sync to a university
            // roaming profile.
            let data_dir = app.path().app_local_data_dir()?;
            let state = AppState::new(data_dir)?;
            state.store.sweep();
            app.manage(state);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::app_info,
            commands::get_settings,
            commands::set_settings,
            commands::list_projects,
            commands::create_project,
            commands::get_project,
            commands::update_project,
            commands::delete_project,
            commands::import_audio,
            commands::cancel_import,
            commands::remove_audio,
            commands::read_peaks,
            commands::quick_sync,
            commands::load_transcript,
            commands::save_transcript,
            commands::load_extras,
            commands::save_extras,
            commands::load_report,
            commands::write_file,
            commands::copy_original,
            commands::reveal_in_folder,
            models::list_models,
            models::download_model,
            models::cancel_download,
            models::delete_model,
            models::import_model,
            jobs::start_job,
            jobs::queue_jobs,
            jobs::job_queue,
            studies::list_studies,
            studies::create_study,
            studies::update_study,
            studies::delete_study,
            studies::save_participant,
            studies::delete_participant,
            jobs::cancel_job,
            jobs::job_status,
        ])
        .build(tauri::generate_context!())
        .expect("error while building Polarity Transcribe")
        .run(|app, event| {
            if let tauri::RunEvent::ExitRequested { .. } = event {
                // Ask a running transcription to stop; its progress is already on disk.
                jobs::stop_all(&app.state::<AppState>());
            }
        });
}
