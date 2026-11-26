use base64::{engine::general_purpose::STANDARD, Engine as _};
use std::{env, fs, path::PathBuf};

const APP_COMMANDS: &[&str] = &[
    "streaming_secret_get",
    "streaming_secret_set",
    "streaming_secret_remove",
    "streaming_http_request",
    "animego_auth_open",
    "animego_auth_complete",
    "animego_auth_status",
    "animego_auth_disconnect",
    "animego_account_list_fetch",
    "animego_account_write_inspect",
    "animego_account_rating_write",
    "animego_account_status_write",
    "animego_account_delete",
    "animego_account_progress_fetch",
    "animego_account_progress_write",
    "animego_network_inspect",
    "animego_ipc_ready",
    "animego_ipc_test",
];

fn main() {
    let manifest_dir = PathBuf::from(env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR is set"));
    let icon_path = manifest_dir.join("icons").join("icon.ico");
    let encoded_icon = include_str!("icons/icon.ico.b64");
    let icon_bytes = STANDARD.decode(encoded_icon.trim()).expect("valid embedded Windows icon");

    let current_icon = fs::read(&icon_path).ok();
    if current_icon.as_deref() != Some(icon_bytes.as_slice()) {
        fs::create_dir_all(icon_path.parent().expect("icon has a parent"))
            .expect("create Tauri icon directory");
        fs::write(&icon_path, icon_bytes).expect("write generated Tauri Windows icon");
    }

    println!("cargo:rerun-if-changed=icons/icon.ico.b64");
    let attributes = tauri_build::Attributes::new()
        .app_manifest(tauri_build::AppManifest::new().commands(APP_COMMANDS))
        .windows_attributes(
            tauri_build::WindowsAttributes::new().window_icon_path(&icon_path),
        );
    tauri_build::try_build(attributes).expect("failed to run tauri-build");
}
