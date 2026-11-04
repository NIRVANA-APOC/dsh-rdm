use std::sync::Mutex;
use std::time::{Duration, Instant};
use tokio::time::sleep;
const MIN_BURST: f64 = 64.0 * 1024.0;
pub struct TokenBucket {
    rate: f64,
    burst: f64,
    state: Mutex<Bucket>,
}
struct Bucket {
    tokens: f64,
    last: Instant,
}
impl TokenBucket {
    pub fn new(bytes_per_sec: u64) -> Self {
        let rate = bytes_per_sec.max(1) as f64;
        let burst = (rate / 4.0).clamp(MIN_BURST.min(rate), rate);
        Self { rate, burst, state: Mutex::new(Bucket { tokens: burst, last: Instant::now() }) }
    }
    pub async fn acquire(&self, bytes: u64) {
        if bytes == 0 {
            return;
        }
        let wait = {
            let mut bucket = self.state.lock().expect("rate limiter mutex poisoned");
            let now = Instant::now();
            let elapsed = now.duration_since(bucket.last).as_secs_f64();
            bucket.tokens = (bucket.tokens + elapsed * self.rate).min(self.burst);
            bucket.last = now;
            bucket.tokens -= bytes as f64;
            if bucket.tokens >= 0.0 {
                0.0
            } else {
                -bucket.tokens / self.rate
            }
        };
        if wait > 0.0 {
            sleep(Duration::from_secs_f64(wait)).await;
        }
    }
}
