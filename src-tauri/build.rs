use base64::{engine::general_purpose::STANDARD, Engine as _};
use std::{env, fs, path::PathBuf};

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
    let attributes = tauri_build::Attributes::new().windows_attributes(
        tauri_build::WindowsAttributes::new().window_icon_path(&icon_path),
    );
    tauri_build::try_build(attributes).expect("failed to run tauri-build");
}
