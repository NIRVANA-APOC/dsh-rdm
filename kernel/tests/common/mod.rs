//! Minimal in-process HTTP fixture server for kernel integration tests.
//!
//! Plain `std::net::TcpListener` + threads, no extra dependencies. Supports:
//! ranged and rangeless responses, HEAD metadata, ETag changes, 302 redirects,
//! one-shot 429 pushback with `Retry-After`, optional slow body writes and
//! filename via `Content-Disposition`.
#![allow(dead_code)]

use std::collections::HashMap;
use std::io::{Read, Write};
use std::net::{SocketAddr, TcpListener, TcpStream};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

pub fn payload(len: usize) -> Vec<u8> {
    (0..len).map(|i| ((i * 37 + 11) % 251) as u8).collect()
}

pub fn sha256_hex(bytes: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    hex::encode(hasher.finalize())
}

pub struct Shared {
    pub bytes: Vec<u8>,
    pub etag: Mutex<String>,
    pub supports_ranges: AtomicBool,
    pub content_disposition: Mutex<Option<String>>,
    pub flaky_429: AtomicUsize,
    pub retry_after: Mutex<Option<String>>,
    pub chunk_delay: Mutex<Option<Duration>>,
    pub redirect: AtomicBool,
    pub requests: AtomicUsize,
    pub range_requests: AtomicUsize,
    pub active: AtomicUsize,
    pub max_active: AtomicUsize,
    pub extra_headers: Mutex<Vec<(String, String)>>,
}

pub struct Fixture {
    pub shared: Arc<Shared>,
    pub addr: SocketAddr,
    stop: Arc<AtomicBool>,
    handle: Option<thread::JoinHandle<()>>,
}

impl Fixture {
    pub fn start(bytes: Vec<u8>) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind fixture");
        let addr = listener.local_addr().expect("fixture addr");
        let shared = Arc::new(Shared {
            bytes,
            etag: Mutex::new("\"v1\"".to_string()),
            supports_ranges: AtomicBool::new(true),
            content_disposition: Mutex::new(None),
            flaky_429: AtomicUsize::new(0),
            retry_after: Mutex::new(None),
            chunk_delay: Mutex::new(None),
            redirect: AtomicBool::new(false),
            requests: AtomicUsize::new(0),
            range_requests: AtomicUsize::new(0),
            active: AtomicUsize::new(0),
            max_active: AtomicUsize::new(0),
            extra_headers: Mutex::new(Vec::new()),
        });
        let stop = Arc::new(AtomicBool::new(false));
        let accept_shared = Arc::clone(&shared);
        let accept_stop = Arc::clone(&stop);
        let handle = thread::spawn(move || {
            for stream in listener.incoming() {
                if accept_stop.load(Ordering::SeqCst) {
                    break;
                }
                let Ok(stream) = stream else { continue };
                let shared = Arc::clone(&accept_shared);
                thread::spawn(move || serve(stream, shared));
            }
        });
        Self { shared, addr, stop, handle: Some(handle) }
    }

    pub fn url(&self, path: &str) -> String {
        format!("http://{}{}", self.addr, path)
    }

    pub fn set_etag(&self, etag: &str) {
        *self.shared.etag.lock().unwrap() = etag.to_string();
    }

    pub fn set_supports_ranges(&self, supported: bool) {
        self.shared.supports_ranges.store(supported, Ordering::SeqCst);
    }

    pub fn set_content_disposition(&self, value: &str) {
        *self.shared.content_disposition.lock().unwrap() = Some(value.to_string());
    }

    pub fn set_flaky_429(&self, count: usize, retry_after: Option<&str>) {
        self.shared.flaky_429.store(count, Ordering::SeqCst);
        *self.shared.retry_after.lock().unwrap() = retry_after.map(str::to_string);
    }

    pub fn set_chunk_delay(&self, delay: Duration) {
        *self.shared.chunk_delay.lock().unwrap() = Some(delay);
    }

    pub fn set_redirect(&self, redirect: bool) {
        self.shared.redirect.store(redirect, Ordering::SeqCst);
    }

    pub fn requests(&self) -> usize {
        self.shared.requests.load(Ordering::SeqCst)
    }

    pub fn range_requests(&self) -> usize {
        self.shared.range_requests.load(Ordering::SeqCst)
    }

    pub fn max_active(&self) -> usize {
        self.shared.max_active.load(Ordering::SeqCst)
    }

    /// Add a static response header to every 200/206 response (checksum,
    /// rate-limit and header-allowlist tests).
    pub fn set_header(&self, name: &str, value: &str) {
        self.shared.extra_headers.lock().unwrap().push((name.to_string(), value.to_string()));
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
        let _ = TcpStream::connect(self.addr);
        if let Some(handle) = self.handle.take() {
            let _ = handle.join();
        }
    }
}

struct Request {
    method: String,
    path: String,
    headers: HashMap<String, String>,
}

fn read_request(stream: &mut TcpStream) -> Option<Request> {
    stream.set_read_timeout(Some(Duration::from_secs(10))).ok()?;
    let mut buffer = Vec::new();
    let mut chunk = [0u8; 4096];
    loop {
        let read = stream.read(&mut chunk).ok()?;
        if read == 0 {
            return None;
        }
        buffer.extend_from_slice(&chunk[..read]);
        if buffer.windows(4).any(|window| window == b"\r\n\r\n") {
            break;
        }
        if buffer.len() > 64 * 1024 {
            return None;
        }
    }
    let text = String::from_utf8_lossy(&buffer);
    let mut lines = text.split("\r\n");
    let request_line = lines.next()?;
    let mut parts = request_line.split_whitespace();
    let method = parts.next()?.to_string();
    let path = parts.next()?.to_string();
    let mut headers = HashMap::new();
    for line in lines {
        if line.is_empty() {
            break;
        }
        if let Some((name, value)) = line.split_once(':') {
            headers.insert(name.trim().to_ascii_lowercase(), value.trim().to_string());
        }
    }
    Some(Request { method, path, headers })
}

fn serve(mut stream: TcpStream, shared: Arc<Shared>) {
    let active = shared.active.fetch_add(1, Ordering::SeqCst) + 1;
    shared.max_active.fetch_max(active, Ordering::SeqCst);
    let result = handle(&mut stream, &shared);
    if result.is_err() {
        // Client aborts (dropped probe responses) are expected in tests.
    }
    shared.active.fetch_sub(1, Ordering::SeqCst);
}

fn handle(stream: &mut TcpStream, shared: &Arc<Shared>) -> std::io::Result<()> {
    let Some(request) = read_request(stream) else {
        return Ok(());
    };
    let path = request.path.split('?').next().unwrap_or("/").to_string();
    if path == "/redirect" {
        // The fixture address is the stream's local address. Serve the redirect
        // for HEAD too, so the kernel's probe follows it.
        let location = format!("http://{}/file", stream.local_addr()?);
        return write_response(stream, "302 Found", &[("Location".to_string(), location)], &[]);
    }
    if path == "/chain" {
        let location = format!("http://{}/redirect", stream.local_addr()?);
        return write_response(stream, "302 Found", &[("Location".to_string(), location)], &[]);
    }
    if path != "/file" && path != "/redirect" {
        return write_response(stream, "404 Not Found", &[], b"not found");
    }
    shared.requests.fetch_add(1, Ordering::SeqCst);
    let etag = shared.etag.lock().unwrap().clone();
    let dispositions = shared.content_disposition.lock().unwrap().clone();
    let supports = shared.supports_ranges.load(Ordering::SeqCst);
    let total = shared.bytes.len() as u64;
    let mut headers: Vec<(String, String)> = vec![
        ("ETag".to_string(), etag),
        ("Content-Type".to_string(), "application/octet-stream".to_string()),
        ("Accept-Ranges".to_string(), if supports { "bytes" } else { "none" }.to_string()),
        ("Last-Modified".to_string(), "Wed, 21 Oct 2026 07:28:00 GMT".to_string()),
    ];
    if let Some(value) = dispositions {
        headers.push(("Content-Disposition".to_string(), value));
    }
    for (name, value) in shared.extra_headers.lock().unwrap().iter() {
        headers.push((name.clone(), value.clone()));
    }

    if request.method == "HEAD" {
        headers.push(("Content-Length".to_string(), total.to_string()));
        return write_response(stream, "200 OK", &headers, &[]);
    }

    // One-shot 429 pushback (counted per GET on the main file route).
    let flaky = shared.flaky_429.load(Ordering::SeqCst);
    if flaky > 0 {
        shared.flaky_429.store(flaky - 1, Ordering::SeqCst);
        if let Some(value) = shared.retry_after.lock().unwrap().clone() {
            headers.push(("Retry-After".to_string(), value));
        }
        headers.push(("Content-Length".to_string(), "9".to_string()));
        return write_response(stream, "429 Too Many Requests", &headers, b"slow down");
    }

    let range = request.headers.get("range").cloned().filter(|_| supports);
    if let Some(range) = range {
        shared.range_requests.fetch_add(1, Ordering::SeqCst);
        let Some((start, end_inclusive)) = parse_range(&range, total) else {
            headers.push(("Content-Range".to_string(), format!("bytes */{total}")));
            return write_response(stream, "416 Range Not Satisfiable", &headers, b"");
        };
        let len = end_inclusive - start + 1;
        headers.push(("Content-Range".to_string(), format!("bytes {start}-{end_inclusive}/{total}")));
        headers.push(("Content-Length".to_string(), len.to_string()));
        let body = shared.bytes[start as usize..=(end_inclusive as usize)].to_vec();
        return write_chunked_response(stream, "206 Partial Content", &headers, &body, shared);
    }

    headers.push(("Content-Length".to_string(), total.to_string()));
    let body = shared.bytes.clone();
    write_chunked_response(stream, "200 OK", &headers, &body, shared)
}

fn parse_range(value: &str, total: u64) -> Option<(u64, u64)> {
    let range = value.trim().strip_prefix("bytes=")?;
    let (start, end) = range.split_once('-')?;
    let start: u64 = start.trim().parse().ok()?;
    if start >= total {
        return None;
    }
    let end: u64 = if end.trim().is_empty() { total - 1 } else { end.trim().parse().ok()? };
    Some((start, end.min(total - 1)))
}

fn write_response(stream: &mut TcpStream, status: &str, headers: &[(String, String)], body: &[u8]) -> std::io::Result<()> {
    let mut response = format!("HTTP/1.1 {status}\r\n");
    for (name, value) in headers {
        response.push_str(&format!("{name}: {value}\r\n"));
    }
    response.push_str("Connection: close\r\n\r\n");
    stream.write_all(response.as_bytes())?;
    if !body.is_empty() {
        stream.write_all(body)?;
    }
    stream.flush()
}

fn write_chunked_response(stream: &mut TcpStream, status: &str, headers: &[(String, String)], body: &[u8], shared: &Arc<Shared>) -> std::io::Result<()> {
    let delay = *shared.chunk_delay.lock().unwrap();
    let mut response = format!("HTTP/1.1 {status}\r\n");
    for (name, value) in headers {
        response.push_str(&format!("{name}: {value}\r\n"));
    }
    response.push_str("Connection: close\r\n\r\n");
    stream.write_all(response.as_bytes())?;
    match delay {
        None => {
            stream.write_all(body)?;
            stream.flush()?;
        }
        Some(delay) => {
            for chunk in body.chunks(32 * 1024) {
                stream.write_all(chunk)?;
                stream.flush()?;
                thread::sleep(delay);
            }
        }
    }
    Ok(())
}
