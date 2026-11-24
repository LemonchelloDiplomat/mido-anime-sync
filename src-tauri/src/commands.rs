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

        let mut poster_url = None;
        if let Some(image) = card.select(&image_selector).next() {
            for name in ["src", "data-src", "data-original", "data-lazy-src", "data-original-src"] {
                let Some(raw) = image.value().attr(name) else { continue; };
                if raw.starts_with("data:") || raw.starts_with("blob:") || raw.starts_with("javascript:") {
                    continue;
                }
                let Ok(mut candidate) = base_url.join(raw) else { continue; };
                let host = candidate.host_str().unwrap_or("");
                let trusted = host == "animego.me" || host == "img.cdngos.com" || host.ends_with(".cdngos.com");
                if !trusted || !matches!(candidate.scheme(), "http" | "https") { continue; }
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
                    if all_items.len() > 3000 {
                        return Err("AnimeGO вернул больше 3000 записей. Импорт остановлен для защиты библиотеки.".to_string());
                    }
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

#[cfg(test)]
mod animego_account_list_tests {
    use super::{parse_animego_mylist_page, parse_animego_progress};

    #[test]
    fn parses_account_list_card_and_episode_progress() {
        let html = r##"
          <turbo-stream action="before" targets="#profile-my-list-page-2"><template>
            <div class="user-mylist__item d-flex" data-mylist-id="51630488">
              <a href="/anime/voyennaya-khronika-romelii-4033"><img src="https://img.cdngos.com/poster.jpg" alt="Военная хроника Ромелии"></a>
              <div class="user-mylist__title"><a href="/anime/voyennaya-khronika-romelii-4033">Военная хроника Ромелии</a></div>
              <div class="fw-lighter small">Romelia Senki</div>
              <div class="user-profile__status">онгоинг</div>
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
        assert_eq!(parsed.next_page_frame_id.as_deref(), Some("profile-my-list-page-3"));
        assert_eq!(parsed.next_page_url.as_deref(), Some("/user/mylist/123456/3?type=1"));
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
    fn rejects_pages_without_authenticated_user_payload() {
        assert_eq!(animego_user_from_html("<html><body>guest</body></html>"), None);
        assert_eq!(animego_user_from_html(r#"<html data-user="{&quot;id&quot;:&quot;not-numeric&quot;}"></html>"#), None);
    }
}
