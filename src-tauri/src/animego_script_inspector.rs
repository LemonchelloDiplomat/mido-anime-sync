//! Read-only, bounded static inspection of first-party AnimeGO JavaScript bundles.
//! This module never executes JavaScript and never returns source snippets or values.

use serde::Serialize;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AnimeGoScriptRouteCandidate {
    pub path: String,
    pub methods: Vec<String>,
    pub capabilities: Vec<String>,
    pub field_hints: Vec<String>,
    pub signals: Vec<String>,
}

fn relevant_text(value: &str) -> bool {
    let lower = value.to_ascii_lowercase();
    ["mylist", "rating", "vote", "progress", "episode", "watched", "watch", "status"]
        .iter()
        .any(|needle| lower.contains(needle))
}

fn safe_relative_path(value: &str) -> Option<String> {
    let path = value.split(['?', '#']).next()?.trim();
    if !path.starts_with('/') || path.starts_with("//") || path.len() < 2 || path.len() > 180 {
        return None;
    }
    if !path.bytes().all(|byte| byte.is_ascii_alphanumeric() || b"/_-.:{}*$".contains(&byte)) {
        return None;
    }
    if !relevant_text(path) { return None; }
    Some(path.to_string())
}

fn context_window(source: &str, start: usize, end: usize) -> &str {
    let mut left = start.saturating_sub(240);
    let mut right = (end + 240).min(source.len());
    while left < start && !source.is_char_boundary(left) { left += 1; }
    while right > end && !source.is_char_boundary(right) { right -= 1; }
    source.get(left..right).unwrap_or("")
}

/// Extract only route-like string literals and coarse nearby request hints.
/// Returned paths are candidates, not verified API contracts.
pub fn inspect_animego_script(source: &str) -> Vec<AnimeGoScriptRouteCandidate> {
    const MAX_SOURCE_BYTES: usize = 2 * 1024 * 1024;
    const MAX_CANDIDATES: usize = 60;
    if source.len() > MAX_SOURCE_BYTES { return Vec::new(); }

    let mut found: Vec<AnimeGoScriptRouteCandidate> = Vec::new();
    let mut cursor = 0usize;
    while cursor < source.len() && found.len() < MAX_CANDIDATES {
        let Some((quote_index, quote)) = source[cursor..].char_indices()
            .find_map(|(offset, ch)| if ch == '"' || ch == '\'' || ch == '`' { Some((cursor + offset, ch)) } else { None })
        else { break; };
        let value_start = quote_index + quote.len_utf8();
        let mut escaped = false;
        let mut closing = None;
        for (offset, ch) in source[value_start..].char_indices() {
            if escaped { escaped = false; continue; }
            if ch == '\\' { escaped = true; continue; }
            if ch == quote { closing = Some(value_start + offset); break; }
            if offset > 240 { break; }
        }
        let Some(value_end) = closing else {
            cursor = value_start;
            continue;
        };
        let literal = source.get(value_start..value_end).unwrap_or("");
        cursor = value_end + quote.len_utf8();

        let Some(path) = safe_relative_path(literal) else { continue; };
        let context = context_window(source, quote_index, cursor).to_ascii_lowercase();

        let mut methods = Vec::new();
        if context.contains("post") && (context.contains("method:") || context.contains(".post(") || context.contains("type:") || context.contains("open(")) {
            methods.push("POST".to_string());
        }
        if context.contains("get") && (context.contains("method:") || context.contains(".get(") || context.contains("open(")) {
            methods.push("GET".to_string());
        }
        if context.contains("delete") && (context.contains("method:") || context.contains(".delete(")) {
            methods.push("DELETE".to_string());
        }
        if context.contains("put") && (context.contains("method:") || context.contains(".put(")) {
            methods.push("PUT".to_string());
        }
        if context.contains("patch") && (context.contains("method:") || context.contains(".patch(")) {
            methods.push("PATCH".to_string());
        }
        if methods.is_empty() { methods.push("unknown".to_string()); }
        methods.sort();
        methods.dedup();

        let searchable = format!("{} {}", path.to_ascii_lowercase(), context);
        let mut capabilities = Vec::new();
        for (needle, label) in [
            ("rating", "rating"), ("vote", "rating"), ("progress", "progress"),
            ("episode", "episode-progress"), ("watched", "episode-progress"),
            ("watch", "episode-progress"), ("status", "list-status"),
            ("mylist", "list-membership"), ("remove", "remove"), ("delete", "remove"),
        ] {
            if searchable.contains(needle) && !capabilities.iter().any(|item| item == label) {
                capabilities.push(label.to_string());
            }
        }

        let mut field_hints = Vec::new();
        for field in ["token", "csrf", "status", "type", "progress", "episode", "rate", "score", "animeId", "mylistId"] {
            if searchable.contains(&field.to_ascii_lowercase()) { field_hints.push(field.to_string()); }
        }

        let mut signals = Vec::new();
        for (needle, label) in [
            ("fetch(", "fetch"), ("xmlhttprequest", "XMLHttpRequest"),
            ("axios", "axios"), ("formdata", "FormData"),
            ("urlsearchparams", "URLSearchParams"), ("addeventlistener", "addEventListener"),
            ("turbo", "Turbo"),
        ] {
            if context.contains(needle) { signals.push(label.to_string()); }
        }

        let candidate = AnimeGoScriptRouteCandidate { path, methods, capabilities, field_hints, signals };
        if let Some(existing) = found.iter_mut().find(|item| item.path == candidate.path) {
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
        } else {
            found.push(candidate);
        }
    }
    found
}

#[cfg(test)]
mod tests {
    use super::inspect_animego_script;

    #[test]
    fn extracts_only_sanitized_same_origin_route_candidates_and_hints() {
        let source = r#"
          fetch('/mylist/anime/' + animeId + '/1/add', {
            method: 'POST',
            body: new URLSearchParams({ token: csrf, status: listType, progress: watched })
          });
          axios.post('/rating/anime/' + id + '/vote', { rate: score });
          const progressUrl = `/episode/${episodeId}/progress`;
          fetch('https://evil.example/steal?token=secret');
        "#;
        let found = inspect_animego_script(source);
        assert!(found.iter().any(|item| item.path == "/mylist/anime/"));
        assert!(found.iter().any(|item| item.path == "/rating/anime/"));
        assert!(found.iter().any(|item| item.path == "/episode/${episodeId}/progress"));
        let list = found.iter().find(|item| item.path == "/mylist/anime/").unwrap();
        assert!(list.methods.contains(&"POST".to_string()));
        assert!(list.capabilities.contains(&"list-membership".to_string()));
        assert!(list.field_hints.contains(&"token".to_string()));
        assert!(list.signals.contains(&"URLSearchParams".to_string()));
        assert!(!found.iter().any(|item| item.path.contains("evil")));
        assert!(!format!("{found:?}").contains("secret"));
    }

    #[test]
    fn rejects_query_values_unrelated_paths_and_oversized_sources() {
        let found = inspect_animego_script(r#"
          const search = '/search/all?q=private';
          const unrelated = '/assets/site.css';
          const candidate = '/episode/progress/update';
        "#);
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].path, "/episode/progress/update");
        assert!(inspect_animego_script(&"x".repeat(2 * 1024 * 1024 + 1)).is_empty());
    }
}
