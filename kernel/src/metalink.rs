//! Minimal Metalink (RFC 5854) reader for HTTP(S) mirrors.
//!
//! The kernel deliberately keeps a tiny dependency set and cargo cannot reach
//! crates.io in every build environment, so this is a small, tolerant scanner
//! for the subset a downloader needs: `<file name>`, `<size>`, `<hash
//! type="sha-256">`, and `<url priority>`. It is not a general XML parser:
//! namespaces are ignored, nested `<file>` elements are not supported, and the
//! input size is bounded by the caller.

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct MetalinkUrl {
    pub url: String,
    pub priority: Option<u32>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct MetalinkFile {
    pub name: Option<String>,
    pub size: Option<u64>,
    pub sha256: Option<String>,
    pub urls: Vec<MetalinkUrl>,
}

const MAX_FILES: usize = 32;
const MAX_URLS_PER_FILE: usize = 16;

/// Parse the HTTP(S) files of a Metalink document. Returns an error only when
/// no usable file is present; malformed individual elements are skipped.
pub fn parse(xml: &str) -> Result<Vec<MetalinkFile>, String> {
    let mut files = Vec::new();
    let mut cursor = 0usize;
    while files.len() < MAX_FILES {
        let Some(open) = find_tag(xml, "file", cursor) else { break };
        let header = &xml[open.start..open.end];
        let name = attribute(header, "name");
        let inner_start = open.end;
        let inner_end = if open.self_closing {
            inner_start
        } else {
            match xml[inner_start..].find("</file>") {
                Some(offset) => inner_start + offset,
                None => xml.len(),
            }
        };
        let inner = &xml[inner_start..inner_end];
        cursor = (inner_end + "</file>".len()).min(xml.len());
        let mut file = MetalinkFile { name, ..MetalinkFile::default() };
        if let Some(size) = element_text(inner, "size") {
            file.size = size.trim().parse::<u64>().ok();
        }
        for hash in elements(inner, "hash") {
            let kind = attribute(hash.attrs, "type").unwrap_or_default().to_ascii_lowercase();
            if kind == "sha-256" || kind == "sha256" {
                let value = decode_entities(inner[hash.inner_start..hash.inner_end].trim());
                if !value.is_empty() {
                    file.sha256 = Some(value.to_ascii_lowercase());
                }
                break;
            }
        }
        for url in elements(inner, "url") {
            let value = decode_entities(inner[url.inner_start..url.inner_end].trim());
            if value.is_empty() {
                continue;
            }
            if !matches!(url::Url::parse(&value).map(|parsed| parsed.scheme().to_string()), Ok(scheme) if scheme == "http" || scheme == "https") {
                continue;
            }
            let priority = attribute(url.attrs, "priority").and_then(|value| value.parse::<u32>().ok());
            if file.urls.len() >= MAX_URLS_PER_FILE {
                break;
            }
            file.urls.push(MetalinkUrl { url: value, priority });
        }
        if !file.urls.is_empty() {
            files.push(file);
        }
    }
    if files.is_empty() {
        return Err("metalink contains no HTTP(S) file URLs".to_string());
    }
    Ok(files)
}

/// Select one file by exact name, basename, or (single-file documents) the
/// only entry. A multi-file document without a selection is an error listing
/// the names so the caller can retry with `metalinkFile`.
pub fn select(files: &[MetalinkFile], requested: Option<&str>) -> Result<MetalinkFile, String> {
    if let Some(requested) = requested {
        if let Some(file) = files.iter().find(|file| file.name.as_deref().is_some_and(|name| name == requested || name.rsplit('/').next() == Some(requested))) {
            return Ok(file.clone());
        }
        return Err(format!("metalink has no file named `{requested}`"));
    }
    if files.len() == 1 {
        return Ok(files[0].clone());
    }
    let names: Vec<&str> = files.iter().filter_map(|file| file.name.as_deref()).collect();
    Err(format!("metalink contains {} files; pass metalinkFile to choose one: {}", files.len(), names.join(", ")))
}

struct Tag<'a> {
    start: usize,
    end: usize,
    attrs: &'a str,
    self_closing: bool,
    inner_start: usize,
    inner_end: usize,
}

fn find_tag<'a>(xml: &'a str, name: &str, from: usize) -> Option<Tag<'a>> {
    let mut cursor = from;
    loop {
        let start = xml[cursor..].find(&format!("<{name}"))? + cursor;
        let after_name = start + 1 + name.len();
        let next = xml[after_name..].chars().next()?;
        // `<file>` / `<file ` / `<file/`; not `<files>`.
        if !(next.is_whitespace() || next == '>' || next == '/') {
            cursor = after_name;
            continue;
        }
        let end_rel = xml[start..].find('>')? + start;
        let end = end_rel + 1;
        let header = &xml[start..end];
        return Some(Tag { start, end, attrs: &xml[start..end], self_closing: header.ends_with("/>"), inner_start: end, inner_end: end });
    }
}

fn elements<'a>(xml: &'a str, name: &str) -> Vec<Tag<'a>> {
    let mut found = Vec::new();
    let mut cursor = 0usize;
    while let Some(tag) = find_tag(xml, name, cursor) {
        let inner_start = tag.end;
        let (inner_end, end) = if tag.self_closing {
            (inner_start, inner_start)
        } else {
            match xml[inner_start..].find(&format!("</{name}>")) {
                Some(offset) => {
                    let close_start = inner_start + offset;
                    (close_start, close_start + name.len() + 3)
                }
                None => (xml.len(), xml.len()),
            }
        };
        found.push(Tag { start: tag.start, end, attrs: tag.attrs, self_closing: tag.self_closing, inner_start, inner_end });
        cursor = end.max(inner_start);
        if cursor >= xml.len() {
            break;
        }
    }
    found
}

fn element_text(xml: &str, name: &str) -> Option<String> {
    let tag = find_tag(xml, name, 0)?;
    if tag.self_closing {
        return None;
    }
    let close = format!("</{name}>");
    let inner_end = xml[tag.end..].find(&close)? + tag.end;
    Some(xml[tag.end..inner_end].to_string())
}

fn attribute(tag: &str, name: &str) -> Option<String> {
    let needle = format!("{name}=");
    let mut cursor = 0usize;
    while let Some(offset) = tag[cursor..].find(&needle) {
        let start = cursor + offset;
        let boundary = tag[..start].chars().next_back().is_none_or(|character| character.is_whitespace() || character == '<' || character == '/');
        if !boundary {
            cursor = start + 1;
            continue;
        }
        let value_start = start + needle.len();
        let rest = tag[value_start..].trim_start();
        let quote = rest.chars().next()?;
        if quote != '"' && quote != '\'' {
            return None;
        }
        let rest = &rest[1..];
        let end = rest.find(quote)?;
        return Some(decode_entities(&rest[..end]));
    }
    None
}

fn decode_entities(value: &str) -> String {
    let mut output = String::with_capacity(value.len());
    let mut cursor = 0;
    while let Some(offset) = value[cursor..].find('&') {
        let start = cursor + offset;
        output.push_str(&value[cursor..start]);
        let Some(end_rel) = value[start..].find(';') else {
            output.push_str(&value[start..]);
            return output;
        };
        let end = start + end_rel;
        let entity = &value[start + 1..end];
        let decoded = match entity {
            "amp" => Some('&'),
            "lt" => Some('<'),
            "gt" => Some('>'),
            "quot" => Some('"'),
            "apos" => Some('\''),
            _ if entity.starts_with("#x") || entity.starts_with("#X") => u32::from_str_radix(&entity[2..], 16).ok().and_then(char::from_u32),
            _ if entity.starts_with('#') => entity[1..].parse::<u32>().ok().and_then(char::from_u32),
            _ => None,
        };
        match decoded {
            Some(character) => output.push(character),
            None => output.push_str(&value[start..=end]),
        }
        cursor = end + 1;
    }
    output.push_str(&value[cursor..]);
    output
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE: &str = r#"<?xml version="1.0"?>
<metalink xmlns="urn:ietf:params:xml:ns:metalink">
  <file name="ubuntu.iso">
    <size>4096</size>
    <hash type="sha-256">ABCDEF0123</hash>
    <url priority="2">https://mirror-b.example/ubuntu.iso</url>
    <url priority="1">https://mirror-a.example/ubuntu.iso?a=1&amp;b=2</url>
    <url>ftp://ftp.example/ubuntu.iso</url>
  </file>
  <file name="other.iso">
    <size>10</size>
    <url>https://mirror.example/other.iso</url>
  </file>
</metalink>"#;

    #[test]
    fn parses_files_hashes_and_http_urls() {
        let files = parse(SAMPLE).expect("parse");
        assert_eq!(files.len(), 2);
        assert_eq!(files[0].name.as_deref(), Some("ubuntu.iso"));
        assert_eq!(files[0].size, Some(4096));
        assert_eq!(files[0].sha256.as_deref(), Some("abcdef0123"));
        assert_eq!(files[0].urls.len(), 2, "ftp must be dropped");
        assert_eq!(files[0].urls[0].url, "https://mirror-b.example/ubuntu.iso");
        assert_eq!(files[0].urls[0].priority, Some(2));
        assert_eq!(files[0].urls[1].url, "https://mirror-a.example/ubuntu.iso?a=1&b=2");
    }

    #[test]
    fn selection_requires_a_name_for_multi_file_documents() {
        let files = parse(SAMPLE).expect("parse");
        assert!(select(&files, None).is_err());
        let chosen = select(&files, Some("other.iso")).expect("select");
        assert_eq!(chosen.urls[0].url, "https://mirror.example/other.iso");
        let basename = select(&files, Some("ubuntu.iso")).expect("basename");
        assert_eq!(basename.size, Some(4096));
    }
}
