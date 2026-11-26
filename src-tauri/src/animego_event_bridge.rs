use serde_json::Value;
use std::{
    collections::HashMap,
    sync::{Mutex, OnceLock},
    time::Duration,
};
use tauri::{Manager, WebviewWindow};
use tokio::sync::oneshot;
use uuid::Uuid;

const AUTH_WINDOW: &str = "animego-auth";
const MAX_RESULT_BYTES: usize = 1024 * 1024;
const OP_TIMEOUT: Duration = Duration::from_secs(25);

struct PendingOperation {
    sender: oneshot::Sender<Result<Value, String>>,
    stage: String,
}

fn pending() -> &'static Mutex<HashMap<String, PendingOperation>> {
    static PENDING: OnceLock<Mutex<HashMap<String, PendingOperation>>> = OnceLock::new();
    PENDING.get_or_init(|| Mutex::new(HashMap::new()))
}

fn verify_auth_window(window: &WebviewWindow) -> Result<(), String> {
    if window.label() != AUTH_WINDOW {
        return Err("AnimeGO bridge is available only in the authenticated window.".into());
    }
    let url = window.url().map_err(|_| "Could not verify the AnimeGO window URL.".to_string())?;
    if url.scheme() != "https" || url.host_str() != Some("animego.me") {
        return Err("AnimeGO bridge requires an https://animego.me page.".into());
    }
    Ok(())
}

#[tauri::command]
pub fn animego_bridge_stage(
    window: WebviewWindow,
    op_id: String,
    stage: String,
) -> Result<(), String> {
    verify_auth_window(&window)?;
    if stage.len() > 120 {
        return Err("Operation stage is too long.".into());
    }
    let mut guard = pending().lock().map_err(|_| "AnimeGO operation registry is unavailable.".to_string())?;
    let operation = guard.get_mut(&op_id).ok_or_else(|| "Unknown or expired AnimeGO operation.".to_string())?;
    operation.stage = stage;
    Ok(())
}

#[tauri::command]
pub fn animego_bridge_complete(
    window: WebviewWindow,
    op_id: String,
    result: Option<Value>,
    error: Option<String>,
) -> Result<(), String> {
    verify_auth_window(&window)?;
    let payload = result.unwrap_or(Value::Null);
    if serde_json::to_vec(&payload).map_err(|_| "Could not encode AnimeGO result.".to_string())?.len() > MAX_RESULT_BYTES {
        return Err("AnimeGO operation result exceeds the allowed size.".into());
    }
    let operation = pending().lock()
        .map_err(|_| "AnimeGO operation registry is unavailable.".to_string())?
        .remove(&op_id)
        .ok_or_else(|| "Unknown or already completed AnimeGO operation.".to_string())?;
    let completion = match error {
        Some(message) => Err(message.chars().take(500).collect()),
        None => Ok(payload),
    };
    operation.sender.send(completion)
        .map_err(|_| "AnimeGO operation is no longer waiting for a result.".to_string())
}

/// Dispatches a narrowly-scoped status-add request inside the authenticated WebView2.
/// Cookies and CSRF material never leave the browser context.
pub async fn add_to_list(
    app: &tauri::AppHandle,
    anime_id: u64,
    list_type: u8,
) -> Result<Value, String> {
    if anime_id == 0 || !(1..=6).contains(&list_type) {
        return Err("Invalid AnimeGO title ID or list status.".into());
    }
    let window = app.get_webview_window(AUTH_WINDOW)
        .ok_or_else(|| "Open and connect AnimeGO before changing a list status.".to_string())?;
    verify_auth_window(&window)?;

    let op_id = Uuid::new_v4().to_string();
    let (sender, receiver) = oneshot::channel();
    {
        let mut guard = pending().lock()
            .map_err(|_| "AnimeGO operation registry is unavailable.".to_string())?;
        guard.insert(op_id.clone(), PendingOperation { sender, stage: "created".into() });
    }

    let endpoint = format!("/mylist/anime/{anime_id}/{list_type}/add");
    let op_json = serde_json::to_string(&op_id).map_err(|_| "Could not encode operation ID.".to_string())?;
    let endpoint_json = serde_json::to_string(&endpoint).map_err(|_| "Could not encode AnimeGO endpoint.".to_string())?;
    let script = format!(r#"(() => {{
      const opId = {op_json};
      const endpoint = {endpoint_json};
      const invoke = window.__TAURI__?.core?.invoke;
      if (!invoke) return false;
      const report = (result, error) => invoke('animego_bridge_complete', {{
        opId, result: result ?? null, error: error ?? null
      }}).catch(() => {{}});
      invoke('animego_bridge_stage', {{ opId, stage: 'reading-csrf' }}).catch(() => {{}});
      const token = document.querySelector('meta[name="csrf-token"]')?.content
        || document.querySelector('input[name="_token"]')?.value
        || document.querySelector('input[name="token"]')?.value;
      const body = new URLSearchParams();
      if (token) body.set('_token', token);
      invoke('animego_bridge_stage', {{ opId, stage: 'posting-status' }}).catch(() => {{}});
      fetch(endpoint, {{
        method: 'POST',
        credentials: 'same-origin',
        headers: {{
          'Accept': 'application/json, text/plain, */*',
          'X-Requested-With': 'XMLHttpRequest',
          ...(token ? {{ 'X-CSRF-TOKEN': token }} : {{}})
        }},
        body
      }}).then(async response => {{
        const text = (await response.text()).slice(0, 50000);
        await report({{ status: response.status, ok: response.ok, url: response.url, body: text }}, null);
      }}).catch(error => report(null, String(error?.message ?? error)));
      return true;
    }})()"#);

    if let Err(error) = window.eval(&script) {
        if let Ok(mut guard) = pending().lock() { guard.remove(&op_id); }
        return Err(format!("Could not dispatch AnimeGO operation: {error}"));
    }

    match tokio::time::timeout(OP_TIMEOUT, receiver).await {
        Ok(Ok(result)) => result,
        Ok(Err(_)) => Err("AnimeGO operation ended before returning a result.".into()),
        Err(_) => {
            let stage = pending().lock().ok()
                .and_then(|mut guard| guard.remove(&op_id))
                .map(|operation| operation.stage)
                .unwrap_or_else(|| "unknown".into());
            Err(format!("AnimeGO operation timed out at stage: {stage}."))
        }
    }
}
