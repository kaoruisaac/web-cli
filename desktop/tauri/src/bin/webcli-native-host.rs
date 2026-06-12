fn main() {
    if let Err(err) = native_counter_desktop::webcli_native_host::run() {
        #[cfg(debug_assertions)]
        eprintln!("native messaging host failed: {err}");
    }
}
