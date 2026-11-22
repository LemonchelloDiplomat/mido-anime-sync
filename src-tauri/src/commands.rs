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

fn allowed_provider_host(host: &str) -> bool {
    host == "animego.me"
        || host.ends_with(".animego.me")
        || host == "anixart.site"
        || host.ends_with(".anixart.site")
}

fn validate_request_url(raw: &str) -> Result<reqwest::Url, String> {
    let url = reqwest::Url::parse(raw).map_err(|_| "Invalid provider URL.".to_string())?;
    if url.scheme() != "https"
        || !url.host_str().map(allowed_provider_host).unwrap_or(false)
        || url.username() != ""
        || url.password().is_some()
    {
        return Err("Native HTTP request is outside the provider allowlist.".to_string());
    }
    Ok(url)
}

#[tauri::command]
pub async fn streaming_http_request(request: NativeHttpRequest) -> Result<NativeHttpResponse, String> {
    let url = validate_request_url(&request.url)?;
    let method = request.method.as_deref().unwrap_or("GET").to_uppercase();
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

    let mut builder = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .redirect(reqwest::redirect::Policy::custom(|attempt| {
            if attempt.previous().len() >= 5 {
                attempt.stop()
            } else if attempt.url().scheme() == "https"
                && attempt.url().host_str().map(allowed_provider_host).unwrap_or(false)
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
    if !response.url().host_str().map(allowed_provider_host).unwrap_or(false) {
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
