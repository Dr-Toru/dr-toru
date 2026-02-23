mod app;
pub mod plugins;
mod storage;
mod util;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    app::run();
}
