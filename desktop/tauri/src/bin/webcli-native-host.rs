fn main() {
    if let Err(err) = webcli_lib::webcli_native_host::run() {
        #[cfg(debug_assertions)]
        eprintln!("native messaging host failed: {err}");
    }
}
