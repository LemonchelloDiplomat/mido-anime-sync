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

/// Returns the persistent authenticated AnimeGO WebView, recreating it after
/// an application restart. Authentication cookies stay inside the WebView2
/// profile and are never copied into renderer JavaScript.
#[cfg(desktop)]
async fn ensure_auth_window_impl(
    app: &tauri::AppHandle,
    require_bridge: bool,
) -> Result<WebviewWindow, String> {
    let window = if let Some(window) = app.get_webview_window(AUTH_WINDOW) {
        window
    } else {
        use tauri::WebviewUrl;
        use tauri::webview::WebviewWindowBuilder;

        let url = "https://animego.me/login".parse()
            .map_err(|_| "Некорректный адрес входа AnimeGO.".to_string())?;
        WebviewWindowBuilder::new(app, AUTH_WINDOW, WebviewUrl::External(url))
            .title("Вход в AnimeGO")
            .inner_size(1040.0, 780.0)
            .min_inner_size(760.0, 560.0)
            .resizable(true)
            .visible(false)
            .build()
            .map_err(|error| format!("Не удалось восстановить окно AnimeGO: {error}"))?
    };

    let deadline = tokio::time::Instant::now() + Duration::from_secs(20);
    loop {
        let url = window.url()
            .map_err(|error| format!("Не удалось проверить адрес окна AnimeGO: {error}"))?;
        if url.scheme() == "https" && url.host_str() == Some("animego.me") {
            let (sender, receiver) = std::sync::mpsc::channel::<String>();
            window.eval_with_callback(
                "JSON.stringify({ ready: document.readyState === 'complete' || document.readyState === 'interactive', bridge: typeof window.__TAURI__?.core?.invoke === 'function' })",
                move |result| { let _ = sender.send(result); },
            ).map_err(|error| format!("Не удалось проверить готовность WebView AnimeGO: {error}"))?;

            let callback = tauri::async_runtime::spawn_blocking(move || {
                receiver.recv_timeout(Duration::from_secs(2))
            }).await.map_err(|error| format!("Проверка WebView AnimeGO завершилась ошибкой: {error}"))?
                .map_err(|_| "WebView AnimeGO не ответил при восстановлении окна.".to_string())?;

            let mut state: Value = serde_json::from_str(&callback)
                .unwrap_or_else(|_| Value::String(callback));
            if let Some(serialized) = state.as_str() {
                state = serde_json::from_str(serialized).unwrap_or(Value::Null);
            }
            let page_ready = state.get("ready").and_then(Value::as_bool) == Some(true);
            let bridge_ready = state.get("bridge").and_then(Value::as_bool) == Some(true);
            if page_ready && (!require_bridge || bridge_ready) {
                return Ok(window);
            }
        }

        if tokio::time::Instant::now() >= deadline {
            let reason = if require_bridge { "страница или IPC-мост" } else { "страница" };
            return Err(format!("Окно AnimeGO создано, но {reason} не готовы. Открой окно AnimeGO и проверь авторизацию."));
        }
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
}

#[cfg(desktop)]
pub async fn ensure_auth_window(app: &tauri::AppHandle) -> Result<WebviewWindow, String> {
    ensure_auth_window_impl(app, true).await
}

/// Progress polling uses eval_with_callback and does not require the Tauri
/// IPC bridge exposed to remote page JavaScript.
#[cfg(desktop)]
pub async fn ensure_auth_window_for_polling(app: &tauri::AppHandle) -> Result<WebviewWindow, String> {
    ensure_auth_window_impl(app, false).await
}

#[cfg(mobile)]
pub async fn ensure_auth_window(_app: &tauri::AppHandle) -> Result<WebviewWindow, String> {
    Err("Встроенное окно AnimeGO доступно только в Windows-приложении.".to_string())
}

#[cfg(mobile)]
pub async fn ensure_auth_window_for_polling(_app: &tauri::AppHandle) -> Result<WebviewWindow, String> {
    Err("Встроенное окно AnimeGO доступно только в Windows-приложении.".to_string())
}

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
    operation.stage = stage.clone();
    eprintln!("[AnimeGO][{}] stage={}", op_id, stage);
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
    eprintln!("[AnimeGO][{}] bridge_complete error={}", op_id, error.is_some());
    let completion = match error {
        Some(message) => Err(message.chars().take(500).collect()),
        None => Ok(payload),
    };
    operation.sender.send(completion)
        .map_err(|_| "AnimeGO operation is no longer waiting for a result.".to_string())
}

#[tauri::command]
pub async fn animego_bridge_ping(app: tauri::AppHandle) -> Result<Value, String> {
    let window = ensure_auth_window(&app).await?;
    verify_auth_window(&window)?;

    let op_id = Uuid::new_v4().to_string();
    let (sender, receiver) = oneshot::channel();
    {
        let mut guard = pending().lock()
            .map_err(|_| "AnimeGO operation registry is unavailable.".to_string())?;
        guard.insert(op_id.clone(), PendingOperation { sender, stage: "ping-created".into() });
    }
    let op_json = serde_json::to_string(&op_id).map_err(|_| "Could not encode operation ID.".to_string())?;
    let script = format!(r#"(() => {{
      const invoke = window.__TAURI__?.core?.invoke;
      if (!invoke) return false;
      invoke('animego_bridge_complete', {{
        opId: {op_json},
        result: {{ pong: true, transport: 'webview-ipc' }},
        error: null
      }}).catch(() => {{}});
      return true;
    }})()"#);
    if let Err(error) = window.eval(&script) {
        if let Ok(mut guard) = pending().lock() { guard.remove(&op_id); }
        return Err(format!("Could not dispatch AnimeGO bridge ping: {error}"));
    }
    match tokio::time::timeout(OP_TIMEOUT, receiver).await {
        Ok(Ok(result)) => result,
        Ok(Err(_)) => Err("AnimeGO bridge ping ended before completion.".into()),
        Err(_) => {
            if let Ok(mut guard) = pending().lock() { guard.remove(&op_id); }
            Err("AnimeGO event bridge ping timed out.".into())
        }
    }
}

/// Runs an async JavaScript operation in the authenticated AnimeGO WebView and
/// completes it through the event-driven IPC channel. The script may call
/// window.__midoAnimeGoSetStage(stage) to report progress.
pub async fn evaluate(
    app: &tauri::AppHandle,
    script: String,
    timeout: Duration,
) -> Result<Value, String> {
    let window = ensure_auth_window(app).await?;
    verify_auth_window(&window)?;

    let op_id = Uuid::new_v4().to_string();
    let (sender, receiver) = oneshot::channel();
    {
        let mut guard = pending().lock()
            .map_err(|_| "AnimeGO operation registry is unavailable.".to_string())?;
        guard.insert(op_id.clone(), PendingOperation { sender, stage: "dispatched".into() });
    }
    eprintln!("[AnimeGO][{}] operation_started", op_id);

    let op_json = serde_json::to_string(&op_id)
        .map_err(|_| "Could not encode AnimeGO operation ID.".to_string())?;
    let script_json = serde_json::to_string(&script)
        .map_err(|_| "Could not encode AnimeGO script.".to_string())?;
    let bootstrap = format!(r#"(() => {{
      const opId = {op_json};
      const source = {script_json};
      const invoke = window.__TAURI__?.core?.invoke;
      if (!invoke) return false;
      const report = (result, error) => invoke('animego_bridge_complete', {{
        opId, result: result ?? null, error: error ?? null
      }}).catch(() => {{}});
      window.__midoAnimeGoSetStage = (stage) => {{
        invoke('animego_bridge_stage', {{ opId, stage: String(stage).slice(0, 120) }}).catch(() => {{}});
      }};
      Promise.resolve().then(() => (0, eval)(source)).then(result => {{
        delete window.__midoAnimeGoSetStage;
        let value = result ?? null;
        if (typeof value === 'string') {{
          try {{ value = JSON.parse(value); }} catch {{ value = {{ raw: value.slice(0, 50000) }}; }}
        }}
        return report(value, null);
      }}).catch(error => {{
        delete window.__midoAnimeGoSetStage;
        return report(null, String(error?.message ?? error).slice(0, 500));
      }});
      return true;
    }})()"#);

    eprintln!("[AnimeGO][{}] dispatching_script", op_id);
    if let Err(error) = window.eval(&bootstrap) {
        eprintln!("[AnimeGO][{}] dispatch_failed: {}", op_id, error);
        if let Ok(mut guard) = pending().lock() { guard.remove(&op_id); }
        return Err(format!("Could not dispatch AnimeGO WebView operation: {error}"));
    }

    match tokio::time::timeout(timeout, receiver).await {
        Ok(Ok(Ok(value))) => {
            eprintln!("[AnimeGO][{}] operation_succeeded", op_id);
            Ok(value)
        }
        Ok(Ok(Err(error))) => {
            eprintln!("[AnimeGO][{}] operation_failed: {}", op_id, error);
            Err(error)
        }
        Ok(Err(_)) => {
            eprintln!("[AnimeGO][{}] result_channel_closed", op_id);
            Err("AnimeGO operation ended before returning a result.".into())
        }
        Err(_) => {
            let stage = pending().lock().ok()
                .and_then(|mut guard| guard.remove(&op_id))
                .map(|operation| operation.stage)
                .unwrap_or_else(|| "unknown".into());
            eprintln!("[AnimeGO][{}] timeout stage={}", op_id, stage);
            Err(format!("AnimeGO operation timed out at stage: {stage}."))
        }
    }
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
    let window = ensure_auth_window(app).await?;
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
