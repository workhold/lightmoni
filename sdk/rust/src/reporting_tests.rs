use super::*;
use std::{ffi::OsString, path::PathBuf, sync::MutexGuard};

// Environment variables are process-wide; serialize tests and restore on panic.
static ENVIRONMENT: Mutex<()> = Mutex::new(());
const VARIABLES: [&str; 8] = [
    "LIGHTMONI_MODE", "LIGHTMONI_ENDPOINT", "LIGHTMONI_AGENT_ENDPOINT",
    "LIGHTMONI_DATA_KEY", "LIGHTMONI_DATA_KEY_FILE", "LIGHTMONI_KEY",
    "LIGHTMONI_LOCAL_TOKEN", "LIGHTMONI_LOCAL_TOKEN_FILE",
];
struct Environment {
    previous: Vec<(&'static str, Option<OsString>)>,
    directory: PathBuf,
    _lock: MutexGuard<'static, ()>,
}
impl Environment {
    fn new() -> Self {
        let lock = ENVIRONMENT.lock().unwrap_or_else(|error| error.into_inner());
        let previous = VARIABLES.iter().map(|&name| (name, std::env::var_os(name))).collect();
        for name in VARIABLES { std::env::remove_var(name); }
        let directory = std::env::temp_dir().join(format!("lightmoni-reporting-{}", Uuid::new_v4()));
        fs::create_dir(&directory).unwrap();
        Self { previous, directory, _lock: lock }
    }
    fn missing_file(&self) -> PathBuf { self.directory.join("missing-secret") }
}
impl Drop for Environment {
    fn drop(&mut self) {
        for (name, value) in &self.previous {
            if let Some(value) = value { std::env::set_var(name, value); }
            else { std::env::remove_var(name); }
        }
        let _ = fs::remove_dir_all(&self.directory);
    }
}

#[test]
fn direct_ignores_agent_secret_files_and_conflicts() {
    let env = Environment::new();
    std::env::set_var("LIGHTMONI_MODE", "direct");
    std::env::set_var("LIGHTMONI_ENDPOINT", "http://localhost:8080");
    std::env::set_var("LIGHTMONI_DATA_KEY", "platform-key");
    std::env::set_var("LIGHTMONI_AGENT_ENDPOINT", "invalid unused address");
    std::env::set_var("LIGHTMONI_LOCAL_TOKEN", "unused-token");
    std::env::set_var("LIGHTMONI_LOCAL_TOKEN_FILE", env.missing_file());
    let config = ConnectionConfig::from_env().unwrap();
    assert!(config.local_token.is_none());
    assert_eq!(config.selected().unwrap(), (
        "http://localhost:8080".into(), "platform-key".into(),
        "direct".into(), "not_probed".into(), 0,
    ));
}

#[test]
fn agent_ignores_platform_secret_files_and_legacy_conflicts() {
    let env = Environment::new();
    std::env::set_var("LIGHTMONI_MODE", "agent");
    std::env::set_var("LIGHTMONI_AGENT_ENDPOINT", "http://localhost:4318");
    std::env::set_var("LIGHTMONI_LOCAL_TOKEN", "local-token");
    std::env::set_var("LIGHTMONI_ENDPOINT", "invalid unused address");
    std::env::set_var("LIGHTMONI_DATA_KEY", "unused-data");
    std::env::set_var("LIGHTMONI_KEY", "unused-legacy");
    std::env::set_var("LIGHTMONI_DATA_KEY_FILE", env.missing_file());
    let config = ConnectionConfig::from_env().unwrap();
    assert!(config.data_key.is_none());
    assert_eq!(config.selected().unwrap(), (
        "http://localhost:4318".into(), "local-token".into(),
        "agent".into(), "configured".into(), 0,
    ));
}

#[test]
fn selected_credentials_still_reject_conflicting_sources() {
    let env = Environment::new();
    let path = env.directory.join("secret");
    fs::write(&path, "file-secret\n").unwrap();
    std::env::set_var("LIGHTMONI_MODE", "direct");
    std::env::set_var("LIGHTMONI_DATA_KEY", "different-env-data");
    std::env::set_var("LIGHTMONI_DATA_KEY_FILE", &path);
    assert_eq!(ConnectionConfig::from_env().unwrap_err(), "credential_source_conflict: LIGHTMONI_DATA_KEY");
    std::env::set_var("LIGHTMONI_MODE", "agent");
    std::env::set_var("LIGHTMONI_LOCAL_TOKEN", "different-env-token");
    std::env::set_var("LIGHTMONI_LOCAL_TOKEN_FILE", &path);
    assert_eq!(ConnectionConfig::from_env().unwrap_err(), "credential_source_conflict: LIGHTMONI_LOCAL_TOKEN");
}

#[test]
fn direct_keeps_legacy_alias_and_conflict_detection() {
    let _env = Environment::new();
    std::env::set_var("LIGHTMONI_ENDPOINT", "http://localhost:8080");
    std::env::set_var("LIGHTMONI_KEY", "legacy-data");
    let config = ConnectionConfig::from_env().unwrap();
    assert_eq!(config.mode, ConnectionMode::Direct);
    assert_eq!(config.selected().unwrap().1, "legacy-data");
    std::env::set_var("LIGHTMONI_DATA_KEY", "new-data");
    assert_eq!(ConnectionConfig::from_env().unwrap_err(), "credential_source_conflict: LIGHTMONI_KEY");
}

#[test]
fn selected_secret_files_are_loaded_and_validated() {
    let env = Environment::new();
    let path = env.directory.join("secret");
    fs::write(&path, "file-secret\n").unwrap();
    std::env::set_var("LIGHTMONI_MODE", "direct");
    std::env::set_var("LIGHTMONI_ENDPOINT", "http://localhost:8080");
    std::env::set_var("LIGHTMONI_DATA_KEY_FILE", &path);
    assert_eq!(ConnectionConfig::from_env().unwrap().selected().unwrap().1, "file-secret");
    std::env::set_var("LIGHTMONI_MODE", "agent");
    std::env::set_var("LIGHTMONI_LOCAL_TOKEN_FILE", &path);
    assert_eq!(ConnectionConfig::from_env().unwrap().selected().unwrap().1, "file-secret");
    std::env::set_var("LIGHTMONI_LOCAL_TOKEN_FILE", env.missing_file());
    assert_eq!(ConnectionConfig::from_env().unwrap_err(), "LIGHTMONI_LOCAL_TOKEN file unavailable");
    #[cfg(unix)]
    {
        let link = env.directory.join("link");
        std::os::unix::fs::symlink(&path, &link).unwrap();
        std::env::set_var("LIGHTMONI_LOCAL_TOKEN_FILE", link);
        assert_eq!(ConnectionConfig::from_env().unwrap_err(), "LIGHTMONI_LOCAL_TOKEN file must be a regular file");
    }
}

#[test]
fn unknown_mode_is_rejected_before_reading_secrets() {
    let env = Environment::new();
    std::env::set_var("LIGHTMONI_MODE", "unknown");
    std::env::set_var("LIGHTMONI_DATA_KEY_FILE", env.missing_file());
    std::env::set_var("LIGHTMONI_LOCAL_TOKEN_FILE", env.missing_file());
    assert_eq!(ConnectionConfig::from_env().unwrap_err(), "mode must be agent, direct, or auto");
}

#[test]
fn auto_still_validates_both_secret_paths() {
    let env = Environment::new();
    std::env::set_var("LIGHTMONI_MODE", "auto");
    std::env::set_var("LIGHTMONI_LOCAL_TOKEN_FILE", env.missing_file());
    assert_eq!(ConnectionConfig::from_env().unwrap_err(), "LIGHTMONI_LOCAL_TOKEN file unavailable");
    std::env::remove_var("LIGHTMONI_LOCAL_TOKEN_FILE");
    std::env::set_var("LIGHTMONI_DATA_KEY_FILE", env.missing_file());
    assert_eq!(ConnectionConfig::from_env().unwrap_err(), "LIGHTMONI_DATA_KEY file unavailable");
}

#[test]
fn agent_permits_disabled_local_authentication() {
    let _env = Environment::new();
    std::env::set_var("LIGHTMONI_MODE", "agent");
    let selected = ConnectionConfig::from_env().unwrap().selected().unwrap();
    assert_eq!(selected.0, "http://127.0.0.1:4318");
    assert!(selected.1.is_empty());
}
