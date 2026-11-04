use rdm_kernel::kernel::Kernel;
use rdm_kernel::protocol::PROTOCOL;
use rdm_kernel::rpc;
use std::io::{BufRead, Write};
use std::path::PathBuf;
use std::sync::Arc;
use std::thread;
use std::time::Duration;
enum Inbound {
    Line(String),
    Eof,
}
fn main() {
    let mut data_dir: Option<PathBuf> = None;
    let mut log_level = "warn".to_string();
    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        let (key, inline) = match arg.split_once('=') {
            Some((key, value)) => (key.to_string(), Some(value.to_string())),
            None => (arg.clone(), None),
        };
        match key.as_str() {
            "--data-dir" => data_dir = inline.or_else(|| args.next()).map(PathBuf::from),
            "--log-level" => log_level = inline.or_else(|| args.next()).unwrap_or(log_level),
            "--help" | "-h" => {
                println!("rdm-kernel --data-dir <dir> [--log-level error|warn|info|debug]");
                return;
            }
            other => {
                eprintln!("rdm-kernel: unknown argument `{other}`");
                std::process::exit(2);
            }
        }
    }
    let Some(data_dir) = data_dir else {
        eprintln!("rdm-kernel: --data-dir is required");
        std::process::exit(2);
    };
    rdm_kernel::log::set_level(&log_level);
    let (outbox, out_rx) = std::sync::mpsc::channel::<String>();
    let writer = thread::spawn(move || {
        let stdout = std::io::stdout();
        let mut lock = stdout.lock();
        for line in out_rx {
            if writeln!(lock, "{line}").is_err() {
                break;
            }
            let _ = lock.flush();
        }
    });
    let runtime = tokio::runtime::Builder::new_multi_thread().worker_threads(2).enable_all().build().unwrap_or_else(|error| {
        eprintln!("rdm-kernel: could not start async runtime: {error}");
        std::process::exit(1);
    });
    let code = runtime.block_on(run(data_dir, outbox.clone(), log_level));
    runtime.shutdown_timeout(Duration::from_millis(300));
    drop(outbox);
    let _ = writer.join();
    std::process::exit(code);
}
async fn run(data_dir: PathBuf, outbox: std::sync::mpsc::Sender<String>, log_level: String) -> i32 {
    let Ok(kernel) = Kernel::new(data_dir, Some(outbox.clone())) else {
        eprintln!("rdm-kernel: cannot initialize data dir");
        return 1;
    };
    rdm_kernel::log::set_level(&log_level);
    let background = {
        let kernel = Arc::clone(&kernel);
        tokio::spawn(async move { kernel.run_background().await })
    };
    let _ = outbox.send(serde_json::json!({ "event": "ready", "protocol": PROTOCOL, "kernel": kernel.info() }).to_string());
    let (in_tx, mut in_rx) = tokio::sync::mpsc::unbounded_channel::<Inbound>();
    thread::spawn(move || {
        let stdin = std::io::stdin();
        let mut line = String::new();
        loop {
            line.clear();
            match stdin.lock().read_line(&mut line) {
                Ok(0) => break,
                Ok(_) => {
                    let trimmed = line.trim_end_matches(['\r', '\n']).to_string();
                    if in_tx.send(Inbound::Line(trimmed)).is_err() {
                        return;
                    }
                }
                Err(_) => break,
            }
        }
        let _ = in_tx.send(Inbound::Eof);
    });
    let mut shutdown_done = false;
    while let Some(item) = in_rx.recv().await {
        let line = match item {
            Inbound::Eof => break,
            Inbound::Line(line) => line,
        };
        if line.trim().is_empty() {
            continue;
        }
        let envelope = match rpc::parse_request(&line) {
            Ok(envelope) => envelope,
            Err((id, error)) => {
                let _ = outbox.send(rpc::error_line(&id, &error));
                continue;
            }
        };
        if envelope.method == "shutdown" {
            kernel.shutdown().await;
            shutdown_done = true;
            let _ = outbox.send(rpc::success_line(&envelope.id, serde_json::json!({"ok": true})));
            break;
        }
        let kernel = Arc::clone(&kernel);
        let outbox = outbox.clone();
        tokio::spawn(async move {
            let line = match rpc::dispatch(&kernel, &envelope.method, envelope.params).await {
                Ok(result) => rpc::success_line(&envelope.id, result),
                Err(error) => rpc::error_line(&envelope.id, &error),
            };
            let _ = outbox.send(line);
        });
    }
    if !shutdown_done {
        kernel.shutdown().await;
    }
    background.abort();
    0
}
