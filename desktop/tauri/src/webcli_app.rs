use crate::webcli_core::{
    CoreRuntimeOwner, CreateThreadInput, CreateThreadOutput, EndThreadInput, ProviderInfo,
    SendTextInput, SendTextOutput, SharedCoreRuntime, SubmitToolResultInput, UpdateSettingsInput,
    WebCliError, WebCliSettings,
};
use crate::webcli_ipc::{start_core_ipc_server, start_provider_process};
use crate::webcli_native_registration::register_chrome_native_messaging_host;
use crate::webcli_paths::{
    ensure_user_path_contains_webcli_dir, ensure_webcli_tool_installed_from_current_exe,
    prepend_webcli_dir_to_process_path,
};
use std::thread;
use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{Emitter, Manager, RunEvent, State};

const MAIN_WINDOW_LABEL: &str = "main";

pub fn run() {
    let runtime_owner = CoreRuntimeOwner::new();
    let runtime = runtime_owner.runtime();
    let runtime_for_setup = runtime.clone();
    let runtime_for_exit = runtime.clone();

    tauri::Builder::default()
        .manage(runtime_owner)
        .invoke_handler(tauri::generate_handler![
            create_thread,
            get_settings,
            update_settings,
            list_providers,
            send_text,
            submit_tool_result,
            end_thread
        ])
        .setup(move |app| {
            let webcli_tool_path =
                ensure_webcli_tool_installed_from_current_exe().map_err(|err| {
                    tauri::Error::from(std::io::Error::other(format!(
                        "cannot install webcli-tool: {}",
                        err.message
                    )))
                })?;
            prepend_webcli_dir_to_process_path().map_err(|err| {
                tauri::Error::from(std::io::Error::other(format!(
                    "cannot update app PATH for webcli-tool: {}",
                    err.message
                )))
            })?;
            ensure_user_path_contains_webcli_dir().map_err(|err| {
                tauri::Error::from(std::io::Error::other(format!(
                    "cannot update user PATH for webcli-tool: {}",
                    err.message
                )))
            })?;
            let ipc_handle = start_core_ipc_server(runtime_for_setup.clone()).map_err(|err| {
                tauri::Error::from(std::io::Error::other(format!(
                    "cannot start Core IPC server: {}",
                    err.message
                )))
            })?;
            forward_thread_events_to_tauri(app.handle().clone(), runtime_for_setup.clone());
            #[cfg(debug_assertions)]
            eprintln!(
                "Core IPC listening at {} (runtime: {})",
                ipc_handle.runtime_file.endpoint,
                ipc_handle.runtime_file_path.to_string_lossy()
            );
            #[cfg(debug_assertions)]
            eprintln!(
                "webcli-tool installed at {}",
                webcli_tool_path.to_string_lossy()
            );
            match register_chrome_native_messaging_host() {
                Ok(registration) => {
                    #[cfg(debug_assertions)]
                    eprintln!(
                        "Chrome native messaging host {} registered (manifest: {}, binary: {})",
                        registration.host_name,
                        registration.manifest_path.to_string_lossy(),
                        registration.native_host_path.to_string_lossy()
                    );
                }
                Err(err) => {
                    #[cfg(debug_assertions)]
                    eprintln!(
                        "Chrome native messaging auto-registration skipped: {}",
                        err.message
                    );
                }
            }

            let show = MenuItem::with_id(app, "show", "Show Window", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show, &quit])?;

            let icon = app
                .default_window_icon()
                .ok_or_else(|| tauri::Error::from(std::io::Error::other("missing app icon")))?;

            let _tray = TrayIconBuilder::with_id("main-tray")
                .icon(icon.clone())
                .menu(&menu)
                .tooltip("WebCLI")
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "show" => show_main_window(app),
                    "quit" => app.exit(0),
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        show_main_window(tray.app_handle());
                    }
                })
                .build(app)?;

            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                let _ = window.hide();
                api.prevent_close();
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(move |_, event| {
            if let RunEvent::ExitRequested { api, code, .. } = event {
                if code.is_none() {
                    api.prevent_exit();
                } else {
                    let errors = runtime_for_exit.lock().unwrap().cleanup_for_app_exit();
                    #[cfg(debug_assertions)]
                    for err in errors {
                        eprintln!("sandbox cleanup failed during app exit: {}", err.message);
                    }
                }
            }
        });
}

fn show_main_window(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window(MAIN_WINDOW_LABEL) {
        let _ = window.show();
        let _ = window.set_focus();
    }
}

#[tauri::command]
fn create_thread(
    state: State<'_, CoreRuntimeOwner>,
    input: CreateThreadInput,
) -> Result<CreateThreadOutput, WebCliError> {
    state.runtime().lock().unwrap().create_thread(input)
}

#[tauri::command]
fn get_settings(state: State<'_, CoreRuntimeOwner>) -> Result<WebCliSettings, WebCliError> {
    state.runtime().lock().unwrap().get_settings()
}

#[tauri::command]
fn update_settings(
    state: State<'_, CoreRuntimeOwner>,
    input: UpdateSettingsInput,
) -> Result<WebCliSettings, WebCliError> {
    state.runtime().lock().unwrap().update_settings(input)
}

#[tauri::command]
fn list_providers(state: State<'_, CoreRuntimeOwner>) -> Vec<ProviderInfo> {
    state.runtime().lock().unwrap().list_providers()
}

#[tauri::command]
fn send_text(
    state: State<'_, CoreRuntimeOwner>,
    input: SendTextInput,
) -> Result<SendTextOutput, WebCliError> {
    start_provider_process(state.runtime(), input)
}

#[tauri::command]
fn submit_tool_result(
    state: State<'_, CoreRuntimeOwner>,
    input: SubmitToolResultInput,
) -> Result<(), WebCliError> {
    state.runtime().lock().unwrap().submit_tool_result(input)
}

#[tauri::command]
fn end_thread(
    state: State<'_, CoreRuntimeOwner>,
    input: EndThreadInput,
) -> Result<(), WebCliError> {
    state.runtime().lock().unwrap().end_thread(input)
}

fn forward_thread_events_to_tauri(app: tauri::AppHandle, runtime: SharedCoreRuntime) {
    let event_rx = runtime.lock().unwrap().subscribe_all_threads();
    thread::spawn(move || {
        while let Ok(event) = event_rx.recv() {
            let _ = app.emit("thread_event", event);
        }
    });
}
