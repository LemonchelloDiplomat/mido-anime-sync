mod commands;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            commands::streaming_secret_get,
            commands::streaming_secret_set,
            commands::streaming_secret_remove,
            commands::streaming_http_request,
            commands::animego_auth_open,
            commands::animego_auth_complete,
            commands::animego_auth_status,
            commands::animego_auth_disconnect,
            commands::animego_account_list_fetch
        ])
        .run(tauri::generate_context!())
        .expect("error while running Mido Anime Sync");
}
