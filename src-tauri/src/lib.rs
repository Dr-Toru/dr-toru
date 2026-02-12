mod storage;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            storage::storage_init,
            storage::storage_list_sessions,
            storage::storage_get_session,
            storage::storage_save_session,
            storage::storage_write_artifact_text
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
