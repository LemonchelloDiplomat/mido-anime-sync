use base64::{engine::general_purpose::STANDARD, Engine as _};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use uuid::Uuid;

const KEYRING_SERVICE: &str = "com.mido-anime-sync.streaming";
const SESSION_KEY_PREFIX: &str = "mido-anime-sync:streaming-session:v1:";
const KEYRING_CHUNK_SIZE: usize = 1500;
const MAX_SECRET_BYTES: usize = 128 * 1024;
const MAX_HTTP_BODY_BYTES: usize = 1024 * 1024;
const MAX_HTTP_RESPONSE_BYTES: usize = 8 * 1024 * 1024;

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SecretManifest {
    generation: String,
    chunks: usize,
}

#[cfg(target_os = "windows")]
fn keyring_entry(account: &str) -> Result<keyring::Entry, String> {
    keyring::Entry::new(KEYRING_SERVICE, account)
        .map_err(|_| "Windows Credential Manager is unavailable.".to_string())
}

#[cfg(target_os = "windows")]
fn read_keyring_value(account: &str) -> Result<Option<String>, String> {
    let entry = keyring_entry(account)?;
    match entry.get_password() {
        Ok(value) => Ok(Some(value)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(_) => Err("Windows Credential Manager read failed.".to_string()),
    }
}

#[cfg(target_os = "windows")]
fn write_keyring_value(account: &str, value: &str) -> Result<(), String> {
    keyring_entry(account)?
        .set_password(value)
        .map_err(|_| "Windows Credential Manager write failed.".to_string())
}

#[cfg(target_os = "windows")]
fn remove_keyring_value(account: &str) -> Result<(), String> {
    let entry = keyring_entry(account)?;
    match entry.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(_) => Err("Windows Credential Manager delete failed.".to_string()),
    }
}

fn validate_secret_key(key: &str) -> Result<(), String> {
    if !key.starts_with(SESSION_KEY_PREFIX)
        || key.len() > 220
        || key.chars().any(char::is_control)
    {
        return Err("Invalid streaming session key.".to_string());
    }
    Ok(())
}

#[tauri::command]
pub fn streaming_secret_get(key: String) -> Result<Option<String>, String> {
    validate_secret_key(&key)?;
    #[cfg(target_os = "windows")]
    {
        let manifest_key = format!("{key}:manifest");
        let Some(raw_manifest) = read_keyring_value(&manifest_key)? else {
            return Ok(None);
        };
        let manifest: SecretManifest = serde_json::from_str(&raw_manifest)
            .map_err(|_| "Stored session metadata is invalid.".to_string())?;
        if manifest.chunks == 0 || manifest.chunks > 128 {
            return Err("Stored session metadata is outside allowed limits.".to_string());
        }
        let mut encoded = String::new();
        for index in 0..manifest.chunks {
            let chunk_key = format!("{key}:{}:{index}", manifest.generation);
            let chunk = read_keyring_value(&chunk_key)?
                .ok_or_else(|| "Stored session is incomplete.".to_string())?;
            encoded.push_str(&chunk);
        }
        let bytes = STANDARD.decode(encoded)
            .map_err(|_| "Stored session data is invalid.".to_string())?;
        let value = String::from_utf8(bytes)
            .map_err(|_| "Stored session data is not valid UTF-8.".to_string())?;
        return Ok(Some(value));
    }
    #[cfg(not(target_os = "windows"))]
    {
        Err("Windows secure storage is unavailable on this platform.".to_string())
    }
}

#[tauri::command]
pub fn streaming_secret_set(key: String, value: String) -> Result<(), String> {
    validate_secret_key(&key)?;
    if value.is_empty() || value.len() > MAX_SECRET_BYTES {
        return Err("Streaming session payload is empty or too large.".to_string());
    }
    #[cfg(target_os = "windows")]
    {
        let manifest_key = format!("{key}:manifest");
        let old_manifest = read_keyring_value(&manifest_key)?
            .and_then(|raw| serde_json::from_str::<SecretManifest>(&raw).ok());
        let generation = Uuid::new_v4().to_string();
        let encoded = STANDARD.encode(value.as_bytes());
        let chunks: Vec<&str> = encoded.as_bytes()
            .chunks(KEYRING_CHUNK_SIZE)
            .map(|chunk| std::str::from_utf8(chunk).expect("base64 is ASCII"))
            .collect();
        if chunks.is_empty() || chunks.len() > 128 {
            return Err("Streaming session payload is outside allowed limits.".to_string());
        }

        for (index, chunk) in chunks.iter().enumerate() {
            let chunk_key = format!("{key}:{generation}:{index}");
            if let Err(error) = write_keyring_value(&chunk_key, chunk) {
                for cleanup_index in 0..index {
                    let _ = remove_keyring_value(&format!("{key}:{generation}:{cleanup_index}"));
                }
                return Err(error);
            }
        }

        let manifest = SecretManifest { generation: generation.clone(), chunks: chunks.len() };
        let serialized = serde_json::to_string(&manifest)
            .map_err(|_| "Could not encode session metadata.".to_string())?;
        if let Err(error) = write_keyring_value(&manifest_key, &serialized) {
            for index in 0..chunks.len() {
                let _ = remove_keyring_value(&format!("{key}:{generation}:{index}"));
            }
            return Err(error);
        }

        if let Some(old) = old_manifest {
            for index in 0..old.chunks.min(128) {
                let _ = remove_keyring_value(&format!("{key}:{}:{index}", old.generation));
            }
        }
        return Ok(());
    }
    #[cfg(not(target_os = "windows"))]
    {
        Err("Windows secure storage is unavailable on this platform.".to_string())
    }
}

#[tauri::command]
pub fn streaming_secret_remove(key: String) -> Result<(), String> {
    validate_secret_key(&key)?;
    #[cfg(target_os = "windows")]
    {
        let manifest_key = format!("{key}:manifest");
        if let Some(raw_manifest) = read_keyring_value(&manifest_key)? {
            if let Ok(manifest) = serde_json::from_str::<SecretManifest>(&raw_manifest) {
                for index in 0..manifest.chunks.min(128) {
                    remove_keyring_value(&format!("{key}:{}:{index}", manifest.generation))?;
                }
            }
        }
        remove_keyring_value(&manifest_key)?;
        return Ok(());
    }
    #[cfg(not(target_os = "windows"))]
    {
        Err("Windows secure storage is unavailable on this platform.".to_string())
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeHttpRequest {
    provider: String,
    url: String,
    method: Option<String>,
    headers: Option<HashMap<String, String>>,
    body: Option<String>,
    body_base64: Option<String>,
    response_type: Option<String>,
    #[allow(dead_code)]
    with_credentials: Option<bool>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeHttpResponse {
    status: u16,
    headers: HashMap<String, String>,
    data: Value,
    url: String,
}

fn allowed_provider_host(provider: &str, host: &str) -> bool {
    match provider {
        "animego" => host == "animego.me" || host.ends_with(".animego.me"),
        "anixart" => host == "anixart.site" || host.ends_with(".anixart.site"),
        _ => false,
    }
}

fn validate_request_url(provider: &str, raw: &str) -> Result<reqwest::Url, String> {
    let url = reqwest::Url::parse(raw).map_err(|_| "Invalid provider URL.".to_string())?;
    if url.scheme() != "https"
        || !url.host_str().map(|host| allowed_provider_host(provider, host)).unwrap_or(false)
        || url.username() != ""
        || url.password().is_some()
    {
        return Err("Native HTTP request is outside the provider allowlist.".to_string());
    }
    Ok(url)
}

#[tauri::command]
pub async fn streaming_http_request(request: NativeHttpRequest) -> Result<NativeHttpResponse, String> {
    let provider = request.provider.clone();
    let url = validate_request_url(&provider, &request.url)?;
    let method = request.method.as_deref().unwrap_or("GET").to_uppercase();
    if !matches!(method.as_str(), "GET" | "POST" | "PUT" | "PATCH" | "DELETE") {
        return Err("Unsupported HTTP method.".to_string());
    }
    let method = reqwest::Method::from_bytes(method.as_bytes())
        .map_err(|_| "Unsupported HTTP method.".to_string())?;
    let body = if let Some(encoded) = request.body_base64 {
        if encoded.len() > (MAX_HTTP_BODY_BYTES * 4 / 3) + 8 {
            return Err("Provider request body is too large.".to_string());
        }
        STANDARD.decode(encoded).map_err(|_| "Invalid binary request body.".to_string())?
    } else {
        request.body.unwrap_or_default().into_bytes()
    };
    if body.len() > MAX_HTTP_BODY_BYTES {
        return Err("Provider request body is too large.".to_string());
    }

    let redirect_provider = provider.clone();
    let mut builder = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .redirect(reqwest::redirect::Policy::custom(move |attempt| {
            if attempt.previous().len() >= 5 {
                attempt.stop()
            } else if attempt.url().scheme() == "https"
                && attempt.url().host_str().map(|host| allowed_provider_host(&redirect_provider, host)).unwrap_or(false)
                && attempt.previous().last().and_then(|previous| previous.host_str()) == attempt.url().host_str()
            {
                attempt.follow()
            } else {
                attempt.stop()
            }
        }));

    // Keep redirects constrained to the provider domains to prevent forwarding
    // session headers to an unrelated host.
    builder = builder.user_agent("MidoAnimeSync/0.5");
    let client = builder.build().map_err(|_| "Native HTTP client could not start.".to_string())?;
    let mut outgoing = client.request(method, url.clone());

    for (name, value) in request.headers.unwrap_or_default() {
        let lower = name.to_ascii_lowercase();
        if !matches!(
            lower.as_str(),
            "accept" | "content-type" | "cookie" | "user-agent" | "x-csrf-token"
                | "x-requested-with" | "authorization" | "origin" | "referer"
        ) {
            return Err("Provider request contains a disallowed header.".to_string());
        }
        let header_name = reqwest::header::HeaderName::from_bytes(name.as_bytes())
            .map_err(|_| "Invalid provider request header.".to_string())?;
        let header_value = reqwest::header::HeaderValue::from_str(&value)
            .map_err(|_| "Invalid provider request header value.".to_string())?;
        outgoing = outgoing.header(header_name, header_value);
    }

    if !body.is_empty() {
        outgoing = outgoing.body(body);
    }

    let mut response = outgoing.send().await
        .map_err(|_| "Provider HTTP request failed.".to_string())?;
    if response.content_length().map(|length| length > MAX_HTTP_RESPONSE_BYTES as u64).unwrap_or(false) {
        return Err("Provider response is too large.".to_string());
    }
    let status = response.status().as_u16();
    let final_url = response.url().to_string();
    if !response.url().host_str().map(|host| allowed_provider_host(&provider, host)).unwrap_or(false) {
        return Err("Provider redirected outside the allowed domains.".to_string());
    }

    let mut safe_headers = HashMap::new();
    for name in ["content-type", "cache-control", "etag", "last-modified", "date"] {
        if let Some(value) = response.headers().get(name).and_then(|v| v.to_str().ok()) {
            safe_headers.insert(name.to_string(), value.to_string());
        }
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await
        .map_err(|_| "Could not read provider response.".to_string())? {
        if bytes.len() + chunk.len() > MAX_HTTP_RESPONSE_BYTES {
            return Err("Provider response is too large.".to_string());
        }
        bytes.extend_from_slice(&chunk);
    }

    let response_type = request.response_type.as_deref().unwrap_or("json");
    let data = match response_type {
        "text" => Value::String(String::from_utf8_lossy(&bytes).into_owned()),
        "arraybuffer" => Value::String(STANDARD.encode(&bytes)),
        "json" if bytes.is_empty() => Value::Null,
        "json" => serde_json::from_slice::<Value>(&bytes)
            .map_err(|_| "Provider returned invalid JSON.".to_string())?,
        _ => return Err("Unsupported provider response type.".to_string()),
    };

    Ok(NativeHttpResponse { status, headers: safe_headers, data, url: final_url })
}


const ANIMEGO_SESSION_KEY: &str = "mido-anime-sync:streaming-session:v1:animego:webview";
const ANIMEGO_AUTH_WINDOW: &str = "animego-auth";
const ANIMEGO_ORIGIN: &str = "https://animego.me";

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AnimeGoStoredSession {
    cookies: Vec<(String, String)>,
    user_id: String,
    account_label: Option<String>,
    connected_at: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AnimeGoAuthStatus {
    connected: bool,
    account_label: Option<String>,
    state: &'static str,
}

fn animego_cookie_header(cookies: &[tauri::webview::Cookie<'static>]) -> Result<String, String> {
    let pairs: Vec<String> = cookies.iter()
        .filter(|cookie| !cookie.name().is_empty())
        .map(|cookie| format!("{}={}", cookie.name(), cookie.value()))
        .collect();
    if pairs.is_empty() {
        return Err("AnimeGO пока не создал cookies. Войди в аккаунт в открытом окне.".to_string());
    }
    let header = pairs.join("; ");
    if header.len() > 16 * 1024 {
        return Err("Размер сессии AnimeGO превышает допустимый лимит.".to_string());
    }
    Ok(header)
}

fn animego_user_from_json(raw: &str) -> Option<(String, Option<String>)> {
    let value: Value = serde_json::from_str(raw).ok()?;
    let id_value = value.get("id").or_else(|| value.get("userId"))?;
    let id = id_value.as_str()
        .map(str::to_string)
        .or_else(|| id_value.as_u64().map(|value| value.to_string()))?;
    if id.is_empty() || !id.chars().all(|character| character.is_ascii_digit()) {
        return None;
    }
    let label = ["username", "login", "name", "nickname"].iter()
        .find_map(|key| value.get(*key).and_then(Value::as_str))
        .map(|value| value.chars().take(100).collect::<String>());
    Some((id, label))
}

fn animego_user_from_html(html: &str) -> Option<(String, Option<String>)> {
    let tag_start = html.find("<html")?;
    let tag_end = html[tag_start..].find('>')? + tag_start;
    let tag = &html[tag_start..tag_end];
    let attr_start = tag.find("data-user")?;
    let after_name = &tag[attr_start + "data-user".len()..];
    let equals = after_name.find('=')?;
    let after_equals = after_name[equals + 1..].trim_start();
    let quote = after_equals.chars().next()?;
    if quote != '"' && quote != '\'' { return None; }
    let raw = &after_equals[1..];
    let end = raw.find(quote)?;
    let decoded = raw[..end]
        .replace("&quot;", "\"")
        .replace("&#34;", "\"")
        .replace("&#x22;", "\"")
        .replace("&amp;", "&")
        .replace("&#39;", "'")
        .replace("&apos;", "'");
    animego_user_from_json(&decoded)
}

async fn animego_user_from_webview(window: &tauri::WebviewWindow) -> Result<(String, Option<String>), String> {
    let (sender, receiver) = std::sync::mpsc::channel::<String>();
    window.eval_with_callback(
        "JSON.stringify({ href: window.location.href, user: document.documentElement?.dataset?.user ?? null })",
        move |result| { let _ = sender.send(result); },
    ).map_err(|_| "Не удалось проверить страницу AnimeGO внутри WebView2.".to_string())?;

    let callback_result = tauri::async_runtime::spawn_blocking(move || {
        receiver.recv_timeout(std::time::Duration::from_secs(5))
    }).await.map_err(|_| "Не удалось получить результат проверки AnimeGO.".to_string())?
        .map_err(|_| "Страница AnimeGO не ответила на проверку авторизации.".to_string())?;

    let mut payload: Value = serde_json::from_str(&callback_result)
        .map_err(|_| "AnimeGO вернул некорректный результат проверки авторизации.".to_string())?;
    if let Some(serialized) = payload.as_str() {
        payload = serde_json::from_str(serialized)
            .map_err(|_| "AnimeGO вернул некорректные данные профиля.".to_string())?;
    }

    let page_url = payload.get("href").and_then(Value::as_str)
        .ok_or_else(|| "Не удалось подтвердить адрес страницы AnimeGO.".to_string())?;
    let parsed_url = reqwest::Url::parse(page_url)
        .map_err(|_| "Некорректный адрес страницы AnimeGO.".to_string())?;
    if parsed_url.scheme() != "https" || parsed_url.host_str() != Some("animego.me") {
        return Err("Страница авторизации покинула домен AnimeGO.".to_string());
    }

    let user_json = payload.get("user").and_then(Value::as_str)
        .ok_or_else(|| "AnimeGO ещё не подтвердил вход. Заверши авторизацию на сайте и повтори проверку.".to_string())?;
    animego_user_from_json(user_json)
        .ok_or_else(|| "Не удалось прочитать подтверждённый профиль AnimeGO.".to_string())
}

#[tauri::command]
pub async fn animego_auth_open(app: tauri::AppHandle) -> Result<(), String> {
    use tauri::{Manager, WebviewUrl};
    use tauri::webview::WebviewWindowBuilder;

    if let Some(window) = app.get_webview_window(ANIMEGO_AUTH_WINDOW) {
        window.show().map_err(|_| "Не удалось показать окно AnimeGO.".to_string())?;
        window.set_focus().map_err(|_| "Не удалось активировать окно AnimeGO.".to_string())?;
        return Ok(());
    }

    let url = format!("{ANIMEGO_ORIGIN}/login").parse()
        .map_err(|_| "Некорректный адрес входа AnimeGO.".to_string())?;
    WebviewWindowBuilder::new(&app, ANIMEGO_AUTH_WINDOW, WebviewUrl::External(url))
        .title("Вход в AnimeGO")
        .inner_size(1040.0, 780.0)
        .min_inner_size(760.0, 560.0)
        .resizable(true)
        .build()
        .map_err(|_| "Не удалось открыть встроенное окно AnimeGO.".to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn animego_auth_complete(app: tauri::AppHandle) -> Result<AnimeGoAuthStatus, String> {
    use tauri::Manager;

    let window = app.get_webview_window(ANIMEGO_AUTH_WINDOW)
        .ok_or_else(|| "Сначала открой окно входа AnimeGO.".to_string())?;
    let current_url = window.url().map_err(|_| "Не удалось проверить адрес окна AnimeGO.".to_string())?;
    if current_url.scheme() != "https" || current_url.host_str() != Some("animego.me") {
        return Err("Окно авторизации находится не на домене AnimeGO. Вернись на animego.me.".to_string());
    }

    let site_url = ANIMEGO_ORIGIN.parse()
        .map_err(|_| "Некорректный адрес AnimeGO.".to_string())?;
    let cookies = window.cookies_for_url(site_url)
        .map_err(|_| "Не удалось получить защищённую сессию из WebView2.".to_string())?;
    let _cookie_header = animego_cookie_header(&cookies)?;
    // Verify the authenticated first-party page in WebView2 itself. This avoids
    // a second network client request and keeps the sign-in path inside the site session.
    let (user_id, account_label) = animego_user_from_webview(&window).await?;

    let cookie_pairs = cookies.iter()
        .filter(|cookie| !cookie.name().is_empty())
        .map(|cookie| (cookie.name().to_string(), cookie.value().to_string()))
        .collect::<Vec<_>>();
    let session = AnimeGoStoredSession {
        cookies: cookie_pairs,
        user_id,
        account_label: account_label.clone(),
        connected_at: chrono_like_now(),
    };
    let serialized = serde_json::to_string(&session)
        .map_err(|_| "Не удалось подготовить защищённую сессию AnimeGO.".to_string())?;
    streaming_secret_set(ANIMEGO_SESSION_KEY.to_string(), serialized)?;

    let _ = window.close();
    Ok(AnimeGoAuthStatus {
        connected: true,
        account_label,
        state: "connected",
    })
}

fn chrono_like_now() -> String {
    // Timestamp is informational only; avoid adding a date/time dependency to the native shell.
    format!("unix:{}", std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default().as_secs())
}

#[tauri::command]
pub async fn animego_auth_status() -> Result<AnimeGoAuthStatus, String> {
    let Some(raw) = streaming_secret_get(ANIMEGO_SESSION_KEY.to_string())? else {
        return Ok(AnimeGoAuthStatus { connected: false, account_label: None, state: "disconnected" });
    };
    let session: AnimeGoStoredSession = serde_json::from_str(&raw)
        .map_err(|_| "Сохранённая сессия AnimeGO повреждена. Подключи аккаунт заново.".to_string())?;
    if session.cookies.is_empty() || session.user_id.is_empty() ||
        !session.user_id.chars().all(|character| character.is_ascii_digit()) {
        let _ = streaming_secret_remove(ANIMEGO_SESSION_KEY.to_string());
        return Ok(AnimeGoAuthStatus { connected: false, account_label: None, state: "expired" });
    }
    // Do not perform a background network probe here: AnimeGO may challenge
    // non-browser clients. The actual session is verified in WebView2 at login
    // and will be checked again when the native list adapter makes its request.
    Ok(AnimeGoAuthStatus {
        connected: true,
        account_label: session.account_label,
        state: "connected",
    })
}

#[tauri::command]
pub async fn animego_auth_disconnect() -> Result<(), String> {
    streaming_secret_remove(ANIMEGO_SESSION_KEY.to_string())
}


#[cfg(test)]
mod animego_auth_tests {
    use super::animego_user_from_html;

    #[test]
    fn recognizes_authenticated_homepage_user_payload() {
        let html = r#"<html data-user="{&quot;id&quot;:1367030,&quot;username&quot;:&quot;demo-user&quot;}"><body></body></html>"#;
        assert_eq!(
            animego_user_from_html(html),
            Some(("1367030".to_string(), Some("demo-user".to_string())))
        );
    }

    #[test]
    fn accepts_string_account_ids_from_the_page_dataset() {
        let html = r#"<html data-user="{&quot;id&quot;:&quot;1367030&quot;,&quot;name&quot;:&quot;demo&quot;}"></html>"#;
        assert_eq!(
            animego_user_from_html(html),
            Some(("1367030".to_string(), Some("demo".to_string())))
        );
    }

    #[test]
    fn rejects_pages_without_authenticated_user_payload() {
        assert_eq!(animego_user_from_html("<html><body>guest</body></html>"), None);
        assert_eq!(animego_user_from_html(r#"<html data-user="{&quot;id&quot;:&quot;not-numeric&quot;}"></html>"#), None);
    }
}
