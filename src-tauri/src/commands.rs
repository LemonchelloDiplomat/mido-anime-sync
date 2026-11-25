use base64::{engine::general_purpose::STANDARD, Engine as _};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use uuid::Uuid;
use crate::animego_script_inspector::{inspect_animego_script, AnimeGoScriptRouteCandidate};

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
    use scraper::{Html, Selector};

    // HTML tag and attribute names are case-insensitive. Parse the document
    // instead of searching raw source so attribute entities are decoded too.
    let document = Html::parse_document(html);
    let selector = Selector::parse("html[data-user]").ok()?;
    let user_json = document.select(&selector).next()?.value().attr("data-user")?;
    animego_user_from_json(user_json)
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
    #[cfg(desktop)]
    {
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
    #[cfg(mobile)]
    {
        let _ = app;
        Err("Встроенная авторизация AnimeGO пока доступна только в Windows-приложении.".to_string())
    }
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
    let cookie_pairs = cookies.iter()
        .filter(|cookie| !cookie.name().is_empty())
        .map(|cookie| (cookie.name().to_string(), cookie.value().to_string()))
        .collect::<Vec<_>>();
    if cookie_pairs.is_empty() {
        return Err("AnimeGO пока не создал cookies. Войди в аккаунт в открытом окне.".to_string());
    }
    let cookie_header = cookie_pairs.iter()
        .map(|(name, value)| format!("{name}={value}"))
        .collect::<Vec<_>>().join("; ");
    if cookie_header.len() > 16 * 1024 {
        return Err("Размер сессии AnimeGO превышает допустимый лимит.".to_string());
    }
    // Verify the authenticated first-party page in WebView2 itself. This avoids
    // a second network client request and keeps the sign-in path inside the site session.
    let (user_id, account_label) = animego_user_from_webview(&window).await?;
    let session = AnimeGoStoredSession {
        cookies: cookie_pairs,
        user_id,
        account_label: account_label.clone(),
        connected_at: chrono_like_now(),
    };
    let serialized = serde_json::to_string(&session)
        .map_err(|_| "Не удалось подготовить защищённую сессию AnimeGO.".to_string())?;
    streaming_secret_set(ANIMEGO_SESSION_KEY.to_string(), serialized)?;

    #[cfg(desktop)]
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


#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct AnimeGoAccountListItem {
    provider: &'static str,
    list_entry_id: String,
    anime_id: Option<String>,
    anime_slug: String,
    url: String,
    title: String,
    alternative_title: Option<String>,
    poster_url: Option<String>,
    list_type: u8,
    release_status: Option<String>,
    episodes_watched: Option<u32>,
    episodes_total: Option<u32>,
    progress_text: Option<String>,
    score: Option<u8>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct AnimeGoAccountListSummary {
    list_type: u8,
    page_count: usize,
    item_count: usize,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct AnimeGoAccountIdentity {
    user_id: String,
    account_label: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AnimeGoAccountListResponse {
    provider: &'static str,
    account: AnimeGoAccountIdentity,
    fetched_at: String,
    lists: Vec<AnimeGoAccountListSummary>,
    total: usize,
    items: Vec<AnimeGoAccountListItem>,
}

struct ParsedAnimeGoListPage {
    items: Vec<AnimeGoAccountListItem>,
    next_page_url: Option<String>,
    next_page_frame_id: Option<String>,
}

struct AnimeGoHttpPage {
    status: u16,
    text: String,
}

fn normalize_html_text(value: String) -> String {
    value.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn parse_leading_number(value: &str) -> Option<u32> {
    let digits = value.trim_start().chars()
        .take_while(|character| character.is_ascii_digit())
        .collect::<String>();
    if digits.is_empty() { None } else { digits.parse().ok() }
}

fn parse_animego_score(value: &str) -> Option<u8> {
    let score = parse_leading_number(value)?;
    (1..=10).contains(&score).then_some(score as u8)
}

fn parse_animego_progress(value: &str) -> (Option<u32>, Option<u32>, Option<String>) {
    let text = normalize_html_text(value.to_string());
    let lower = text.to_lowercase();
    let marker = lower.find("продолжить").map(|index| (index, "продолжить".len()))
        .or_else(|| lower.find("начать").map(|index| (index, "начать".len())));
    let Some((index, marker_len)) = marker else {
        return (None, None, if text.is_empty() { None } else { Some(text) });
    };
    let remainder = &text[index + marker_len..];
    let mut parts = remainder.split('/');
    let watched = parts.next().and_then(parse_leading_number);
    let total = parts.next().and_then(parse_leading_number);
    (watched, total, Some(text))
}

fn safe_animego_title_url(raw: &str, base: &reqwest::Url) -> Option<reqwest::Url> {
    let url = base.join(raw).ok()?;
    if url.scheme() != "https" || url.host_str() != Some("animego.me") {
        return None;
    }
    let slug = url.path().strip_prefix("/anime/")?.trim_end_matches('/');
    if slug.is_empty() || slug.contains('/') {
        return None;
    }
    let id = slug.rsplit_once('-')?.1;
    if id.is_empty() || !id.chars().all(|character| character.is_ascii_digit()) {
        return None;
    }
    Some(url)
}

fn parse_animego_mylist_page(
    html: &str,
    base_url: &reqwest::Url,
    list_type: u8,
) -> Result<ParsedAnimeGoListPage, String> {
    use scraper::{Html, Selector};

    if html.len() > 2 * 1024 * 1024 {
        return Err("Ответ личного списка AnimeGO превышает лимит 2 МБ.".to_string());
    }
    if base_url.scheme() != "https" || base_url.host_str() != Some("animego.me") {
        return Err("Парсер личного списка принимает только страницы animego.me.".to_string());
    }
    if !(1..=6).contains(&list_type) {
        return Err("Неизвестная категория списка AnimeGO.".to_string());
    }

    // Turbo Stream responses wrap cards and the next lazy frame in <template>.
    // Extract those template fragments as ordinary HTML before querying them.
    let mut expanded_html = html.to_string();
    let lower_html = html.to_ascii_lowercase();
    let mut template_cursor = 0usize;
    while let Some(relative_start) = lower_html[template_cursor..].find("<template") {
        let template_start = template_cursor + relative_start;
        let Some(open_end_relative) = lower_html[template_start..].find('>') else { break; };
        let content_start = template_start + open_end_relative + 1;
        let Some(close_relative) = lower_html[content_start..].find("</template") else { break; };
        let content_end = content_start + close_relative;
        expanded_html.push_str(&html[content_start..content_end]);
        template_cursor = content_end + "</template".len();
    }
    let document = Html::parse_document(&expanded_html);
    let card_selector = Selector::parse("div.user-mylist__item[data-mylist-id]")
        .map_err(|_| "Не удалось подготовить парсер карточек AnimeGO.".to_string())?;
    let link_selector = Selector::parse("a[href]")
        .map_err(|_| "Не удалось подготовить парсер ссылок AnimeGO.".to_string())?;
    let title_selector = Selector::parse(".user-mylist__title a")
        .map_err(|_| "Не удалось подготовить парсер названий AnimeGO.".to_string())?;
    let alternative_selector = Selector::parse(".fw-lighter.small")
        .map_err(|_| "Не удалось подготовить парсер альтернативных названий AnimeGO.".to_string())?;
    let release_selector = Selector::parse(".user-profile__status")
        .map_err(|_| "Не удалось подготовить парсер статусов AnimeGO.".to_string())?;
    let rating_selector = Selector::parse("[data-rating-value]")
        .map_err(|_| "Не удалось подготовить парсер оценок AnimeGO.".to_string())?;
    let image_selector = Selector::parse("img")
        .map_err(|_| "Не удалось подготовить парсер постеров AnimeGO.".to_string())?;
    let frame_selector = Selector::parse("turbo-frame[id][src]")
        .map_err(|_| "Не удалось подготовить парсер страниц AnimeGO.".to_string())?;

    let mut items = Vec::new();
    let mut seen = std::collections::HashSet::new();

    for card in document.select(&card_selector) {
        let list_entry_id = card.value().attr("data-mylist-id").unwrap_or("").trim().to_string();
        if list_entry_id.is_empty() || !list_entry_id.chars().all(|character| character.is_ascii_digit()) ||
            !seen.insert(list_entry_id.clone()) {
            continue;
        }

        let anime_url = card.select(&link_selector)
            .filter_map(|anchor| anchor.value().attr("href"))
            .find_map(|href| safe_animego_title_url(href, base_url));
        let Some(anime_url) = anime_url else { continue; };

        let image_alt = card.select(&image_selector).next()
            .and_then(|element| element.value().attr("alt"))
            .map(str::to_string);
        let title = card.select(&title_selector).next()
            .map(|element| normalize_html_text(element.text().collect::<Vec<_>>().join(" ")))
            .filter(|value| !value.is_empty())
            .or_else(|| image_alt)
            .unwrap_or_default();
        if title.is_empty() { continue; }

        let alternative_title = card.select(&alternative_selector).next()
            .map(|element| normalize_html_text(element.text().collect::<Vec<_>>().join(" ")))
            .filter(|value| !value.is_empty());
        let release_status = card.select(&release_selector).next()
            .map(|element| normalize_html_text(element.text().collect::<Vec<_>>().join(" ")))
            .filter(|value| !value.is_empty());
        // AnimeGO exposes a user's personal score in the card's data-rating-value element.
        // Missing or out-of-range values stay unknown instead of being converted to zero.
        let score = card.select(&rating_selector).next()
            .and_then(|element| {
                element.value().attr("data-rating-value")
                    .and_then(parse_animego_score)
                    .or_else(|| parse_animego_score(&normalize_html_text(
                        element.text().collect::<Vec<_>>().join(" ")
                    )))
            });

        let mut poster_url = None;
        if let Some(image) = card.select(&image_selector).next() {
            for name in ["data-original", "data-original-src", "data-lazy-src", "data-src", "src"] {
                let Some(raw) = image.value().attr(name) else { continue; };
                if raw.starts_with("data:") || raw.starts_with("blob:") || raw.starts_with("javascript:") {
                    continue;
                }
                let Ok(mut candidate) = base_url.join(raw) else { continue; };
                let host = candidate.host_str().unwrap_or("");
                let trusted = host == "animego.me" || host == "img.cdngos.com" || host.ends_with(".cdngos.com");
                if !trusted || !matches!(candidate.scheme(), "http" | "https") ||
                    (candidate.path() == "/" && candidate.query().is_none()) { continue; }
                if candidate.scheme() == "http" {
                    let _ = candidate.set_scheme("https");
                }
                poster_url = Some(candidate.to_string());
                break;
            }
        }

        let progress_text = card.select(&link_selector)
            .find(|anchor| anchor.value().attr("href").unwrap_or("").contains("#player"))
            .map(|anchor| normalize_html_text(anchor.text().collect::<Vec<_>>().join(" ")));
        let (episodes_watched, episodes_total, parsed_progress_text) =
            parse_animego_progress(progress_text.as_deref().unwrap_or(""));
        let anime_slug = anime_url.path().split('/').filter(|part| !part.is_empty()).last().unwrap_or("").to_string();
        let anime_id = anime_slug.rsplit_once('-').map(|(_, id)| id.to_string())
            .filter(|id| !id.is_empty() && id.chars().all(|character| character.is_ascii_digit()));

        items.push(AnimeGoAccountListItem {
            provider: "animego",
            list_entry_id,
            anime_id,
            anime_slug,
            url: anime_url.to_string(),
            title,
            alternative_title,
            poster_url,
            list_type,
            release_status,
            episodes_watched,
            episodes_total,
            progress_text: parsed_progress_text,
            score,
        });
    }

    let mut next_page_url = None;
    let mut next_page_frame_id = None;
    let expected_type = list_type.to_string();
    for frame in document.select(&frame_selector) {
        let id = frame.value().attr("id").unwrap_or("");
        let Some(page_suffix) = id.strip_prefix("profile-my-list-page-") else { continue; };
        if page_suffix.is_empty() || !page_suffix.chars().all(|character| character.is_ascii_digit()) {
            continue;
        }
        let Some(raw_src) = frame.value().attr("src") else { continue; };
        let Ok(url) = base_url.join(raw_src) else { continue; };
        if url.scheme() != "https" || url.host_str() != Some("animego.me") ||
            !url.path().starts_with("/user/mylist/") {
            continue;
        }
        let segments = url.path().split('/').filter(|part| !part.is_empty()).collect::<Vec<_>>();
        let frame_type = url.query_pairs().find(|(key, _)| key == "type")
            .map(|(_, value)| value.to_string());
        if segments.len() != 4 || segments[0] != "user" || segments[1] != "mylist" ||
            !segments[2].chars().all(|character| character.is_ascii_digit()) ||
            !segments[3].chars().all(|character| character.is_ascii_digit()) ||
            frame_type.as_deref() != Some(expected_type.as_str()) {
            continue;
        }
        let mut relative = url.path().to_string();
        if let Some(query) = url.query() {
            relative.push('?');
            relative.push_str(query);
        }
        next_page_url = Some(relative);
        next_page_frame_id = Some(id.to_string());
        break;
    }

    Ok(ParsedAnimeGoListPage { items, next_page_url, next_page_frame_id })
}

fn update_animego_cookie_jar(
    cookies: &mut HashMap<String, String>,
    headers: &reqwest::header::HeaderMap,
) {
    for value in headers.get_all(reqwest::header::SET_COOKIE).iter() {
        let Ok(line) = value.to_str() else { continue; };
        let first = line.split(';').next().unwrap_or("");
        let Some((name, cookie_value)) = first.split_once('=') else { continue; };
        let name = name.trim();
        let cookie_value = cookie_value.trim();
        if name.is_empty() || !name.chars().all(|character| character.is_ascii_alphanumeric() ||
            "!#$%&'*+-.^_|~".contains(character) || character as u32 == 96) {
            continue;
        }
        if cookie_value.is_empty() || line.to_ascii_lowercase().contains("max-age=0") {
            cookies.remove(name);
        } else {
            cookies.insert(name.to_string(), cookie_value.to_string());
        }
    }
}

async fn animego_fetch_account_page(
    client: &reqwest::Client,
    cookies: &mut HashMap<String, String>,
    path: &str,
    referer: &str,
    turbo_frame: Option<&str>,
) -> Result<AnimeGoHttpPage, String> {
    if !path.starts_with('/') || path.starts_with("//") {
        return Err("AnimeGO вернул некорректный адрес страницы списка.".to_string());
    }
    let url = reqwest::Url::parse(&format!("{ANIMEGO_ORIGIN}{path}"))
        .map_err(|_| "AnimeGO вернул некорректный адрес страницы списка.".to_string())?;
    if url.scheme() != "https" || url.host_str() != Some("animego.me") {
        return Err("Запрос личного списка вышел за пределы animego.me.".to_string());
    }
    let cookie_header = cookies.iter().map(|(name, value)| format!("{name}={value}")).collect::<Vec<_>>().join("; ");
    if cookie_header.is_empty() || cookie_header.len() > 16 * 1024 {
        return Err("Сохранённая сессия AnimeGO пуста или превышает допустимый размер.".to_string());
    }

    let mut outgoing = client.get(url.clone())
        .header(reqwest::header::ACCEPT, "text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8")
        .header(reqwest::header::USER_AGENT, "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36")
        .header(reqwest::header::REFERER, referer)
        .header(reqwest::header::COOKIE, cookie_header);
    if let Some(frame_id) = turbo_frame {
        if frame_id.len() > 80 || !frame_id.starts_with("profile-my-list-page-") ||
            !frame_id["profile-my-list-page-".len()..].chars().all(|character| character.is_ascii_digit()) {
            return Err("AnimeGO вернул некорректный идентификатор страницы списка.".to_string());
        }
        outgoing = outgoing.header("Turbo-Frame", frame_id);
    }

    let response = outgoing.send().await
        .map_err(|_| "Не удалось связаться с AnimeGO при загрузке личного списка. Проверь интернет, DNS и доступность сайта.".to_string())?;
    let status = response.status().as_u16();
    let final_url = response.url().clone();
    if final_url.scheme() != "https" || final_url.host_str() != Some("animego.me") {
        return Err("AnimeGO перенаправил запрос за пределы разрешённого домена.".to_string());
    }
    update_animego_cookie_jar(cookies, response.headers());

    if response.content_length().map(|length| length > 2 * 1024 * 1024).unwrap_or(false) {
        return Err("AnimeGO вернул слишком большой ответ личного списка.".to_string());
    }
    let mut response = response;
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await
        .map_err(|_| "Не удалось прочитать ответ личного списка AnimeGO.".to_string())? {
        if bytes.len() + chunk.len() > 2 * 1024 * 1024 {
            return Err("AnimeGO вернул слишком большой ответ личного списка.".to_string());
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(AnimeGoHttpPage { status, text: String::from_utf8_lossy(&bytes).into_owned() })
}

#[tauri::command]
pub async fn animego_account_list_fetch() -> Result<AnimeGoAccountListResponse, String> {
    let raw = streaming_secret_get(ANIMEGO_SESSION_KEY.to_string())?
        .ok_or_else(|| "Сначала подключи аккаунт AnimeGO.".to_string())?;
    let mut session: AnimeGoStoredSession = serde_json::from_str(&raw)
        .map_err(|_| "Сохранённая сессия AnimeGO повреждена. Подключи аккаунт заново.".to_string())?;
    if session.cookies.is_empty() || session.user_id.is_empty() ||
        !session.user_id.chars().all(|character| character.is_ascii_digit()) {
        return Err("Сохранённая сессия AnimeGO неполная. Подключи аккаунт заново.".to_string());
    }

    let mut cookies = session.cookies.iter().cloned().collect::<HashMap<_, _>>();
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(20))
        .redirect(reqwest::redirect::Policy::custom(|attempt| {
            if attempt.previous().len() >= 5 {
                attempt.stop()
            } else if attempt.url().scheme() == "https" && attempt.url().host_str() == Some("animego.me") {
                attempt.follow()
            } else {
                attempt.stop()
            }
        }))
        .build()
        .map_err(|_| "Не удалось запустить защищённый HTTP-клиент AnimeGO.".to_string())?;

    let home = animego_fetch_account_page(&client, &mut cookies, "/", ANIMEGO_ORIGIN, None).await?;
    if !(200..300).contains(&home.status) {
        return Err(format!("AnimeGO не подтвердил сессию (HTTP {}). Повтори вход в аккаунт.", home.status));
    }
    let (confirmed_user_id, confirmed_label) = animego_user_from_html(&home.text)
        .ok_or_else(|| "AnimeGO не подтвердил действующую сессию. Возможно, сайт запросил дополнительную проверку. Повтори вход в приложении.".to_string())?;
    if confirmed_user_id != session.user_id {
        return Err("AnimeGO вернул другой аккаунт. Для безопасности импорт остановлен.".to_string());
    }
    if confirmed_label.is_some() {
        session.account_label = confirmed_label;
    }

    let mut lists = Vec::new();
    let mut all_items = Vec::new();
    let mut seen = std::collections::HashSet::new();

    for list_type in 1u8..=6u8 {
        let referer = format!("{ANIMEGO_ORIGIN}/profile/{}?type={}", session.user_id, list_type);
        let profile_path = format!("/profile/{}?type={}", session.user_id, list_type);
        let mut page = animego_fetch_account_page(&client, &mut cookies, &profile_path, ANIMEGO_ORIGIN, None).await?;
        if page.status == 404 {
            let fallback_path = format!("/user/{}?type={}", session.user_id, list_type);
            page = animego_fetch_account_page(&client, &mut cookies, &fallback_path, ANIMEGO_ORIGIN, None).await?;
        }
        if !(200..300).contains(&page.status) {
            return Err(format!("AnimeGO не смог открыть категорию списка {} (HTTP {}).", list_type, page.status));
        }

        let mut page_count = 0usize;
        let mut item_count = 0usize;
        let mut visited_next_urls = std::collections::HashSet::new();
        let mut page_signatures = std::collections::HashSet::new();
        loop {
            let base_url = reqwest::Url::parse(ANIMEGO_ORIGIN)
                .map_err(|_| "Некорректный адрес AnimeGO.".to_string())?;
            let parsed = parse_animego_mylist_page(&page.text, &base_url, list_type)?;

            // A valid page may contain overlapping entries, but an identical
            // page payload repeated in the same category means pagination is stuck.
            let mut page_signature = parsed.items.iter()
                .map(|item| item.list_entry_id.clone())
                .collect::<Vec<_>>();
            page_signature.sort_unstable();
            if !page_signatures.insert(page_signature) {
                return Err(format!(
                    "AnimeGO повторил содержимое страницы категории {}. Загрузка остановлена, чтобы не зациклиться.",
                    list_type
                ));
            }

            page_count = page_count.saturating_add(1);
            item_count += parsed.items.len();
            for item in parsed.items {
                if seen.insert(item.list_entry_id.clone()) {
                    all_items.push(item);
                }
            }

            let Some(next_url) = parsed.next_page_url else { break; };
            if !visited_next_urls.insert(next_url.clone()) {
                return Err(format!(
                    "AnimeGO повторил ссылку следующей страницы категории {}. Загрузка остановлена, чтобы не зациклиться.",
                    list_type
                ));
            }
            tokio::time::sleep(std::time::Duration::from_millis(1500)).await;
            page = animego_fetch_account_page(
                &client,
                &mut cookies,
                &next_url,
                &referer,
                parsed.next_page_frame_id.as_deref(),
            ).await?;
            if !(200..300).contains(&page.status) {
                return Err(format!("AnimeGO не смог загрузить следующую страницу списка (HTTP {}).", page.status));
            }
        }
        lists.push(AnimeGoAccountListSummary { list_type, page_count, item_count });
    }

    session.cookies = cookies.into_iter().collect();
    let serialized = serde_json::to_string(&session)
        .map_err(|_| "Не удалось обновить защищённую сессию AnimeGO.".to_string())?;
    streaming_secret_set(ANIMEGO_SESSION_KEY.to_string(), serialized)?;

    Ok(AnimeGoAccountListResponse {
        provider: "animego",
        account: AnimeGoAccountIdentity {
            user_id: session.user_id,
            account_label: session.account_label,
        },
        fetched_at: chrono_like_now(),
        lists,
        total: all_items.len(),
        items: all_items,
    })
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AnimeGoWriteFieldInspection {
    name: String,
    tag: String,
    input_type: String,
    required: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AnimeGoWriteFormInspection {
    method: String,
    action_path: String,
    enctype: String,
    purpose: String,
    field_names: Vec<String>,
    fields: Vec<AnimeGoWriteFieldInspection>,
    has_csrf_field: bool,
    has_inline_event_handler: bool,
    has_data_action: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AnimeGoInteractiveControlInspection {
    tag: String,
    name: Option<String>,
    input_type: Option<String>,
    id: Option<String>,
    href_path: Option<String>,
    ajax_url_path: Option<String>,
    class_names: Vec<String>,
    controller_names: Vec<String>,
    action_hints: Vec<String>,
    required: bool,
    has_inline_event_handler: bool,
    has_data_action: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AnimeGoAccountListWriteInspection {
    list_type: u8,
    http_status: u16,
    forms: Vec<AnimeGoWriteFormInspection>,
    interactive_controls: Vec<AnimeGoInteractiveControlInspection>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AnimeGoWriteInspection {
    provider: &'static str,
    title_url: String,
    http_status: u16,
    forms: Vec<AnimeGoWriteFormInspection>,
    csrf_meta_names: Vec<String>,
    interactive_controls: Vec<AnimeGoInteractiveControlInspection>,
    account_lists: Vec<AnimeGoAccountListWriteInspection>,
    same_origin_script_paths: Vec<String>,
    inline_script_hints: Vec<String>,
    scripts_inspected: usize,
    scripts_skipped: usize,
    script_route_candidates: Vec<AnimeGoScriptRouteCandidate>,
    note: &'static str,
}

/// Inspect authenticated title-page forms without submitting them or exposing
/// cookies, hidden field values, CSRF values, or authenticated HTML to the UI.
fn parse_animego_write_forms(
    html: &str,
    base_url: &reqwest::Url,
) -> Result<(
    Vec<AnimeGoWriteFormInspection>,
    Vec<String>,
    Vec<AnimeGoInteractiveControlInspection>,
    Vec<String>,
    Vec<String>,
), String> {
    use scraper::{Html, Selector};

    if html.len() > 2 * 1024 * 1024 {
        return Err("Страница AnimeGO превышает лимит 2 МБ.".to_string());
    }
    if base_url.scheme() != "https" || base_url.host_str() != Some("animego.me") {
        return Err("Инспектор принимает только страницы animego.me.".to_string());
    }

    let document = Html::parse_document(html);
    let form_selector = Selector::parse("form")
        .map_err(|_| "Не удалось подготовить анализатор форм AnimeGO.".to_string())?;
    let field_selector = Selector::parse("input[name], select[name], textarea[name], button[name]")
        .map_err(|_| "Не удалось подготовить анализатор полей AnimeGO.".to_string())?;
    let meta_selector = Selector::parse("meta[name]")
        .map_err(|_| "Не удалось подготовить анализатор meta-тегов AnimeGO.".to_string())?;
    let control_selector = Selector::parse("input, select, textarea, button, a, [role='button']")
        .map_err(|_| "Не удалось подготовить анализатор интерактивных элементов AnimeGO.".to_string())?;
    let script_selector = Selector::parse("script")
        .map_err(|_| "Не удалось подготовить анализатор скриптов AnimeGO.".to_string())?;

    let safe_identifier = |value: &str| -> Option<String> {
        let value = value.trim();
        if value.is_empty() || value.len() > 100 { return None; }
        let safe = value.chars()
            .filter(|ch| ch.is_ascii_alphanumeric() || "_-[]:.".contains(*ch))
            .take(100)
            .collect::<String>();
        if safe.is_empty() { None } else { Some(safe) }
    };

    let mut forms = Vec::new();
    for form in document.select(&form_selector).take(100) {
        let method = form.value().attr("method").unwrap_or("GET").trim().to_ascii_uppercase();
        if !matches!(method.as_str(), "GET" | "POST") { continue; }
        let raw_action = form.value().attr("action").unwrap_or(base_url.path());
        let Ok(action) = base_url.join(raw_action) else { continue; };
        if action.scheme() != "https" || action.host_str() != Some("animego.me") { continue; }

        let enctype = match form.value().attr("enctype").unwrap_or("application/x-www-form-urlencoded").trim().to_ascii_lowercase().as_str() {
            "application/x-www-form-urlencoded" => "application/x-www-form-urlencoded",
            "multipart/form-data" => "multipart/form-data",
            "text/plain" => "text/plain",
            _ => "other",
        }.to_string();
        let action_path = action.path().to_string();
        let purpose = if action_path.to_ascii_lowercase().contains("logout") {
            "logout"
        } else if action_path.to_ascii_lowercase().contains("rating") || action_path.to_ascii_lowercase().contains("vote") {
            "rating"
        } else if action_path.to_ascii_lowercase().contains("mylist") {
            "list"
        } else {
            "unknown"
        }.to_string();

        let mut field_names: Vec<String> = Vec::new();
        let mut fields = Vec::new();
        let mut has_csrf_field = false;
        for field in form.select(&field_selector).take(100) {
            let Some(raw_name) = field.value().attr("name") else { continue; };
            let Some(name) = safe_identifier(raw_name) else { continue; };
            let lower = name.to_ascii_lowercase();
            if lower.contains("csrf") || lower == "token" || lower.contains("xsrf") {
                has_csrf_field = true;
            }
            if !field_names.iter().any(|existing| existing == &name) {
                field_names.push(name.clone());
                let tag = field.value().name().to_ascii_lowercase();
                let input_type = if tag == "input" {
                    match field.value().attr("type").unwrap_or("text").trim().to_ascii_lowercase().as_str() {
                        "hidden" | "text" | "number" | "submit" | "button" | "checkbox" | "radio" |
                        "email" | "password" | "search" | "url" | "file" | "date" | "datetime-local" |
                        "time" | "range" | "color" => field.value().attr("type").unwrap_or("text").to_ascii_lowercase(),
                        _ => "other".to_string(),
                    }
                } else {
                    tag.clone()
                };
                fields.push(AnimeGoWriteFieldInspection {
                    name,
                    tag,
                    input_type,
                    required: field.value().attr("required").is_some(),
                });
            }
        }
        let has_inline_event_handler = ["onsubmit", "onclick", "onchange", "oninput"]
            .iter().any(|name| form.value().attr(name).is_some());
        let has_data_action = form.value().attr("data-action").is_some();
        forms.push(AnimeGoWriteFormInspection {
            method,
            action_path,
            enctype,
            purpose,
            field_names,
            fields,
            has_csrf_field,
            has_inline_event_handler,
            has_data_action,
        });
    }

    let mut csrf_meta_names = Vec::new();
    for meta in document.select(&meta_selector).take(100) {
        let name = meta.value().attr("name").unwrap_or("").trim();
        let lower = name.to_ascii_lowercase();
        if (lower.contains("csrf") || lower.contains("xsrf")) && name.len() <= 100 {
            if let Some(name) = safe_identifier(name) { csrf_meta_names.push(name); }
        }
    }
    csrf_meta_names.sort();
    csrf_meta_names.dedup();

    let relevant_words = ["status", "progress", "episode", "mylist", "rating", "vote", "watch"];
    let mut interactive_controls = Vec::new();
    for control in document.select(&control_selector).take(500) {
        let tag = control.value().name().to_ascii_lowercase();
        let name = control.value().attr("name").and_then(safe_identifier);
        let id = control.value().attr("id").and_then(safe_identifier);
        let class_names = control.value().attr("class").unwrap_or("")
            .split_whitespace()
            .filter_map(safe_identifier)
            .take(12)
            .collect::<Vec<_>>();
        let safe_same_origin_path = |raw: &str| -> Option<String> {
            let url = base_url.join(raw).ok()?;
            if url.scheme() != "https" || url.host_str() != Some("animego.me") {
                return None;
            }
            let path = url.path();
            if path.len() > 180 || path.chars().any(char::is_control) {
                return None;
            }
            Some(path.to_string())
        };
        let href_path = control.value().attr("href").and_then(safe_same_origin_path);
        let ajax_url_path = control.value().attr("data-ajax-url").and_then(safe_same_origin_path);
        let controller_names = control.value().attr("data-controller").unwrap_or("")
            .split_whitespace()
            .filter_map(safe_identifier)
            .take(12)
            .collect::<Vec<_>>();
        let action_hints = control.value().attr("data-action").unwrap_or("")
            .split_whitespace()
            .filter_map(|action| {
                let safe = action.chars()
                    .filter(|ch| ch.is_ascii_alphanumeric() || "_-.#@>:".contains(*ch))
                    .take(160)
                    .collect::<String>();
                if safe.is_empty() { None } else { Some(safe) }
            })
            .take(12)
            .collect::<Vec<_>>();
        let searchable = format!(
            "{} {} {} {} {} {} {}",
            name.as_deref().unwrap_or(""),
            id.as_deref().unwrap_or(""),
            class_names.join(" "),
            controller_names.join(" "),
            action_hints.join(" "),
            href_path.as_deref().unwrap_or(""),
            ajax_url_path.as_deref().unwrap_or("")
        ).to_ascii_lowercase();
        if !relevant_words.iter().any(|word| searchable.contains(word)) { continue; }
        let input_type = if tag == "input" {
            Some(control.value().attr("type").unwrap_or("text").to_ascii_lowercase())
        } else { None };
        interactive_controls.push(AnimeGoInteractiveControlInspection {
            tag,
            name,
            input_type,
            id,
            href_path,
            ajax_url_path,
            class_names,
            controller_names,
            action_hints,
            required: control.value().attr("required").is_some(),
            has_inline_event_handler: ["onclick", "onchange", "oninput", "onsubmit"]
                .iter().any(|name| control.value().attr(name).is_some()),
            has_data_action: control.value().attr("data-action").is_some(),
        });
        if interactive_controls.len() >= 100 { break; }
    }

    let mut same_origin_script_paths = Vec::new();
    let mut inline_script_hints = Vec::new();
    let script_hint_tokens = [
        ("addEventListener", "addEventListener"),
        ("onchange", "onchange"),
        ("oninput", "oninput"),
        ("fetch(", "fetch"),
        ("XMLHttpRequest", "XMLHttpRequest"),
        ("mylist", "mylist"),
        ("progress", "progress"),
        ("episode", "episode"),
        ("status", "status"),
        ("rating", "rating"),
        ("vote", "vote"),
    ];
    for script in document.select(&script_selector).take(100) {
        if let Some(src) = script.value().attr("src") {
            if let Ok(url) = base_url.join(src) {
                if url.scheme() == "https" && url.host_str() == Some("animego.me") {
                    same_origin_script_paths.push(url.path().to_string());
                }
            }
        } else {
            let source = script.text().collect::<String>().to_ascii_lowercase();
            for &(needle, label) in &script_hint_tokens {
                if source.contains(&needle.to_ascii_lowercase()) && !inline_script_hints.iter().any(|item| item == label) {
                    inline_script_hints.push(label.to_string());
                }
            }
        }
    }
    same_origin_script_paths.sort();
    same_origin_script_paths.dedup();
    inline_script_hints.sort();

    Ok((forms, csrf_meta_names, interactive_controls, same_origin_script_paths, inline_script_hints))
}

#[tauri::command]
pub async fn animego_account_write_inspect(title_url: String) -> Result<AnimeGoWriteInspection, String> {
    let requested = reqwest::Url::parse(&title_url)
        .map_err(|_| "Некорректная ссылка на тайтл AnimeGO.".to_string())?;
    let origin = reqwest::Url::parse(ANIMEGO_ORIGIN)
        .map_err(|_| "Некорректный адрес AnimeGO.".to_string())?;
    let safe_title = safe_animego_title_url(requested.as_str(), &origin)
        .ok_or_else(|| "Для проверки нужна HTTPS-ссылка на карточку AnimeGO вида /anime/slug-ID.".to_string())?;

    let raw = streaming_secret_get(ANIMEGO_SESSION_KEY.to_string())?
        .ok_or_else(|| "Сначала подключи аккаунт AnimeGO.".to_string())?;
    let session: AnimeGoStoredSession = serde_json::from_str(&raw)
        .map_err(|_| "Сохранённая сессия AnimeGO повреждена. Подключи аккаунт заново.".to_string())?;
    if session.cookies.is_empty() || session.user_id.is_empty() ||
        !session.user_id.chars().all(|character| character.is_ascii_digit()) {
        return Err("Сохранённая сессия AnimeGO неполная. Подключи аккаунт заново.".to_string());
    }

    let mut cookies = session.cookies.iter().cloned().collect::<HashMap<_, _>>();
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(20))
        .redirect(reqwest::redirect::Policy::custom(|attempt| {
            if attempt.previous().len() >= 5 { attempt.stop() }
            else if attempt.url().scheme() == "https" && attempt.url().host_str() == Some("animego.me") { attempt.follow() }
            else { attempt.stop() }
        }))
        .build()
        .map_err(|_| "Не удалось запустить защищённый HTTP-клиент AnimeGO.".to_string())?;

    let mut path = safe_title.path().to_string();
    if let Some(query) = safe_title.query() { path.push('?'); path.push_str(query); }
    let page = animego_fetch_account_page(&client, &mut cookies, &path, ANIMEGO_ORIGIN, None).await?;
    if !(200..300).contains(&page.status) {
        return Err(format!("AnimeGO не смог открыть карточку тайтла (HTTP {}).", page.status));
    }
    let (confirmed_user_id, _) = animego_user_from_html(&page.text)
        .ok_or_else(|| "AnimeGO не подтвердил авторизованный профиль на странице тайтла. Повтори вход.".to_string())?;
    if confirmed_user_id != session.user_id {
        return Err("Страница AnimeGO принадлежит другому аккаунту или сессия истекла. Проверка остановлена.".to_string());
    }

    let (forms, csrf_meta_names, interactive_controls, same_origin_script_paths, inline_script_hints) =
        parse_animego_write_forms(&page.text, &safe_title)?;

    // Inspect the six authenticated list categories as well as the title page.
    // Status/progress/delete controls often live on profile cards rather than
    // the anime detail page. This remains read-only and records only safe paths,
    // field names, and sanitized control metadata.
    let mut account_lists = Vec::new();
    for list_type in 1u8..=6u8 {
        let mut list_path = format!("/profile/{}?type={}", session.user_id, list_type);
        let mut list_page = animego_fetch_account_page(
            &client, &mut cookies, &list_path, ANIMEGO_ORIGIN, None
        ).await?;
        if list_page.status == 404 {
            list_path = format!("/user/{}?type={}", session.user_id, list_type);
            list_page = animego_fetch_account_page(
                &client, &mut cookies, &list_path, ANIMEGO_ORIGIN, None
            ).await?;
        }
        if !(200..300).contains(&list_page.status) {
            account_lists.push(AnimeGoAccountListWriteInspection {
                list_type,
                http_status: list_page.status,
                forms: Vec::new(),
                interactive_controls: Vec::new(),
            });
            continue;
        }
        if let Some((list_user_id, _)) = animego_user_from_html(&list_page.text) {
            if list_user_id != session.user_id {
                return Err("Страница списка AnimeGO принадлежит другому аккаунту. Проверка остановлена.".to_string());
            }
        }
        let list_base = reqwest::Url::parse(ANIMEGO_ORIGIN)
            .map_err(|_| "Некорректный адрес AnimeGO.".to_string())?
            .join(&list_path)
            .map_err(|_| "Некорректный адрес личного списка AnimeGO.".to_string())?;
        let (list_forms, _, list_controls, _, _) = parse_animego_write_forms(&list_page.text, &list_base)?;
        account_lists.push(AnimeGoAccountListWriteInspection {
            list_type,
            http_status: list_page.status,
            forms: list_forms,
            interactive_controls: list_controls,
        });
    }

    // Fetch a small, bounded set of first-party bundles. Never execute them and
    // never return their source, response headers, cookies, or token values.
    let mut scripts_inspected = 0usize;
    let mut scripts_skipped = 0usize;
    let mut script_route_candidates: Vec<AnimeGoScriptRouteCandidate> = Vec::new();
    for script_path in same_origin_script_paths.iter()
        .filter(|path| path.starts_with("/build/") && !path.contains('?'))
        .take(8) {
        tokio::time::sleep(std::time::Duration::from_millis(120)).await;
        let script_page = match animego_fetch_account_page(
            &client, &mut cookies, script_path, safe_title.as_str(), None
        ).await {
            Ok(result) if (200..300).contains(&result.status) => result,
            _ => { scripts_skipped += 1; continue; }
        };
        if script_page.text.trim_start().starts_with("<") {
            scripts_skipped += 1;
            continue;
        }
        scripts_inspected += 1;
        for candidate in inspect_animego_script(&script_page.text) {
            if let Some(existing) = script_route_candidates.iter_mut().find(|item| item.path == candidate.path) {
                for method in candidate.methods {
                    if !existing.methods.contains(&method) { existing.methods.push(method); }
                }
                for capability in candidate.capabilities {
                    if !existing.capabilities.contains(&capability) { existing.capabilities.push(capability); }
                }
                for field in candidate.field_hints {
                    if !existing.field_hints.contains(&field) { existing.field_hints.push(field); }
                }
                for signal in candidate.signals {
                    if !existing.signals.contains(&signal) { existing.signals.push(signal); }
                }
            } else if script_route_candidates.len() < 80 {
                script_route_candidates.push(candidate);
            }
        }
    }

    Ok(AnimeGoWriteInspection {
        provider: "animego",
        title_url: safe_title.to_string(),
        http_status: page.status,
        forms,
        csrf_meta_names,
        interactive_controls,
        account_lists,
        same_origin_script_paths,
        inline_script_hints,
        scripts_inspected,
        scripts_skipped,
        script_route_candidates,
        note: "Только чтение. JavaScript-бандлы анализируются статически и не выполняются. Возвращаются только кандидаты путей и фиксированные подсказки; исходный код, значения полей, токены и cookies не возвращаются. Кандидаты не являются подтверждённым API-контрактом.",
    })
}




#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AnimeGoRatingWriteResult {
    provider: &'static str,
    title_url: String,
    rating: u8,
    http_status: u16,
    submitted: bool,
    verified: bool,
    verified_rating: Option<u8>,
    duration_ms: u128,
}

fn animego_rating_form_data(
    html: &str,
    title_url: &reqwest::Url,
    anime_id: &str,
) -> Result<(String, String, Option<u8>), String> {
    use scraper::{Html, Selector};
    let document = Html::parse_document(html);
    let forms = Selector::parse("form").map_err(|_| "Не удалось разобрать форму оценки AnimeGO.".to_string())?;
    let inputs = Selector::parse("input[name]").map_err(|_| "Не удалось разобрать поля формы AnimeGO.".to_string())?;
    let options = Selector::parse("option").map_err(|_| "Не удалось разобрать варианты оценки AnimeGO.".to_string())?;
    let expected_path = format!("/rating/anime/{anime_id}/vote");
    for form in document.select(&forms) {
        if !form.value().attr("method").unwrap_or("GET").eq_ignore_ascii_case("POST") { continue; }
        let action = form.value().attr("action").unwrap_or(title_url.path());
        let Ok(action_url) = title_url.join(action) else { continue; };
        if action_url.scheme() != "https" || action_url.host_str() != Some("animego.me") ||
            action_url.path() != expected_path { continue; }
        let mut token = None;
        for input in form.select(&inputs) {
            if input.value().attr("name") == Some("token") &&
                input.value().attr("type").unwrap_or("hidden").eq_ignore_ascii_case("hidden") {
                token = input.value().attr("value").filter(|value| !value.trim().is_empty()).map(str::to_string);
                break;
            }
        }
        let token = token.ok_or_else(|| "В форме оценки AnimeGO отсутствует CSRF-токен. Запись остановлена.".to_string())?;
        let mut selected_rating = None;
        if let Ok(selects) = Selector::parse("select[name='rate']") {
            if let Some(select) = form.select(&selects).next() {
                for option in select.select(&options) {
                    if option.value().attr("selected").is_some() {
                        selected_rating = option.value().attr("value").and_then(|value| value.parse::<u8>().ok());
                        break;
                    }
                }
            }
        }
        return Ok((action_url.path().to_string(), token, selected_rating));
    }
    Err("На карточке AnimeGO не найдена ожидаемая POST-форма оценки. Ничего не отправлено.".to_string())
}

#[tauri::command]
pub async fn animego_account_rating_write(
    title_url: String,
    rating: u8,
) -> Result<AnimeGoRatingWriteResult, String> {
    let started = std::time::Instant::now();
    if !(1..=10).contains(&rating) {
        return Err("Оценка AnimeGO должна быть числом от 1 до 10.".to_string());
    }
    let requested = reqwest::Url::parse(&title_url)
        .map_err(|_| "Некорректная ссылка на тайтл AnimeGO.".to_string())?;
    let safe_title = safe_animego_title_url(requested.as_str(), &reqwest::Url::parse(ANIMEGO_ORIGIN).unwrap())
        .ok_or_else(|| "Для записи оценки нужна прямая ссылка на карточку animego.me/anime/…".to_string())?;
    let slug = safe_title.path().trim_end_matches('/').rsplit('/').next().unwrap_or("");
    let anime_id = slug.rsplit_once('-').map(|(_, id)| id)
        .filter(|id| !id.is_empty() && id.chars().all(|ch| ch.is_ascii_digit()))
        .ok_or_else(|| "Не удалось определить ID тайтла AnimeGO.".to_string())?;

    let raw = streaming_secret_get(ANIMEGO_SESSION_KEY.to_string())?
        .ok_or_else(|| "Сначала подключи аккаунт AnimeGO.".to_string())?;
    let mut session: AnimeGoStoredSession = serde_json::from_str(&raw)
        .map_err(|_| "Сохранённая сессия AnimeGO повреждена. Подключи аккаунт заново.".to_string())?;
    if session.cookies.is_empty() || session.user_id.is_empty() ||
        !session.user_id.chars().all(|ch| ch.is_ascii_digit()) {
        return Err("Сохранённая сессия AnimeGO неполная. Подключи аккаунт заново.".to_string());
    }
    let mut cookies = session.cookies.iter().cloned().collect::<HashMap<_, _>>();
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(20))
        .redirect(reqwest::redirect::Policy::custom(|attempt| {
            if attempt.previous().len() >= 5 { attempt.stop() }
            else if attempt.url().scheme() == "https" && attempt.url().host_str() == Some("animego.me") { attempt.follow() }
            else { attempt.stop() }
        }))
        .build()
        .map_err(|_| "Не удалось запустить защищённый HTTP-клиент AnimeGO.".to_string())?;

    let mut title_path = safe_title.path().to_string();
    if let Some(query) = safe_title.query() { title_path.push('?'); title_path.push_str(query); }
    let page = animego_fetch_account_page(&client, &mut cookies, &title_path, ANIMEGO_ORIGIN, None).await?;
    if !(200..300).contains(&page.status) {
        eprintln!("[AnimeGO Sync] operation=rating method=GET endpoint=/anime/{anime_id} status={} result=failed durationMs={}", page.status, started.elapsed().as_millis());
        return Err(format!("AnimeGO не смог открыть карточку тайтла (HTTP {}).", page.status));
    }
    let (confirmed_user_id, _) = animego_user_from_html(&page.text)
        .ok_or_else(|| "AnimeGO не подтвердил авторизованный профиль. Повтори вход.".to_string())?;
    if confirmed_user_id != session.user_id {
        return Err("Страница AnimeGO принадлежит другому аккаунту или сессия истекла.".to_string());
    }
    let (action_path, token, _) = animego_rating_form_data(&page.text, &safe_title, anime_id)?;
    let cookie_header = cookies.iter().map(|(name, value)| format!("{name}={value}")).collect::<Vec<_>>().join("; ");
    if cookie_header.is_empty() || cookie_header.len() > 16 * 1024 {
        return Err("Сохранённая сессия AnimeGO пуста или превышает допустимый размер.".to_string());
    }
    let rating_value = rating.to_string();
    let response = client.post(format!("{ANIMEGO_ORIGIN}{action_path}"))
        .header(reqwest::header::ACCEPT, "text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8")
        .header(reqwest::header::USER_AGENT, "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36")
        .header(reqwest::header::REFERER, safe_title.as_str())
        .header(reqwest::header::COOKIE, cookie_header)
        .form(&[("token", token.as_str()), ("rate", rating_value.as_str())])
        .send().await
        .map_err(|_| "Не удалось отправить оценку в AnimeGO. Проверь соединение.".to_string())?;
    let status = response.status().as_u16();
    let final_url = response.url().clone();
    if final_url.scheme() != "https" || final_url.host_str() != Some("animego.me") {
        return Err("AnimeGO перенаправил запись за пределы разрешённого домена.".to_string());
    }
    update_animego_cookie_jar(&mut cookies, response.headers());
    if response.content_length().map(|length| length > 2 * 1024 * 1024).unwrap_or(false) {
        return Err("Ответ AnimeGO превышает допустимый размер.".to_string());
    }
    let mut response = response;
    let mut response_bytes = Vec::new();
    while let Some(chunk) = response.chunk().await
        .map_err(|_| "Не удалось прочитать ответ AnimeGO после отправки оценки.".to_string())? {
        if response_bytes.len() + chunk.len() > 2 * 1024 * 1024 {
            return Err("Ответ AnimeGO превышает допустимый размер.".to_string());
        }
        response_bytes.extend_from_slice(&chunk);
    }
    if !(200..300).contains(&status) {
        eprintln!("[AnimeGO Sync] operation=rating method=POST endpoint=/rating/anime/{anime_id}/vote status={status} result=failed durationMs={}", started.elapsed().as_millis());
        return Err(format!("AnimeGO отклонил оценку (HTTP {}).", status));
    }

    // A successful HTTP response is not treated as proof of persistence.
    // Re-read the same title page and compare the selected value in the rating form.
    let verify_page = animego_fetch_account_page(&client, &mut cookies, &title_path, ANIMEGO_ORIGIN, None).await;
    let verified_rating = match verify_page {
        Ok(refetched) if (200..300).contains(&refetched.status) => {
            animego_rating_form_data(&refetched.text, &safe_title, anime_id)
                .ok().and_then(|(_, _, selected)| selected)
        }
        _ => None,
    };
    let verified = verified_rating == Some(rating);
    session.cookies = cookies.into_iter().collect();
    let serialized = serde_json::to_string(&session)
        .map_err(|_| "Не удалось обновить защищённую сессию AnimeGO.".to_string())?;
    streaming_secret_set(ANIMEGO_SESSION_KEY.to_string(), serialized)?;
    eprintln!("[AnimeGO Sync] operation=rating method=POST endpoint=/rating/anime/{anime_id}/vote status={status} result={} durationMs={}",
        if verified { "verified" } else { "submitted_unverified" }, started.elapsed().as_millis());

    Ok(AnimeGoRatingWriteResult {
        provider: "animego",
        title_url: safe_title.to_string(),
        rating,
        http_status: status,
        submitted: true,
        verified,
        verified_rating,
        duration_ms: started.elapsed().as_millis(),
    })
}


#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AnimeGoStatusWriteResult {
    provider: &'static str,
    title_url: String,
    status: String,
    list_type: u8,
    http_status: u16,
    submitted: bool,
    verified: bool,
    duration_ms: u128,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AnimeGoDeleteWriteResult {
    provider: &'static str,
    title_url: String,
    http_status: u16,
    submitted: bool,
    verified: bool,
    duration_ms: u128,
}

fn animego_csrf_token(html: &str) -> Result<String, String> {
    use scraper::{Html, Selector};
    let document = Html::parse_document(html);
    let selector = Selector::parse("input[name='_token'], input[name='token']")
        .map_err(|_| "Не удалось разобрать CSRF-поле AnimeGO.".to_string())?;
    document.select(&selector)
        .find_map(|input| input.value().attr("value")
            .filter(|value| !value.trim().is_empty())
            .map(str::to_string))
        .ok_or_else(|| "На странице AnimeGO не найден CSRF-токен. Запись остановлена.".to_string())
}

fn animego_status_list_type(status: &str) -> Result<u8, String> {
    match status {
        "WATCHING" => Ok(1),
        "COMPLETED" => Ok(2),
        "ON_HOLD" => Ok(3),
        "DROPPED" => Ok(4),
        "PLANNING" => Ok(5),
        "REWATCHING" => Ok(6),
        _ => Err("Неизвестный статус AnimeGO.".to_string()),
    }
}

async fn animego_submit_list_mutation(
    title_url: String,
    list_type: Option<u8>,
) -> Result<(reqwest::Url, u16, bool, u128), String> {
    let started = std::time::Instant::now();
    if list_type.map(|value| !(1..=6).contains(&value)).unwrap_or(false) {
        return Err("Категория списка AnimeGO вне допустимого диапазона.".to_string());
    }
    let requested = reqwest::Url::parse(&title_url)
        .map_err(|_| "Некорректная ссылка на тайтл AnimeGO.".to_string())?;
    let origin = reqwest::Url::parse(ANIMEGO_ORIGIN)
        .map_err(|_| "Некорректный адрес AnimeGO.".to_string())?;
    let safe_title = safe_animego_title_url(requested.as_str(), &origin)
        .ok_or_else(|| "Для изменения списка нужна HTTPS-ссылка на карточку animego.me/anime/…".to_string())?;
    let slug = safe_title.path().trim_end_matches('/').rsplit('/').next().unwrap_or("");
    let anime_id = slug.rsplit_once('-').map(|(_, id)| id)
        .filter(|id| !id.is_empty() && id.chars().all(|ch| ch.is_ascii_digit()))
        .ok_or_else(|| "Не удалось определить ID тайтла AnimeGO.".to_string())?;

    let raw = streaming_secret_get(ANIMEGO_SESSION_KEY.to_string())?
        .ok_or_else(|| "Сначала подключи аккаунт AnimeGO.".to_string())?;
    let mut session: AnimeGoStoredSession = serde_json::from_str(&raw)
        .map_err(|_| "Сохранённая сессия AnimeGO повреждена. Подключи аккаунт заново.".to_string())?;
    if session.cookies.is_empty() || session.user_id.is_empty() ||
        !session.user_id.chars().all(|ch| ch.is_ascii_digit()) {
        return Err("Сохранённая сессия AnimeGO неполная. Подключи аккаунт заново.".to_string());
    }
    let mut cookies = session.cookies.iter().cloned().collect::<HashMap<_, _>>();
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(20))
        .redirect(reqwest::redirect::Policy::custom(|attempt| {
            if attempt.previous().len() >= 5 { attempt.stop() }
            else if attempt.url().scheme() == "https" && attempt.url().host_str() == Some("animego.me") { attempt.follow() }
            else { attempt.stop() }
        }))
        .build()
        .map_err(|_| "Не удалось запустить защищённый HTTP-клиент AnimeGO.".to_string())?;

    let mut title_path = safe_title.path().to_string();
    if let Some(query) = safe_title.query() { title_path.push('?'); title_path.push_str(query); }
    let page = animego_fetch_account_page(&client, &mut cookies, &title_path, ANIMEGO_ORIGIN, None).await?;
    if !(200..300).contains(&page.status) {
        return Err(format!("AnimeGO не смог открыть карточку тайтла (HTTP {}).", page.status));
    }
    let (confirmed_user_id, _) = animego_user_from_html(&page.text)
        .ok_or_else(|| "AnimeGO не подтвердил авторизованный профиль. Повтори вход.".to_string())?;
    if confirmed_user_id != session.user_id {
        return Err("Страница AnimeGO принадлежит другому аккаунту или сессия истекла.".to_string());
    }
    let token = animego_csrf_token(&page.text)?;
    let action_path = match list_type {
        Some(value) => format!("/mylist/anime/{anime_id}/{value}/add"),
        None => format!("/mylist/anime/{anime_id}/delete"),
    };
    let cookie_header = cookies.iter().map(|(name, value)| format!("{name}={value}")).collect::<Vec<_>>().join("; ");
    if cookie_header.is_empty() || cookie_header.len() > 16 * 1024 {
        return Err("Сохранённая сессия AnimeGO пуста или превышает допустимый размер.".to_string());
    }
    let response = client.post(format!("{ANIMEGO_ORIGIN}{action_path}"))
        .header(reqwest::header::ACCEPT, "*/*")
        .header(reqwest::header::USER_AGENT, "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36")
        .header(reqwest::header::REFERER, safe_title.as_str())
        .header(reqwest::header::ORIGIN, ANIMEGO_ORIGIN)
        .header(reqwest::header::COOKIE, cookie_header)
        .header("X-Requested-With", "XMLHttpRequest")
        .form(&[("_token", token.as_str())])
        .send().await
        .map_err(|_| "Не удалось отправить изменение списка в AnimeGO. Проверь соединение.".to_string())?;
    let http_status = response.status().as_u16();
    let final_url = response.url().clone();
    if final_url.scheme() != "https" || final_url.host_str() != Some("animego.me") {
        return Err("AnimeGO перенаправил запись за пределы разрешённого домена.".to_string());
    }
    update_animego_cookie_jar(&mut cookies, response.headers());
    if response.content_length().map(|length| length > 2 * 1024 * 1024).unwrap_or(false) {
        return Err("Ответ AnimeGO превышает допустимый размер.".to_string());
    }
    let mut response = response;
    let mut response_bytes = Vec::new();
    while let Some(chunk) = response.chunk().await
        .map_err(|_| "Не удалось прочитать ответ AnimeGO после изменения списка.".to_string())? {
        if response_bytes.len() + chunk.len() > 2 * 1024 * 1024 {
            return Err("Ответ AnimeGO превышает допустимый размер.".to_string());
        }
        response_bytes.extend_from_slice(&chunk);
    }
    if !(200..300).contains(&http_status) {
        return Err(format!("AnimeGO отклонил изменение списка (HTTP {}).", http_status));
    }
    session.cookies = cookies.into_iter().collect();
    let serialized = serde_json::to_string(&session)
        .map_err(|_| "Не удалось обновить защищённую сессию AnimeGO.".to_string())?;
    streaming_secret_set(ANIMEGO_SESSION_KEY.to_string(), serialized)?;
    eprintln!("[AnimeGO Sync] operation={} method=POST endpoint={} status={} result=submitted durationMs={}",
        if list_type.is_some() { "status" } else { "delete" }, action_path, http_status, started.elapsed().as_millis());
    Ok((safe_title, http_status, true, started.elapsed().as_millis()))
}

#[tauri::command]
pub async fn animego_account_status_write(
    title_url: String,
    status: String,
) -> Result<AnimeGoStatusWriteResult, String> {
    let list_type = animego_status_list_type(&status)?;
    let (safe_title, http_status, submitted, duration_ms) =
        animego_submit_list_mutation(title_url, Some(list_type)).await?;
    let fetched = animego_account_list_fetch().await?;
    let anime_id = safe_title.path().trim_end_matches('/').rsplit('-').next().unwrap_or("");
    let verified = fetched.items.iter().any(|item|
        item.anime_id.as_deref() == Some(anime_id) && item.list_type == list_type
    );
    Ok(AnimeGoStatusWriteResult {
        provider: "animego", title_url: safe_title.to_string(), status, list_type,
        http_status, submitted, verified, duration_ms,
    })
}

#[tauri::command]
pub async fn animego_account_delete(
    title_url: String,
) -> Result<AnimeGoDeleteWriteResult, String> {
    let (safe_title, http_status, submitted, duration_ms) =
        animego_submit_list_mutation(title_url, None).await?;
    let anime_id = safe_title.path().trim_end_matches('/').rsplit('-').next().unwrap_or("");
    let fetched = animego_account_list_fetch().await?;
    let verified = !fetched.items.iter().any(|item| item.anime_id.as_deref() == Some(anime_id));
    Ok(AnimeGoDeleteWriteResult {
        provider: "animego", title_url: safe_title.to_string(),
        http_status, submitted, verified, duration_ms,
    })
}



#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AnimeGoEpisodeProgressItem {
    episode_id: String,
    episode_number: u32,
    watched: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AnimeGoProgressSnapshot {
    provider: &'static str,
    title_url: String,
    player_id: String,
    translation_id: String,
    watched_episode_number: u32,
    episodes: Vec<AnimeGoEpisodeProgressItem>,
    http_status: u16,
    duration_ms: u128,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AnimeGoProgressWriteResult {
    provider: &'static str,
    title_url: String,
    requested_progress: u32,
    translation_id: String,
    changed_episodes: u32,
    verified: bool,
    watched_episode_number: u32,
    http_status: u16,
    duration_ms: u128,
}

#[derive(Debug, Clone)]
struct AnimeGoEpisodePageState {
    player_id: String,
    watched_path: String,
    translation_id: String,
    episodes: Vec<AnimeGoEpisodeProgressItem>,
}

fn animego_parse_episode_items(html: &str) -> Result<Vec<AnimeGoEpisodeProgressItem>, String> {
    use scraper::{Html, Selector};
    if html.len() > 2 * 1024 * 1024 {
        return Err("Ответ списка серий AnimeGO превышает лимит 2 МБ.".to_string());
    }
    let document = Html::parse_document(html);
    let selector = Selector::parse("[data-episode][data-episode-number][data-episode-watched]")
        .map_err(|_| "Не удалось подготовить парсер серий AnimeGO.".to_string())?;
    let mut episodes = Vec::new();
    let mut seen_ids = std::collections::HashSet::new();
    let mut seen_numbers = std::collections::HashSet::new();
    for element in document.select(&selector) {
        let id = element.value().attr("data-episode").unwrap_or("").trim();
        let number = element.value().attr("data-episode-number").unwrap_or("").trim();
        let watched = element.value().attr("data-episode-watched").unwrap_or("");
        let (Ok(number), Ok(_)) = (number.parse::<u32>(), id.parse::<u64>()) else { continue; };
        if number == 0 || number > 10000 || !seen_ids.insert(id.to_string()) || !seen_numbers.insert(number) {
            continue;
        }
        if !matches!(watched, "true" | "false") { continue; }
        episodes.push(AnimeGoEpisodeProgressItem {
            episode_id: id.to_string(),
            episode_number: number,
            watched: watched == "true",
        });
    }
    episodes.sort_by_key(|episode| episode.episode_number);
    if episodes.is_empty() {
        return Err("AnimeGO не вернул распознаваемые серии. Прогресс не изменён.".to_string());
    }
    if episodes.len() > 500 {
        return Err("Список серий AnimeGO превышает безопасный лимит.".to_string());
    }
    Ok(episodes)
}

async fn animego_load_episode_state(
    client: &reqwest::Client,
    cookies: &mut HashMap<String, String>,
    title_url: &reqwest::Url,
    anime_id: &str,
) -> Result<AnimeGoEpisodePageState, String> {
    let player_page = animego_fetch_account_page(
        client, cookies, &format!("/player/{anime_id}"), title_url.as_str(), None
    ).await?;
    if !(200..300).contains(&player_page.status) {
        return Err(format!("AnimeGO не смог открыть плеер (HTTP {}).", player_page.status));
    }
    let player_json: Value = serde_json::from_str(&player_page.text)
        .map_err(|_| "AnimeGO вернул некорректный ответ плеера.".to_string())?;
    if player_json.get("status").and_then(Value::as_str) != Some("success") {
        return Err("AnimeGO не подтвердил загрузку плеера.".to_string());
    }
    let player_html = player_json.pointer("/data/content").and_then(Value::as_str)
        .ok_or_else(|| "В ответе AnimeGO отсутствует HTML плеера.".to_string())?;
    let document = scraper::Html::parse_document(player_html);
    let selector = scraper::Selector::parse(".player-video[data-anime-player-episodes-url-value][data-anime-episode-watched-url-value]")
        .map_err(|_| "Не удалось разобрать HTML плеера AnimeGO.".to_string())?;
    let player = document.select(&selector).next()
        .ok_or_else(|| "В плеере AnimeGO отсутствуют данные списка серий.".to_string())?;
    let player_id = player.value().attr("data-anime-player-anime-id-value").unwrap_or("").to_string();
    if player_id != anime_id || !player_id.chars().all(|ch| ch.is_ascii_digit()) {
        return Err("ID плеера AnimeGO не совпадает с ID тайтла.".to_string());
    }
    let episodes_path = player.value().attr("data-anime-player-episodes-url-value")
        .ok_or_else(|| "В плеере AnimeGO отсутствует адрес списка серий.".to_string())?.to_string();
    let watched_path = player.value().attr("data-anime-episode-watched-url-value")
        .ok_or_else(|| "В плеере AnimeGO отсутствует адрес записи прогресса.".to_string())?.to_string();
    if watched_path != "/anime/episode/watched" {
        return Err("Адрес записи прогресса AnimeGO не прошёл проверку.".to_string());
    }
    let active_selector = scraper::Selector::parse("[data-translation-id].active")
        .map_err(|_| "Не удалось разобрать список переводов AnimeGO.".to_string())?;
    let translation_id = document.select(&active_selector)
        .filter(|element| !element.ancestors()
            .filter_map(scraper::ElementRef::wrap)
            .any(|ancestor| ancestor.value().attr("hidden").is_some()
                || ancestor.value().classes().any(|class_name| class_name == "d-none")))
        .filter_map(|element| element.value().attr("data-translation-id"))
        .find(|value| !value.is_empty() && value.chars().all(|ch| ch.is_ascii_digit()))
        .ok_or_else(|| "Не удалось определить активный видимый перевод AnimeGO.".to_string())?.to_string();

    let origin = reqwest::Url::parse(ANIMEGO_ORIGIN).map_err(|_| "Некорректный адрес AnimeGO.".to_string())?;
    let episodes_url = origin.join(&episodes_path)
        .map_err(|_| "Некорректный адрес списка серий AnimeGO.".to_string())?;
    if episodes_url.scheme() != "https" || episodes_url.host_str() != Some("animego.me") ||
        episodes_url.path() != format!("/player/{player_id}/episodes") || episodes_url.query().is_some() {
        return Err("Адрес списка серий AnimeGO не прошёл проверку.".to_string());
    }
    let episodes_page = animego_fetch_account_page(
        client, cookies, episodes_url.path(), title_url.as_str(), None
    ).await?;
    if !(200..300).contains(&episodes_page.status) {
        return Err(format!("AnimeGO не смог загрузить серии (HTTP {}).", episodes_page.status));
    }
    let episodes_json: Value = serde_json::from_str(&episodes_page.text)
        .map_err(|_| "AnimeGO вернул некорректный список серий.".to_string())?;
    if episodes_json.get("status").and_then(Value::as_str) != Some("success") {
        return Err("AnimeGO не подтвердил загрузку списка серий.".to_string());
    }
    let episodes_html = episodes_json.pointer("/data/content").and_then(Value::as_str)
        .ok_or_else(|| "В ответе AnimeGO отсутствует содержимое списка серий.".to_string())?;
    let episodes = animego_parse_episode_items(episodes_html)?;
    Ok(AnimeGoEpisodePageState {
        player_id,
        watched_path,
        translation_id,
        episodes,
    })
}

async fn animego_save_session_cookies(
    session: &mut AnimeGoStoredSession,
    cookies: HashMap<String, String>,
) -> Result<(), String> {
    session.cookies = cookies.into_iter().collect();
    let serialized = serde_json::to_string(session)
        .map_err(|_| "Не удалось обновить защищённую сессию AnimeGO.".to_string())?;
    streaming_secret_set(ANIMEGO_SESSION_KEY.to_string(), serialized)
}

async fn animego_account_progress_read_inner(
    title_url: String,
) -> Result<(AnimeGoProgressSnapshot, AnimeGoStoredSession, HashMap<String, String>), String> {
    let requested = reqwest::Url::parse(&title_url)
        .map_err(|_| "Некорректная ссылка на тайтл AnimeGO.".to_string())?;
    let origin = reqwest::Url::parse(ANIMEGO_ORIGIN).map_err(|_| "Некорректный адрес AnimeGO.".to_string())?;
    let safe_title = safe_animego_title_url(requested.as_str(), &origin)
        .ok_or_else(|| "Для чтения прогресса нужна прямая ссылка animego.me/anime/…".to_string())?;
    let anime_id = safe_title.path().trim_end_matches('/').rsplit('-').next().unwrap_or("");
    let raw = streaming_secret_get(ANIMEGO_SESSION_KEY.to_string())?
        .ok_or_else(|| "Сначала подключи аккаунт AnimeGO.".to_string())?;
    let mut session: AnimeGoStoredSession = serde_json::from_str(&raw)
        .map_err(|_| "Сохранённая сессия AnimeGO повреждена. Подключи аккаунт заново.".to_string())?;
    if session.cookies.is_empty() || session.user_id.is_empty() ||
        !session.user_id.chars().all(|ch| ch.is_ascii_digit()) {
        return Err("Сохранённая сессия AnimeGO неполная. Подключи аккаунт заново.".to_string());
    }
    let mut cookies = session.cookies.iter().cloned().collect::<HashMap<_, _>>();
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(20))
        .redirect(reqwest::redirect::Policy::custom(|attempt| {
            if attempt.previous().len() >= 5 { attempt.stop() }
            else if attempt.url().scheme() == "https" && attempt.url().host_str() == Some("animego.me") { attempt.follow() }
            else { attempt.stop() }
        }))
        .build().map_err(|_| "Не удалось запустить защищённый HTTP-клиент AnimeGO.".to_string())?;
    let home = animego_fetch_account_page(&client, &mut cookies, "/", ANIMEGO_ORIGIN, None).await?;
    if !(200..300).contains(&home.status) {
        return Err(format!("AnimeGO не подтвердил сессию (HTTP {}). Повтори вход.", home.status));
    }
    let (user_id, _) = animego_user_from_html(&home.text)
        .ok_or_else(|| "AnimeGO не подтвердил действующую авторизацию.".to_string())?;
    if user_id != session.user_id {
        return Err("AnimeGO вернул другой аккаунт. Чтение прогресса остановлено.".to_string());
    }
    let state = animego_load_episode_state(&client, &mut cookies, &safe_title, anime_id).await?;
    let watched_episode_number = state.episodes.iter().filter(|episode| episode.watched)
        .map(|episode| episode.episode_number).max().unwrap_or(0);
    let snapshot = AnimeGoProgressSnapshot {
        provider: "animego",
        title_url: safe_title.to_string(),
        player_id: state.player_id,
        translation_id: state.translation_id,
        watched_episode_number,
        episodes: state.episodes,
        http_status: 200,
        duration_ms: 0,
    };
    animego_save_session_cookies(&mut session, cookies.clone()).await?;
    Ok((snapshot, session, cookies))
}

#[tauri::command]
pub async fn animego_account_progress_fetch(title_url: String) -> Result<AnimeGoProgressSnapshot, String> {
    let started = std::time::Instant::now();
    let (mut snapshot, _, _) = animego_account_progress_read_inner(title_url).await?;
    snapshot.duration_ms = started.elapsed().as_millis();
    Ok(snapshot)
}

#[tauri::command]
pub async fn animego_account_progress_write(
    title_url: String,
    progress: u32,
) -> Result<AnimeGoProgressWriteResult, String> {
    let started = std::time::Instant::now();
    let requested = reqwest::Url::parse(&title_url)
        .map_err(|_| "Некорректная ссылка на тайтл AnimeGO.".to_string())?;
    let origin = reqwest::Url::parse(ANIMEGO_ORIGIN).map_err(|_| "Некорректный адрес AnimeGO.".to_string())?;
    let safe_title = safe_animego_title_url(requested.as_str(), &origin)
        .ok_or_else(|| "Для записи прогресса нужна прямая ссылка animego.me/anime/…".to_string())?;
    let anime_id = safe_title.path().trim_end_matches('/').rsplit('-').next().unwrap_or("");
    let raw = streaming_secret_get(ANIMEGO_SESSION_KEY.to_string())?
        .ok_or_else(|| "Сначала подключи аккаунт AnimeGO.".to_string())?;
    let mut session: AnimeGoStoredSession = serde_json::from_str(&raw)
        .map_err(|_| "Сохранённая сессия AnimeGO повреждена. Подключи аккаунт заново.".to_string())?;
    if session.cookies.is_empty() || session.user_id.is_empty() ||
        !session.user_id.chars().all(|ch| ch.is_ascii_digit()) {
        return Err("Сохранённая сессия AnimeGO неполная. Подключи аккаунт заново.".to_string());
    }
    let mut cookies = session.cookies.iter().cloned().collect::<HashMap<_, _>>();
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(20))
        .redirect(reqwest::redirect::Policy::custom(|attempt| {
            if attempt.previous().len() >= 5 { attempt.stop() }
            else if attempt.url().scheme() == "https" && attempt.url().host_str() == Some("animego.me") { attempt.follow() }
            else { attempt.stop() }
        }))
        .build().map_err(|_| "Не удалось запустить защищённый HTTP-клиент AnimeGO.".to_string())?;
    let home = animego_fetch_account_page(&client, &mut cookies, "/", ANIMEGO_ORIGIN, None).await?;
    if !(200..300).contains(&home.status) {
        return Err(format!("AnimeGO не подтвердил сессию (HTTP {}). Повтори вход.", home.status));
    }
    let (user_id, _) = animego_user_from_html(&home.text)
        .ok_or_else(|| "AnimeGO не подтвердил действующую авторизацию.".to_string())?;
    if user_id != session.user_id {
        return Err("AnimeGO вернул другой аккаунт. Запись прогресса остановлена.".to_string());
    }

    let initial = animego_load_episode_state(&client, &mut cookies, &safe_title, anime_id).await?;
    let translation_id = initial.translation_id.clone();
    let watched_path = initial.watched_path.clone();
    let cookie_header = cookies.iter().map(|(name, value)| format!("{name}={value}")).collect::<Vec<_>>().join("; ");
    if cookie_header.is_empty() || cookie_header.len() > 16 * 1024 {
        return Err("Сохранённая сессия AnimeGO пуста или превышает допустимый размер.".to_string());
    }
    let mut changed = 0u32;
    let mut final_http_status = 200u16;
    for episode in &initial.episodes {
        let desired = episode.episode_number <= progress;
        if episode.watched == desired { continue; }
        let current_cookie_header = cookies.iter().map(|(name, value)| format!("{name}={value}")).collect::<Vec<_>>().join("; ");
        if current_cookie_header.is_empty() || current_cookie_header.len() > 16 * 1024 {
            return Err("Сохранённая сессия AnimeGO пуста или превышает допустимый размер.".to_string());
        }
        let response = client.post(format!("{ANIMEGO_ORIGIN}{watched_path}"))
            .header(reqwest::header::ACCEPT, "application/json")
            .header(reqwest::header::CONTENT_TYPE, "application/x-www-form-urlencoded;charset=UTF-8")
            .header(reqwest::header::USER_AGENT, "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36")
            .header(reqwest::header::REFERER, safe_title.as_str())
            .header(reqwest::header::ORIGIN, ANIMEGO_ORIGIN)
            .header(reqwest::header::COOKIE, current_cookie_header)
            .header("X-Requested-With", "XMLHttpRequest")
            .form(&[("id", episode.episode_id.as_str()), ("translationId", translation_id.as_str())])
            .send().await
            .map_err(|_| "Неизвестен результат записи прогресса AnimeGO. При повторной попытке приложение сначала перечитает состояние.".to_string())?;
        final_http_status = response.status().as_u16();
        let final_url = response.url().clone();
        if final_url.scheme() != "https" || final_url.host_str() != Some("animego.me") {
            return Err("AnimeGO перенаправил запись за пределы разрешённого домена.".to_string());
        }
        update_animego_cookie_jar(&mut cookies, response.headers());
        let body = response.text().await
            .map_err(|_| "Не удалось прочитать ответ AnimeGO. Состояние будет сверено перед повтором.".to_string())?;
        if body.len() > 64 * 1024 {
            return Err("Ответ записи прогресса AnimeGO превышает допустимый размер.".to_string());
        }
        if !(200..300).contains(&final_http_status) {
            return Err(format!("AnimeGO отклонил изменение прогресса (HTTP {}).", final_http_status));
        }
        let result: Value = serde_json::from_str(&body)
            .map_err(|_| "AnimeGO вернул некорректный ответ записи прогресса.".to_string())?;
        let actual = result.pointer("/data/isSetWatched").and_then(Value::as_bool);
        if result.get("status").and_then(Value::as_str) != Some("success") || actual != Some(desired) {
            return Err("AnimeGO не подтвердил запрошенное состояние серии.".to_string());
        }
        changed = changed.saturating_add(1);
    }

    // A fresh read is mandatory because this endpoint is a toggle, not an idempotent setter.
    let verified_state = animego_load_episode_state(&client, &mut cookies, &safe_title, anime_id).await?;
    let verified = verified_state.episodes.iter()
        .all(|episode| episode.watched == (episode.episode_number <= progress));
    if !verified {
        return Err("AnimeGO не подтвердил итоговый прогресс после повторного чтения списка серий.".to_string());
    }
    let watched_episode_number = verified_state.episodes.iter().filter(|episode| episode.watched)
        .map(|episode| episode.episode_number).max().unwrap_or(0);
    animego_save_session_cookies(&mut session, cookies).await?;
    Ok(AnimeGoProgressWriteResult {
        provider: "animego",
        title_url: safe_title.to_string(),
        requested_progress: progress,
        translation_id,
        changed_episodes: changed,
        verified: true,
        watched_episode_number,
        http_status: final_http_status,
        duration_ms: started.elapsed().as_millis(),
    })
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AnimeGoNetworkEvent {
    method: String,
    path: String,
    transport: String,
    field_names: Vec<String>,
    status: Option<u16>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AnimeGoNetworkInspection {
    provider: &'static str,
    page_path: String,
    duration_seconds: u8,
    events: Vec<AnimeGoNetworkEvent>,
    note: &'static str,
}

async fn animego_eval_json(
    window: &tauri::WebviewWindow,
    script: &str,
) -> Result<Value, String> {
    let (sender, receiver) = std::sync::mpsc::channel::<String>();
    window.eval_with_callback(script.to_string(), move |result| {
        let _ = sender.send(result);
    }).map_err(|_| "Не удалось выполнить безопасную проверку окна AnimeGO.".to_string())?;

    let raw = tauri::async_runtime::spawn_blocking(move || {
        receiver.recv_timeout(std::time::Duration::from_secs(5))
    }).await.map_err(|_| "Проверка окна AnimeGO завершилась с ошибкой.".to_string())?
        .map_err(|_| "Окно AnimeGO не ответило на проверку.".to_string())?;

    let mut value: Value = serde_json::from_str(&raw)
        .map_err(|_| "Окно AnimeGO вернуло некорректные метаданные.".to_string())?;
    if let Some(serialized) = value.as_str() {
        value = serde_json::from_str(serialized)
            .map_err(|_| "Окно AnimeGO вернуло некорректный JSON.".to_string())?;
    }
    Ok(value)
}

const ANIMEGO_NETWORK_INSPECT_INSTALL: &str = r#"(() => {
  const key = "__midoAnimeGoNetworkInspector";
  if (window[key]?.active) return JSON.stringify({ installed: true, alreadyActive: true });
  const queue = [];
  const maxEvents = 100;
  const relevant = /mylist|rating|vote|progress|episode|watch|status|bookmark/i;
  const safePath = (raw) => {
    try {
      const url = new URL(raw, window.location.href);
      const trustedHost = url.hostname === "animego.me" || url.hostname.endsWith(".animego.me");
      if (url.protocol !== "https:" || !trustedHost || (url.port && url.port !== "443")) return null;
      if (!url.pathname.startsWith("/") || url.pathname === "/logout") return null;
      return url.pathname.slice(0, 180);
    } catch { return null; }
  };
  const fieldNames = (body) => {
    try {
      let names = [];
      if (body instanceof FormData) names = Array.from(body.keys());
      else if (body instanceof URLSearchParams) names = Array.from(body.keys());
      else if (typeof body === "string" && !body.trim().startsWith("{")) {
        names = Array.from(new URLSearchParams(body).keys());
      }
      return Array.from(new Set(names.filter((name) =>
        typeof name === "string" && /^[A-Za-z0-9_.\[\]-]{1,64}$/.test(name)
      ))).slice(0, 30);
    } catch { return []; }
  };
  const record = (method, rawUrl, transport, fields, status) => {
    const path = safePath(rawUrl);
    const normalizedMethod = String(method || "UNKNOWN").toUpperCase().slice(0, 12);
    if (!path || normalizedMethod === "GET" && !relevant.test(path)) return;
    if (queue.length >= maxEvents) queue.shift();
    queue.push({
      method: normalizedMethod,
      path,
      transport,
      fieldNames: Array.from(new Set(fields || [])).slice(0, 30),
      status: Number.isInteger(status) && status >= 100 && status <= 599 ? status : null
    });
  };

  const originalFetch = window.fetch;
  const originalOpen = XMLHttpRequest.prototype.open;
  const originalSend = XMLHttpRequest.prototype.send;
  const originalBeacon = navigator.sendBeacon;
  const originalFormSubmit = HTMLFormElement.prototype.submit;
  const formFieldNames = (form) => Array.from(form.elements)
    .map((element) => element.name).filter(Boolean);
  const recordForm = (form) => {
    if (!(form instanceof HTMLFormElement)) return;
    record(form.method || "GET", form.action, "form", formFieldNames(form), null);
  };
  const formListener = (event) => recordForm(event.target);

  if (typeof originalFetch === "function") {
    window.fetch = function(input, init) {
      const rawUrl = typeof input === "string" || input instanceof URL ? String(input) : input?.url;
      const method = init?.method || input?.method || "GET";
      const fields = fieldNames(init?.body);
      const request = originalFetch.apply(this, arguments);
      request.then((response) => record(method, rawUrl, "fetch", fields, response.status))
        .catch(() => record(method, rawUrl, "fetch", fields, null));
      return request;
    };
  }
  XMLHttpRequest.prototype.open = function(method, url) {
    this.__midoAnimeGoRequest = { method, url: String(url) };
    return originalOpen.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function(body) {
    const meta = this.__midoAnimeGoRequest;
    if (meta) {
      const fields = fieldNames(body);
      this.addEventListener("loadend", () => record(meta.method, meta.url, "xhr", fields, this.status), { once: true });
    }
    return originalSend.apply(this, arguments);
  };
  if (typeof originalBeacon === "function") {
    navigator.sendBeacon = function(url, body) {
      record("POST", url, "beacon", fieldNames(body), null);
      return originalBeacon.apply(this, arguments);
    };
  }
  document.addEventListener("submit", formListener, true);
  // HTMLFormElement.submit() bypasses the DOM submit event, so observe that
  // invocation separately. requestSubmit() is already covered by formListener.
  HTMLFormElement.prototype.submit = function() {
    recordForm(this);
    return originalFormSubmit.apply(this, arguments);
  };

  window[key] = {
    active: true,
    drain: () => queue.splice(0, queue.length),
    stop: () => {
      if (!window[key]?.active) return;
      window.fetch = originalFetch;
      XMLHttpRequest.prototype.open = originalOpen;
      XMLHttpRequest.prototype.send = originalSend;
      if (originalBeacon) navigator.sendBeacon = originalBeacon;
      HTMLFormElement.prototype.submit = originalFormSubmit;
      document.removeEventListener("submit", formListener, true);
      window[key].active = false;
    }
  };
  return JSON.stringify({ installed: true, alreadyActive: false });
})()"#;

const ANIMEGO_NETWORK_INSPECT_DRAIN: &str =
    "JSON.stringify({ active: !!window.__midoAnimeGoNetworkInspector?.active, events: window.__midoAnimeGoNetworkInspector?.drain?.() ?? [] })";
const ANIMEGO_NETWORK_INSPECT_STOP: &str =
    "window.__midoAnimeGoNetworkInspector?.stop?.(); JSON.stringify({ stopped: true })";

#[tauri::command]
pub async fn animego_network_inspect(
    app: tauri::AppHandle,
) -> Result<AnimeGoNetworkInspection, String> {
    use tauri::Manager;

    const DURATION_SECONDS: u8 = 90;
    let window = app.get_webview_window(ANIMEGO_AUTH_WINDOW)
        .ok_or_else(|| "Сначала открой встроенное окно AnimeGO и перейди на страницу тайтла.".to_string())?;
    let current_url = window.url()
        .map_err(|_| "Не удалось проверить адрес окна AnimeGO.".to_string())?;
    if current_url.scheme() != "https" || current_url.host_str() != Some("animego.me") {
        return Err("Для наблюдения открой страницу на https://animego.me.".to_string());
    }

    let raw_session = streaming_secret_get(ANIMEGO_SESSION_KEY.to_string())?
        .ok_or_else(|| "Сначала подключи аккаунт AnimeGO.".to_string())?;
    let session: AnimeGoStoredSession = serde_json::from_str(&raw_session)
        .map_err(|_| "Сохранённая сессия AnimeGO повреждена.".to_string())?;
    let (user_id, _) = animego_user_from_webview(&window).await?;
    if user_id != session.user_id {
        return Err("Окно AnimeGO не соответствует подключённому аккаунту. Проверка остановлена.".to_string());
    }

    let page_path = current_url.path().chars().take(180).collect::<String>();
    let installed = animego_eval_json(&window, ANIMEGO_NETWORK_INSPECT_INSTALL).await?;
    if installed.get("installed").and_then(Value::as_bool) != Some(true) {
        return Err("Не удалось включить пассивное наблюдение AnimeGO.".to_string());
    }

    let deadline = std::time::Instant::now()
        + std::time::Duration::from_secs(DURATION_SECONDS as u64);
    let mut events: Vec<AnimeGoNetworkEvent> = Vec::new();

    while std::time::Instant::now() < deadline && events.len() < 100 {
        tokio::time::sleep(std::time::Duration::from_millis(500)).await;
        let observed_url = match window.url() {
            Ok(url) if url.scheme() == "https" && url.host_str() == Some("animego.me") => url,
            _ => break,
        };
        let _ = observed_url;
        let batch = match animego_eval_json(&window, ANIMEGO_NETWORK_INSPECT_DRAIN).await {
            Ok(value) => value,
            Err(_) => break,
        };
        if batch.get("active").and_then(Value::as_bool) != Some(true) {
            break;
        }
        let parsed: Vec<AnimeGoNetworkEvent> = match batch.get("events").cloned()
            .and_then(|value| serde_json::from_value(value).ok()) {
            Some(value) => value,
            None => continue,
        };
        for event in parsed {
            if event.path.starts_with('/')
                && !event.path.starts_with("//")
                && event.path != "/logout"
                && matches!(event.method.as_str(), "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "UNKNOWN")
                && matches!(event.transport.as_str(), "fetch" | "xhr" | "form" | "beacon")
            {
                events.push(event);
                if events.len() >= 100 { break; }
            }
        }
    }

    if window.url().map(|url| url.scheme() == "https" && url.host_str() == Some("animego.me")).unwrap_or(false) {
        let _ = animego_eval_json(&window, ANIMEGO_NETWORK_INSPECT_STOP).await;
    }

    Ok(AnimeGoNetworkInspection {
        provider: "animego",
        page_path,
        duration_seconds: DURATION_SECONDS,
        events,
        note: "Пассивное наблюдение завершено. Собирались только метод, путь без query-параметров, названия полей без значений, транспорт и HTTP-статус. Значения полей, тело запросов/ответов, cookies и токены не сохранялись. Запросы не создавались и не изменялись инспектором.",
    })
}

#[cfg(test)]
mod animego_account_list_tests {
    use super::{parse_animego_mylist_page, parse_animego_progress, parse_animego_score};


    #[test]
    fn inspects_same_origin_forms_without_exposing_hidden_values() {
        use super::parse_animego_write_forms;
        let html = r#"<html><head><meta name="csrf-token" content="SECRET-META"></head>
          <body><form method="post" action="/mylist/anime/123/1/add">
            <input type="hidden" name="token" value="SECRET-FORM">
            <input name="rate" value="8">
          </form>
          <form method="post" action="https://evil.example/steal"><input name="x"></form>
          </body></html>"#;
        let base = reqwest::Url::parse("https://animego.me/anime/example-123").unwrap();
        let (forms, meta, controls, script_paths, script_hints) = parse_animego_write_forms(html, &base).unwrap();
        assert_eq!(forms.len(), 1);
        assert_eq!(forms[0].method, "POST");
        assert_eq!(forms[0].action_path, "/mylist/anime/123/1/add");
        assert_eq!(forms[0].enctype, "application/x-www-form-urlencoded");
        assert_eq!(forms[0].purpose, "list");
        assert!(forms[0].has_csrf_field);
        assert_eq!(forms[0].field_names, vec!["token", "rate"]);
        assert_eq!(forms[0].fields[0].input_type, "hidden");
        assert_eq!(forms[0].fields[1].input_type, "text");
        assert_eq!(meta, vec!["csrf-token"]);
        assert!(controls.is_empty());
        assert!(script_paths.is_empty());
        assert!(script_hints.is_empty());
        let serialized = serde_json::to_string(&(forms, meta, controls, script_paths, script_hints)).unwrap();
        assert!(!serialized.contains("SECRET"));
    }

    #[test]
    fn inspects_form_encoding_required_fields_and_static_control_hints() {
        use super::parse_animego_write_forms;
        let html = r#"<html><body>
          <form method="post" action="/rating/anime/694/vote" enctype="multipart/form-data">
            <input type="hidden" name="token" value="DO_NOT_RETURN">
            <input type="number" name="rate" required>
            <button name="submit" onclick="sendVote()">Vote</button>
          </form>
          <select id="watch-status" class="mylist-status" name="status" data-action="change->list#status">
            <option value="1">Watching</option>
          </select>
          <script>document.addEventListener('change', updateProgress); fetch('/mylist/progress');</script>
          <script src="/assets/title-controls.js"></script>
        </body></html>"#;
        let base = reqwest::Url::parse("https://animego.me/anime/example-694").unwrap();
        let (forms, _, controls, script_paths, script_hints) = parse_animego_write_forms(html, &base).unwrap();

        assert_eq!(forms.len(), 1);
        assert_eq!(forms[0].enctype, "multipart/form-data");
        assert_eq!(forms[0].purpose, "rating");
        assert_eq!(forms[0].fields[0].input_type, "hidden");
        assert!(forms[0].fields[1].required);
        assert!(forms[0].has_inline_event_handler);
        assert!(controls.iter().any(|control| control.name.as_deref() == Some("status") && control.has_data_action));
        let status_control = controls.iter().find(|control| control.name.as_deref() == Some("status")).unwrap();
        assert!(status_control.controller_names.iter().any(|name| name == "mylist-status"));
        assert!(status_control.action_hints.iter().any(|action| action == "change->list#status"));
        assert_eq!(status_control.href_path, None);
        assert_eq!(script_paths, vec!["/assets/title-controls.js"]);
        assert!(script_hints.contains(&"addEventListener".to_string()));
        assert!(script_hints.contains(&"fetch".to_string()));
        assert!(script_hints.contains(&"progress".to_string()));
        let serialized = serde_json::to_string(&(forms, controls, script_paths, script_hints)).unwrap();
        assert!(!serialized.contains("DO_NOT_RETURN"));
        assert!(!serialized.contains("sendVote"));
        assert!(!serialized.contains("updateProgress"));
    }

    #[test]
    fn exposes_sanitized_controller_and_action_hints_for_dynamic_controls() {
        use super::parse_animego_write_forms;
        let html = r#"<html><body>
          <button class="schedule-episodes-table__watched" data-controller="anime-episode-watched"
            data-action="click->anime-episode-watched#toggleSchedule">Watch</button>
          <span data-controller="anime-watched-progress"
            data-action="anime-watched:changed@document->anime-watched-progress#update">0 / 12</span>
        </body></html>"#;
        let base = reqwest::Url::parse("https://animego.me/anime/example-694").unwrap();
        let (_, _, controls, _, _) = parse_animego_write_forms(html, &base).unwrap();
        assert!(controls.iter().any(|control|
            control.controller_names.iter().any(|name| name == "anime-episode-watched")
            && control.action_hints.iter().any(|action| action == "click->anime-episode-watched#toggleSchedule")
        ));
        assert!(controls.iter().any(|control|
            control.action_hints.iter().any(|action| action == "anime-watched:changed@document->anime-watched-progress#update")
        ));
        let serialized = serde_json::to_string(&controls).unwrap();
        assert!(!serialized.contains("Watch</"));
    }

    #[test]
    fn exposes_only_same_origin_action_paths_without_query_values() {
        use super::parse_animego_write_forms;
        let html = r#"<html><body>
          <a class="mylist-action" href="/mylist/anime/123/1/add?token=SECRET">Add</a>
          <button class="mylist-statistics" data-ajax-url="/mylist/anime/123/statistics?user=private">Stats</button>
          <a href="https://evil.example/steal">External</a>
        </body></html>"#;
        let base = reqwest::Url::parse("https://animego.me/anime/example-123").unwrap();
        let (_, _, controls, _, _) = parse_animego_write_forms(html, &base).unwrap();
        let add = controls.iter().find(|control| control.href_path.is_some()).unwrap();
        assert_eq!(add.href_path.as_deref(), Some("/mylist/anime/123/1/add"));
        let stats = controls.iter().find(|control| control.ajax_url_path.is_some()).unwrap();
        assert_eq!(stats.ajax_url_path.as_deref(), Some("/mylist/anime/123/statistics"));
        let serialized = serde_json::to_string(&controls).unwrap();
        assert!(!serialized.contains("SECRET"));
        assert!(!serialized.contains("private"));
        assert!(!serialized.contains("evil.example"));
    }

    #[test]
    fn ignores_off_origin_scripts_and_unrelated_controls() {
        use super::parse_animego_write_forms;
        let html = r#"<html><body>
          <input name="search" id="global-search">
          <script src="https://evil.example/steal.js"></script>
        </body></html>"#;
        let base = reqwest::Url::parse("https://animego.me/anime/example-694").unwrap();
        let (_, _, controls, script_paths, _) = parse_animego_write_forms(html, &base).unwrap();
        assert!(controls.is_empty());
        assert!(script_paths.is_empty());
    }

    #[test]
    fn parses_account_list_card_and_episode_progress() {
        let html = r##"
          <turbo-stream action="before" targets="#profile-my-list-page-2"><template>
            <div class="user-mylist__item d-flex" data-mylist-id="51630488">
              <a href="/anime/voyennaya-khronika-romelii-4033"><img src="https://img.cdngos.com/poster.jpg" alt="Военная хроника Ромелии"></a>
              <div class="user-mylist__title"><a href="/anime/voyennaya-khronika-romelii-4033">Военная хроника Ромелии</a></div>
              <div class="fw-lighter small">Romelia Senki</div>
              <div class="user-profile__status">онгоинг</div>
              <div data-rating-value="8"></div>
              <a href="/anime/voyennaya-khronika-romelii-4033#player">Продолжить 7 / 8 (24)</a>
            </div>
          </template></turbo-stream>
          <turbo-stream action="replace" targets="#profile-my-list-page-2"><template>
            <turbo-frame id="profile-my-list-page-3" src="/user/mylist/123456/3?type=1"></turbo-frame>
          </template></turbo-stream>
        "##;
        let base = reqwest::Url::parse("https://animego.me/profile/123456?type=1").unwrap();
        let parsed = parse_animego_mylist_page(html, &base, 1).unwrap();
        assert_eq!(parsed.items.len(), 1);
        assert_eq!(parsed.items[0].list_entry_id, "51630488");
        assert_eq!(parsed.items[0].anime_id.as_deref(), Some("4033"));
        assert_eq!(parsed.items[0].title, "Военная хроника Ромелии");
        assert_eq!(parsed.items[0].alternative_title.as_deref(), Some("Romelia Senki"));
        assert_eq!(parsed.items[0].episodes_watched, Some(7));
        assert_eq!(parsed.items[0].episodes_total, Some(8));
        assert_eq!(parsed.items[0].score, Some(8));
        assert_eq!(parsed.next_page_frame_id.as_deref(), Some("profile-my-list-page-3"));
        assert_eq!(parsed.next_page_url.as_deref(), Some("/user/mylist/123456/3?type=1"));
    }

    #[test]
    fn prefers_lazy_poster_url_over_root_placeholder_src() {
        let html = r#"<div class="user-mylist__item" data-mylist-id="3">
          <a href="/anime/example-123">
            <img src="https://cdngos.com" data-src="https://img.cdngos.com/posters/example.jpg" alt="Example">
          </a>
          <div class="user-mylist__title"><a href="/anime/example-123">Example</a></div>
        </div>"#;
        let base = reqwest::Url::parse("https://animego.me/profile/123456?type=1").unwrap();
        let parsed = parse_animego_mylist_page(html, &base, 1).unwrap();
        assert_eq!(parsed.items[0].poster_url.as_deref(), Some("https://img.cdngos.com/posters/example.jpg"));
    }

    #[test]
    fn reads_personal_score_from_data_rating_value_attribute() {
        let html = r#"<div class="user-mylist__item" data-mylist-id="2">
          <a href="/anime/example-123"><img src="https://img.cdngos.com/example.jpg" alt="Example"></a>
          <div class="user-mylist__title"><a href="/anime/example-123">Example</a></div>
          <div data-rating-value="6"></div>
        </div>"#;
        let base = reqwest::Url::parse("https://animego.me/profile/123456?type=1").unwrap();
        let parsed = parse_animego_mylist_page(html, &base, 1).unwrap();
        assert_eq!(parsed.items.len(), 1);
        assert_eq!(parsed.items[0].score, Some(6));
    }

    #[test]
    fn rejects_off_site_title_links_and_ignores_opaque_rating_values() {
        let html = r#"<div class="user-mylist__item" data-mylist-id="1">
          <div class="user-mylist__title"><a href="https://evil.example/anime/no-1">Not ours</a></div>
          <div data-rating="6010">Rating</div>
        </div>"#;
        let base = reqwest::Url::parse("https://animego.me/profile/123456?type=1").unwrap();
        let parsed = parse_animego_mylist_page(html, &base, 1).unwrap();
        assert!(parsed.items.is_empty());
    }

    #[test]
    fn parses_personal_score_only_within_animego_ten_point_range() {
        assert_eq!(parse_animego_score("8"), Some(8));
        assert_eq!(parse_animego_score("10"), Some(10));
        assert_eq!(parse_animego_score("0"), None);
        assert_eq!(parse_animego_score("11"), None);
        assert_eq!(parse_animego_score(""), None);
    }

    #[test]
    fn parses_progress_without_treating_missing_progress_as_zero() {
        assert_eq!(parse_animego_progress("Продолжить 7 / 8 (24)").0, Some(7));
        assert_eq!(parse_animego_progress("Продолжить 7 / 8 (24)").1, Some(8));
        assert_eq!(parse_animego_progress("Открыть страницу").0, None);
    }
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
    fn reads_user_payload_when_html_tag_and_attribute_are_uppercase() {
        let html = r#"<HTML DATA-USER="{&quot;id&quot;:&quot;1367030&quot;,&quot;username&quot;:&quot;demo-user&quot;}"></HTML>"#;
        assert_eq!(
            animego_user_from_html(html),
            Some(("1367030".to_string(), Some("demo-user".to_string())))
        );
    }

    #[test]
    fn accepts_only_the_expected_first_party_rating_form_and_keeps_token_private() {
        use super::animego_rating_form_data;
        let title = reqwest::Url::parse("https://animego.me/anime/example-123").unwrap();
        let html = r#"<form method="post" action="/rating/anime/123/vote">
            <input type="hidden" name="token" value="private-csrf-value">
            <select name="rate"><option value="8">8</option><option value="9" selected>9</option></select>
        </form>"#;
        let (path, token, selected) = animego_rating_form_data(html, &title, "123").unwrap();
        assert_eq!(path, "/rating/anime/123/vote");
        assert_eq!(token, "private-csrf-value");
        assert_eq!(selected, Some(9));
    }

    #[test]
    fn refuses_rating_forms_outside_the_expected_action() {
        use super::animego_rating_form_data;
        let title = reqwest::Url::parse("https://animego.me/anime/example-123").unwrap();
        let html = r#"<form method="post" action="https://evil.example/rating/anime/123/vote">
            <input type="hidden" name="token" value="private">
        </form>"#;
        assert!(animego_rating_form_data(html, &title, "123").is_err());
    }

    #[test]
    fn rejects_pages_without_authenticated_user_payload() {
        assert_eq!(animego_user_from_html("<html><body>guest</body></html>"), None);
        assert_eq!(animego_user_from_html(r#"<html data-user="{&quot;id&quot;:&quot;not-numeric&quot;}"></html>"#), None);
    }
}


#[cfg(test)]
mod animego_episode_progress_tests {
    use super::animego_parse_episode_items;

    #[test]
    fn parses_and_orders_episode_ids_and_watched_flags() {
        let html = r#"
          <div data-episode="54399" data-episode-number="6" data-episode-watched="true"></div>
          <div data-episode="54398" data-episode-number="5" data-episode-watched="false"></div>
          <div data-episode="bad" data-episode-number="7" data-episode-watched="false"></div>
          <div data-episode="54400" data-episode-number="7" data-episode-watched="false"></div>
        "#;
        let episodes = animego_parse_episode_items(html).expect("valid episode list");
        assert_eq!(episodes.len(), 3);
        assert_eq!(episodes[0].episode_id, "54398");
        assert_eq!(episodes[0].episode_number, 5);
        assert!(!episodes[0].watched);
        assert_eq!(episodes[1].episode_id, "54399");
        assert!(episodes[1].watched);
        assert_eq!(episodes[2].episode_number, 7);
    }

    #[test]
    fn rejects_empty_or_unrecognized_episode_lists() {
        assert!(animego_parse_episode_items("<div>no episode data</div>").is_err());
    }
}
