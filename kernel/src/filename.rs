use crate::state;
use percent_encoding::percent_decode_str;
use std::path::{Path, PathBuf};
pub const FALLBACK_NAME: &str = "download.bin";
const MAX_NAME_CHARS: usize = 180;
pub fn derive(disposition: Option<&str>, final_url: &str) -> String {
    let candidate = disposition.and_then(parse_content_disposition).or_else(|| from_url(final_url));
    match candidate {
        Some(raw) => {
            let clean = sanitize(&raw);
            if clean.is_empty() {
                FALLBACK_NAME.to_string()
            } else {
                clean
            }
        }
        None => FALLBACK_NAME.to_string(),
    }
}
pub fn parse_content_disposition(value: &str) -> Option<String> {
    let mut star: Option<String> = None;
    let mut plain: Option<String> = None;
    for param in split_params(value) {
        let Some((name, raw_value)) = param.split_once('=') else {
            continue;
        };
        let name = name.trim().to_ascii_lowercase();
        let raw_value = raw_value.trim();
        match name.as_str() {
            "filename*" => {
                if let Some(decoded) = decode_ext_value(raw_value) {
                    star = Some(decoded);
                }
            }
            "filename" => {
                let unquoted = unquote(raw_value);
                if !unquoted.is_empty() {
                    plain = Some(unquoted);
                }
            }
            _ => {}
        }
    }
    star.or(plain)
}
pub fn sanitize(raw: &str) -> String {
    let mut out = String::with_capacity(raw.len());
    for ch in raw.trim().chars() {
        if ch.is_control() {
            out.push('_');
            continue;
        }
        match ch {
            '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*' => out.push('_'),
            _ => out.push(ch),
        }
    }
    while out.ends_with(' ') || out.ends_with('.') {
        out.pop();
    }
    let out = out.trim_start().to_string();
    if out.is_empty() || out == "." || out == ".." {
        return String::new();
    }
    let stem = out.split('.').next().unwrap_or("").to_ascii_uppercase();
    let reserved = matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL") || (stem.len() == 4 && (stem.starts_with("COM") || stem.starts_with("LPT")) && stem.as_bytes()[3].is_ascii_digit());
    let out = if reserved { format!("_{out}") } else { out };
    truncate_chars(out, MAX_NAME_CHARS)
}
pub fn resolve_target(dir: &Path, desired: &str, resume: bool) -> (PathBuf, String) {
    let desired = {
        let clean = sanitize(desired);
        if clean.is_empty() {
            FALLBACK_NAME.to_string()
        } else {
            clean
        }
    };
    for attempt in 0u32..10_000 {
        let name = if attempt == 0 { desired.clone() } else { numbered(&desired, attempt) };
        let path = dir.join(&name);
        if resume && state::state_path(&path).exists() {
            return (path, name);
        }
        if !path.exists() {
            return (path, name);
        }
    }
    let fallback = format!("{}-{}", desired, std::process::id());
    (dir.join(&fallback), fallback)
}
fn numbered(name: &str, n: u32) -> String {
    let path = Path::new(name);
    match (path.file_stem(), path.extension()) {
        (Some(stem), Some(ext)) => {
            format!("{} ({n}).{}", stem.to_string_lossy(), ext.to_string_lossy())
        }
        _ => format!("{name} ({n})"),
    }
}
fn split_params(value: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut current = String::new();
    let mut quoted = false;
    let mut escaped = false;
    for ch in value.chars() {
        if escaped {
            current.push(ch);
            escaped = false;
            continue;
        }
        match ch {
            '\\' if quoted => {
                current.push(ch);
                escaped = true;
            }
            '"' => {
                quoted = !quoted;
                current.push(ch);
            }
            ';' if !quoted => {
                out.push(current.trim().to_string());
                current.clear();
            }
            _ => current.push(ch),
        }
    }
    out.push(current.trim().to_string());
    out
}
fn unquote(value: &str) -> String {
    let value = value.trim();
    if value.len() >= 2 && value.starts_with('"') && value.ends_with('"') {
        let inner = &value[1..value.len() - 1];
        let mut out = String::with_capacity(inner.len());
        let mut chars = inner.chars();
        while let Some(ch) = chars.next() {
            if ch == '\\' {
                if let Some(next) = chars.next() {
                    out.push(next);
                }
            } else {
                out.push(ch);
            }
        }
        out
    } else {
        value.to_string()
    }
}
fn decode_ext_value(value: &str) -> Option<String> {
    let value = value.trim().trim_matches('"');
    let mut parts = value.splitn(3, '\'');
    let charset = parts.next()?.trim();
    let _language = parts.next()?;
    let encoded = parts.next()?;
    let bytes: Vec<u8> = percent_decode_str(encoded).collect();
    match charset.to_ascii_lowercase().as_str() {
        "utf-8" | "utf8" => Some(String::from_utf8_lossy(&bytes).into_owned()),
        "iso-8859-1" | "latin1" => Some(bytes.iter().map(|b| *b as char).collect()),
        _ => None,
    }
}
fn from_url(final_url: &str) -> Option<String> {
    let parsed = url::Url::parse(final_url).ok()?;
    let last = parsed.path_segments()?.rev().find(|segment| !segment.is_empty())?;
    let decoded = percent_decode_str(last).decode_utf8_lossy().into_owned();
    if decoded.trim().is_empty() {
        None
    } else {
        Some(decoded)
    }
}
fn truncate_chars(mut value: String, max: usize) -> String {
    if value.chars().count() <= max {
        return value;
    }
    let cutoff = value.char_indices().nth(max).map(|(index, _)| index).unwrap_or(value.len());
    value.truncate(cutoff);
    value
}
