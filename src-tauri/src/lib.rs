pub mod plugins;
mod storage;
mod util;

use serde::Serialize;
use tauri::WebviewWindow;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct DevtoolsState {
    available: bool,
    open: bool,
}

#[tauri::command]
fn debug_devtools_status(_window: WebviewWindow) -> Result<DevtoolsState, String> {
    #[cfg(debug_assertions)]
    {
        Ok(DevtoolsState {
            available: true,
            open: _window.is_devtools_open(),
        })
    }
    #[cfg(not(debug_assertions))]
    {
        Ok(DevtoolsState {
            available: false,
            open: false,
        })
    }
}

#[tauri::command]
fn debug_devtools_set(window: WebviewWindow, open: bool) -> Result<DevtoolsState, String> {
    #[cfg(debug_assertions)]
    {
        if open {
            window.open_devtools();
        } else {
            window.close_devtools();
        }
        Ok(DevtoolsState {
            available: true,
            open: window.is_devtools_open(),
        })
    }
    #[cfg(not(debug_assertions))]
    {
        let _ = (window, open);
        Ok(DevtoolsState {
            available: false,
            open: false,
        })
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(plugins::PluginRuntimeState::default())
        .invoke_handler(tauri::generate_handler![
            debug_devtools_status,
            debug_devtools_set,
            plugins::plugin_registry_init,
            plugins::plugin_registry_list,
            plugins::plugin_registry_discover,
            plugins::plugin_import_from_path,
            plugins::plugin_registry_add,
            plugins::plugin_registry_remove,
            plugins::plugin_registry_active,
            plugins::plugin_registry_set_active,
            plugins::plugin_service_start,
            plugins::plugin_service_status,
            plugins::plugin_service_stop,
            plugins::plugin_runtime_llamafile_execute,
            plugins::plugin_asr_load,
            plugins::plugin_asr_transcribe,
            plugins::plugin_asr_unload,
            storage::storage_init,
            storage::storage_list_recordings,
            storage::storage_get_recording,
            storage::storage_save_recording,
            storage::storage_delete_recording,
            storage::storage_export_recording,
            storage::storage_read_text,
            storage::storage_write_attachment_text
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
