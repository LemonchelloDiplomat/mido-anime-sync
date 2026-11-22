mod commands;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            commands::streaming_secret_get,
            commands::streaming_secret_set,
            commands::streaming_secret_remove,
            commands::streaming_http_request
        ])
        .run(tauri::generate_context!())
        .expect("error while running Mido Anime Sync");
}
