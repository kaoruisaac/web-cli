fn main() {
    if let Err(_err) = webcli_lib::webcli_native_host::run() {
        #[cfg(debug_assertions)]
        eprintln!("native messaging host failed: {_err}");
    }
}
