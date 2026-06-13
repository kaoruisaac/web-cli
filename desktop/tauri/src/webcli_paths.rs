use crate::webcli_core::{error_codes, WebCliError};
use std::env;
use std::ffi::{OsStr, OsString};
use std::fs;
use std::path::{Path, PathBuf};

pub fn webcli_home_dir() -> Result<PathBuf, WebCliError> {
    dirs::home_dir()
        .map(|home| home.join(".webcli"))
        .ok_or_else(|| {
            WebCliError::new(
                error_codes::IPC_UNAVAILABLE,
                "cannot resolve user home directory",
            )
        })
}

pub fn webcli_tool_binary_name() -> &'static str {
    if cfg!(windows) {
        "webcli-tool.exe"
    } else {
        "webcli-tool"
    }
}

pub fn webcli_tool_install_path() -> Result<PathBuf, WebCliError> {
    Ok(webcli_home_dir()?.join(webcli_tool_binary_name()))
}

pub fn webcli_native_host_binary_name() -> &'static str {
    if cfg!(windows) {
        "webcli-native-host.exe"
    } else {
        "webcli-native-host"
    }
}

pub fn webcli_native_host_install_path() -> Result<PathBuf, WebCliError> {
    Ok(webcli_home_dir()?.join(webcli_native_host_binary_name()))
}

pub fn install_webcli_tool_from_path(source: impl AsRef<Path>) -> Result<PathBuf, WebCliError> {
    install_binary_from_paths(
        source,
        webcli_tool_install_path()?,
        "webcli-tool",
        "cannot install webcli-tool binary",
    )
}

pub fn install_webcli_tool_from_paths(
    source: impl AsRef<Path>,
    target: impl AsRef<Path>,
) -> Result<PathBuf, WebCliError> {
    install_binary_from_paths(
        source,
        target,
        "webcli-tool",
        "cannot install webcli-tool binary",
    )
}

pub fn install_webcli_native_host_from_path(
    source: impl AsRef<Path>,
) -> Result<PathBuf, WebCliError> {
    install_binary_from_paths(
        source,
        webcli_native_host_install_path()?,
        "webcli-native-host",
        "cannot install webcli-native-host binary",
    )
}

fn install_binary_from_paths(
    source: impl AsRef<Path>,
    target: impl AsRef<Path>,
    binary_label: &str,
    install_error_message: &str,
) -> Result<PathBuf, WebCliError> {
    let source = source.as_ref();
    let target = target.as_ref();

    if !source.exists() {
        return Err(WebCliError::with_details(
            error_codes::IPC_UNAVAILABLE,
            format!("{binary_label} binary was not found in Tauri resources"),
            serde_json::json!({ "path": source.to_string_lossy() }),
        ));
    }

    if source == target {
        return Ok(target.to_path_buf());
    }

    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent).map_err(|err| {
            WebCliError::with_details(
                error_codes::IPC_UNAVAILABLE,
                "cannot create .webcli directory",
                serde_json::json!({
                    "path": parent.to_string_lossy(),
                    "error": err.to_string()
                }),
            )
        })?;
    }

    fs::copy(source, target).map_err(|err| {
        WebCliError::with_details(
            error_codes::IPC_UNAVAILABLE,
            install_error_message,
            serde_json::json!({
                "source": source.to_string_lossy(),
                "target": target.to_string_lossy(),
                "error": err.to_string()
            }),
        )
    })?;

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut permissions = fs::metadata(target)
            .map_err(|err| {
                WebCliError::with_details(
                    error_codes::IPC_UNAVAILABLE,
                    format!("cannot read installed {binary_label} metadata"),
                    serde_json::json!({
                        "path": target.to_string_lossy(),
                        "error": err.to_string()
                    }),
                )
            })?
            .permissions();
        permissions.set_mode(0o755);
        fs::set_permissions(target, permissions).map_err(|err| {
            WebCliError::with_details(
                error_codes::IPC_UNAVAILABLE,
                format!("cannot mark installed {binary_label} executable"),
                serde_json::json!({
                    "path": target.to_string_lossy(),
                    "error": err.to_string()
                }),
            )
        })?;
    }

    Ok(target.to_path_buf())
}

pub fn path_value_with_webcli_dir(
    existing_path: Option<&OsStr>,
    webcli_dir: &Path,
) -> Result<OsString, WebCliError> {
    if let Some(existing_path) = existing_path {
        if path_contains_dir(existing_path, webcli_dir) {
            return Ok(existing_path.to_os_string());
        }
    }

    let mut paths = vec![webcli_dir.to_path_buf()];
    if let Some(existing_path) = existing_path {
        paths.extend(env::split_paths(existing_path));
    }

    env::join_paths(paths).map_err(|err| {
        WebCliError::with_details(
            error_codes::IPC_UNAVAILABLE,
            "cannot update PATH for webcli-tool",
            serde_json::json!({ "error": err.to_string() }),
        )
    })
}

pub fn path_value_with_default_webcli_dir() -> Result<OsString, WebCliError> {
    let webcli_dir = webcli_home_dir()?;
    path_value_with_webcli_dir(env::var_os("PATH").as_deref(), &webcli_dir)
}

pub fn prepend_webcli_dir_to_process_path() -> Result<(), WebCliError> {
    let path = path_value_with_default_webcli_dir()?;
    env::set_var("PATH", path);
    Ok(())
}

#[cfg(windows)]
pub fn ensure_user_path_contains_webcli_dir() -> Result<(), WebCliError> {
    use winreg::enums::HKEY_CURRENT_USER;
    use winreg::RegKey;

    let webcli_dir = webcli_home_dir()?;
    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    let (environment, _) = hkcu.create_subkey("Environment").map_err(|err| {
        WebCliError::with_details(
            error_codes::IPC_UNAVAILABLE,
            "cannot open user environment registry key",
            serde_json::json!({ "error": err.to_string() }),
        )
    })?;
    let existing = environment.get_value::<String, _>("Path").ok();
    let existing_os = existing.as_deref().map(OsStr::new);
    if existing_os
        .as_ref()
        .is_some_and(|path| path_contains_dir(path, &webcli_dir))
    {
        return Ok(());
    }

    let updated = path_value_with_webcli_dir(existing_os, &webcli_dir)?;
    environment
        .set_value("Path", &updated.to_string_lossy().to_string())
        .map_err(|err| {
            WebCliError::with_details(
                error_codes::IPC_UNAVAILABLE,
                "cannot update user PATH registry value",
                serde_json::json!({ "error": err.to_string() }),
            )
        })
}

#[cfg(not(windows))]
pub fn ensure_user_path_contains_webcli_dir() -> Result<(), WebCliError> {
    Ok(())
}

fn path_contains_dir(path_value: &OsStr, dir: &Path) -> bool {
    env::split_paths(path_value).any(|entry| paths_match(&entry, dir))
}

#[cfg(windows)]
fn paths_match(left: &Path, right: &Path) -> bool {
    left.to_string_lossy()
        .trim_end_matches(['\\', '/'])
        .eq_ignore_ascii_case(right.to_string_lossy().trim_end_matches(['\\', '/']))
}

#[cfg(not(windows))]
fn paths_match(left: &Path, right: &Path) -> bool {
    left == right
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::ffi::OsString;

    #[test]
    fn install_webcli_tool_copies_sibling_binary_to_target() {
        let temp = tempfile::tempdir().unwrap();
        let source_dir = temp.path().join("bin");
        let target_dir = temp.path().join(".webcli");
        fs::create_dir_all(&source_dir).unwrap();
        let source = source_dir.join(webcli_tool_binary_name());
        let target = target_dir.join(webcli_tool_binary_name());
        fs::write(&source, b"fake-tool").unwrap();

        let installed = install_webcli_tool_from_paths(&source, &target).unwrap();

        assert_eq!(installed, target);
        assert_eq!(fs::read(&installed).unwrap(), b"fake-tool");
    }

    #[test]
    fn path_value_prepends_webcli_dir_when_missing() {
        let temp = tempfile::tempdir().unwrap();
        let webcli_dir = temp.path().join(".webcli");
        let other_dir = temp.path().join("other");
        let existing = env::join_paths([other_dir.clone()]).unwrap();

        let updated = path_value_with_webcli_dir(Some(existing.as_os_str()), &webcli_dir).unwrap();
        let paths = env::split_paths(&updated).collect::<Vec<_>>();

        assert_eq!(paths[0], webcli_dir);
        assert_eq!(paths[1], other_dir);
    }

    #[test]
    fn path_value_does_not_duplicate_existing_webcli_dir() {
        let temp = tempfile::tempdir().unwrap();
        let webcli_dir = temp.path().join(".webcli");
        let existing = env::join_paths([webcli_dir.clone()]).unwrap();

        let updated = path_value_with_webcli_dir(Some(existing.as_os_str()), &webcli_dir).unwrap();
        let paths = env::split_paths(&updated).collect::<Vec<_>>();

        assert_eq!(paths, vec![webcli_dir]);
    }

    #[test]
    fn path_value_handles_empty_path() {
        let temp = tempfile::tempdir().unwrap();
        let webcli_dir = temp.path().join(".webcli");

        let updated = path_value_with_webcli_dir(None, &webcli_dir).unwrap();

        assert_eq!(updated, OsString::from(webcli_dir));
    }
}
