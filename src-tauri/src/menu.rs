//! The macOS menu bar: the standard app, Edit, View and Window menus, plus Settings in the app
//! menu, an About panel with the same details as the About section in Settings, and a Help menu
//! with the manual. Windows has no menu bar; there the same things are in the app itself.
//!
//! Menu choices that belong to the web UI are sent to it as a "menu" event ("help", "settings").

use tauri::menu::{AboutMetadataBuilder, Menu, MenuItemBuilder, PredefinedMenuItem, SubmenuBuilder};
use tauri::{AppHandle, Emitter, Runtime};

const COPYRIGHT: &str = "© 2026 Floris Bos · OnPolarity.com";

pub fn build<R: Runtime>(app: &AppHandle<R>, dutch: bool) -> tauri::Result<Menu<R>> {
    let l = |nl: &'static str, en: &'static str| if dutch { nl } else { en };
    let name = app.package_info().name.clone();
    let version = app.package_info().version.to_string();

    let about = AboutMetadataBuilder::new()
        .name(Some(name.clone()))
        .version(Some(version))
        .copyright(Some(COPYRIGHT))
        .credits(Some(l(
            "Open source (MIT-licentie)\nBroncode en problemen melden:\ngithub.com/bosti-hub/polarity-transcribe",
            "Open source (MIT licence)\nSource code and problem reports:\ngithub.com/bosti-hub/polarity-transcribe",
        )))
        .build();

    let settings = MenuItemBuilder::with_id("settings", l("Instellingen…", "Settings…")).accelerator("Cmd+,").build(app)?;
    let app_menu = SubmenuBuilder::new(app, &name)
        .item(&PredefinedMenuItem::about(app, Some(&format!("{} {name}", l("Over", "About"))), Some(about))?)
        .separator()
        .item(&settings)
        .separator()
        .services()
        .separator()
        .hide()
        .hide_others()
        .show_all()
        .separator()
        .quit()
        .build()?;
    let edit = SubmenuBuilder::new(app, l("Wijzig", "Edit")).undo().redo().separator().cut().copy().paste().select_all().build()?;
    let view = SubmenuBuilder::new(app, l("Weergave", "View")).fullscreen().build()?;
    let window = SubmenuBuilder::new(app, l("Venster", "Window")).minimize().maximize().separator().close_window().build()?;
    let manual = MenuItemBuilder::with_id("help", l("Handleiding Polarity Transcribe", "Polarity Transcribe manual")).accelerator("Cmd+?").build(app)?;
    let source = MenuItemBuilder::with_id("page:home", l("Broncode op GitHub", "Source code on GitHub")).build(app)?;
    let issues = MenuItemBuilder::with_id("page:issues", l("Probleem melden…", "Report a problem…")).build(app)?;
    let help = SubmenuBuilder::new(app, l("Help", "Help")).item(&manual).separator().item(&source).item(&issues).build()?;

    Menu::with_items(app, &[&app_menu, &edit, &view, &window, &help])
}

/// What a menu choice does: open a project page, or tell the web UI.
pub fn handle<R: Runtime>(app: &AppHandle<R>, id: &str) {
    if let Some(page) = id.strip_prefix("page:") {
        let _ = crate::commands::open_project_page(page.to_string());
    } else if id == "help" || id == "settings" {
        let _ = app.emit("menu", id);
    }
}
