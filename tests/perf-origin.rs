// Zero-dependency HTTP range origin for the dsh-rdm perf harness
// (and for ad-hoc loopback throughput checks). Serves a deterministic pattern
// buffer, honours single byte ranges, keep-alive, no artificial delay.
// Build: rustc -O -o tests/.tmp-e2e/perf-origin.exe tests/perf-origin.rs
// Run:   tests/.tmp-e2e/perf-origin.exe --size 268435456   (prints PORT <n>)
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::Arc;
use std::thread;

fn parse_range(value: &str, size: u64) -> Option<(u64, u64)> {
    let rest = value.trim().strip_prefix("bytes=")?;
    let (start, end) = rest.split_once('-')?;
    let start: u64 = start.trim().parse().ok()?;
    let end: u64 = if end.trim().is_empty() { size - 1 } else { end.trim().parse().ok()? };
    if start >= size || end < start {
        return None;
    }
    Some((start, end.min(size - 1)))
}

fn handle(mut stream: TcpStream, body: Arc<Vec<u8>>) {
    let size = body.len() as u64;
    let mut reader = BufReader::new(stream.try_clone().expect("clone"));
    loop {
        let mut request_line = String::new();
        if reader.read_line(&mut request_line).unwrap_or(0) == 0 {
            return;
        }
        if request_line.trim().is_empty() {
            continue;
        }
        let mut range: Option<String> = None;
        let mut content_length = 0usize;
        loop {
            let mut line = String::new();
            if reader.read_line(&mut line).unwrap_or(0) == 0 {
                return;
            }
            let trimmed = line.trim_end();
            if trimmed.is_empty() {
                break;
            }
            let lower = trimmed.to_ascii_lowercase();
            if let Some(value) = lower.strip_prefix("range:") {
                range = Some(value.trim().to_string());
            } else if let Some(value) = lower.strip_prefix("content-length:") {
                content_length = value.trim().parse().unwrap_or(0);
            }
        }
        if content_length > 0 {
            let mut sink = vec![0u8; content_length];
            let _ = reader.read_exact(&mut sink);
        }
        let mut parts = request_line.split_whitespace();
        let method = parts.next().unwrap_or("GET");
        let is_head = method.eq_ignore_ascii_case("HEAD");
        let (status, headers, start, end) = match range.as_deref().and_then(|value| parse_range(value, size)) {
            Some((start, end)) => (
                "206 Partial Content",
                format!(
                    "HTTP/1.1 206 Partial Content\r\nContent-Length: {}\r\nContent-Range: bytes {start}-{end}/{size}\r\nAccept-Ranges: bytes\r\nETag: \"big-v1\"\r\nConnection: keep-alive\r\n\r\n",
                    end - start + 1
                ),
                start,
                end,
            ),
            None => (
                "200 OK",
                format!(
                    "HTTP/1.1 200 OK\r\nContent-Length: {size}\r\nAccept-Ranges: bytes\r\nETag: \"big-v1\"\r\nConnection: keep-alive\r\n\r\n"
                ),
                0,
                size - 1,
            ),
        };
        let _ = status;
        if stream.write_all(headers.as_bytes()).is_err() {
            return;
        }
        if !is_head {
            let slice = &body[start as usize..=end as usize];
            if stream.write_all(slice).is_err() {
                return;
            }
        }
        let _ = stream.flush();
    }
}

fn main() {
    let mut size: u64 = 256 * 1024 * 1024;
    let mut port: u16 = 0;
    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--size" => size = args.next().and_then(|v| v.parse().ok()).unwrap_or(size),
            "--port" => port = args.next().and_then(|v| v.parse().ok()).unwrap_or(port),
            other => panic!("unknown arg {other}"),
        }
    }
    let mut pattern = vec![0u8; size as usize];
    let mut state = 0x12345678u32;
    for byte in pattern.iter_mut() {
        state = state.wrapping_mul(1664525).wrapping_add(1013904223);
        *byte = (state >> 24) as u8;
    }
    let body = Arc::new(pattern);
    let listener = TcpListener::bind(("127.0.0.1", port)).expect("bind");
    println!("PORT {}", listener.local_addr().unwrap().port());
    let _ = std::io::stdout().flush();
    for stream in listener.incoming() {
        match stream {
            Ok(stream) => {
                let _ = stream.set_nodelay(true);
                let body = Arc::clone(&body);
                thread::spawn(move || handle(stream, body));
            }
            Err(_) => continue,
        }
    }
}


