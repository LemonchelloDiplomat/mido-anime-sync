/// Safe IPC smoke-test command for the authenticated AnimeGO webview.
#[tauri::command]
pub fn animego_ipc_test(
    window: tauri::WebviewWindow,
    a: i32,
    b: i32,
) -> Result<i32, String> {
    if window.label() != "animego-auth" {
        return Err("Unauthorized window caller.".to_string());
    }

    let current_url = window
        .url()
        .map_err(|_| "Could not verify the AnimeGO webview URL.".to_string())?;
    if current_url.scheme() != "https" || current_url.host_str() != Some("animego.me") {
        return Err("IPC test is allowed only on https://animego.me.".to_string());
    }

    a.checked_add(b)
        .ok_or_else(|| "IPC test integer overflow.".to_string())
}
