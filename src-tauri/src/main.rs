// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod app;
mod plugins;
mod storage;
mod util;

fn main() {
    app::run()
}
