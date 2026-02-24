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

pub(crate) fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(crate::plugins::PluginRuntimeState::default())
        .invoke_handler(tauri::generate_handler![
            debug_devtools_status,
            debug_devtools_set,
            crate::plugins::plugin_registry_init,
            crate::plugins::plugin_registry_list,
            crate::plugins::plugin_registry_discover,
            crate::plugins::plugin_import_from_path,
            crate::plugins::plugin_registry_add,
            crate::plugins::plugin_registry_remove,
            crate::plugins::plugin_registry_active,
            crate::plugins::plugin_registry_set_active,
            crate::plugins::plugin_service_start,
            crate::plugins::plugin_service_status,
            crate::plugins::plugin_service_stop,
            crate::plugins::plugin_runtime_llamafile_execute,
            crate::plugins::plugin_asr_load,
            crate::plugins::plugin_asr_transcribe,
            crate::plugins::plugin_asr_unload,
            crate::storage::storage_init,
            crate::storage::storage_list_recordings,
            crate::storage::storage_get_recording,
            crate::storage::storage_save_recording,
            crate::storage::storage_delete_recording,
            crate::storage::storage_export_recording,
            crate::storage::storage_read_text,
            crate::storage::storage_write_attachment_text
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
