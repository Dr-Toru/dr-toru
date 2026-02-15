mod plugins;
mod storage;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(plugins::PluginRuntimeState::default())
        .invoke_handler(tauri::generate_handler![
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
            storage::storage_init,
            storage::storage_list_recordings,
            storage::storage_get_recording,
            storage::storage_save_recording,
            storage::storage_read_text,
            storage::storage_write_attachment_text
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
