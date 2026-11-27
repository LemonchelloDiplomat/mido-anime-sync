mod commands;
mod animego_bridge;
mod animego_event_bridge;
mod animego_script_inspector;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .on_window_event(|window, event| {
            if window.label() == "animego-auth" {
                if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            commands::streaming_secret_get,
            commands::streaming_secret_set,
            commands::streaming_secret_remove,
            commands::streaming_http_request,
            commands::animego_auth_open,
            commands::animego_auth_complete,
            commands::animego_auth_status,
            commands::animego_auth_disconnect,
            commands::animego_account_list_fetch,
            commands::animego_account_write_inspect,
            commands::animego_account_rating_write,
            commands::animego_account_status_write,
            commands::animego_account_delete,
            commands::animego_account_progress_fetch,
            commands::animego_account_progress_write,
            commands::animego_network_inspect,
            commands::animego_ipc_ready,
            animego_bridge::animego_ipc_test,
            animego_event_bridge::animego_bridge_stage,
            animego_event_bridge::animego_bridge_complete,
            animego_event_bridge::animego_bridge_ping
        ])
        .run(tauri::generate_context!())
        .expect("error while running Mido Anime Sync");
}
