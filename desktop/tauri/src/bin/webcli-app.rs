#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    webcli_lib::webcli_app::run();
}
