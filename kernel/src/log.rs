use std::sync::atomic::{AtomicU8, Ordering};
pub const ERROR: u8 = 1;
pub const WARN: u8 = 2;
pub const INFO: u8 = 3;
pub const DEBUG: u8 = 4;
static LEVEL: AtomicU8 = AtomicU8::new(WARN);
pub fn set_level(level: &str) {
    let value = match level.trim().to_ascii_lowercase().as_str() {
        "error" => ERROR,
        "warn" | "warning" => WARN,
        "info" => INFO,
        "debug" | "trace" => DEBUG,
        _ => WARN,
    };
    LEVEL.store(value, Ordering::Relaxed);
}
pub fn enabled(level: u8) -> bool {
    level <= LEVEL.load(Ordering::Relaxed)
}
#[macro_export]
macro_rules! klog {
    (error, $($arg:tt)*) => {
        if $crate::log::enabled($crate::log::ERROR) {
            eprintln!("[rdm-kernel] error: {}", format_args!($($arg)*));
        }
    };
    (warn, $($arg:tt)*) => {
        if $crate::log::enabled($crate::log::WARN) {
            eprintln!("[rdm-kernel] warn: {}", format_args!($($arg)*));
        }
    };
    (info, $($arg:tt)*) => {
        if $crate::log::enabled($crate::log::INFO) {
            eprintln!("[rdm-kernel] info: {}", format_args!($($arg)*));
        }
    };
    (debug, $($arg:tt)*) => {
        if $crate::log::enabled($crate::log::DEBUG) {
            eprintln!("[rdm-kernel] debug: {}", format_args!($($arg)*));
        }
    };
}
