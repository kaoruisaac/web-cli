#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    native_counter_desktop::webcli_app::run();
}
